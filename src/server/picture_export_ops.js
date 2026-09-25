"use strict";

// POST /api/pictures/export: copies up to MAX_PER_REQUEST chosen pictures'
// originals into reports/picture-export-<time>/. The page sends a long
// selection in small batches (so it can show progress and stop), passing back
// the folder name the first batch created. Nothing is kept in the store: an
// original fetched from Tencent for this goes to a temp file and is removed.

const fs = require("node:fs");
const path = require("node:path");
const state = require("./toolkit_state");
const jobs = require("./picture_jobs");
const knowledge = require("./knowledge_ops");
const pictureStore = require("../picture_store");
const platform = require("../platform");
const { promptFor, sidecarText } = require("../knowledge_export");
const { newFolderName, isFolderName, extensionOf, fileStem, uniqueName } = require("../picture_export");

const MAX_PER_REQUEST = 10;
const MD5 = /^[a-f0-9]{32}$/u;

const exportRoot = () => state.loadConfig().reportsDir;

const folderPath = (name) => {
  if (!isFolderName(name)) {
    throw new Error("导出文件夹名无效。");
  }
  return path.join(exportRoot(), name);
};

const firstPosting = (md5) =>
  pictureStore.occurrences(state.getStore(), md5).sort((left, right) => left.sentAt - right.sentAt)[0] ?? null;

// The library's own local original (QQ's cache under nt_data, or media-objects).
const libraryOriginal = (md5) => knowledge.imageFilePath(state.toolRoot, md5);

const writeSidecar = (directory, name, md5) => {
  const record = knowledge.imageByHash(state.toolRoot, md5);
  if (record === null) {
    return false;
  }
  const prompt = promptFor(record);
  if (prompt.text.length === 0) {
    return false;
  }
  fs.writeFileSync(path.join(directory, `${path.parse(name).name}.txt`), sidecarText(record, prompt), "utf8");
  return true;
};

const exportOne = async (directory, md5) => {
  const source = await jobs.originalFile(md5, libraryOriginal);
  if (source.error !== undefined) {
    return { md5, status: source.error };
  }
  try {
    const name = uniqueName(directory, fileStem(md5, firstPosting(md5)), extensionOf(source.filePath));
    fs.copyFileSync(source.filePath, path.join(directory, name), fs.constants.COPYFILE_EXCL);
    return { md5, status: "exported", file: name, prompt: writeSidecar(directory, name, md5) };
  } finally {
    if (source.temporary) {
      fs.rmSync(source.filePath, { force: true });
    }
  }
};

const exportPictures = async ({ md5s, folder = null }) => {
  const wanted = [...new Set((Array.isArray(md5s) ? md5s : []).map((md5) => String(md5).toLowerCase()).filter((md5) => MD5.test(md5)))]
    .slice(0, MAX_PER_REQUEST);
  const name = folder === null || folder === "" ? newFolderName(Math.floor(Date.now() / 1000)) : String(folder);
  const directory = folderPath(name);
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  for (const md5 of wanted) {
    results.push(await exportOne(directory, md5));
  }
  return { folder: name, path: directory, results };
};

const openExportFolder = ({ folder }) => {
  const directory = folderPath(folder);
  if (!fs.existsSync(directory)) {
    throw new Error("导出文件夹不存在。");
  }
  platform.openPath(directory);
  return { opened: true };
};

module.exports = { exportPictures, openExportFolder, MAX_PER_REQUEST };
