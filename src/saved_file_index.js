"use strict";

// md5 of every picture under the folders the user keeps pictures in, so QQ
// 收藏图 can tell which collection pictures are saved already, whatever the
// file is called now and whichever subfolder it was sorted into. The first
// scan of a big folder reads everything (40 GB took about a minute on the
// user's drive); a file keeps its md5 while its size and mtime stay the same,
// so later scans only read new or changed files. Kept in a small database of
// its own (store/qq-collection.db).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PICTURE_FILE = /\.(png|jpe?g|jfif|gif|webp|bmp|heic|avif)$/iu;
// Files read at the same time, and rows written per transaction.
const READ_AHEAD = 4;
const WRITE_EVERY = 200;
const STAT_BATCH = 64;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    md5 TEXT NOT NULL,
    scan_id INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5)",
];

const openIndex = (Database, dbPath) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Every picture file under the roots, links not followed: { files: [{ path,
// size, mtimeMs }], unreadable: [folders that could not be listed] }. A root
// missing right now (a drive not plugged in) is unreadable, not empty.
const listPictureFiles = async (roots, shouldStop) => {
  const files = [];
  const unreadable = [];
  const pending = [...roots];
  while (pending.length > 0 && !shouldStop()) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      continue;
    }
    const pictures = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(path.join(dir, entry.name));
      } else if (entry.isFile() && PICTURE_FILE.test(entry.name)) {
        pictures.push(path.join(dir, entry.name));
      }
    }
    for (let start = 0; start < pictures.length; start += STAT_BATCH) {
      const stats = await Promise.all(pictures.slice(start, start + STAT_BATCH).map((file) => fs.promises.stat(file).then(
        (stat) => ({ path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }),
        () => null,
      )));
      files.push(...stats.filter((item) => item !== null));
    }
  }
  return { files, unreadable };
};

// Streamed: a big file never sits in memory whole.
const md5File = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("md5");
  fs.createReadStream(filePath)
    .on("error", reject)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex")));
});

// Rows not seen by this scan, except under folders it could not list.
const removeUnseen = (db, scanId, unreadable) => {
  const unseen = db.prepare("SELECT path FROM files WHERE scan_id <> ?").all(scanId)
    .map((row) => row.path)
    .filter((filePath) => !unreadable.some((dir) => isInside(dir, filePath)));
  const remove = db.prepare("DELETE FROM files WHERE path = ?");
  db.transaction(() => {
    for (const filePath of unseen) {
      remove.run(filePath);
    }
  })();
  return unseen.length;
};

// Brings the index in line with the folders. onProgress({ phase, done, total, hashed }).
// A stopped scan keeps what it hashed and removes nothing. A file that
// cannot be read keeps its earlier md5 (and is read again next time); files
// under a folder that cannot be listed stay as they were.
const scanFolders = async (db, roots, { onProgress = () => {}, shouldStop = () => false, now = Date.now(), hashFile = md5File } = {}) => {
  const scanId = now;
  onProgress({ phase: "listing", done: 0, total: 0, hashed: 0 });
  const { files, unreadable } = await listPictureFiles(roots, shouldStop);
  const known = db.prepare("SELECT size, mtime_ms AS mtimeMs, md5 FROM files WHERE path = ?");
  const upsert = db.prepare(`
    INSERT INTO files (path, size, mtime_ms, md5, scan_id) VALUES (@path, @size, @mtimeMs, @md5, @scanId)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, md5 = excluded.md5, scan_id = excluded.scan_id
  `);
  const writeAll = db.transaction((rows) => {
    for (const row of rows) {
      upsert.run({ ...row, scanId });
    }
  });
  const counts = { files: files.length, hashed: 0, reused: 0, failed: 0, removed: 0, stopped: false, unreadable };
  if (shouldStop()) {
    return { ...counts, stopped: true };
  }
  let unwritten = [];
  for (let start = 0; start < files.length; start += READ_AHEAD) {
    if (shouldStop()) {
      counts.stopped = true;
      break;
    }
    const results = await Promise.all(files.slice(start, start + READ_AHEAD).map(async (file) => {
      const row = known.get(file.path);
      if (row !== undefined && row.size === file.size && row.mtimeMs === file.mtimeMs) {
        counts.reused += 1;
        return { ...file, md5: row.md5 };
      }
      try {
        const md5 = await hashFile(file.path);
        counts.hashed += 1;
        return { ...file, md5 };
      } catch {
        counts.failed += 1;
        // The old size and mtime stay, so the next scan reads it again.
        return row === undefined ? null : { path: file.path, size: row.size, mtimeMs: row.mtimeMs, md5: row.md5 };
      }
    }));
    unwritten = [...unwritten, ...results.filter((row) => row !== null)];
    if (unwritten.length >= WRITE_EVERY) {
      writeAll(unwritten);
      unwritten = [];
    }
    onProgress({ phase: "hashing", done: Math.min(files.length, start + READ_AHEAD), total: files.length, hashed: counts.hashed });
  }
  writeAll(unwritten);
  if (!counts.stopped) {
    // Files moved away or deleted since, and folders no longer checked.
    counts.removed = removeUnseen(db, scanId, unreadable);
  }
  return counts;
};

// md5 -> one path that has it.
const md5Paths = (db) => new Map(db.prepare("SELECT md5, MIN(path) AS path FROM files GROUP BY md5").all().map((row) => [row.md5, row.path]));

// A file whose name holds an md5 (32 hex digits standing alone) -> that
// md5. When a picture is saved from QQ's collection viewer, QQ writes a
// re-compressed JPEG (same pixel size, different bytes) but names it after
// the original's md5, so the name is the only link left (seen on 110 of the
// user's files); this tool's own saves carry it too.
const NAME_MD5 = /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/iu;

const nameMd5Paths = (db) => {
  const found = new Map();
  for (const { path: filePath } of db.prepare("SELECT path FROM files ORDER BY path").all()) {
    const match = NAME_MD5.exec(path.basename(filePath));
    if (match !== null && !found.has(match[1].toLowerCase())) {
      found.set(match[1].toLowerCase(), filePath);
    }
  }
  return found;
};

// A file the tool just saved: counts before the next scan.
const recordFile = (db, filePath, md5) => {
  const stat = fs.statSync(filePath);
  const scanId = db.prepare("SELECT MAX(scan_id) AS id FROM files").get().id ?? 0;
  db.prepare(`
    INSERT INTO files (path, size, mtime_ms, md5, scan_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, md5 = excluded.md5
  `).run(filePath, stat.size, Math.round(stat.mtimeMs), md5, scanId);
};

const indexedFileCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM files").get().n;

module.exports = { openIndex, scanFolders, md5Paths, nameMd5Paths, recordFile, indexedFileCount, PICTURE_FILE };
