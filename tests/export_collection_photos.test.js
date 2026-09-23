"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectPhotoJobs,
  collectorUrl,
  extractCollectorRefs,
  extractFileMeta,
  extractOriPaths,
  kindForRow,
  remapNtDataPath,
  sanitizeFileName,
} = require("../src/export_collection_photos");

const encodeVarint = (value) => {
  const bytes = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
};

const encodeLengthDelimited = (fieldNumber, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(body.length), body]);
};

test("extracts collector uuid without trailing protobuf junk", () => {
  const text = "XMhttp://shp.qpic.cn/collector/10001/11111111-2222-3333-4444-555555555555/\u0000X";
  assert.deepEqual(extractCollectorRefs(text), [
    { uin: "10001", uuid: "11111111-2222-3333-4444-555555555555" },
  ]);
});

test("extracts Ori paths and ignores Thumb", () => {
  const text = [
    "C:\\Users\\User\\Documents\\Tencent Files\\10001\\nt_qq\\nt_data\\Pic\\2025-10\\Thumb\\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_128.jpg",
    "C:\\Users\\User\\Documents\\Tencent Files\\10001\\nt_qq\\nt_data\\Pic\\2025-10\\Ori\\cccccccccccccccccccccccccccccccc.jpg",
  ].join("\n");
  assert.deepEqual(extractOriPaths(text), [
    "C:\\Users\\User\\Documents\\Tencent Files\\10001\\nt_qq\\nt_data\\Pic\\2025-10\\Ori\\cccccccccccccccccccccccccccccccc.jpg",
  ]);
});

test("remaps historic Documents path onto the live nt_data directory", () => {
  const mapped = remapNtDataPath(
    "C:\\Users\\User\\Documents\\Tencent Files\\10001\\nt_qq\\nt_data\\Pic\\2025-10\\Ori\\abc.jpg",
    "L:\\Tencent Files\\Tencent Files\\10001\\nt_qq\\nt_data",
  );
  assert.equal(
    mapped,
    path.join("L:\\Tencent Files\\Tencent Files\\10001\\nt_qq\\nt_data", "Pic", "2025-10", "Ori", "abc.jpg"),
  );
});

test("collector original URL uses /0", () => {
  assert.equal(
    collectorUrl("10001", "11111111-2222-3333-4444-555555555555"),
    "https://shp.qpic.cn/collector/10001/11111111-2222-3333-4444-555555555555/0",
  );
});

test("collectPhotoJobs binds a single Ori file to its collector uuid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "colpic-"));
  const ori = path.join(root, "Pic", "2025-10", "Ori");
  fs.mkdirSync(ori, { recursive: true });
  const localPath = path.join(ori, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg");
  fs.writeFileSync(localPath, "fake");
  const recorded = `C:\\Users\\User\\Documents\\Tencent Files\\1\\nt_qq\\nt_data\\Pic\\2025-10\\Ori\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg`;
  const blob = Buffer.from(
    `http://shp.qpic.cn/collector/1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/\n${recorded}`,
  );
  const { remoteJobs, extraJobs } = collectPhotoJobs(
    [{ id: "1-1-x", ts: 1760533025317, b4: blob, b15: null }],
    root,
  );
  assert.equal(extraJobs.length, 0);
  assert.equal(remoteJobs.length, 1);
  assert.equal(remoteJobs[0].uuid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(remoteJobs[0].localPath, localPath);
});

test("sanitizes Windows-forbidden filename characters", () => {
  assert.equal(sanitizeFileName('画师tag:<>.xls'), "画师tag___.xls");
});

test("type 8 without media is filed as text, files stay in files", () => {
  assert.equal(kindForRow(8, false), "text");
  assert.equal(kindForRow(8, true), "photos");
  assert.equal(kindForRow(6, true), "files");
  assert.equal(kindForRow(5, true), "videos");
  assert.equal(kindForRow(2, true), "links");
  assert.equal(kindForRow(4, false), "text");
});

test("extractFileMeta reads name and md5 from protobuf", () => {
  const md5 = Buffer.from("25bcbb436672066a7c4e9f121afb89ac", "hex");
  const buf = Buffer.concat([
    encodeLengthDelimited(180604, "画师tag.xls"),
    encodeLengthDelimited(180606, md5),
    encodeLengthDelimited(180603, "cf6142b2ad86046662bdeb5f0ee71746/7d6b9952-eeb3-4745-be57-ede7c6cee6be"),
  ]);
  assert.deepEqual(extractFileMeta(buf), {
    fileName: "画师tag.xls",
    md5s: ["25bcbb436672066a7c4e9f121afb89ac"],
    fileIds: ["cf6142b2ad86046662bdeb5f0ee71746/7d6b9952-eeb3-4745-be57-ede7c6cee6be"],
    size: null,
  });
});
