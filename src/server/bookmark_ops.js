"use strict";

// 收藏 routes: list, save, remove, and the saved keys the pages use to fill
// their stars.

const state = require("./toolkit_state");
const store = require("../bookmark_store");

let schemaReady = false;
const db = () => {
  const handle = state.getStore();
  if (!schemaReady) {
    store.ensureBookmarkSchema(handle);
    schemaReady = true;
  }
  return handle;
};

const numberOrNull = (value) => (value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

const handleBookmarkApi = async (request, response, url, { sendJson, readBody }) => {
  if (request.method === "GET" && url.pathname === "/api/bookmarks") {
    sendJson(response, 200, store.listBookmarks(db(), {
      fromUnix: numberOrNull(url.searchParams.get("fromUnix")),
      toUnix: numberOrNull(url.searchParams.get("toUnix")),
      query: url.searchParams.get("q") ?? "",
      offset: Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    }));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/bookmarks/keys") {
    sendJson(response, 200, { saved: store.savedKeys(db()) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/bookmarks") {
    const id = store.addBookmark(db(), (await readBody(request)).item);
    sendJson(response, 200, { id, saved: store.savedKeys(db()) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/bookmarks/remove") {
    const removed = store.removeBookmark(db(), (await readBody(request)).id);
    sendJson(response, 200, { removed, saved: store.savedKeys(db()) });
    return true;
  }
  return false;
};

module.exports = { handleBookmarkApi };
