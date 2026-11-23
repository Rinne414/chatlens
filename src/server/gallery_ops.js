"use strict";

// HTTP side of 画廊 (src/gallery_store.js). Each request opens its own
// read-only connection to messages.db and attaches knowledge.db read-only
// (an attached database inherits the connection's read-only flag), so a
// browse can never write to either store or wait on the refresh's writes.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const state = require("./toolkit_state");
const gallery = require("../gallery_store");
const pictureService = require("./picture_service");
const { removedDirFor } = require("../media_removed");
const similar = require("../picture_similar");

const storePath = () => path.join(state.toolRoot, "store", "messages.db");
const knowledgePath = () => path.join(state.toolRoot, "store", "knowledge.db");

const withReadOnlyStore = (work) => {
  const db = new Database(storePath(), { readonly: true, fileMustExist: true });
  // The gallery's working tables (a few MB) stay in memory: on disk the
  // sidebar counts took three times as long.
  db.pragma("temp_store = MEMORY");
  try {
    if (fs.existsSync(knowledgePath())) {
      db.prepare("ATTACH DATABASE ? AS kb").run(knowledgePath());
    }
    return work(db);
  } finally {
    db.close();
  }
};

const nowUnix = () => Math.floor(Date.now() / 1000);

// `days` (0 = everything recorded) or an explicit fromUnix/toUnix pair.
const rangeFrom = (params) => {
  const from = Number(params.get("fromUnix"));
  const to = Number(params.get("toUnix"));
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) {
    return { fromUnix: from, toUnix: to };
  }
  const days = Number.parseInt(params.get("days") ?? "7", 10);
  if (days === 0) {
    return { fromUnix: 0, toUnix: nowUnix() + 60 };
  }
  return gallery.rangeForDays(Number.isInteger(days) && days > 0 ? days : 7, nowUnix());
};

const filterFrom = (params) => ({
  ...rangeFrom(params),
  groupId: /^\d+$/u.test(params.get("groupId") ?? "") ? params.get("groupId") : "",
  sender: String(params.get("sender") ?? "").slice(0, 80),
  kind: params.get("kind") ?? "images",
  ai: params.get("ai") === "1",
  q: String(params.get("q") ?? "").slice(0, 200),
  shape: params.get("shape") ?? "",
  size: params.get("size") ?? "",
  prompt: params.get("prompt") === "1",
  asked: params.get("asked") === "1",
  file: params.get("file") === "1",
  kept: params.get("kept") === "1",
  unsaved: params.get("unsaved") === "1",
  why: params.get("why") ?? "",
  removed: params.get("removed") === "1",
});

const list = (params) => withReadOnlyStore((db) => gallery.listPictures(db, {
  ...filterFrom(params),
  sort: params.get("sort") ?? "recent",
  limit: params.get("limit"),
  offset: params.get("offset"),
}));

const days = (params) => withReadOnlyStore((db) => ({ days: gallery.pictureDays(db, filterFrom(params)) }));

// The counts change only when a store file does (new pictures, a keep, the
// prompt library): until then the same question gets the same answer at once.
const FACET_CACHE_SIZE = 24;
const SLIDING_WINDOW_CACHE_MS = 10 * 60 * 1000;
const facetCache = new Map();

const fileStamp = (file) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
};

// Pictures only ever get added; a file row changes the counts when it is
// kept, removed or found to be an AI picture.
const storeStamp = () => {
  const pictures = withReadOnlyStore((db) => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('picture_files')").all().map((column) => column.name);
    const removed = columns.includes("removed") ? "COALESCE(SUM(removed), 0)" : "0";
    // Saving a picture out changes the 「还没存过」 count.
    const saves = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'picture_saves'").get() === undefined
      ? "0"
      : "(SELECT COUNT(*) FROM picture_saves)";
    return db.prepare(`
      SELECT (SELECT COUNT(*) FROM pictures) AS postings, (SELECT COALESCE(MAX(rowid), 0) FROM pictures) AS newest,
             (SELECT COUNT(*) || ':' || COALESCE(SUM(kept), 0) || ':' || ${removed} || ':' || COALESCE(SUM(probe = 'ai'), 0) FROM picture_files) AS files,
             ${saves} AS saves
    `).get();
  });
  return JSON.stringify([pictures, fileStamp(knowledgePath()), fileStamp(`${knowledgePath()}-wal`)]);
};

const facets = (params) => {
  const filter = filterFrom(params);
  // A range of the last N days moves with the clock, so its answer is kept
  // ten minutes; all time and fixed ranges do not move.
  const days = Number.parseInt(params.get("days") ?? "7", 10);
  const moves = !(params.has("fromUnix") && params.has("toUnix")) && days !== 0;
  const key = JSON.stringify([params.toString(), moves ? Math.floor(Date.now() / SLIDING_WINDOW_CACHE_MS) : 0]);
  const stamp = storeStamp();
  const cached = facetCache.get(key);
  if (cached !== undefined && cached.stamp === stamp) {
    return cached.result;
  }
  const result = withReadOnlyStore((db) => gallery.galleryFacets(db, filter));
  facetCache.delete(key);
  facetCache.set(key, { stamp, result });
  if (facetCache.size > FACET_CACHE_SIZE) {
    facetCache.delete(facetCache.keys().next().value);
  }
  return result;
};

/* ---------- picture fingerprints (src/picture_similar.js) ---------- */

// All fingerprints stay loaded between requests; they are read again only
// after new ones were made.
const fingerprints = { stamp: null, index: null };
const fingerprintIndex = (db) => {
  const stamp = similar.indexStamp(db);
  if (fingerprints.stamp !== stamp) {
    fingerprints.index = similar.loadIndex(db);
    fingerprints.stamp = stamp;
  }
  return fingerprints.index;
};

// The picture's story: every posting of every file that is the same picture
// (the file itself included), oldest first. null when it has no fingerprint.
const storyOf = (db, md5) => {
  const own = similar.hashOfMd5(db, md5);
  if (own === null || own.hash === "") {
    return null;
  }
  const close = similar.nearest(fingerprintIndex(db), own.hash, { maxBits: similar.SAME_BITS }).map((item) => item.md5);
  const shapes = new Map(gallery.picturesByMd5(db, [md5, ...close]).map((item) => [item.md5, item]));
  const others = close.filter((other) => other !== md5 && sameShape(shapes.get(md5), shapes.get(other)));
  return others.length === 0 ? { files: 1, postings: [] } : { files: others.length + 1, postings: gallery.postingsOf(db, [md5, ...others]) };
};

// A fingerprint match alone was wrong for about 1 pair in 200 (measured on
// 578 pairs); the same picture as another file also keeps its proportions.
const SHAPE_TOLERANCE = 0.04;
const sameShape = (left, right) => {
  if (!left || !right || !(left.width > 0 && left.height > 0 && right.width > 0 && right.height > 0)) {
    return true;
  }
  const ratio = (left.width / left.height) / (right.width / right.height);
  return Math.abs(ratio - 1) <= SHAPE_TOLERANCE;
};

const detail = (params) => withReadOnlyStore((db) => {
  const md5 = String(params.get("md5") ?? "").toLowerCase();
  const picture = gallery.pictureDetail(db, md5);
  return picture === null ? null : { ...picture, story: storyOf(db, md5) };
});

const SIMILAR_LIMIT = 1000;

// Pictures that look like one already stored (md5) or like a fingerprint the
// page got for a picture of the user's (hash), closest first.
const similarPictures = (params) => withReadOnlyStore((db) => {
  const md5 = String(params.get("md5") ?? "").toLowerCase();
  const own = md5 === "" ? null : similar.hashOfMd5(db, md5);
  const hash = md5 === "" ? String(params.get("hash") ?? "").toLowerCase() : own?.hash ?? "";
  const coverage = similar.coverage(db);
  if (!similar.HEX.test(hash)) {
    // state: why this picture has no fingerprint ("" = not looked at yet).
    return { total: 0, items: [], coverage, noFingerprint: md5 === "" ? "bad-hash" : own?.state || "pending" };
  }
  const found = similar.nearest(fingerprintIndex(db), hash, { maxBits: similar.SEARCH_BITS });
  const bits = new Map(found.map((item) => [item.md5, item.bits]));
  const listed = gallery.picturesByMd5(db, found.slice(0, SIMILAR_LIMIT).map((item) => item.md5));
  const asked = listed.find((item) => item.md5 === md5);
  const items = listed.map((item) => {
    const closeness = similar.closeness(bits.get(item.md5));
    // "The same picture" also has to have the same proportions.
    return { ...item, closeness: closeness === "same" && !sameShape(asked, item) ? "close" : closeness, itself: item.md5 === md5 };
  });
  return { total: found.length, items, coverage, noFingerprint: null };
});

// What the removed originals really take on disk (some have no posting to
// read a size from); the folder is small next to the kept ones.
const folderBytes = (directory) => {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      bytes += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
    }
  }
  return bytes;
};

// The kept library's numbers plus where the files are and which rules are on.
const keptSummary = () => {
  const pictures = pictureService.settings();
  const summary = withReadOnlyStore((db) => gallery.keptSummary(db));
  const removedFolder = removedDirFor(pictureService.objectDir);
  return {
    ...summary,
    removed: { ...summary.removed, bytes: fs.existsSync(removedFolder) ? folderBytes(removedFolder) : 0 },
    folder: pictureService.objectDir,
    removedFolder: removedDirFor(pictureService.objectDir),
    rules: { keepAllGroups: pictures.keepAllGroups.length, keepAi: pictures.keepAi === true },
  };
};

const context = (params) => withReadOnlyStore((db) => gallery.messageContext(db, {
  groupId: params.get("groupId"),
  rowId: params.get("rowId"),
  sentAt: params.get("sentAt"),
}));

// Returns true when the request was one of ours.
const handleGalleryApi = (request, response, url, { sendJson, sendError }) => {
  if (request.method !== "GET") {
    return false;
  }
  const routes = { "/api/gallery": list, "/api/gallery/days": days, "/api/gallery/facets": facets, "/api/gallery/picture": detail, "/api/gallery/context": context, "/api/gallery/kept-summary": keptSummary, "/api/gallery/similar": similarPictures };
  const handler = routes[url.pathname];
  if (handler === undefined) {
    return false;
  }
  const result = handler(url.searchParams);
  if (result === null) {
    sendError(response, 404, "没有这张图的记录。");
  } else {
    sendJson(response, 200, result);
  }
  return true;
};

// The list and its facet counts over a long range (1-2 s measured on 20k+
// pictures) run in the read worker (read_worker.js); the query comes as a
// plain object there.
const HEAVY_ROUTES = { "/api/gallery": list, "/api/gallery/days": days, "/api/gallery/facets": facets, "/api/gallery/kept-summary": keptSummary };
const isHeavyGalleryRoute = (pathname) => Object.hasOwn(HEAVY_ROUTES, pathname);
const runHeavyGalleryQuery = (pathname, query) => HEAVY_ROUTES[pathname](new URLSearchParams(query));

// What the gallery asks for when it is first opened (web/gallery.js defaults).
const DEFAULT_VIEW_QUERY = { kind: "images", ai: "0", groupId: "", sender: "", days: "7" };
// The same over all time, which is also the slowest question the page asks.
const ALL_TIME_QUERY = { ...DEFAULT_VIEW_QUERY, days: "0" };

module.exports = { handleGalleryApi, withReadOnlyStore, isHeavyGalleryRoute, runHeavyGalleryQuery, DEFAULT_VIEW_QUERY, ALL_TIME_QUERY };
