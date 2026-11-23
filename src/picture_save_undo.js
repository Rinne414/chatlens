"use strict";

// Taking back a picture just saved into one of the user's folders (存图文件夹).
// The folder is the user's own, so only a file this program wrote itself and
// that is still exactly as it was written is removed: when a copy is made its
// size and file time are noted (in memory, for this run of the console), and
// an undo removes the file only while both still match. Anything else (a file
// edited or replaced since, one saved before a restart, one saved long ago)
// stays. The picture's source is never touched, so it can be saved again.

const fs = require("node:fs");
const path = require("node:path");

// A save can be taken back for this long.
const UNDO_WINDOW_SECONDS = 3600;
const MD5 = /^[a-f0-9]{32}$/u;

// full path (lower case) -> { size, mtimeMs, sidecar: null | { size, mtimeMs } }
const made = new Map();

const keyOf = (dir, file) => path.resolve(dir, file).toLowerCase();
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const isPlainFileName = (name) => typeof name === "string" && name !== "" && name !== "." && name !== ".." && path.basename(name) === name && !/[\\/:]/u.test(name);
const sidecarOf = (dir, file) => path.join(dir, `${path.parse(file).name}.txt`);

const stampOf = (file) => {
  const stat = fs.statSync(file);
  return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
};

const unchanged = (file, stamp) => {
  if (stamp === null || !fs.existsSync(file)) {
    return false;
  }
  const now = stampOf(file);
  return now !== null && now.size === stamp.size && now.mtimeMs === stamp.mtimeMs;
};

// Called right after a copy (and its prompt file, when one was written) was made.
const noteMade = (dir, file, { sidecar = false } = {}) => {
  made.set(keyOf(dir, file), { ...stampOf(path.join(dir, file)), sidecar: sidecar ? stampOf(sidecarOf(dir, file)) : null });
};

// status: undone | gone (the file was already removed; the mark is cleared) |
// not-ours (no save of ours by that name in that folder) | too-old |
// changed (not as this program wrote it, or written before a restart) |
// busy (the file could not be removed just now; nothing was changed).
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
  const key = keyOf(save.dir, save.file);
  const exists = fs.existsSync(target);
  if (exists) {
    const note = made.get(key) ?? null;
    if (note === null || !unchanged(target, note)) {
      return "changed";
    }
    try {
      fs.rmSync(target);
    } catch {
      return "busy";
    }
    const sidecar = sidecarOf(save.dir, save.file);
    if (unchanged(sidecar, note.sidecar)) {
      // Left behind when it cannot be removed: the picture itself is gone already.
      fs.rmSync(sidecar, { force: true, maxRetries: 0 });
    }
  }
  made.delete(key);
  db.prepare("DELETE FROM picture_saves WHERE md5 = ? AND dir = ? AND file = ?").run(md5, save.dir, save.file);
  return exists ? "undone" : "gone";
};

module.exports = { undoSave, noteMade, UNDO_WINDOW_SECONDS };
