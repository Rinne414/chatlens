"use strict";

// Taking back a picture just saved into one of the user's folders (存图文件夹).
// Only a copy this program made itself, a short while ago, and that nobody
// has touched since is removed: the folder is the user's own, so anything
// that might be theirs stays. The picture's source is never touched, so it
// can be saved again.

const fs = require("node:fs");
const path = require("node:path");

// A save can be taken back for this long.
const UNDO_WINDOW_SECONDS = 3600;
// A copy keeps its source's file time or gets the time of the save; a file
// changed later than this after the save was edited by someone.
const TOUCH_SLACK_SECONDS = 10;
const MD5 = /^[a-f0-9]{32}$/u;

const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

const isPlainFileName = (name) => typeof name === "string" && name !== "" && name !== "." && name !== ".." && path.basename(name) === name && !/[\\/:]/u.test(name);

const touchedSince = (file, savedAt) => fs.statSync(file).mtimeMs / 1000 > savedAt + TOUCH_SLACK_SECONDS;

// The prompt written beside the picture by the same save (same name, .txt).
const removeSidecar = (dir, file, savedAt) => {
  const sidecar = path.join(dir, `${path.parse(file).name}.txt`);
  if (!fs.existsSync(sidecar)) {
    return;
  }
  const written = fs.statSync(sidecar).mtimeMs / 1000;
  if (Math.abs(written - savedAt) <= TOUCH_SLACK_SECONDS) {
    fs.rmSync(sidecar);
  }
};

// status: undone | gone (the file was already removed; the mark is cleared) |
// not-ours (no save of ours by that name in that folder) | too-old | changed.
const undoSave = (db, { md5, dir, file, nowUnix }) => {
  if (!MD5.test(String(md5)) || !isPlainFileName(file)) {
    return "not-ours";
  }
  const save = db.prepare("SELECT dir, file, saved_at AS savedAt FROM picture_saves WHERE md5 = ? AND file = ?").all(md5, file)
    .find((row) => samePath(row.dir, dir)) ?? null;
  if (save === null) {
    return "not-ours";
  }
  if (nowUnix - save.savedAt > UNDO_WINDOW_SECONDS) {
    return "too-old";
  }
  const target = path.join(save.dir, save.file);
  const exists = fs.existsSync(target);
  if (exists && touchedSince(target, save.savedAt)) {
    return "changed";
  }
  if (exists) {
    fs.rmSync(target);
    removeSidecar(save.dir, save.file, save.savedAt);
  }
  db.prepare("DELETE FROM picture_saves WHERE md5 = ? AND dir = ? AND file = ?").run(md5, save.dir, save.file);
  return exists ? "undone" : "gone";
};

module.exports = { undoSave, UNDO_WINDOW_SECONDS };
