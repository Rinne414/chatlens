"use strict";

// HTTP side of QQ 收藏图 (web/qq_collection.js): QQ's own collection
// (src/qq_collection.js), which of its pictures the user's folders already
// hold (src/saved_file_index.js, matched by md5), and saving the rest
// (src/qq_collection_save.js). Settings live in config.qqCollection:
//   scanDirs  folders (with subfolders) where saved pictures may be now
//   saveDir   where new ones are written (checked as well)

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const state = require("./toolkit_state");
const platform = require("../platform");
const { readSecretSync } = require("../secrets");
const { readCollection } = require("../qq_collection");
const { openIndex, scanFolders, md5Paths, nameMd5Paths, recordFile, indexedFileCount } = require("../saved_file_index");
const { savePicture } = require("../qq_collection_save");
const { validateTargetDir } = require("./backup_ops");

const MAX_PER_REQUEST = 8;
const MD5 = /^[a-f0-9]{32}$/u;

const storeDir = () => path.join(state.toolRoot, "store");
const lastScanPath = () => path.join(storeDir(), "qq-collection-scan.json");

let collection = null;
let collectionError = null;
let indexDb = null;
const scan = { running: false, stop: false, phase: null, done: 0, total: 0, hashed: 0, startedAt: null, error: null };
// Save requests in flight: a scan started meanwhile would drop the files they record.
let saving = 0;

const index = () => {
  indexDb ??= openIndex(Database, path.join(storeDir(), "qq-collection.db"));
  return indexDb;
};

/* ---------- settings ---------- */

const settings = () => {
  const saved = state.loadConfig().qqCollection ?? {};
  return {
    scanDirs: (Array.isArray(saved.scanDirs) ? saved.scanDirs : []).map(String).filter((dir) => dir !== ""),
    saveDir: String(saved.saveDir ?? ""),
  };
};

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// The save folder is checked too: a picture saved outside every checked
// folder would otherwise count as unsaved again after the next scan. A
// folder missing right now (a drive not plugged in) stays in: the scan
// reports it and keeps what it knew about it.
const scanRoots = () => {
  const { scanDirs, saveDir } = settings();
  return saveDir !== "" && !scanDirs.some((root) => isInside(root, saveDir)) ? [...scanDirs, saveDir] : scanDirs;
};

const saveSettings = (body) => {
  if (saving > 0) {
    throw new Error("正在保存图片，存完再改文件夹。");
  }
  const config = state.loadConfig();
  const scanDirs = [...new Set((Array.isArray(body?.scanDirs) ? body.scanDirs : []).map((dir) => String(dir).trim()).filter((dir) => dir !== ""))]
    .map((dir) => {
      const resolved = validateTargetDir(dir, config, "检查的文件夹");
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`找不到文件夹：${resolved}`);
      }
      return resolved;
    });
  const saveValue = String(body?.saveDir ?? "").trim();
  const saveDir = saveValue === "" ? "" : validateTargetDir(saveValue, config, "保存文件夹");
  if (saveDir !== "") {
    fs.mkdirSync(saveDir, { recursive: true });
  }
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, qqCollection: { ...(raw.qqCollection ?? {}), scanDirs, saveDir } });
  return settings();
};

/* ---------- QQ's collection ---------- */

const reload = () => {
  const config = state.loadConfig();
  try {
    collection = {
      ...readCollection({
        Database,
        ntDbDir: String(config.ntDbDir ?? ""),
        ntDataDir: String(config.ntDataDir ?? ""),
        key: readSecretSync("ntqqKey"),
        workDir: path.join(storeDir(), "qq-collection"),
      }),
      readAt: Date.now(),
    };
    collectionError = null;
  } catch (error) {
    collectionError = `读取 QQ 收藏失败：${error.message}`;
  }
};

const byMd5 = () => new Map((collection?.pictures ?? []).map((picture) => [picture.md5, picture]));

/* ---------- scanning the folders ---------- */

const readLastScan = () => {
  try {
    return JSON.parse(fs.readFileSync(lastScanPath(), "utf8"));
  } catch {
    return null;
  }
};

const scanStatus = () => ({ ...scan, last: readLastScan(), indexedFiles: indexedFileCount(index()) });

const startScan = () => {
  if (scan.running) {
    return scanStatus();
  }
  if (saving > 0) {
    throw new Error("正在保存图片，存完再检查文件夹。");
  }
  const roots = scanRoots();
  if (roots.length === 0) {
    throw new Error("先选要检查的文件夹。");
  }
  Object.assign(scan, { running: true, stop: false, phase: "listing", done: 0, total: 0, hashed: 0, startedAt: Date.now(), error: null });
  scanFolders(index(), roots, {
    onProgress: (step) => Object.assign(scan, step),
    shouldStop: () => scan.stop,
  }).then((result) => {
    fs.writeFileSync(lastScanPath(), JSON.stringify({ ...result, roots, finishedAt: Date.now() }), "utf8");
  }).catch((error) => {
    scan.error = error.message;
  }).finally(() => {
    scan.running = false;
  });
  return scanStatus();
};

/* ---------- the page ---------- */

const overview = () => {
  if (collection === null && collectionError === null) {
    reload();
  }
  // Same bytes, or a file named after the picture's md5 (QQ's own "save"
  // re-compresses the picture but keeps that name).
  const sameBytes = md5Paths(index());
  const sameName = nameMd5Paths(index());
  return {
    settings: settings(),
    sync: collection?.sync ?? null,
    readAt: collection?.readAt ?? null,
    error: collectionError,
    scan: scanStatus(),
    pictures: (collection?.pictures ?? []).map((picture) => ({
      md5: picture.md5,
      uin: picture.uin,
      uuid: picture.uuid,
      collectedAt: picture.collectedAt,
      width: picture.width,
      height: picture.height,
      savedPath: sameBytes.get(picture.md5) ?? sameName.get(picture.md5) ?? null,
      savedBy: sameBytes.has(picture.md5) ? "bytes" : sameName.has(picture.md5) ? "name" : null,
    })),
  };
};

// A few pictures per request, so the page can show progress and stop.
const savePictures = async (body) => {
  const { saveDir } = settings();
  if (saveDir === "") {
    throw new Error("先选新图要存到哪个文件夹。");
  }
  if (scan.running) {
    throw new Error("正在检查文件夹，检查完再存。");
  }
  const pictures = byMd5();
  const wanted = [...new Set((Array.isArray(body?.md5s) ? body.md5s : []).map((md5) => String(md5).toLowerCase()).filter((md5) => MD5.test(md5)))]
    .slice(0, MAX_PER_REQUEST);
  saving += 1;
  try {
    const results = await Promise.all(wanted.map(async (md5) => {
      const picture = pictures.get(md5);
      if (picture === undefined) {
        return { md5, status: "not-found" };
      }
      let result;
      try {
        result = await savePicture(picture, saveDir, { fetchImpl: globalThis.fetch });
      } catch (error) {
        console.error(`qq-collection save ${md5} failed: ${error.message}`);
        return { md5, status: "write-failed" };
      }
      if (result.status === "saved") {
        try {
          // The bytes' md5: a re-compressed copy is known by its name only.
          recordFile(index(), result.file, result.bytesMd5);
        } catch (error) {
          // The file is saved; the next folder check finds it.
          console.error(`qq-collection index ${md5} failed: ${error.message}`);
        }
      }
      return result;
    }));
    return { saveDir, results };
  } finally {
    saving -= 1;
  }
};

const openFolder = (body) => {
  const target = body?.path ? path.resolve(String(body.path)) : settings().saveDir;
  const allowed = scanRoots().some((root) => isInside(root, target));
  if (!allowed || !fs.existsSync(target)) {
    throw new Error("只能打开检查的文件夹或保存文件夹里的位置。");
  }
  platform.openPath(fs.statSync(target).isDirectory() ? target : path.dirname(target));
  return { opened: true };
};

const handleQqCollectionApi = async (request, response, url, { sendJson, readBody }) => {
  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/qq-collection":
      sendJson(response, 200, overview());
      return true;
    case "POST /api/qq-collection/reload":
      reload();
      sendJson(response, 200, overview());
      return true;
    case "POST /api/qq-collection/settings":
      sendJson(response, 200, { settings: saveSettings(await readBody(request)) });
      return true;
    case "GET /api/qq-collection/scan":
      sendJson(response, 200, scanStatus());
      return true;
    case "POST /api/qq-collection/scan":
      sendJson(response, 200, startScan());
      return true;
    case "POST /api/qq-collection/scan/stop":
      scan.stop = true;
      sendJson(response, 200, scanStatus());
      return true;
    case "POST /api/qq-collection/save":
      sendJson(response, 200, await savePictures(await readBody(request)));
      return true;
    case "POST /api/qq-collection/open":
      sendJson(response, 200, openFolder(await readBody(request)));
      return true;
    default:
      return false;
  }
};

module.exports = { handleQqCollectionApi, MAX_PER_REQUEST };
