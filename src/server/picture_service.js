"use strict";

// Fetches group pictures from Tencent inside the console process, so the
// rkey (src/rkey.js) only ever lives in this process's memory. QQ keeps a
// picture's original only once it is opened IN QQ; this is what lets the
// console show and keep pictures nobody opened.
//
// Automatic, after each background refresh (while Tencent still has them,
// i.e. for 31 days):
//   - a 198px thumbnail of every picture;
//   - large PNG/JPG/WebP: the first 128 KB decides whether it is AI-generated;
//     if so its prompt, parameters and full workflow go into the knowledge
//     base and Tencent's larger preview is kept (up to 1280px; a PNG stays
//     a PNG, ~1.7 MB), newest first, within the budget; the original is not;
//   - every original of the groups marked "keep everything".
// On demand: any size when a picture is opened in the console (originals go
// to a size-capped cache), and "save the original" for good.
// Thumbnails, previews and the cache stay within the picture budget.

const fs = require("node:fs");
const path = require("node:path");
const state = require("./toolkit_state");
const store = require("../picture_store");
const pictureFetch = require("../picture_fetch");
const rkeyScan = require("../rkey");
const { findExistingMediaObject } = require("../media_object_store");

const storeDir = path.join(state.toolRoot, "store");
const objectDir = path.join(storeDir, "media-objects");
const tmpDir = path.join(storeDir, "tmp");
const knowledgeDbPath = path.join(storeDir, "knowledge.db");

const DEFAULTS = { enabled: true, budgetGB: 10, keepAllGroups: [] };
const BUDGETS_GB = new Set([2, 5, 10, 20, 50, 100]);
const GB = 1024 ** 3;
const CACHE_SHARE = 0.3;
const PASS_MAX_MS = 10 * 60 * 1000;
const BATCH = 40;
const CONCURRENCY = 3;
const WIDE_HEAD_BYTES = 4 * 1024 * 1024;
const SIZE_TO_KIND = { thumb: "thumb", preview: "preview", original: "cache" };

const unix = () => Math.floor(Date.now() / 1000);

/* ---------- settings ---------- */

const settings = () => {
  const saved = state.loadConfig().pictures ?? {};
  return { ...DEFAULTS, ...saved, keepAllGroups: Array.isArray(saved.keepAllGroups) ? saved.keepAllGroups.map(String) : [] };
};

const saveSettings = (patch) => {
  const raw = state.loadRawConfig();
  const next = { ...DEFAULTS, ...(raw.pictures ?? {}) };
  if (typeof patch.enabled === "boolean") {
    next.enabled = patch.enabled;
  }
  if (patch.budgetGB !== undefined) {
    if (!BUDGETS_GB.has(Number(patch.budgetGB))) {
      throw new Error("图片空间上限无效。");
    }
    next.budgetGB = Number(patch.budgetGB);
  }
  if (patch.keepAllGroups !== undefined) {
    const watched = new Set((raw.watchlist ?? []).map((entry) => String(entry.groupId)));
    if (!Array.isArray(patch.keepAllGroups) || patch.keepAllGroups.some((groupId) => !watched.has(String(groupId)))) {
      throw new Error("只能选择关注列表里的群。");
    }
    next.keepAllGroups = [...new Set(patch.keepAllGroups.map(String))];
  }
  state.writeConfig({ ...raw, pictures: next });
  return next;
};

/* ---------- rkey (memory only) ---------- */

const scanForRkey = async () => {
  const probes = store.recentNt(state.getStore(), unix(), 5);
  if (probes.length === 0) {
    return { key: null, problem: "no-pictures" };
  }
  const scan = await rkeyScan.scanCandidates(state.toolRoot);
  if (scan.problem !== null) {
    return { key: null, problem: scan.problem };
  }
  for (const probe of probes) {
    const picked = await rkeyScan.pickWorking(scan.candidates, probe);
    if (picked.key !== null) {
      return { key: picked.key, problem: null };
    }
    if (!picked.probeGone) {
      break;
    }
  }
  return { key: null, problem: scan.candidates.length === 0 ? "none-found" : "none-valid" };
};

const rkey = rkeyScan.createKeyHolder({ scan: scanForRkey });

// A valid rkey, scanning QQ's memory when there is none (see createKeyHolder).
const ensureRkey = () => rkey.ensure();

/* ---------- fetching and files ---------- */

const traffic = { day: "", bytes: 0 };
const countTraffic = (bytes) => {
  const day = new Date().toISOString().slice(0, 10);
  if (traffic.day !== day) {
    Object.assign(traffic, { day, bytes: 0 });
  }
  traffic.bytes += bytes;
};

// One fetch, retried once with a fresh rkey when Tencent refuses the key and
// the holder decides the key itself is stale.
const withRkey = async (picture, fetchOnce) => {
  let key = picture.fileId ? await ensureRkey() : null;
  let result = await fetchOnce(key);
  if (result.outcome === "rkey") {
    const fresh = await rkey.refused(key);
    if (fresh !== null) {
      key = fresh;
      result = await fetchOnce(fresh);
    }
  }
  if (result.outcome === "ok") {
    countTraffic(result.bytes.length);
    if (result.via === "nt") {
      rkey.succeeded(key);
    }
  }
  return result;
};

const fetchSize = (picture, size) => withRkey(picture, (key) => pictureFetch.fetchPicture(picture, size, { rkey: key }));

const writeAtomic = (target, bytes) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, target);
};

const saveVariant = (db, md5, kind, result) => {
  const target = store.picturePath(storeDir, kind, md5, result.ext);
  writeAtomic(target, result.bytes);
  store.updateFile(db, md5, { [kind]: path.basename(target), [`${kind}_bytes`]: result.bytes.length, last_used: unix(), evicted: 0 });
  return target;
};

const variantPath = (row, kind) => {
  const name = row?.[kind] ?? "";
  if (name === "") {
    return null;
  }
  const target = store.picturePath(storeDir, kind, row.md5, path.extname(name).slice(1));
  return fs.existsSync(target) ? target : null;
};

const keptPath = (row, md5) => {
  if (row?.kept !== 1) {
    return null;
  }
  try {
    return findExistingMediaObject(objectDir, md5);
  } catch {
    return null;
  }
};

// Local file for a size. A thumbnail request is never answered with a bigger
// copy while the thumbnail can still be fetched: an AI preview is ~1.7 MB, and
// lists of thumbnails would load dozens of them.
const localFile = (row, md5, size) => {
  const original = () => keptPath(row, md5) ?? variantPath(row, "cache");
  if (size === "original") {
    return original();
  }
  if (size === "preview") {
    return variantPath(row, "preview") ?? original();
  }
  return variantPath(row, "thumb");
};

// Any local copy, smallest first: shown when the wanted size cannot be fetched.
const anyLocalFile = (row, md5) =>
  variantPath(row, "thumb") ?? variantPath(row, "preview") ?? keptPath(row, md5) ?? variantPath(row, "cache");

const rkeyStatus = () => rkey.status();

const trafficToday = () => (traffic.day === new Date().toISOString().slice(0, 10) ? traffic.bytes : 0);

module.exports = {
  DEFAULTS,
  BUDGETS_GB,
  GB,
  CACHE_SHARE,
  SIZE_TO_KIND,
  WIDE_HEAD_BYTES,
  storeDir,
  objectDir,
  tmpDir,
  knowledgeDbPath,
  unix,
  settings,
  saveSettings,
  ensureRkey,
  rkeyStatus,
  trafficToday,
  withRkey,
  fetchSize,
  writeAtomic,
  saveVariant,
  variantPath,
  keptPath,
  localFile,
  anyLocalFile,
};
