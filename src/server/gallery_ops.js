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

const storePath = () => path.join(state.toolRoot, "store", "messages.db");
const knowledgePath = () => path.join(state.toolRoot, "store", "knowledge.db");

const withReadOnlyStore = (work) => {
  const db = new Database(storePath(), { readonly: true, fileMustExist: true });
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
});

const list = (params) => withReadOnlyStore((db) => gallery.listPictures(db, {
  ...filterFrom(params),
  sort: params.get("sort") ?? "recent",
  limit: params.get("limit"),
  offset: params.get("offset"),
}));

const facets = (params) => withReadOnlyStore((db) => gallery.galleryFacets(db, filterFrom(params)));

const detail = (params) => withReadOnlyStore((db) => gallery.pictureDetail(db, String(params.get("md5") ?? "").toLowerCase()));

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
  const routes = { "/api/gallery": list, "/api/gallery/facets": facets, "/api/gallery/picture": detail, "/api/gallery/context": context };
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

module.exports = { handleGalleryApi, withReadOnlyStore };
