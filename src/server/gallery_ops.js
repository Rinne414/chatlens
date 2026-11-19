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
  why: params.get("why") ?? "",
  removed: params.get("removed") === "1",
});

const list = (params) => withReadOnlyStore((db) => gallery.listPictures(db, {
  ...filterFrom(params),
  sort: params.get("sort") ?? "recent",
  limit: params.get("limit"),
  offset: params.get("offset"),
}));

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
    return db.prepare(`
      SELECT (SELECT COUNT(*) FROM pictures) AS postings, (SELECT COALESCE(MAX(rowid), 0) FROM pictures) AS newest,
             (SELECT COUNT(*) || ':' || COALESCE(SUM(kept), 0) || ':' || ${removed} || ':' || COALESCE(SUM(probe = 'ai'), 0) FROM picture_files) AS files
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

const detail = (params) => withReadOnlyStore((db) => gallery.pictureDetail(db, String(params.get("md5") ?? "").toLowerCase()));

// The kept library's numbers plus where the files are and which rules are on.
const keptSummary = () => {
  const pictures = pictureService.settings();
  return {
    ...withReadOnlyStore((db) => gallery.keptSummary(db)),
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
  const routes = { "/api/gallery": list, "/api/gallery/facets": facets, "/api/gallery/picture": detail, "/api/gallery/context": context, "/api/gallery/kept-summary": keptSummary };
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
const HEAVY_ROUTES = { "/api/gallery": list, "/api/gallery/facets": facets, "/api/gallery/kept-summary": keptSummary };
const isHeavyGalleryRoute = (pathname) => Object.hasOwn(HEAVY_ROUTES, pathname);
const runHeavyGalleryQuery = (pathname, query) => HEAVY_ROUTES[pathname](new URLSearchParams(query));

// What the gallery asks for when it is first opened (web/gallery.js defaults).
const DEFAULT_VIEW_QUERY = { kind: "images", ai: "0", groupId: "", sender: "", days: "7" };
// The same over all time, which is also the slowest question the page asks.
const ALL_TIME_QUERY = { ...DEFAULT_VIEW_QUERY, days: "0" };

module.exports = { handleGalleryApi, withReadOnlyStore, isHeavyGalleryRoute, runHeavyGalleryQuery, DEFAULT_VIEW_QUERY, ALL_TIME_QUERY };
