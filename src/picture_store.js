"use strict";

// Group pictures recorded from message bodies (see picture_elements.js) and
// what the tool has fetched for each, in the message store (messages.db).
//
// pictures:      one row per picture per message (stickers are not stored).
//                row_id matches the media row in `messages` (m<rowId>).
// picture_files: one row per md5: which copies exist under store/pictures/
//                (thumb = Tencent's spec 198: 300px; preview = its spec 720, which is up
//                to 1280px and a PNG for a PNG, ~1.7 MB for AI pictures; cache = an
//                original kept only while the cache budget allows) and whether
//                the original was saved for good into store/media-objects.

const fs = require("node:fs");
const path = require("node:path");

// Tencent deletes a group picture 31 days after upload; nothing can fetch it
// after that, QQ included.
const REMOTE_LIFETIME_SECONDS = 31 * 24 * 3600;
const KINDS = new Set(["thumb", "preview", "cache"]);
const MD5 = /^[a-f0-9]{32}$/u;
const EXTENSION = /^[a-z0-9]{2,5}$/u;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pictures (
    group_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    md5 TEXT NOT NULL,
    file_id TEXT NOT NULL DEFAULT '',
    legacy_path TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    format INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, row_id, seq)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_pictures_md5 ON pictures(md5)",
  "CREATE INDEX IF NOT EXISTS idx_pictures_time ON pictures(sent_at)",
  "CREATE INDEX IF NOT EXISTS idx_pictures_expires ON pictures(expires_at)",
  `CREATE TABLE IF NOT EXISTS picture_files (
    md5 TEXT PRIMARY KEY,
    thumb TEXT NOT NULL DEFAULT '',
    thumb_bytes INTEGER NOT NULL DEFAULT 0,
    preview TEXT NOT NULL DEFAULT '',
    preview_bytes INTEGER NOT NULL DEFAULT 0,
    cache TEXT NOT NULL DEFAULT '',
    cache_bytes INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 0,
    probe TEXT NOT NULL DEFAULT '',
    gone INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    evicted INTEGER NOT NULL DEFAULT 0
  )`,
];

const ensurePictureSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  // Added after the table was first created by a pre-release run.
  const columns = db.prepare("PRAGMA table_info(picture_files)").all().map((column) => column.name);
  if (!columns.includes("evicted")) {
    db.prepare("ALTER TABLE picture_files ADD COLUMN evicted INTEGER NOT NULL DEFAULT 0").run();
  }
  return db;
};

const pictureRoot = (storeDir) => path.join(storeDir, "pictures");

// kind is thumb | preview | cache; the file name is <md5>.<ext>.
const picturePath = (storeDir, kind, md5, ext) => {
  if (!KINDS.has(kind) || !MD5.test(md5) || !EXTENSION.test(ext)) {
    throw new Error(`Invalid picture file: ${kind}/${md5}.${ext}`);
  }
  return path.join(pictureRoot(storeDir), kind, md5.slice(0, 2), `${md5}.${ext}`);
};

const ingestPictures = (db, rows) => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pictures (group_id, row_id, seq, md5, file_id, legacy_path, size, width, height, format, sent_at, expires_at)
    VALUES (@groupId, @rowId, @seq, @md5, @fileId, @legacyPath, @size, @width, @height, @format, @sentAt, @expiresAt)
  `);
  let inserted = 0;
  for (const row of rows) {
    inserted += insert.run({
      groupId: String(row.groupId),
      rowId: String(row.rowId),
      seq: row.seq,
      md5: row.md5,
      fileId: row.fileId ?? "",
      legacyPath: row.legacyPath ?? "",
      size: row.size ?? 0,
      width: row.width ?? 0,
      height: row.height ?? 0,
      format: row.format ?? 0,
      sentAt: row.sentAt,
      // Older bodies carry no expiry; upload + 31 days is what Tencent applies.
      expiresAt: row.expiresAt > 0 ? row.expiresAt : row.sentAt + REMOTE_LIFETIME_SECONDS,
    }).changes;
  }
  return inserted;
};

const fileRow = (db, md5) => db.prepare("SELECT * FROM picture_files WHERE md5 = ?").get(md5) ?? null;

const FILE_COLUMNS = new Set([
  "thumb", "thumb_bytes", "preview", "preview_bytes", "cache", "cache_bytes",
  "kept", "probe", "gone", "failures", "last_used", "evicted",
]);

const updateFile = (db, md5, patch, now = Math.floor(Date.now() / 1000)) => {
  const columns = Object.keys(patch).filter((column) => FILE_COLUMNS.has(column));
  db.prepare("INSERT OR IGNORE INTO picture_files (md5, updated_at) VALUES (?, ?)").run(md5, now);
  if (columns.length === 0) {
    return;
  }
  db.prepare(`UPDATE picture_files SET ${columns.map((column) => `${column} = @${column}`).join(", ")}, updated_at = @updatedAt WHERE md5 = @md5`)
    .run({ ...Object.fromEntries(columns.map((column) => [column, patch[column]])), md5, updatedAt: now });
};

// The newest sighting of an md5: its URL fields are the freshest (a repost
// re-uploads, so it expires later than the first post).
const locate = (db, md5) =>
  db.prepare(`
    SELECT md5, file_id AS fileId, legacy_path AS legacyPath, size, width, height, format,
           sent_at AS sentAt, expires_at AS expiresAt, group_id AS groupId, row_id AS rowId
    FROM pictures WHERE md5 = ? ORDER BY expires_at DESC LIMIT 1
  `).get(md5) ?? null;

// Distinct pictures still on Tencent's servers that match `where` (SQL over
// p = pictures, f = picture_files). With a single MAX() aggregate SQLite takes
// the bare columns from that row, so the URL fields are the newest upload's (a
// repost re-uploads and expires later). `order` may use the output aliases.
const liveCandidates = (db, { now, where, order, limit, params = {} }) =>
  db.prepare(`
    SELECT p.md5, p.file_id AS fileId, p.legacy_path AS legacyPath, p.size, p.width, p.height,
           p.format, p.sent_at AS sentAt, MAX(p.expires_at) AS expiresAt, p.group_id AS groupId, p.row_id AS rowId
    FROM pictures p
    LEFT JOIN picture_files f ON f.md5 = p.md5
    WHERE p.expires_at > @now
      AND COALESCE(f.gone, 0) = 0
      AND COALESCE(f.failures, 0) < 3
      AND (${where})
    GROUP BY p.md5
    ORDER BY ${order}
    LIMIT @limit
  `).all({ now, limit, ...params });

// Recent NT pictures (well before expiry) to test rkey candidates against.
const recentNt = (db, now, limit) =>
  db.prepare(`
    SELECT md5, file_id AS fileId FROM pictures
    WHERE file_id <> '' AND expires_at > ? ORDER BY sent_at DESC LIMIT ?
  `).all(now + 24 * 3600, limit);

// Every place an md5 was posted, with who posted it, for knowledge sightings.
const occurrences = (db, md5) =>
  db.prepare(`
    SELECT p.group_id AS groupId, p.row_id AS rowId, p.sent_at AS sentAt,
           COALESCE(m.speaker, '') AS speaker, COALESCE(m.speaker_uin, '') AS speakerUin,
           COALESCE(g.name, '') AS groupName
    FROM pictures p
    LEFT JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
    LEFT JOIN group_names g ON g.group_id = p.group_id
    WHERE p.md5 = ?
  `).all(md5);

// A thumbnail or preview cleared for space is not fetched again automatically
// (opening the picture still fetches it).
const THUMB_WANTED = "COALESCE(f.thumb, '') = '' AND COALESCE(f.evicted, 0) = 0";
const PREVIEW_WANTED = "f.probe = 'ai' AND COALESCE(f.preview, '') = '' AND COALESCE(f.evicted, 0) = 0";

const needingThumbs = (db, { now, limit }) =>
  liveCandidates(db, { now, limit, where: THUMB_WANTED, order: "sentAt DESC" });

// Newest first: when the budget runs short, the newest previews are kept.
const needingPreviews = (db, { now, limit }) =>
  liveCandidates(db, { now, limit, where: PREVIEW_WANTED, order: "sentAt DESC" });

// Big enough to be a generated image; measured: no smaller file carried a
// prompt. PNG (1001) from 256 KB, JPG/WebP (1000/1002) from 512 KB.
const PROBE_WHERE = `COALESCE(f.probe, '') = '' AND (
  (p.format = 1001 AND p.size >= 262144) OR (p.format IN (1000, 1002) AND p.size >= 524288))`;

// Closest to expiry first: those are the ones about to be lost.
const needingProbe = (db, { now, limit }) =>
  liveCandidates(db, { now, limit, where: PROBE_WHERE, order: "expiresAt ASC" });

const needingKeep = (db, { now, limit, groupIds }) => {
  if (groupIds.length === 0) {
    return [];
  }
  const placeholders = groupIds.map((_, index) => `@g${index}`).join(", ");
  return liveCandidates(db, {
    now,
    limit,
    where: `COALESCE(f.kept, 0) = 0 AND p.md5 IN (SELECT md5 FROM pictures WHERE group_id IN (${placeholders}))`,
    order: "expiresAt ASC",
    params: Object.fromEntries(groupIds.map((groupId, index) => [`g${index}`, String(groupId)])),
  });
};

// Pictures per media row for the chat view, in message order.
const picturesForRows = (db, groupId, rowIds) => {
  if (rowIds.length === 0) {
    return new Map();
  }
  const rows = db.prepare(`
    SELECT p.row_id AS rowId, p.seq, p.md5, p.width, p.height, p.size, p.format, p.expires_at AS expiresAt,
           COALESCE(f.thumb, '') <> '' AS hasThumb, COALESCE(f.kept, 0) AS kept, COALESCE(f.gone, 0) AS gone,
           COALESCE(f.probe, '') AS probe
    FROM pictures p LEFT JOIN picture_files f ON f.md5 = p.md5
    WHERE p.group_id = ? AND p.row_id IN (SELECT value FROM json_each(?))
    ORDER BY p.row_id, p.seq
  `).all(String(groupId), JSON.stringify(rowIds.map(String)));
  const byRow = new Map();
  for (const row of rows) {
    byRow.set(row.rowId, [...(byRow.get(row.rowId) ?? []), row]);
  }
  return byRow;
};

const usage = (db) =>
  db.prepare(`
    SELECT COUNT(CASE WHEN thumb <> '' THEN 1 END) AS thumbs,
           COALESCE(SUM(thumb_bytes), 0) AS thumbBytes,
           COUNT(CASE WHEN preview <> '' THEN 1 END) AS previews,
           COALESCE(SUM(preview_bytes), 0) AS previewBytes,
           COUNT(CASE WHEN cache <> '' THEN 1 END) AS cached,
           COALESCE(SUM(cache_bytes), 0) AS cacheBytes,
           COUNT(CASE WHEN kept = 1 THEN 1 END) AS kept,
           COUNT(CASE WHEN probe = 'ai' THEN 1 END) AS aiFound
    FROM picture_files
  `).get();

const keptBytes = (db) =>
  db.prepare(`
    SELECT COALESCE(SUM(size), 0) AS bytes FROM (
      SELECT MAX(p.size) AS size FROM picture_files f JOIN pictures p ON p.md5 = f.md5
      WHERE f.kept = 1 GROUP BY f.md5
    )
  `).get().bytes;

// AI pictures whose original is not saved for good, soonest expiry first.
const EXPIRING_AI_WHERE = "f.probe = 'ai' AND COALESCE(f.kept, 0) = 0";

const expiringAi = (db, { now, limit = 200 }) =>
  liveCandidates(db, { now, limit, where: EXPIRING_AI_WHERE, order: "expiresAt ASC" });

// How many there are in all (the list itself is capped), optionally only
// those Tencent deletes within `withinSeconds`.
const countExpiringAi = (db, { now, withinSeconds = null }) =>
  db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT MAX(p.expires_at) AS expiresAt
      FROM pictures p LEFT JOIN picture_files f ON f.md5 = p.md5
      WHERE p.expires_at > @now AND COALESCE(f.gone, 0) = 0 AND COALESCE(f.failures, 0) < 3 AND ${EXPIRING_AI_WHERE}
      GROUP BY p.md5
    ) WHERE expiresAt <= @until
  `).get({ now, until: withinSeconds === null ? Number.MAX_SAFE_INTEGER : now + withinSeconds }).n;

const pendingCounts = (db, now) => {
  const count = (where) =>
    db.prepare(`
      SELECT COUNT(DISTINCT p.md5) AS n FROM pictures p LEFT JOIN picture_files f ON f.md5 = p.md5
      WHERE p.expires_at > ? AND COALESCE(f.gone, 0) = 0 AND COALESCE(f.failures, 0) < 3 AND (${where})
    `).get(now).n;
  return { thumbs: count(THUMB_WANTED), probes: count(PROBE_WHERE), previews: count(PREVIEW_WANTED) };
};

// What to clear when over the budget, tier by tier: originals opened in the
// console, ordinary pictures' previews and thumbnails, AI previews, and last
// AI thumbnails. Within a tier the oldest picture goes first.
const EVICTION_TIERS = {
  cache: { kind: "cache", where: "f.cache <> ''" },
  "plain-preview": { kind: "preview", where: "f.preview <> '' AND f.probe <> 'ai'" },
  "plain-thumb": { kind: "thumb", where: "f.thumb <> '' AND f.probe <> 'ai'" },
  "ai-preview": { kind: "preview", where: "f.preview <> ''" },
  "ai-thumb": { kind: "thumb", where: "f.thumb <> ''" },
};

const evictionCandidates = (db, tier, limit) => {
  const { kind, where } = EVICTION_TIERS[tier];
  return db.prepare(`
    SELECT f.md5, f.${kind} AS name, f.${kind}_bytes AS bytes, '${kind}' AS kind
    FROM picture_files f
    WHERE ${where}
    ORDER BY (SELECT MAX(p.sent_at) FROM pictures p WHERE p.md5 = f.md5) ASC, f.last_used ASC
    LIMIT ?
  `).all(limit);
};

const removeFile = (storeDir, kind, md5, name) => {
  if (name === "") {
    return;
  }
  const ext = path.extname(name).slice(1);
  fs.rmSync(picturePath(storeDir, kind, md5, ext), { force: true });
};

module.exports = {
  REMOTE_LIFETIME_SECONDS,
  ensurePictureSchema,
  pictureRoot,
  picturePath,
  ingestPictures,
  fileRow,
  updateFile,
  locate,
  recentNt,
  occurrences,
  needingThumbs,
  needingPreviews,
  needingProbe,
  needingKeep,
  picturesForRows,
  usage,
  keptBytes,
  expiringAi,
  countExpiringAi,
  pendingCounts,
  EVICTION_TIERS,
  evictionCandidates,
  removeFile,
};
