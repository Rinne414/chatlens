"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { newFolderName, isFolderName, extensionOf, fileStem, uniqueName } = require("../src/picture_export");

const MD5 = "6d8112a1866a99617d1f2212e67aee23";
// 2026-09-24 20:53:07 Beijing time.
const SENT_AT = Date.UTC(2026, 8, 24, 12, 53, 7) / 1000;

test("export folders are named by Beijing time and nothing else is accepted", () => {
  assert.equal(newFolderName(SENT_AT), "picture-export-20260924-205307");
  assert.equal(isFolderName("picture-export-20260924-205307"), true);
  assert.equal(isFolderName("../picture-export-20260924-205307"), false);
  assert.equal(isFolderName("picture-export-20260924-205307/.."), false);
  assert.equal(isFolderName("C:\\Windows"), false);
  assert.equal(isFolderName(null), false);
});

test("file names say when, where and who, with unsafe characters replaced", () => {
  assert.equal(fileStem(MD5, { sentAt: SENT_AT, groupName: "AI朋友交流群", speaker: "青苇" }), "20260924-2053_AI朋友交流群_青苇_6d8112a1");
  assert.equal(fileStem(MD5, { sentAt: SENT_AT, groupName: "a/b:c", speaker: "x?y" }), "20260924-2053_a_b_c_x_y_6d8112a1");
  assert.equal(fileStem(MD5, null), "6d8112a1");
});

test("a second export of the same name gets a number instead of overwriting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pexport-"));
  try {
    assert.equal(uniqueName(dir, "pic", ".png"), "pic.png");
    fs.writeFileSync(path.join(dir, "pic.png"), "x");
    assert.equal(uniqueName(dir, "pic", ".png"), "pic (2).png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("everything the export route imports from other modules exists", () => {
  // Guards the failure where the route loaded fine but threw on first use
  // because a helper it destructures was never exported.
  const knowledgeExport = require("../src/knowledge_export");
  assert.equal(typeof knowledgeExport.promptFor, "function");
  assert.equal(typeof knowledgeExport.sidecarText, "function");
  const jobs = require("../src/server/picture_jobs");
  assert.equal(typeof jobs.originalFile, "function");
  const ops = require("../src/server/picture_export_ops");
  assert.equal(typeof ops.exportPictures, "function");
  assert.equal(typeof ops.openExportFolder, "function");
});

test("originals stored without an extension get one from their first bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pexport-"));
  try {
    const png = path.join(dir, "noext");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    assert.equal(extensionOf(png), ".png");
    const jpg = path.join(dir, "photo.JPEG");
    fs.writeFileSync(jpg, "x");
    assert.equal(extensionOf(jpg), ".jpg");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
