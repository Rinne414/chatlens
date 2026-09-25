"use strict";

// Persistent, block-diffed mirror of the QQNT databases.
//
// nt_msg.db is routinely ~10 GB. Earlier versions copied it in full for every
// run (minutes of disk I/O and 10 GB of writes each time), which also made a
// periodic background refresh impossible. The mirror keeps ONE stripped copy
// and, on each sync, re-reads the source but only rewrites the fixed-size
// blocks whose hash changed — measured at ~2% of blocks per 10 minutes on a
// busy account, so a sync is a few seconds of reading and a few hundred MB of
// writes instead of a full copy.
//
// Invariants:
// - The QQ originals are only ever opened for reading.
// - Nothing but this module writes the mirror files; every reader opens them
//   readonly (so SQLite can never checkpoint into them and invalidate the
//   stored block hashes). If the mirror's size/mtime no longer match what the
//   last sync recorded, the next sync rewrites every block.
// - Callers serialize access with withMirrorLock: never read while syncing.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIRROR_FORMAT = 1;
const BLOCK_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
const HASH_BYTES = 20;
// QQNT prepends a 1024-byte fake header ("SQLite header 3\0...") to its
// SQLCipher databases on Windows and Linux; SQLCipher only opens a copy with
// the prefix stripped. Detected per file instead of assumed.
const QQ_FAKE_HEADER = Buffer.from("SQLite header 3\0", "latin1");
const QQ_PREFIX_BYTES = 1024;

const DATABASES = [
  { source: "nt_msg.db", target: "nt_msg.clean.db", diffed: true },
  { source: "group_info.db", target: "group_info.clean.db", diffed: false },
];

const detectPrefixBytes = (filePath) => {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(QQ_FAKE_HEADER.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(QQ_FAKE_HEADER) ? QQ_PREFIX_BYTES : 0;
  } finally {
    fs.closeSync(fd);
  }
};

const readJsonOrNull = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const writeFileAtomic = (filePath, data) => {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
};

// WAL/SHM sidecars are small; copy them whole. They must be copied BEFORE the
// main file: if QQ checkpoints between the two copies, the checkpointed pages
// land in the (later) main copy and the older WAL copy merely replays the same
// content. The reverse order would silently lose those pages.
const syncSidecars = (sourcePath, targetPath) => {
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${sourcePath}${suffix}`;
    const target = `${targetPath}${suffix}`;
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else {
      fs.rmSync(target, { force: true });
    }
  }
};

const copyWithoutPrefix = (sourcePath, targetPath, prefixBytes) => {
  const source = fs.openSync(sourcePath, "r");
  const tempPath = `${targetPath}.tmp-${process.pid}`;
  const target = fs.openSync(tempPath, "w");
  try {
    const size = fs.fstatSync(source).size;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = prefixBytes;
    while (position < size) {
      const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read === 0) {
        break;
      }
      fs.writeSync(target, buffer, 0, read);
      position += read;
    }
  } finally {
    fs.closeSync(target);
    fs.closeSync(source);
  }
  fs.renameSync(tempPath, targetPath);
};

// Block indexes are derived from offsets, so a short read must never shift
// the alignment: keep reading until the chunk is full or the file ends.
const readFully = (fd, buffer, length, position) => {
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, position + total);
    if (read === 0) {
      break;
    }
    total += read;
  }
  return total;
};

// Every sync re-reads the whole ~10 GB source. Read through the Windows file
// cache, that pushed 10 GB into standby memory every refresh and evicted what
// other programs had cached (the PC felt sluggish after each refresh).
// FILE_FLAG_NO_BUFFERING (libuv's UV_FS_O_DIRECT on Windows) reads straight
// from disk: measured 2026-09-25 on the real 10.5 GB file, read + hash took
// 6.7 s instead of ~20 s and the standby cache did not change. NTFS flushes
// a file's dirty cached pages before an uncached read of them, so QQ's latest
// writes are seen. Uncached I/O needs sector-aligned offsets, lengths and
// buffer addresses; anything unsupported falls back to cached reads.
const UV_FS_O_DIRECT = 0x02000000;
const DIRECT_ALIGN = 4096;
const ALIGN_PROBE_STEP = 16;

const cachedReader = (sourcePath, prefixBytes) => {
  const fd = fs.openSync(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  return {
    mode: "cached",
    size: fs.fstatSync(fd).size,
    read: (mirrorOffset, wanted) => buffer.subarray(0, readFully(fd, buffer, wanted, mirrorOffset + prefixBytes)),
    close: () => fs.closeSync(fd),
  };
};

// The buffer's memory address is not visible from JS; a read into a
// misaligned view fails with EINVAL, so try views until one is accepted.
const findAlignedOffset = (fd, raw) => {
  for (let offset = 0; offset < DIRECT_ALIGN; offset += ALIGN_PROBE_STEP) {
    try {
      fs.readSync(fd, raw, offset, DIRECT_ALIGN, 0);
      return offset;
    } catch (error) {
      if (error.code !== "EINVAL") {
        throw error;
      }
    }
  }
  return -1;
};

// Reads [start, start+length) where both are sector multiples. A short read
// that is not a sector multiple can only be the end of the file.
const readAligned = (fd, view, length, start) => {
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, view, total, length - total, start + total);
    total += read;
    if (read === 0 || total % DIRECT_ALIGN !== 0) {
      break;
    }
  }
  return total;
};

const uncachedReader = (sourcePath, prefixBytes) => {
  let fd;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | UV_FS_O_DIRECT);
  } catch {
    return null;
  }
  try {
    // Room for the sector the block's start falls in and a partial last sector.
    const raw = Buffer.allocUnsafeSlow(READ_CHUNK_BYTES + 3 * DIRECT_ALIGN);
    const offset = findAlignedOffset(fd, raw);
    if (offset < 0) {
      fs.closeSync(fd);
      return null;
    }
    const view = raw.subarray(offset, offset + READ_CHUNK_BYTES + 2 * DIRECT_ALIGN);
    return {
      mode: "uncached",
      size: fs.fstatSync(fd).size,
      read: (mirrorOffset, wanted) => {
        const filePosition = mirrorOffset + prefixBytes;
        const lead = filePosition % DIRECT_ALIGN;
        const length = Math.ceil((lead + wanted) / DIRECT_ALIGN) * DIRECT_ALIGN;
        const got = readAligned(fd, view, length, filePosition - lead);
        return view.subarray(lead, lead + Math.max(0, Math.min(wanted, got - lead)));
      },
      close: () => fs.closeSync(fd),
    };
  } catch {
    fs.closeSync(fd);
    return null;
  }
};

const openSourceReader = (sourcePath, prefixBytes, uncached) =>
  (uncached ? uncachedReader(sourcePath, prefixBytes) : null) ?? cachedReader(sourcePath, prefixBytes);

const metaPathFor = (targetPath) => `${targetPath}.mirror.json`;
const hashesPathFor = (targetPath) => `${targetPath}.blocks`;

const loadTrustedHashes = (targetPath, prefixBytes) => {
  const meta = readJsonOrNull(metaPathFor(targetPath));
  if (meta === null || meta.format !== MIRROR_FORMAT || meta.blockBytes !== BLOCK_BYTES || meta.prefixBytes !== prefixBytes) {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return null;
  }
  // Something other than a sync touched the mirror: its hashes are no
  // longer a description of what is on disk.
  if (stat.size !== meta.mirrorBytes || Math.trunc(stat.mtimeMs) !== meta.mirrorMtimeMs) {
    return null;
  }
  try {
    const hashes = fs.readFileSync(hashesPathFor(targetPath));
    return hashes.length === meta.blockCount * HASH_BYTES ? hashes : null;
  } catch {
    return null;
  }
};

// Re-reads the whole source but rewrites only blocks whose hash changed.
const diffSync = (sourcePath, targetPath, prefixBytes, uncached) => {
  const trusted = loadTrustedHashes(targetPath, prefixBytes);
  const source = openSourceReader(sourcePath, prefixBytes, uncached);
  const target = fs.openSync(targetPath, fs.existsSync(targetPath) ? "r+" : "w+");
  let changedBlocks = 0;
  let blockCount = 0;
  let mirrorBytes = 0;
  const hashes = [];
  try {
    mirrorBytes = Math.max(0, source.size - prefixBytes);
    blockCount = Math.ceil(mirrorBytes / BLOCK_BYTES);
    let mirrorOffset = 0;
    while (mirrorOffset < mirrorBytes) {
      const wanted = Math.min(READ_CHUNK_BYTES, mirrorBytes - mirrorOffset);
      const buffer = source.read(mirrorOffset, wanted);
      const read = buffer.length;
      if (read === 0) {
        // The source shrank mid-read; whatever we have is still consistent
        // block by block, and the next sync starts over.
        mirrorBytes = mirrorOffset;
        blockCount = Math.ceil(mirrorBytes / BLOCK_BYTES);
        break;
      }
      for (let blockStart = 0; blockStart < read; blockStart += BLOCK_BYTES) {
        const block = buffer.subarray(blockStart, Math.min(read, blockStart + BLOCK_BYTES));
        const blockIndex = (mirrorOffset + blockStart) / BLOCK_BYTES;
        const digest = crypto.createHash("sha1").update(block).digest();
        hashes.push(digest);
        const known = trusted !== null && (blockIndex + 1) * HASH_BYTES <= trusted.length
          ? trusted.subarray(blockIndex * HASH_BYTES, (blockIndex + 1) * HASH_BYTES)
          : null;
        if (known === null || !known.equals(digest)) {
          fs.writeSync(target, block, 0, block.length, mirrorOffset + blockStart);
          changedBlocks += 1;
        }
      }
      mirrorOffset += read;
    }
    fs.ftruncateSync(target, mirrorBytes);
  } finally {
    fs.closeSync(target);
    source.close();
  }

  const stat = fs.statSync(targetPath);
  writeFileAtomic(hashesPathFor(targetPath), Buffer.concat(hashes));
  writeFileAtomic(metaPathFor(targetPath), JSON.stringify({
    format: MIRROR_FORMAT,
    blockBytes: BLOCK_BYTES,
    prefixBytes,
    blockCount: hashes.length,
    mirrorBytes: stat.size,
    mirrorMtimeMs: Math.trunc(stat.mtimeMs),
    syncedAt: new Date().toISOString(),
  }));
  return {
    changedBlocks,
    blockCount,
    changedBytes: Math.min(changedBlocks * BLOCK_BYTES, mirrorBytes),
    fullRewrite: trusted === null,
    readMode: source.mode,
  };
};

// An uncached read that fails mid-file (an unexpected alignment rule, say)
// redoes the pass through the cache rather than failing the refresh.
const diffSyncWithFallback = (sourcePath, targetPath, prefixBytes, uncached) => {
  try {
    return diffSync(sourcePath, targetPath, prefixBytes, uncached);
  } catch (error) {
    if (!uncached) {
      throw error;
    }
    return diffSync(sourcePath, targetPath, prefixBytes, false);
  }
};

const fileVersion = (filePath) => {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
};

// A snapshot is only consistent if QQ did not checkpoint into the main file
// between our WAL copy and the end of the main-file pass: a checkpoint in that
// window mixes newer main pages with older WAL frames, which SQLite then reads
// as a malformed B-tree (observed in practice). The main file is written ONLY
// by checkpoints, so an unchanged size+mtime across the pass proves none
// happened. Otherwise redo the pass — each retry rewrites only what changed.
const MAX_CONSISTENCY_ATTEMPTS = 4;

const syncOneDatabase = (database, sourcePath, targetPath, uncached) => {
  const prefixBytes = detectPrefixBytes(sourcePath);
  let attempts = 0;
  let changedBlocks = 0;
  let changedBytes = 0;
  let last = null;
  while (attempts < MAX_CONSISTENCY_ATTEMPTS) {
    attempts += 1;
    const before = fileVersion(sourcePath);
    syncSidecars(sourcePath, targetPath);
    if (database.diffed) {
      last = diffSyncWithFallback(sourcePath, targetPath, prefixBytes, uncached);
      changedBlocks += last.changedBlocks;
      changedBytes += last.changedBytes;
    } else {
      copyWithoutPrefix(sourcePath, targetPath, prefixBytes);
    }
    if (fileVersion(sourcePath) === before) {
      return { prefixBytes, attempts, consistent: true, changedBlocks, changedBytes, fullRewrite: last?.fullRewrite ?? true, readMode: last?.readMode ?? "copy" };
    }
  }
  return { prefixBytes, attempts, consistent: false, changedBlocks, changedBytes, fullRewrite: last?.fullRewrite ?? true, readMode: last?.readMode ?? "copy" };
};

const syncMirror = ({ ntDbDir, mirrorDir, uncached = process.platform === "win32" }) => {
  if (typeof ntDbDir !== "string" || !path.isAbsolute(ntDbDir)) {
    throw new Error(`QQ 数据库目录必须是绝对路径: ${ntDbDir}`);
  }
  fs.mkdirSync(mirrorDir, { recursive: true });
  const startedAt = Date.now();
  const stats = {};
  for (const database of DATABASES) {
    const sourcePath = path.join(ntDbDir, database.source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`找不到源数据库: ${sourcePath}（请在设置页检查 QQ 数据库路径）`);
    }
    stats[database.source] = syncOneDatabase(database, sourcePath, path.join(mirrorDir, database.target), uncached);
  }
  return {
    cleanDir: mirrorDir,
    messageDb: path.join(mirrorDir, "nt_msg.clean.db"),
    groupDb: path.join(mirrorDir, "group_info.clean.db"),
    elapsedMs: Date.now() - startedAt,
    consistent: Object.values(stats).every((item) => item.consistent),
    stats,
  };
};

/* ---------- cross-process lock ---------- */

const LOCK_NAME = "mirror.lock";

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const tryAcquireLock = (mirrorDir, owner) => {
  fs.mkdirSync(mirrorDir, { recursive: true });
  const lockPath = path.join(mirrorDir, LOCK_NAME);
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner, at: Date.now() }), { flag: "wx" });
    return lockPath;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  const holder = readJsonOrNull(lockPath);
  if (holder === null || !Number.isInteger(holder.pid) || !isProcessAlive(holder.pid)) {
    // Stale lock from a crashed or killed process.
    fs.rmSync(lockPath, { force: true });
    return tryAcquireLock(mirrorDir, owner);
  }
  return null;
};

const describeLockHolder = (mirrorDir) => readJsonOrNull(path.join(mirrorDir, LOCK_NAME));

// Runs fn while holding the mirror lock. Returns { acquired:false } instead of
// waiting when another process (a manual run vs. the background refresh)
// currently owns it.
const withMirrorLock = async (mirrorDir, owner, fn) => {
  const lockPath = tryAcquireLock(mirrorDir, owner);
  if (lockPath === null) {
    return { acquired: false, holder: describeLockHolder(mirrorDir) };
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
};

const mirrorFiles = (mirrorDir) =>
  DATABASES.flatMap((database) => {
    const base = path.join(mirrorDir, database.target);
    return [base, `${base}-wal`, `${base}-shm`, metaPathFor(base), hashesPathFor(base)];
  });

module.exports = {
  BLOCK_BYTES,
  QQ_PREFIX_BYTES,
  detectPrefixBytes,
  syncMirror,
  withMirrorLock,
  describeLockHolder,
  mirrorFiles,
};

if (require.main === module) {
  const [ntDbDir, mirrorDir] = process.argv.slice(2);
  if (!ntDbDir || !mirrorDir) {
    console.error("Usage: node db_mirror.js <ntDbDir> <mirrorDir>");
    process.exit(2);
  }
  withMirrorLock(path.resolve(mirrorDir), "cli", () => syncMirror({ ntDbDir: path.resolve(ntDbDir), mirrorDir: path.resolve(mirrorDir) }))
    .then((result) => {
      if (!result.acquired) {
        console.error(`mirror is busy: ${JSON.stringify(result.holder)}`);
        process.exit(3);
      }
      console.log(JSON.stringify(result.value));
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exit(1);
    });
}
