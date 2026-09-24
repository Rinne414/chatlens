"use strict";

// What the console does with pictures: serve one when it is opened, save an
// original for good, and the background pass after each refresh (AI check,
// "keep everything" groups, thumbnails, budget). See picture_service.js.

const fs = require("node:fs");
const path = require("node:path");
const state = require("./toolkit_state");
const service = require("./picture_service");
const store = require("../picture_store");
const pictureFetch = require("../picture_fetch");
const pictureAi = require("../picture_ai");
const { persistMediaObject } = require("../media_object_store");

const MD5 = /^[a-f0-9]{32}$/u;
const SIZES = new Set(["thumb", "preview", "original"]);
const MAX_KEEP_PER_REQUEST = 500;

const db = () => state.getStore();

/* ---------- opening a picture ---------- */

const inFlight = new Map();

const fetchAndStore = async (md5, size) => {
  const picture = store.locate(db(), md5);
  if (picture === null) {
    return { error: "not-found" };
  }
  const row = store.fileRow(db(), md5);
  if (row?.gone === 1 || picture.expiresAt <= service.unix()) {
    return { error: "gone" };
  }
  const result = await service.fetchSize(picture, size);
  if (result.outcome === "ok") {
    return { filePath: service.saveVariant(db(), md5, service.SIZE_TO_KIND[size], result) };
  }
  if (result.outcome === "gone") {
    store.updateFile(db(), md5, { gone: 1 });
    return { error: "gone" };
  }
  const noKey = picture.fileId !== "" && !service.rkeyStatus().ready;
  return { error: noKey ? "no-rkey" : "unavailable" };
};

// { filePath } or { error: not-found | gone | no-rkey | unavailable, fallback? }
// where fallback is the best smaller local copy to show instead.
const resolvePicture = async (md5, size) => {
  if (!MD5.test(String(md5)) || !SIZES.has(size)) {
    return { error: "not-found" };
  }
  const row = store.fileRow(db(), md5);
  const local = service.localFile(row, md5, size);
  if (local !== null) {
    store.updateFile(db(), md5, { last_used: service.unix() });
    return { filePath: local };
  }
  const key = `${md5}|${size}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, fetchAndStore(md5, size).finally(() => inFlight.delete(key)));
  }
  const result = await inFlight.get(key);
  if (result.error === undefined) {
    return result;
  }
  return { ...result, fallback: service.anyLocalFile(store.fileRow(db(), md5), md5) };
};

/* ---------- saving originals for good ---------- */

let tempCounter = 0;

const keepOne = async (md5) => {
  const row = store.fileRow(db(), md5);
  const kept = service.keptPath(row, md5);
  if (kept !== null) {
    return { md5, status: "kept", objectPath: kept };
  }
  let source = service.variantPath(row, "cache");
  let temporary = null;
  if (source === null) {
    const fetched = await fetchAndStoreTemp(md5);
    if (fetched.error !== undefined) {
      return { md5, status: fetched.error };
    }
    source = fetched.filePath;
    temporary = fetched.filePath;
  }
  try {
    const persisted = persistMediaObject(source, service.objectDir, md5);
    if (persisted.objectPath === null) {
      return { md5, status: "unavailable" };
    }
    const cached = service.variantPath(row, "cache");
    if (cached !== null) {
      fs.rmSync(cached, { force: true });
    }
    store.updateFile(db(), md5, { kept: 1, cache: "", cache_bytes: 0 });
    pictureAi.attachOriginal({ knowledgeDbPath: service.knowledgeDbPath, md5, objectPath: persisted.objectPath });
    return { md5, status: "kept", objectPath: persisted.objectPath };
  } finally {
    if (temporary !== null) {
      fs.rmSync(temporary, { force: true });
    }
  }
};

// The original straight into a temp file (not the cache): it is about to be
// copied into media-objects anyway.
const fetchAndStoreTemp = async (md5) => {
  const picture = store.locate(db(), md5);
  if (picture === null) {
    return { error: "not-found" };
  }
  if (store.fileRow(db(), md5)?.gone === 1 || picture.expiresAt <= service.unix()) {
    return { error: "gone" };
  }
  const result = await service.fetchSize(picture, "original");
  if (result.outcome === "gone") {
    store.updateFile(db(), md5, { gone: 1 });
    return { error: "gone" };
  }
  if (result.outcome !== "ok") {
    return { error: picture.fileId !== "" && !service.rkeyStatus().ready ? "no-rkey" : "unavailable" };
  }
  tempCounter += 1;
  const filePath = path.join(service.tmpDir, `keep-${process.pid}-${tempCounter}.${result.ext}`);
  service.writeAtomic(filePath, result.bytes);
  return { filePath };
};

const keepOriginals = async (md5s) => {
  const wanted = [...new Set((Array.isArray(md5s) ? md5s : []).map(String).filter((md5) => MD5.test(md5)))].slice(0, MAX_KEEP_PER_REQUEST);
  const results = [];
  for (const md5 of wanted) {
    results.push(await keepOne(md5));
  }
  const tally = results.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {});
  return { requested: wanted.length, tally, results };
};

/* ---------- AI check ---------- */

const headFor = async (picture) => {
  const head = await service.withRkey(picture, (key) => pictureFetch.fetchHead(picture, { rkey: key }));
  if (head.outcome !== "ok" || !pictureFetch.headLooksGenerated(head.bytes)) {
    return head;
  }
  if (pictureFetch.headIsComplete(head.bytes)) {
    return { ...head, complete: true };
  }
  const wide = await service.withRkey(picture, (key) => pictureFetch.fetchHead(picture, { rkey: key, length: service.WIDE_HEAD_BYTES }));
  if (wide.outcome === "ok" && pictureFetch.headIsComplete(wide.bytes, service.WIDE_HEAD_BYTES)) {
    return { ...wide, complete: true };
  }
  return { ...head, complete: false };
};

// Returns ok | plain | gone | failed. A generated picture's metadata goes to
// the knowledge base; its preview is fetched by previewOne (newest first).
const probeOne = async (picture) => {
  const head = await headFor(picture);
  if (head.outcome === "gone") {
    store.updateFile(db(), picture.md5, { gone: 1 });
    return "gone";
  }
  if (head.outcome !== "ok") {
    return "failed";
  }
  if (head.complete === undefined) {
    store.updateFile(db(), picture.md5, { probe: "plain" });
    return "plain";
  }
  let bytes = head.bytes;
  if (head.complete === false) {
    const original = await service.fetchSize(picture, "original");
    if (original.outcome !== "ok") {
      return original.outcome === "gone" ? "gone" : "failed";
    }
    bytes = original.bytes;
  }
  const ext = pictureFetch.sniffExtension(bytes) ?? "bin";
  const { parsed, chunks } = pictureAi.parseBytes(bytes, ext, service.tmpDir);
  if (parsed.generator === "unknown") {
    store.updateFile(db(), picture.md5, { probe: "plain" });
    return "plain";
  }
  pictureAi.recordGenerated({
    knowledgeDbPath: service.knowledgeDbPath,
    picture,
    parsed,
    chunks,
    occurrences: store.occurrences(db(), picture.md5),
  });
  store.updateFile(db(), picture.md5, { probe: "ai" });
  return "ok";
};

const previewOne = async (picture) => {
  const result = await fetchAndStore(picture.md5, "preview");
  if (result.error === undefined) {
    return "ok";
  }
  return result.error === "gone" ? "gone" : "failed";
};

const thumbOne = async (picture) => {
  const result = await service.fetchSize(picture, "thumb");
  if (result.outcome === "ok") {
    service.saveVariant(db(), picture.md5, "thumb", result);
    return "ok";
  }
  if (result.outcome === "gone") {
    store.updateFile(db(), picture.md5, { gone: 1 });
    return "gone";
  }
  return "failed";
};

module.exports = { resolvePicture, keepOriginals, keepOne, probeOne, previewOne, thumbOne, fetchAndStore };
