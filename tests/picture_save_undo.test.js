"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pictureStore = require("../src/picture_store");
const gallery = require("../src/gallery_store");
const { undoSave, noteMade, UNDO_WINDOW_SECONDS } = require("../src/picture_save_undo");

const A = "a".repeat(32);
const B = "b".repeat(32);
const NOW = Math.floor(Date.now() / 1000);

// A store and a folder of the user's with one picture (and its prompt file)
// saved into it just now, the way the export does it.
const withSavedPicture = (work, { sidecar = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-"));
  const folder = path.join(root, "好图");
  fs.mkdirSync(folder);
  const db = messageStore.openStore(path.join(root, "messages.db"));
  try {
    fs.writeFileSync(path.join(folder, "pic.png"), "picture");
    if (sidecar) {
      fs.writeFileSync(path.join(folder, "pic.txt"), "prompt");
    }
    pictureStore.recordSave(db, { md5: A, dir: folder, file: "pic.png", savedAt: NOW });
    noteMade(folder, "pic.png", { sidecar });
    work({ db, folder });
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const marks = (db) => pictureStore.savesOf(db, A).length;
const undo = (db, folder, extra = {}) => undoSave(db, { md5: A, dir: folder, file: "pic.png", nowUnix: NOW + 30, ...extra });

test("a save just made is taken back: the copy, its prompt file and the mark", () => {
  withSavedPicture(({ db, folder }) => {
    assert.equal(undo(db, folder), "undone");
    assert.deepEqual(fs.readdirSync(folder), []);
    assert.equal(marks(db), 0);
  });
});

test("a file the user put there, or another picture's name, is never removed", () => {
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "mine.png"), "mine");
    assert.equal(undo(db, folder, { file: "mine.png" }), "not-ours");
    assert.equal(undo(db, folder, { md5: B }), "not-ours");
    assert.equal(undo(db, path.dirname(folder)), "not-ours");
    assert.deepEqual(fs.readdirSync(folder).sort(), ["mine.png", "pic.png", "pic.txt"]);
    assert.equal(marks(db), 1);
  });
});

test("a name that points outside the folder is refused", () => {
  withSavedPicture(({ db, folder }) => {
    const outside = path.join(path.dirname(folder), "outside.png");
    fs.writeFileSync(outside, "x");
    pictureStore.recordSave(db, { md5: A, dir: folder, file: "..\\outside.png", savedAt: NOW });
    noteMade(path.dirname(folder), "outside.png");
    assert.equal(undo(db, folder, { file: "..\\outside.png" }), "not-ours");
    assert.equal(undo(db, folder, { file: "../outside.png" }), "not-ours");
    assert.ok(fs.existsSync(outside));
  });
});

test("a copy changed in any way after the save stays, even with an old file time", () => {
  // Edited: another size.
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "pic.png"), "picture, edited");
    assert.equal(undo(db, folder), "changed");
  });
  // Replaced by a file of the same size with an older time.
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "pic.png"), "PICTURE");
    const earlier = new Date((NOW - 5000) * 1000);
    fs.utimesSync(path.join(folder, "pic.png"), earlier, earlier);
    assert.equal(undo(db, folder), "changed");
    assert.equal(fs.readFileSync(path.join(folder, "pic.png"), "utf8"), "PICTURE");
    assert.equal(marks(db), 1);
  });
});

test("a save from long ago, or one this run of the console did not make, stays", () => {
  withSavedPicture(({ db, folder }) => {
    assert.equal(undo(db, folder, { nowUnix: NOW + UNDO_WINDOW_SECONDS + 1 }), "too-old");
    assert.ok(fs.existsSync(path.join(folder, "pic.png")));
  });
  withSavedPicture(({ db, folder }) => {
    // The mark is there, but nothing noted the file being written (a restart since).
    fs.writeFileSync(path.join(folder, "old.png"), "old");
    pictureStore.recordSave(db, { md5: A, dir: folder, file: "old.png", savedAt: NOW });
    assert.equal(undo(db, folder, { file: "old.png" }), "changed");
    assert.ok(fs.existsSync(path.join(folder, "old.png")));
  });
});

test("a prompt file the save did not write, or that was edited, is left", () => {
  // The user's own text file of the same name, there before the save.
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "pic.txt"), "my notes");
    assert.equal(undo(db, folder), "undone");
    assert.deepEqual(fs.readdirSync(folder), ["pic.txt"]);
  }, { sidecar: false });
  // Written by the save, edited since.
  withSavedPicture(({ db, folder }) => {
    fs.writeFileSync(path.join(folder, "pic.txt"), "prompt, with my notes");
    assert.equal(undo(db, folder), "undone");
    assert.deepEqual(fs.readdirSync(folder), ["pic.txt"]);
  });
});

test("a copy already deleted only loses its mark; one that cannot be removed changes nothing", () => {
  withSavedPicture(({ db, folder }) => {
    fs.rmSync(path.join(folder, "pic.png"));
    assert.equal(undo(db, folder), "gone");
    assert.equal(marks(db), 0);
    assert.ok(fs.existsSync(path.join(folder, "pic.txt")));
  });
  withSavedPicture(({ db, folder }) => {
    // A folder now sits where the copy was: removing it as a file fails.
    fs.rmSync(path.join(folder, "pic.png"));
    fs.mkdirSync(path.join(folder, "pic.png"));
    assert.equal(undo(db, folder), "changed");
    assert.equal(marks(db), 1);
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
