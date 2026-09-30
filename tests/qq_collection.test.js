"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pictureElements, collectionPictures, syncInfo, copyCollectionDb, collectorUrl } = require("../src/qq_collection");

const varint = (value) => {
  const bytes = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const tag = (fieldNumber, wireType) => varint(fieldNumber * 8 + wireType);
const vField = (fieldNumber, value) => Buffer.concat([tag(fieldNumber, 0), varint(value)]);
const bField = (fieldNumber, payload) => Buffer.concat([tag(fieldNumber, 2), varint(payload.length), payload]);

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const md5Hex = (seed) => seed.repeat(32).slice(0, 32);

// The real nesting: 180015 { 180657 { 181453 { picture } } }; QQ stores the
// URL with a trailing slash and no size.
const picture = (md5, uuid, width = 800, height = 600, sizeSuffix = "") => bField(181453, Buffer.concat([
  bField(180550, Buffer.from(`http://shp.qpic.cn/collector/10001/${uuid}/${sizeSuffix}`)),
  bField(180551, Buffer.from(md5, "hex")),
  bField(180553, Buffer.from(md5)),
  vField(180555, width),
  vField(180556, height),
  vField(180557, 12345),
]));
const content = (...pictures) => bField(180015, bField(180657, Buffer.concat(pictures)));

test("reads every picture element: md5, collector id and size", () => {
  const blob = content(picture(md5Hex("a"), UUID_A, 1280, 1962), picture(md5Hex("b"), UUID_B, 800, 600, "0"));
  assert.deepEqual(pictureElements(blob), [
    { md5: md5Hex("a"), uin: "10001", uuid: UUID_A, width: 1280, height: 1962 },
    { md5: md5Hex("b"), uin: "10001", uuid: UUID_B, width: 800, height: 600 },
  ]);
  assert.deepEqual(pictureElements(null), []);
  assert.deepEqual(pictureElements(Buffer.from([0xff, 0xff])), []);
});

test("one entry per picture, newest collection first; a picture collected twice sits at its latest time", () => {
  const rows = [
    { id: "1", type: 8, ts: 1000, b15: content(picture(md5Hex("a"), UUID_A)) },
    { id: "2", type: 8, ts: 3000, b15: content(picture(md5Hex("a"), UUID_A), picture(md5Hex("b"), UUID_B)) },
    { id: "3", type: 6, ts: 4000, b15: content(picture(md5Hex("c"), UUID_A)) },
    { id: "4", type: null, ts: null, b15: null },
  ];
  const pictures = collectionPictures(rows, (text) => (text.includes(UUID_B) ? ["L:/local/b.png"] : []));
  assert.deepEqual(pictures.map((item) => [item.md5, item.collectedAt]), [[md5Hex("a"), 3000], [md5Hex("b"), 3000]]);
  assert.deepEqual(pictures[1].localFiles, ["L:/local/b.png"]);
});

test("sync info: newest synced item, last contact with the server, placeholders", () => {
  const info = syncInfo([
    { key: "Collection_Top_Timstamp", value: "1789474152377" },
    { key: "Collection_ModiGroupId_Timstamp", value: "1790745140" },
    { key: "Collection_Get_Bottom_End_NEW", value: "true" },
  ], [{ type: 8 }, { type: null }, { type: null }]);
  assert.deepEqual(info, { newestAt: 1789474152377, checkedAt: 1790745140000, placeholders: 2, rows: 3 });
});

test("the copy strips QQ's fake header and brings the WAL along", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-collection-copy-"));
  try {
    const source = path.join(dir, "nt_db");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "collection.db"), Buffer.concat([Buffer.from("SQLite header 3\0", "latin1"), Buffer.alloc(1008), Buffer.from("DATA")]));
    fs.writeFileSync(path.join(source, "collection.db-wal"), "WAL");
    const target = copyCollectionDb(source, path.join(dir, "copy"));
    assert.equal(fs.readFileSync(target, "utf8"), "DATA");
    assert.equal(fs.readFileSync(`${target}-wal`, "utf8"), "WAL");
    assert.equal(fs.existsSync(`${target}-shm`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collector URLs: original is size 0, thumbnails by width", () => {
  assert.equal(collectorUrl({ uin: "10001", uuid: UUID_A }), `https://shp.qpic.cn/collector/10001/${UUID_A}/0`);
  assert.equal(collectorUrl({ uin: "10001", uuid: UUID_A }, 200), `https://shp.qpic.cn/collector/10001/${UUID_A}/200`);
});
