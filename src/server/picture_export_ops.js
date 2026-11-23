"use strict";

// POST /api/pictures/export: copies up to MAX_PER_REQUEST chosen pictures'
// originals into the user's save folder (设置 in 画廊, config.pictures.saveDir)
// or, without one, a new reports/picture-export-<time>/. The page sends a long
// selection in small batches (so it can show progress and stop), passing back
// the folder token the first batch used. Nothing is kept in the store: an
// original fetched from Tencent for this goes to a temp file and is removed.
// With `tray` the copies go to that 存图托盘's folder (src/picture_trays.js).
// Every copy is written down in picture_saves, so the wall can mark it.

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
const trayList = require("../picture_trays");

const MAX_PER_REQUEST = 10;
const MD5 = /^[a-f0-9]{32}$/u;

const SAVE_DIR_TOKEN = "save-dir";
const TRAY_TOKEN = /^tray:(t[0-9a-z]{1,12})$/u;

const exportRoot = () => state.loadConfig().reportsDir;

const saveDir = () => {
  const dir = String(state.loadConfig().pictures?.saveDir ?? "").trim();
  return dir.length > 0 ? dir : null;
};

const trays = () => trayList.listTrays(state.loadConfig().pictures, exportRoot());

const trayById = (id) => {
  const tray = trays().find((item) => item.id === id);
  if (tray === undefined) {
    throw new Error("没有这个托盘，可能已经被移除。");
  }
  return tray;
};

const folderPath = (name) => {
  if (name === SAVE_DIR_TOKEN && saveDir() !== null) {
    return saveDir();
  }
  const tray = TRAY_TOKEN.exec(String(name ?? ""));
  if (tray !== null) {
    return trayById(tray[1]).path;
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

// The copy is on disk either way; a mark that could not be written only means
// the wall does not show 「已存」 for it.
const noteSaved = (md5, directory, file) => {
  try {
    pictureStore.recordSave(state.getStore(), { md5, dir: directory, file, savedAt: Math.floor(Date.now() / 1000) });
  } catch (error) {
    console.error(`picture save mark failed md5=${md5}: ${error.message}`);
  }
};

// A copy this program already put in that folder, when it is still there.
const copyAlreadyIn = (directory, md5) => {
  const folder = path.resolve(directory).toLowerCase();
  return pictureStore.savesOf(state.getStore(), md5)
    .find((save) => path.resolve(save.dir).toLowerCase() === folder && fs.existsSync(path.join(save.dir, save.file))) ?? null;
};

// once: saving a picture again into a folder that still has it makes no
// second file (a 存图托盘 is a place to collect into; a key pressed twice
// should not leave "name (2)").
const exportOne = async (directory, md5, { once = false } = {}) => {
  const existing = once ? copyAlreadyIn(directory, md5) : null;
  if (existing !== null) {
    return { md5, status: "exported", file: existing.file, prompt: false, previewOnly: false, already: true };
  }
  const source = await jobs.originalFile(md5, libraryOriginal);
  if (source.error !== undefined) {
    return { md5, status: source.error };
  }
  try {
    const name = uniqueName(directory, fileStem(md5, firstPosting(md5)), extensionOf(source.filePath));
    fs.copyFileSync(source.filePath, path.join(directory, name), fs.constants.COPYFILE_EXCL);
    noteSaved(md5, directory, name);
    return { md5, status: "exported", file: name, prompt: writeSidecar(directory, name, md5), previewOnly: source.previewOnly === true };
  } finally {
    if (source.temporary) {
      fs.rmSync(source.filePath, { force: true });
    }
  }
};

const exportPictures = async ({ md5s, folder = null, tray = null }) => {
  const wanted = [...new Set((Array.isArray(md5s) ? md5s : []).map((md5) => String(md5).toLowerCase()).filter((md5) => MD5.test(md5)))]
    .slice(0, MAX_PER_REQUEST);
  const fresh = saveDir() !== null ? SAVE_DIR_TOKEN : newFolderName(Math.floor(Date.now() / 1000));
  const name = tray !== null && tray !== ""
    ? `tray:${trayById(String(tray)).id}`
    : folder === null || folder === "" ? fresh : String(folder);
  const directory = folderPath(name);
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  // A dated folder is new each time; a fixed folder or a tray is collected into.
  const once = !isFolderName(name);
  for (const md5 of wanted) {
    results.push(await exportOne(directory, md5, { once }));
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

/* ---------- 存图托盘 ---------- */

const getTrays = () => ({ trays: trays().map(({ id, name, ownName, dir, path: folder }) => ({ id, name, ownName, dir, path: folder })) });

const validTrayDir = (dir) => validateTargetDir(dir, state.loadConfig(), "托盘的文件夹");

// action: add { name, dir } | update { id, name?, dir? } | remove { id }.
// A first tray given an empty dir goes back to its default folder.
const changeTrays = ({ action, id, name, dir }) => {
  const raw = state.loadRawConfig();
  const pictures = raw.pictures ?? {};
  const root = exportRoot();
  const cleanDir = dir === undefined ? undefined : String(dir ?? "").trim();
  let result;
  if (action === "add") {
    result = trayList.addTray(pictures, root, { name, dir: validTrayDir(cleanDir) });
  } else if (action === "update") {
    result = trayList.updateTray(pictures, root, { id: String(id), name, dir: cleanDir === undefined || cleanDir === "" ? cleanDir : validTrayDir(cleanDir) });
  } else if (action === "remove") {
    result = trayList.removeTray(pictures, root, { id: String(id) });
  } else {
    throw new Error("不认识的托盘操作。");
  }
  // Made only once the change was accepted (a refused one leaves no empty folder).
  if (action !== "remove" && cleanDir !== undefined && cleanDir !== "") {
    fs.mkdirSync(validTrayDir(cleanDir), { recursive: true });
  }
  state.writeConfig({ ...raw, pictures: result.pictures });
  return { ...getTrays(), id: result.id ?? null };
};

// For dragging a picture out of the page: the file name it will get, known
// only when the original is already on this computer (nothing is fetched).
const saveName = (md5) => {
  if (!MD5.test(md5)) {
    return { name: null };
  }
  const local = jobs.localOriginalFile(md5, libraryOriginal);
  return { name: local === null ? null : downloadName(md5, local) };
};

// The original as a file to hand to the browser, never a smaller stand-in.
// The caller deletes `temporary` files once sent.
const originalForDownload = async (md5) => {
  if (!MD5.test(md5)) {
    return { error: "not-found" };
  }
  const source = await jobs.originalFile(md5, libraryOriginal);
  if (source.error !== undefined) {
    return source;
  }
  // QQ's preview of a picture sent as a file is not handed out under the
  // original's name (a tray save takes it, and says so).
  return source.previewOnly === true ? { error: "file-only" } : { ...source, name: downloadName(md5, source.filePath) };
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

module.exports = { exportPictures, openExportFolder, getSaveTarget, setSaveDir, downloadName, getTrays, changeTrays, saveName, originalForDownload, MAX_PER_REQUEST };
