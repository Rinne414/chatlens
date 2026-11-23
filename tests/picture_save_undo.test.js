"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pictureStore = require("../src/picture_store");
const gallery = require("../src/gallery_store");
const { undoSave, UNDO_WINDOW_SECONDS } = require("../src/picture_save_undo");

const A = "a".repeat(32);
const B = "b".repeat(32);
const NOW = Math.floor(Date.now() / 1000);

// A store and a folder of the user's with one picture saved into it just now.
const withSavedPicture = (work) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-"));
  const folder = path.join(root, "好图");
  fs.mkdirSync(folder);
  const db = messageStore.openStore(path.join(root, "messages.db"));
  try {
    fs.writeFileSync(path.join(folder, "pic.png"), "picture");
    fs.writeFileSync(path.join(folder, "pic.txt"), "prompt");
    pictureStore.recordSave(db, { md5: A, dir: folder, file: "pic.png", savedAt: NOW });
    work({ db, folder });
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const marks = (db) => pictureStore.savesOf(db, A).length;

test("a save just made is taken back: the copy, its prompt file and the mark", () => {
  withSavedPicture(({ db, folder }) => {
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + 30 }), "undone");
    assert.deepEqual(fs.readdirSync(folder), []);
    assert.equal(marks(db), 0);
  });
});

test("a file the user put there, or another picture's name, is never removed", () => {
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "mine.png"), "mine");
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "mine.png", nowUnix: NOW + 30 }), "not-ours");
    assert.equal(undoSave(db, { md5: B, dir: folder, file: "pic.png", nowUnix: NOW + 30 }), "not-ours");
    assert.equal(undoSave(db, { md5: A, dir: path.dirname(folder), file: "pic.png", nowUnix: NOW + 30 }), "not-ours");
    assert.deepEqual(fs.readdirSync(folder).sort(), ["mine.png", "pic.png", "pic.txt"]);
    assert.equal(marks(db), 1);
  });
});

test("a name that points outside the folder is refused", () => {
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(path.dirname(folder), "outside.png"), "x");
    pictureStore.recordSave(db, { md5: A, dir: folder, file: "..\\outside.png", savedAt: NOW });
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "..\\outside.png", nowUnix: NOW + 30 }), "not-ours");
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "../outside.png", nowUnix: NOW + 30 }), "not-ours");
    assert.ok(fs.existsSync(path.join(path.dirname(folder), "outside.png")));
  });
});

test("a copy edited after the save, or saved long ago, stays", () => {
  withSavedPicture(({ db, folder }) => {
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + UNDO_WINDOW_SECONDS + 1 }), "too-old");
    const later = new Date((NOW + 600) * 1000);
    fs.utimesSync(path.join(folder, "pic.png"), later, later);
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + 700 }), "changed");
    assert.ok(fs.existsSync(path.join(folder, "pic.png")));
    assert.equal(marks(db), 1);
  });
});

test("a prompt file written at another time is left; a copy already deleted only loses its mark", () => {
  withSavedPicture(({ db, folder }) => {
    const earlier = new Date((NOW - 5000) * 1000);
    fs.utimesSync(path.join(folder, "pic.txt"), earlier, earlier);
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + 30 }), "undone");
    assert.deepEqual(fs.readdirSync(folder), ["pic.txt"]);
  });
  withSavedPicture(({ db, folder }) => {
    fs.rmSync(path.join(folder, "pic.png"));
    assert.equal(undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + 30 }), "gone");
    assert.equal(marks(db), 0);
    assert.ok(fs.existsSync(path.join(folder, "pic.txt")));
  });
});

test("the date rail counts each picture once, on the day of its newest posting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "days-"));
  const db = messageStore.openStore(path.join(root, "messages.db"));
  try {
    const picture = db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker)
      VALUES (?, ?, 0, ?, 800, 600, 1000, 1001, ?, 0, 0)`);
    // 2026-01-10 00:30 and 2026-01-11 23:30 in UTC+8.
    const dayOne = Date.UTC(2026, 0, 9, 16, 30) / 1000;
    const dayTwo = Date.UTC(2026, 0, 11, 15, 30) / 1000;
    picture.run("1", "r1", A, dayOne);
    picture.run("2", "r2", A, dayTwo);
    picture.run("1", "r3", B, dayOne);
    const all = { fromUnix: 1, toUnix: dayTwo + 86400 };
    assert.deepEqual(gallery.pictureDays(db, all), [{ day: "2026-01-11", n: 1 }, { day: "2026-01-10", n: 1 }]);
    assert.deepEqual(gallery.pictureDays(db, { ...all, groupId: "1" }), [{ day: "2026-01-10", n: 2 }]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
