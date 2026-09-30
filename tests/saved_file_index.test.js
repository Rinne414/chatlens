"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");
const { openIndex, scanFolders, md5Paths, nameMd5Paths, recordFile } = require("../src/saved_file_index");

const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");

const withFolder = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-saved-index-"));
  const pictures = path.join(dir, "Pictures");
  fs.mkdirSync(path.join(pictures, "sorted"), { recursive: true });
  const db = openIndex(Database, path.join(dir, "index.db"));
  try {
    await fn({ dir, pictures, db });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("hashes every picture under the folders, subfolders included, and ignores other files", async () => {
  await withFolder(async ({ pictures, db }) => {
    fs.writeFileSync(path.join(pictures, "a.png"), "picture a");
    fs.writeFileSync(path.join(pictures, "sorted", "b.JPG"), "picture b");
    fs.writeFileSync(path.join(pictures, "notes.txt"), "not a picture");
    const progress = [];
    const result = await scanFolders(db, [pictures], { onProgress: (step) => progress.push(step) });
    assert.deepEqual({ files: result.files, hashed: result.hashed, reused: result.reused, removed: result.removed }, { files: 2, hashed: 2, reused: 0, removed: 0 });
    const found = md5Paths(db);
    assert.equal(found.get(md5("picture a")), path.join(pictures, "a.png"));
    assert.equal(found.get(md5("picture b")), path.join(pictures, "sorted", "b.JPG"));
    assert.equal(progress.at(-1).done, 2);
  });
});

test("a rescan only reads new or changed files and forgets files that are gone", async () => {
  await withFolder(async ({ pictures, db }) => {
    fs.writeFileSync(path.join(pictures, "a.png"), "picture a");
    fs.writeFileSync(path.join(pictures, "b.png"), "picture b");
    await scanFolders(db, [pictures], { now: 1 });
    fs.rmSync(path.join(pictures, "a.png"));
    fs.writeFileSync(path.join(pictures, "b.png"), "picture b, edited");
    fs.writeFileSync(path.join(pictures, "c.png"), "picture c");
    const result = await scanFolders(db, [pictures], { now: 2 });
    assert.deepEqual({ files: result.files, hashed: result.hashed, reused: result.reused, removed: result.removed }, { files: 2, hashed: 2, reused: 0, removed: 1 });
    const again = await scanFolders(db, [pictures], { now: 3 });
    assert.deepEqual({ hashed: again.hashed, reused: again.reused }, { hashed: 0, reused: 2 });
    assert.equal(md5Paths(db).has(md5("picture a")), false);
    assert.equal(md5Paths(db).has(md5("picture b, edited")), true);
  });
});

test("a stopped scan keeps what it hashed and forgets nothing", async () => {
  await withFolder(async ({ pictures, db }) => {
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      fs.writeFileSync(path.join(pictures, `${name}.png`), `picture ${name}`);
    }
    await scanFolders(db, [pictures], { now: 1 });
    fs.writeFileSync(path.join(pictures, "g.png"), "picture g");
    const result = await scanFolders(db, [pictures], { now: 2, shouldStop: () => true });
    assert.equal(result.stopped, true);
    assert.equal(md5Paths(db).size, 6);
  });
});

test("a folder that cannot be read (a drive not plugged in) keeps its files and is reported", async () => {
  await withFolder(async ({ dir, pictures, db }) => {
    const external = path.join(dir, "External");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(pictures, "a.png"), "picture a");
    fs.writeFileSync(path.join(external, "b.png"), "picture b");
    await scanFolders(db, [pictures, external], { now: 1 });
    fs.renameSync(external, path.join(dir, "unplugged"));
    const result = await scanFolders(db, [pictures, external], { now: 2 });
    assert.deepEqual(result.unreadable, [external]);
    assert.equal(result.removed, 0);
    assert.equal(md5Paths(db).get(md5("picture b")), path.join(external, "b.png"));
  });
});

test("a file that cannot be read keeps its earlier md5 and is read again next time", async () => {
  await withFolder(async ({ pictures, db }) => {
    const file = path.join(pictures, "a.png");
    fs.writeFileSync(file, "picture a");
    await scanFolders(db, [pictures], { now: 1 });
    fs.writeFileSync(file, "picture a, edited");
    const locked = await scanFolders(db, [pictures], { now: 2, hashFile: async () => { throw new Error("EBUSY"); } });
    assert.deepEqual({ failed: locked.failed, removed: locked.removed }, { failed: 1, removed: 0 });
    assert.equal(md5Paths(db).get(md5("picture a")), file);
    const later = await scanFolders(db, [pictures], { now: 3 });
    assert.equal(later.hashed, 1);
    assert.equal(md5Paths(db).get(md5("picture a, edited")), file);
  });
});

test("a file saved by the tool counts right away", async () => {
  await withFolder(async ({ pictures, db }) => {
    const file = path.join(pictures, "new.png");
    fs.writeFileSync(file, "saved picture");
    recordFile(db, file, md5("saved picture"));
    assert.equal(md5Paths(db).get(md5("saved picture")), file);
  });
});

test("a file named after an md5 is found by that name too (QQ names a re-compressed save after the original)", async () => {
  await withFolder(async ({ pictures, db }) => {
    const original = "ABCDEF0123456789ABCDEF0123456789";
    fs.writeFileSync(path.join(pictures, `${original}.jpg`), "re-compressed bytes");
    fs.writeFileSync(path.join(pictures, `${original.toLowerCase().replace("a", "b")}_1.png`), "other");
    fs.writeFileSync(path.join(pictures, "holiday.png"), "not named after an md5");
    fs.writeFileSync(path.join(pictures, "QQ收藏_20260915-200912_0123456789abcdef0123456789abcdef.jpg"), "saved by the tool");
    await scanFolders(db, [pictures]);
    const byName = nameMd5Paths(db);
    assert.equal(byName.get(original.toLowerCase()), path.join(pictures, `${original}.jpg`));
    assert.equal(byName.get("0123456789abcdef0123456789abcdef"), path.join(pictures, "QQ收藏_20260915-200912_0123456789abcdef0123456789abcdef.jpg"));
    assert.equal(byName.size, 3);
  });
});
