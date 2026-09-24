"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const files = require("../src/backup_files");

const setupFolder = () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "backup-files-"));
  const month = path.join(target, "群_1001", "2026-09");
  fs.mkdirSync(month, { recursive: true });
  fs.writeFileSync(path.join(month, "20260921-001455_A_dc28c8bb_缩略图.jpg"), "thumb");
  fs.writeFileSync(path.join(month, "20260921-001455_A_dc28c8bb_缩略图.txt"), "prompt");
  fs.writeFileSync(path.join(target, "outside.jpg"), "keep");
  return { target, month };
};

test("a better copy removes the thumbnail it replaces, and nothing else", () => {
  const { target, month } = setupFolder();
  files.removeSuperseded(target, { status: "thumb", path: "群_1001/2026-09/20260921-001455_A_dc28c8bb_缩略图.jpg" });
  assert.deepEqual(fs.readdirSync(month), []);

  // Originals are never removed, and a ledger path can never leave the folder.
  fs.writeFileSync(path.join(month, "keep.jpg"), "original");
  files.removeSuperseded(target, { status: "original", path: "群_1001/2026-09/keep.jpg" });
  files.removeSuperseded(target, { status: "thumb", path: "../outside.jpg" });
  files.removeSuperseded(target, { status: "thumb", path: "群_1001/../../outside.jpg" });
  files.removeSuperseded(target, undefined);
  assert.deepEqual(fs.readdirSync(month), ["keep.jpg"]);
  assert.equal(fs.readFileSync(path.join(target, "outside.jpg"), "utf8"), "keep");
});

test("only better copies are worth re-saving", () => {
  assert.equal(files.isImprovement("original", null), true);
  assert.equal(files.isImprovement("original", "thumb"), true);
  assert.equal(files.isImprovement("compressed", "thumb"), true);
  assert.equal(files.isImprovement("thumb", "thumb"), false);
  assert.equal(files.isImprovement("thumb", "compressed"), false);
});

test("thumbnails are recognised by folder or by QQ's <md5>_<size> name", () => {
  assert.equal(files.isThumbnail("C:\\nt_data\\Pic\\2026-09\\Thumb\\a.jpg"), true);
  assert.equal(files.isThumbnail(`/nt_data/Pic/2026-09/Ori/${"a".repeat(32)}_720.jpg`), true);
  assert.equal(files.isThumbnail(`/nt_data/Pic/2026-09/Ori/${"a".repeat(32)}.jpg`), false);
});

test("the remote CDN is only asked for well-formed md5s", () => {
  assert.equal(files.canTryRemote({ kind: "image", hash: "a".repeat(32) }), true);
  assert.equal(files.canTryRemote({ kind: "image", hash: "../../x" }), false);
  assert.equal(files.canTryRemote({ kind: "video", hash: "a".repeat(32) }), false);
});
