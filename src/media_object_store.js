"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PARSER_VERSION, parseAiMetadata } = require("./ai_metadata");
const {
  attachMediaObject,
  markScanned,
  openKnowledgeStore,
  recordSighting,
  upsertImage,
} = require("./knowledge_store");

const HASH_PATTERN = /^[a-f0-9]{32}$/u;
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".heic",
]);
const HASH_BUFFER_BYTES = 1024 * 1024;

class MediaObjectIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaObjectIntegrityError";
  }
}

const ensurePath = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty path.`);
  }
  return path.resolve(value);
};

const normalizeHash = (value) => {
  const hash = String(value ?? "").toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new TypeError(`Media hash must be 32 lowercase hexadecimal characters. hash=${hash}`);
  }
  return hash;
};

const hashFileMd5 = (filePath) => {
  const descriptor = fs.openSync(filePath, "r");
  const hash = crypto.createHash("md5");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
};

const objectDirectoryFor = (objectDir, hash) => path.join(objectDir, hash.slice(0, 2));

const findExistingMediaObject = (objectDir, hash) => {
  const directoryPath = objectDirectoryFor(objectDir, hash);
  if (!fs.existsSync(directoryPath)) {
    return null;
  }
  const matches = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith(`${hash}.`))
    .map((name) => path.join(directoryPath, name))
    .sort();
  if (matches.length === 0) {
    return null;
  }
  const objectPath = matches[0];
  const actualHash = hashFileMd5(objectPath);
  if (actualHash !== hash) {
    throw new MediaObjectIntegrityError(
      `Persistent media object failed integrity validation. Path=${objectPath} ExpectedMd5=${hash} ActualMd5=${actualHash}`,
    );
  }
  return objectPath;
};

const persistMediaObject = (sourcePathValue, objectDirValue, hashValue) => {
  const sourcePath = ensurePath(sourcePathValue, "sourcePath");
  const objectDir = ensurePath(objectDirValue, "objectDir");
  const hash = normalizeHash(hashValue);
  const existing = findExistingMediaObject(objectDir, hash);
  if (existing !== null) {
    return { objectPath: existing, status: "reused" };
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Media source file does not exist. Path=${sourcePath}`);
  }
  const extension = path.extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { objectPath: null, status: "unsupported-extension" };
  }
  const actualHash = hashFileMd5(sourcePath);
  if (actualHash !== hash) {
    return { objectPath: null, status: "hash-mismatch", actualHash };
  }

  const directoryPath = objectDirectoryFor(objectDir, hash);
  const objectPath = path.join(directoryPath, `${hash}${extension}`);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.copyFileSync(sourcePath, objectPath, fs.constants.COPYFILE_EXCL);
  const storedHash = hashFileMd5(objectPath);
  if (storedHash !== hash) {
    fs.rmSync(objectPath, { force: true });
    throw new MediaObjectIntegrityError(
      `Persistent media copy failed integrity validation. Path=${objectPath} ExpectedMd5=${hash} ActualMd5=${storedHash}`,
    );
  }
  return { objectPath, status: "stored" };
};

// Ori holds the untouched original; Thumb is QQ's re-encode and never carries
// metadata. Both are named by the md5 of the ORIGINAL, so the same hash locates
// either -- but only Ori is worth copying into media-objects.
//
// One directory listing per month, reused across every hash in a harvest.
const buildOriIndex = (ntDataDir) => {
  const picRoot = path.join(ntDataDir, "Pic");
  const byHash = new Map();
  let months;
  try {
    months = fs.readdirSync(picRoot, { withFileTypes: true });
  } catch {
    return byHash;
  }
  for (const month of months) {
    if (!month.isDirectory()) {
      continue;
    }
    const oriDir = path.join(picRoot, month.name, "Ori");
    let names;
    try {
      names = fs.readdirSync(oriDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.toLowerCase().match(/^([a-f0-9]{32})\./u);
      if (match !== null && !byHash.has(match[1])) {
        byHash.set(match[1], path.join(oriDir, name));
      }
    }
  }
  return byHash;
};

const ORIGINAL_CACHE_PATH = /[/\\]ori[/\\]/iu;

const isOriginalCachePath = (filePath) =>
  typeof filePath === "string" && ORIGINAL_CACHE_PATH.test(filePath);

const ATTACH_BATCH = 50;

// File copies stay outside the harvest transaction so a slow copy does not hold
// the knowledge-base lock. Only Ori paths belong in sourceByHash; a hash
// mismatch is counted, not thrown, so a corrupt cache slot cannot abort
// attribution. Attach in batches so a long backfill still records object_path
// if the process is interrupted.
const persistOriginalsForHashes = ({ hashes, sourceByHash, objectDir, db, onProgress }) => {
  const stats = { durableStored: 0, durableReused: 0, durableFailed: 0 };
  const attached = [];
  const existingPath = db.prepare("SELECT object_path AS objectPath FROM images WHERE hash = ?");
  const flushAttached = () => {
    if (attached.length === 0) {
      return;
    }
    const batch = attached.splice(0, attached.length);
    db.transaction(() => {
      for (const item of batch) {
        attachMediaObject(db, item);
      }
    })();
  };
  const report = () => {
    if (typeof onProgress === "function") {
      onProgress({ ...stats });
    }
  };
  let processed = 0;
  for (const hash of hashes) {
    const sourcePath = sourceByHash.get(hash);
    if (sourcePath === undefined) {
      continue;
    }
    const already = existingPath.get(hash)?.objectPath ?? "";
    if (already !== "" && fs.existsSync(already)) {
      stats.durableReused += 1;
      processed += 1;
      if (processed % ATTACH_BATCH === 0) {
        report();
      }
      continue;
    }
    try {
      const persisted = persistMediaObject(sourcePath, objectDir, hash);
      if (persisted.objectPath === null) {
        stats.durableFailed += 1;
      } else {
        if (persisted.status === "stored") {
          stats.durableStored += 1;
        } else {
          stats.durableReused += 1;
        }
        attached.push({ hash, objectPath: persisted.objectPath });
        if (attached.length >= ATTACH_BATCH) {
          flushAttached();
        }
      }
    } catch {
      stats.durableFailed += 1;
    }
    processed += 1;
    if (processed % ATTACH_BATCH === 0) {
      report();
    }
  }
  flushAttached();
  report();
  return stats;
};

// Historical harvest wrote file_path to Ori but did not copy into
// media-objects. Live harvest only copies the current export, so this is the
// path that protects already-harvested rows before QQ evicts the cache.
const backfillHarvestedMediaObjects = (args) => {
  const knowledgeStorePath = ensurePath(args.knowledgeStorePath, "knowledgeStorePath");
  const objectDir = ensurePath(args.objectDir, "objectDir");
  const ntDataDir = typeof args.ntDataDir === "string" && args.ntDataDir.trim() !== ""
    ? ensurePath(args.ntDataDir, "ntDataDir")
    : "";
  const db = openKnowledgeStore(knowledgeStorePath);
  try {
    const rows = db.prepare(`
      SELECT hash, file_path AS filePath, object_path AS objectPath
      FROM images
    `).all();
    const needed = [];
    for (const row of rows) {
      if (typeof row.objectPath === "string" && row.objectPath !== "" && fs.existsSync(row.objectPath)) {
        continue;
      }
      needed.push(row);
    }
    const oriIndex = ntDataDir === "" ? new Map() : buildOriIndex(ntDataDir);
    const sourceByHash = new Map();
    for (const row of needed) {
      const fromIndex = oriIndex.get(row.hash);
      if (fromIndex !== undefined) {
        sourceByHash.set(row.hash, fromIndex);
        continue;
      }
      if (isOriginalCachePath(row.filePath) && fs.existsSync(row.filePath)) {
        sourceByHash.set(row.hash, row.filePath);
      }
    }
    const persisted = persistOriginalsForHashes({
      hashes: needed.map((row) => row.hash),
      sourceByHash,
      objectDir,
      db,
      onProgress: args.onProgress,
    });
    return {
      needed: needed.length,
      candidates: sourceByHash.size,
      durableStored: persisted.durableStored,
      durableReused: persisted.durableReused,
      durableFailed: persisted.durableFailed,
    };
  } finally {
    db.close();
  }
};

const readManifest = (manifestPathValue) => {
  const manifestPath = ensurePath(manifestPathValue, "manifestPath");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new SyntaxError(`Unable to read media manifest. Path=${manifestPath} Cause=${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`Media manifest must contain an array. Path=${manifestPath}`);
  }
  return { manifestPath, entries: parsed };
};

const imageEntriesByHash = (entries) => {
  const grouped = new Map();
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.kind !== "image") {
      continue;
    }
    const hash = String(entry.hash ?? "").toLowerCase();
    if (!HASH_PATTERN.test(hash)) {
      continue;
    }
    const values = grouped.get(hash) ?? [];
    values.push({ index, entry });
    grouped.set(hash, values);
  }
  return grouped;
};

const resolveCopiedPath = (toolRoot, entry) => {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  if (typeof entry.copiedPath !== "string" || entry.copiedPath.trim() === "") {
    return null;
  }
  const copiedPath = path.isAbsolute(entry.copiedPath)
    ? path.resolve(entry.copiedPath)
    : path.resolve(toolRoot, entry.copiedPath);
  return fs.existsSync(copiedPath) && fs.statSync(copiedPath).isFile() ? copiedPath : null;
};

const entrySighting = (entry, hash) => ({
  hash,
  groupId: String(entry.groupId ?? ""),
  rowId: String(entry.rowId ?? ""),
  sentAt: Number(entry.sentAt ?? 0),
  speaker: String(entry.speaker ?? ""),
  speakerUin: String(entry.speakerUin ?? ""),
  groupName: String(entry.groupName ?? ""),
});

const parsedImageRecord = (hash, parsed, stat, parsedAt) => ({
  ...parsed,
  hash,
  filePath: "",
  fileMtime: Math.floor(stat.mtimeMs / 1000),
  parsedAt,
});

const applyKnowledgeObjects = (db, objects) => {
  const getImage = db.prepare("SELECT hash, generator FROM images WHERE hash = ?");
  const stats = { attached: 0, upgraded: 0, discovered: 0 };
  const applyAll = db.transaction(() => {
    for (const object of objects) {
      const stat = fs.statSync(object.objectPath);
      const parsedAt = Math.floor(Date.now() / 1000);
      const parsed = object.parsed ?? parseAiMetadata(object.objectPath, stat.size);
      const existing = getImage.get(object.hash);
      if (existing === undefined && parsed.generator !== "unknown") {
        upsertImage(db, parsedImageRecord(object.hash, parsed, stat, parsedAt));
        stats.discovered += 1;
      } else if (existing?.generator === "stripped" && parsed.generator !== "unknown") {
        upsertImage(db, parsedImageRecord(object.hash, parsed, stat, parsedAt));
        stats.upgraded += 1;
      }

      if (getImage.get(object.hash) === undefined) {
        continue;
      }
      attachMediaObject(db, { hash: object.hash, objectPath: object.objectPath });
      markScanned(db, {
        filePath: object.objectPath,
        fileSize: stat.size,
        fileMtime: Math.floor(stat.mtimeMs / 1000),
        parserVersion: PARSER_VERSION,
        outcome: parsed.generator === "unknown" ? "no-metadata" : parsed.generator,
        scannedAt: parsedAt,
      });
      const sighting = entrySighting(object.entry, object.hash);
      if (sighting.groupId !== "" && sighting.rowId !== "") {
        recordSighting(db, sighting);
      }
      stats.attached += 1;
    }
  });
  applyAll();
  return stats;
};

const synchronizeEntries = (args, entries) => {
  const toolRoot = ensurePath(args.toolRoot, "toolRoot");
  const objectDir = ensurePath(args.objectDir, "objectDir");
  const knowledgeStorePath = ensurePath(args.knowledgeStorePath, "knowledgeStorePath");
  const db = openKnowledgeStore(knowledgeStorePath);
  try {
    const knownRows = new Map(db.prepare("SELECT hash, generator FROM images").all().map((row) => [row.hash, row]));
    const grouped = imageEntriesByHash(entries);
    const objectResults = new Map();
    const knowledgeObjects = [];
    const stats = {
      imageHashes: grouped.size,
      stored: 0,
      reused: 0,
      skippedUntracked: 0,
      sourceMissing: 0,
      integrityRejected: 0,
    };

    for (const [hash, occurrences] of grouped) {
      const known = knownRows.has(hash);
      const existingObject = findExistingMediaObject(objectDir, hash);
      const sourceEntry = occurrences.find(({ entry }) => resolveCopiedPath(toolRoot, entry) !== null) ?? occurrences[0];
      const copiedPath = resolveCopiedPath(toolRoot, sourceEntry.entry);
      let parsed = null;

      if (!known && existingObject === null) {
        if (sourceEntry.entry.remoteStatus !== "downloaded" || copiedPath === null) {
          stats.skippedUntracked += 1;
          objectResults.set(hash, { objectPath: null, objectStatus: "untracked" });
          continue;
        }
        const actualHash = hashFileMd5(copiedPath);
        if (actualHash !== hash) {
          stats.integrityRejected += 1;
          objectResults.set(hash, { objectPath: null, objectStatus: "hash-mismatch", actualHash });
          continue;
        }
        const stat = fs.statSync(copiedPath);
        parsed = parseAiMetadata(copiedPath, stat.size);
        if (parsed.generator === "unknown") {
          stats.skippedUntracked += 1;
          objectResults.set(hash, { objectPath: null, objectStatus: "untracked" });
          continue;
        }
      }

      if (existingObject === null && copiedPath === null) {
        stats.sourceMissing += 1;
        objectResults.set(hash, { objectPath: null, objectStatus: "source-missing" });
        continue;
      }

      const persisted = existingObject === null
        ? persistMediaObject(copiedPath, objectDir, hash)
        : { objectPath: existingObject, status: "reused" };
      if (persisted.objectPath === null) {
        stats.integrityRejected += 1;
        objectResults.set(hash, {
          objectPath: null,
          objectStatus: persisted.status,
          actualHash: persisted.actualHash,
        });
        continue;
      }
      stats[persisted.status] += 1;
      objectResults.set(hash, { objectPath: persisted.objectPath, objectStatus: persisted.status });
      knowledgeObjects.push({
        hash,
        objectPath: persisted.objectPath,
        entry: sourceEntry.entry,
        parsed,
      });
    }

    const knowledge = applyKnowledgeObjects(db, knowledgeObjects);
    return { stats: { ...stats, ...knowledge }, objectResults };
  } finally {
    db.close();
  }
};

const updatedManifestEntries = (entries, objectResults) => entries.map((entry) => {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }
  const hash = String(entry.hash ?? "").toLowerCase();
  const result = objectResults.get(hash);
  return result === undefined ? entry : { ...entry, ...result };
});

const synchronizeManifestMedia = (args) => {
  const { manifestPath, entries } = readManifest(args.manifestPath);
  const result = synchronizeEntries(args, entries);
  fs.writeFileSync(manifestPath, JSON.stringify(updatedManifestEntries(entries, result.objectResults), null, 2), "utf8");
  return result.stats;
};

const backfillMissingMediaObjects = (args) => {
  const toolRoot = ensurePath(args.toolRoot, "toolRoot");
  const runsDir = ensurePath(args.runsDir, "runsDir");
  const knowledgeStorePath = ensurePath(args.knowledgeStorePath, "knowledgeStorePath");
  const db = openKnowledgeStore(knowledgeStorePath);
  const needed = new Set(db.prepare(`
    SELECT hash FROM images
    WHERE object_path = ''
  `).all().map((row) => row.hash));
  db.close();

  const selected = new Map();
  const runs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(runsDir, entry.name) }))
    .sort((left, right) => right.name.localeCompare(left.name));
  let manifestsRead = 0;
  for (const run of runs) {
    const manifestPath = path.join(run.path, "media", "media-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const { entries } = readManifest(manifestPath);
    manifestsRead += 1;
    for (const entry of entries) {
      const hash = String(entry?.hash ?? "").toLowerCase();
      if (!needed.has(hash) || selected.has(hash) || resolveCopiedPath(toolRoot, entry) === null) {
        continue;
      }
      selected.set(hash, entry);
    }
  }

  const result = synchronizeEntries(args, [...selected.values()]);
  return {
    ...result.stats,
    needed: needed.size,
    candidates: selected.size,
    manifestsRead,
  };
};

module.exports = {
  MediaObjectIntegrityError,
  backfillHarvestedMediaObjects,
  backfillMissingMediaObjects,
  buildOriIndex,
  findExistingMediaObject,
  hashFileMd5,
  persistMediaObject,
  persistOriginalsForHashes,
  synchronizeManifestMedia,
};
