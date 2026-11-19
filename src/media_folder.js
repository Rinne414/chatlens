"use strict";

// Which originals are really in the kept folder (store/media-objects/<2 hex>/
// <md5>.<ext>), read from file names only. Deleting files there by hand is a
// fair way to drop them, and putting them back a fair way to keep them again:
// this listing is what lets the records follow the folder.

const fs = require("node:fs");
const path = require("node:path");

const BUCKET = /^[a-f0-9]{2}$/u;
const NAMED_BY_HASH = /^([a-f0-9]{32})\./u;

let cached = { key: "", hashes: new Set() };

const bucketFolders = async (objectDir) => (await fs.promises.readdir(objectDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && BUCKET.test(entry.name))
  .map((entry) => path.join(objectDir, entry.name));

// Adding or deleting a file changes its folder's modified time, so a stat per
// bucket says whether the listing (tens of thousands of names) is still right.
// Returns { key, hashes }, or null when the folder cannot be read at all (not
// created yet, or its drive is away): then nothing may be concluded from it.
const listHashes = async (objectDirValue) => {
  const objectDir = path.resolve(objectDirValue);
  let folders;
  try {
    folders = await bucketFolders(objectDir);
  } catch {
    return null;
  }
  const stamps = await Promise.all(folders.map(async (folder) => (await fs.promises.stat(folder)).mtimeMs));
  const key = JSON.stringify([objectDir, folders.length, ...stamps]);
  if (cached.key !== key) {
    const hashes = new Set();
    for (const folder of folders) {
      for (const name of await fs.promises.readdir(folder)) {
        const match = NAMED_BY_HASH.exec(name.toLowerCase());
        if (match !== null) {
          hashes.add(match[1]);
        }
      }
    }
    cached = { key, hashes };
  }
  return cached;
};

module.exports = { listHashes };
