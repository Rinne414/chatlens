"use strict";

// Fingerprints of the stored pictures (src/picture_hash.js) and what they are
// for: finding a picture again when it was posted as a different file
// (re-compressed, re-saved, a screenshot of it), and searching by picture.
// A fingerprint is made from the thumbnail (or the preview) already on disk;
// nothing is downloaded for it. Animated pictures and pictures of one flat
// colour get none.

const fs = require("node:fs");
const { decodeGray, UnsupportedImage } = require("./image_pixels");
const { hashOfGray, halves, distanceOfHalves, SIZE } = require("./picture_hash");
const { picturePath } = require("./picture_store");

// Bits apart (of 64). Measured on 6,000 thumbnails (2026-11-23): a picture's
// own thumbnail and preview are 0-2 apart (6 at most); different files 0-2
// apart were the same picture every time; from 8 on different pictures mix in.
const SAME_BITS = 2;
const CLOSE_BITS = 6;
const SEARCH_BITS = 10;
const HEX = /^[0-9a-f]{16}$/u;

const SCHEMA = [
  // state: '' = has a fingerprint; flat / unsupported / unreadable = has none,
  // and why; missing = its file was not on disk (looked at again once the
  // picture's files change).
  `CREATE TABLE IF NOT EXISTS picture_hashes (
    md5 TEXT PRIMARY KEY,
    hash TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    hashed_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
];

const ensureHashSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const hasHashes = (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'picture_hashes'").get() !== undefined;

/* ---------- making them ---------- */

// The fingerprint of one image file's bytes: { hash } or { state }.
const fingerprintOf = (bytes) => {
  try {
    const hash = hashOfGray(decodeGray(bytes));
    return hash === null ? { state: "flat" } : { hash };
  } catch (error) {
    return { state: error instanceof UnsupportedImage ? "unsupported" : "unreadable" };
  }
};

// For a picture of the user's own: the page shrinks it to SIZE x SIZE grey
// values itself (the same area average), so the picture never leaves the page.
const fingerprintOfSmallGray = (base64) => {
  const gray = Buffer.from(String(base64 ?? ""), "base64");
  if (gray.length !== SIZE * SIZE) {
    return { state: "unreadable" };
  }
  const hash = hashOfGray({ width: SIZE, height: SIZE, gray });
  return hash === null ? { state: "flat" } : { hash };
};

const fileFor = (storeDir, row) => {
  for (const kind of ["thumb", "preview"]) {
    const name = row[kind];
    const ext = /\.([a-z0-9]{2,5})$/u.exec(name)?.[1];
    if (name !== "" && ext !== undefined) {
      const target = picturePath(storeDir, kind, row.md5, ext);
      if (fs.existsSync(target)) {
        return target;
      }
    }
  }
  return null;
};

// Has a local file and no answer yet (or one from before its files changed).
const PENDING = `(f.thumb <> '' OR f.preview <> '')
  AND NOT EXISTS (SELECT 1 FROM picture_hashes h WHERE h.md5 = f.md5 AND NOT (h.state = 'missing' AND f.updated_at > h.hashed_at))`;

const pendingCount = (db) => db.prepare(`SELECT COUNT(*) AS n FROM picture_files f WHERE ${PENDING}`).get().n;

// Fingerprints pictures that have a local file and none yet, newest first,
// until `limit` are done or `deadline()` says time is up.
const hashPending = (db, storeDir, { limit, deadline = () => false, nowUnix }) => {
  ensureHashSchema(db);
  const rows = db.prepare(`
    SELECT f.md5, f.thumb, f.preview FROM picture_files f
    WHERE ${PENDING}
    ORDER BY f.updated_at DESC LIMIT ?
  `).all(limit);
  const save = db.prepare("INSERT OR REPLACE INTO picture_hashes (md5, hash, state, hashed_at) VALUES (?, ?, ?, ?)");
  const outcome = { hashed: 0, flat: 0, unsupported: 0, unreadable: 0, missing: 0, skipped: 0 };
  for (const row of rows) {
    if (deadline()) {
      break;
    }
    const file = fileFor(storeDir, row);
    let bytes = null;
    if (file !== null) {
      try {
        bytes = fs.readFileSync(file);
      } catch {
        // Locked or busy right now (a virus scanner, a copy in progress): no
        // answer is written, so it is tried again on the next refresh.
        outcome.skipped += 1;
        continue;
      }
    }
    const result = bytes === null ? { state: "missing" } : fingerprintOf(bytes);
    save.run(row.md5, result.hash ?? "", result.state ?? "", nowUnix);
    outcome[result.hash === undefined ? result.state : "hashed"] += 1;
  }
  return { ...outcome, left: pendingCount(db) };
};

/* ---------- looking things up ---------- */

// Every fingerprint in memory: md5s[i] has halves hi[i], lo[i].
const loadIndex = (db) => {
  if (!hasHashes(db)) {
    return { md5s: [], hi: new Uint32Array(0), lo: new Uint32Array(0) };
  }
  const rows = db.prepare("SELECT md5, hash FROM picture_hashes WHERE hash <> ''").all();
  const hi = new Uint32Array(rows.length);
  const lo = new Uint32Array(rows.length);
  rows.forEach((row, index) => {
    [hi[index], lo[index]] = halves(row.hash);
  });
  return { md5s: rows.map((row) => row.md5), hi, lo };
};

// What changes when the index would: asked before reusing a loaded one.
const indexStamp = (db) => (hasHashes(db)
  ? JSON.stringify(db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(hashed_at), 0) AS at FROM picture_hashes").get())
  : "none");

// The pictures at most maxBits from `hash`, closest first: [{ md5, bits }].
const nearest = (index, hash, { maxBits = SEARCH_BITS, excludeMd5 = "" } = {}) => {
  if (!HEX.test(String(hash))) {
    return [];
  }
  const wanted = halves(hash);
  const found = [];
  for (let position = 0; position < index.md5s.length; position += 1) {
    const bits = distanceOfHalves(wanted, [index.hi[position], index.lo[position]]);
    if (bits <= maxBits && index.md5s[position] !== excludeMd5) {
      found.push({ md5: index.md5s[position], bits });
    }
  }
  return found.sort((left, right) => left.bits - right.bits || left.md5.localeCompare(right.md5));
};

// { hash, state } for a stored picture; null when it was never looked at.
const hashOfMd5 = (db, md5) => (hasHashes(db) ? db.prepare("SELECT hash, state FROM picture_hashes WHERE md5 = ?").get(md5) ?? null : null);

const closeness = (bits) => (bits <= SAME_BITS ? "same" : bits <= CLOSE_BITS ? "close" : "alike");

const coverage = (db) => {
  if (!hasHashes(db)) {
    return { hashed: 0, left: 0 };
  }
  return { hashed: db.prepare("SELECT COUNT(*) AS n FROM picture_hashes WHERE hash <> ''").get().n, left: pendingCount(db) };
};

module.exports = {
  ensureHashSchema,
  fingerprintOf,
  fingerprintOfSmallGray,
  hashPending,
  loadIndex,
  indexStamp,
  nearest,
  hashOfMd5,
  closeness,
  coverage,
  SAME_BITS,
  CLOSE_BITS,
  SEARCH_BITS,
  HEX,
};
