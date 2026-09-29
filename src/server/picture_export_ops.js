"use strict";

// POST /api/pictures/export: copies up to MAX_PER_REQUEST chosen pictures'
// originals into the user's save folder (设置 in 画廊, config.pictures.saveDir)
// or, without one, a new reports/picture-export-<time>/. The page sends a long
// selection in small batches (so it can show progress and stop), passing back
// the folder token the first batch used. Nothing is kept in the store: an
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
const { validateTargetDir } = require("./backup_ops");

const MAX_PER_REQUEST = 10;
const MD5 = /^[a-f0-9]{32}$/u;

const SAVE_DIR_TOKEN = "save-dir";

const exportRoot = () => state.loadConfig().reportsDir;

const saveDir = () => {
  const dir = String(state.loadConfig().pictures?.saveDir ?? "").trim();
  return dir.length > 0 ? dir : null;
};

const folderPath = (name) => {
  if (name === SAVE_DIR_TOKEN && saveDir() !== null) {
    return saveDir();
  }
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
  const fresh = saveDir() !== null ? SAVE_DIR_TOKEN : newFolderName(Math.floor(Date.now() / 1000));
  const name = folder === null || folder === "" ? fresh : String(folder);
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

// Where 「保存原图到文件夹」 writes: the chosen folder, or a new dated folder
// under reports/ when none is chosen.
const getSaveTarget = () => ({
  saveDir: saveDir(),
  fallbackRoot: exportRoot(),
});

// "" goes back to the dated folders under reports/.
const setSaveDir = ({ dir }) => {
  const raw = state.loadRawConfig();
  const value = String(dir ?? "").trim();
  const next = value.length === 0 ? "" : validateTargetDir(value, state.loadConfig(), "保存文件夹");
  if (next !== "") {
    fs.mkdirSync(next, { recursive: true });
  }
  state.writeConfig({ ...raw, pictures: { ...(raw.pictures ?? {}), saveDir: next } });
  return getSaveTarget();
};

// A browser's "save image as" name: the same when / where / who name the
// exports use, so saved pictures never pile up as image.png, image (1).png.
const downloadName = (md5, filePath) => {
  try {
    return `${fileStem(md5, firstPosting(md5))}${extensionOf(filePath)}`;
  } catch {
    return `${md5}${path.extname(filePath)}`;
  }
};

module.exports = { exportPictures, openExportFolder, getSaveTarget, setSaveDir, downloadName, MAX_PER_REQUEST };
