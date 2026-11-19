"use strict";

// Originals the user took out of 「留存的原图」. They are moved beside the
// kept originals (store/media-removed/<2 hex>/<md5>.<ext>) so the choice can
// be undone; emptying leaves a zero-byte <md5>.off so nothing copies the
// picture back in on its own. No database: every path that stores an original
// can ask with only the folder and the md5.
//
// Every step can be repeated after a crash or a failed move: a file found in
// the removed folder always wins over a marker, and no step deletes the only
// copy before the other one is in place.

const fs = require("node:fs");
const path = require("node:path");

const OFF_EXTENSION = ".off";

const isMarker = (filePath) => filePath.toLowerCase().endsWith(OFF_EXTENSION);

// media-objects may be a link to another drive: the removed folder goes next
// to the real one, so a removal stays a rename and not a copy.
const removedDirFor = (objectDir) => {
  const resolved = path.resolve(objectDir);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Not there yet: nothing to follow.
  }
  return path.join(path.dirname(real), "media-removed");
};

const entriesFor = (rootDir, hash) => {
  const directory = path.join(rootDir, hash.slice(0, 2));
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names.filter((entry) => entry.toLowerCase().startsWith(`${hash}.`)).sort().map((name) => path.join(directory, name));
};

// The file itself when there is one, else a marker, else null.
const findByName = (rootDir, hash) => {
  const entries = entriesFor(rootDir, hash);
  return entries.find((entry) => !isMarker(entry)) ?? entries[0] ?? null;
};

const isRemoved = (objectDir, hash) => findByName(removedDirFor(objectDir), hash) !== null;

// The removed original still waiting (not emptied), or null.
const waitingFile = (objectDir, hash) => {
  const entry = findByName(removedDirFor(objectDir), hash);
  return entry === null || isMarker(entry) ? null : entry;
};

const moveFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
};

// Returns the bytes moved, or null when media-objects holds no such original.
const moveOut = (objectDir, hash) => {
  const objectPath = findByName(path.resolve(objectDir), hash);
  if (objectPath === null) {
    return null;
  }
  const bytes = fs.statSync(objectPath).size;
  const target = path.join(removedDirFor(objectDir), hash.slice(0, 2), path.basename(objectPath));
  fs.rmSync(target, { force: true });
  moveFile(objectPath, target);
  return bytes;
};

// Returns where the original is again, or null when none is waiting.
const moveBack = (objectDir, hash) => {
  const entry = waitingFile(objectDir, hash);
  if (entry === null) {
    return null;
  }
  const target = path.join(path.resolve(objectDir), hash.slice(0, 2), path.basename(entry));
  // A complete copy already there (an interrupted cross-drive move): keep it.
  // Anything else under that name is a broken leftover and is replaced.
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(entry).size) {
    fs.rmSync(entry, { force: true });
  } else {
    fs.rmSync(target, { force: true });
    moveFile(entry, target);
  }
  return target;
};

const markEmptied = (objectDir, hash) => {
  const marker = path.join(removedDirFor(objectDir), hash.slice(0, 2), `${hash}${OFF_EXTENSION}`);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "");
};

// Deletes the removed original for good; returns the bytes freed. The marker
// is written first: stopped in between, the file is still there and still
// counts as waiting.
const empty = (objectDir, hash) => {
  const entry = waitingFile(objectDir, hash);
  markEmptied(objectDir, hash);
  if (entry === null) {
    return 0;
  }
  const bytes = fs.statSync(entry).size;
  fs.rmSync(entry, { force: true });
  return bytes;
};

// The user keeps the picture again: forget that it was emptied.
const forget = (objectDir, hash) => {
  for (const entry of entriesFor(removedDirFor(objectDir), hash).filter(isMarker)) {
    fs.rmSync(entry, { force: true });
  }
};

module.exports = { removedDirFor, findByName, isRemoved, waitingFile, moveOut, moveBack, markEmptied, empty, forget };
