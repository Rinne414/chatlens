"use strict";

// v0.0.14: picture elements are not message text, stickers are recorded and
// labeled, and rows stored by earlier versions are repaired once.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");
const messageStore = require("../src/message_store");
const pictureStore = require("../src/picture_store");
const { ensureBriefingSchema, getState } = require("../src/briefing_store");
const { messagePictures, STICKER_SEQ_BASE } = require("../src/picture_elements");
const { getMessageText, labelStickerRefs } = require("../src/export_group_recent");
const repair = require("../src/repair_picture_text");

const MD5 = "a9481467651131a7e9c7ea40ac2b6ec4";
const OTHER_MD5 = "6c51f72ed2e9c6ae933453147738719b";
const SENT_AT = 1_700_000_000;

const writeVarint = (value) => {
  const bytes = [];
  let rest = value;
  do {
    const piece = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? piece | 0x80 : piece);
  } while (rest > 0);
  return Buffer.from(bytes);
};
const fieldVarint = (field, value) => Buffer.concat([writeVarint(field * 8), writeVarint(value)]);
const fieldBytes = (field, payload) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return Buffer.concat([writeVarint(field * 8 + 2), writeVarint(data.length), data]);
};

// A picture element as QQ stores it, with the strings the old extractor
// mistook for text: file name, summary and host.
const pictureElement = (md5, { subType = 0 } = {}) => Buffer.concat([
  fieldVarint(45002, 2),
  fieldVarint(45003, subType),
  fieldBytes(45402, `${md5.toUpperCase()}.jpg`),
  fieldVarint(45405, 30000),
  fieldBytes(45406, Buffer.from(md5, "hex")),
  fieldVarint(45416, 1000),
  fieldBytes(45804, `/download?appid=1407&fileid=f${md5.slice(0, 6)}&spec=0`),
  fieldBytes(45815, subType === 0 ? "[图片]" : "[动画表情]"),
  fieldBytes(45816, "multimedia.nt.qq.com.cn"),
]);
const textElement = (text) => Buffer.concat([fieldVarint(45002, 1), fieldBytes(45101, text)]);
const body = (...elements) => Buffer.concat(elements.map((element) => fieldBytes(40800, element))).toString("hex");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qq-picture-text-"));

test("message text leaves picture and sticker elements out", () => {
  assert.equal(getMessageText(body(textElement("今天好热"), pictureElement(MD5))), "今天好热");
  assert.equal(getMessageText(body(pictureElement(MD5, { subType: 1 }))), "");
  assert.equal(getMessageText(body(pictureElement(MD5), pictureElement(OTHER_MD5, { subType: 1 }))), "");
  // A reply quoting a picture keeps the reply's text only.
  const reply = Buffer.concat([fieldVarint(45002, 7), fieldBytes(47423, fieldBytes(40800, pictureElement(OTHER_MD5)))]);
  assert.equal(getMessageText(body(reply, textElement("好看"))), "好看");
});

test("stickers are flagged, numbered apart, and labeled as stickers", () => {
  const pictures = messagePictures(body(pictureElement(MD5, { subType: 1 }), pictureElement(OTHER_MD5)));
  assert.deepEqual(pictures.map((picture) => [picture.md5, picture.sticker, picture.seq]), [
    [OTHER_MD5, false, 0],
    [MD5, true, STICKER_SEQ_BASE],
  ]);
  const refs = labelStickerRefs([
    { kind: "image", hash: MD5, fileName: `${MD5}.jpg` },
    { kind: "image", hash: OTHER_MD5, fileName: `${OTHER_MD5}.jpg` },
  ], pictures);
  assert.deepEqual(refs.map((ref) => ref.kind), ["sticker", "image"]);
});

test("media rows keep only a shared file's name and list sticker kinds", () => {
  assert.deepEqual(messageStore.mediaText({ mediaRefs: [{ kind: "sticker", fileName: `${MD5}.jpg` }], pictures: [{ sticker: true }] }), { kinds: "sticker", text: "" });
  assert.deepEqual(messageStore.mediaText({ mediaRefs: [{ kind: "image", fileName: `${MD5}.jpg` }], pictures: [{ sticker: false }] }), { kinds: "image", text: "" });
  assert.deepEqual(messageStore.mediaText({ mediaRefs: [{ kind: "file", fileName: "报告.pdf" }] }), { kinds: "file", text: "报告.pdf" });
  assert.deepEqual(messageStore.mediaText({ mediaRefs: [{ kind: "video", fileName: "录屏 0924.mp4" }] }), { kinds: "video", text: "录屏 0924.mp4" });
  assert.deepEqual(messageStore.mediaText({ mediaRefs: [{ kind: "video", fileName: `${MD5.toUpperCase()}.mp4` }] }), { kinds: "video", text: "" });
});

test("stickers get thumbnails but never an AI check or a kept original", () => {
  const dir = tempDir();
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    const base = { groupId: "7", fileId: "fid", legacyPath: "", size: 900_000, width: 512, height: 512, format: 1001, sentAt: SENT_AT, expiresAt: SENT_AT + 1000 };
    pictureStore.ingestPictures(db, [
      { ...base, rowId: "m1", seq: STICKER_SEQ_BASE, md5: MD5, sticker: true },
      { ...base, rowId: "m2", seq: 0, md5: OTHER_MD5, sticker: false },
    ]);
    const md5s = (rows) => rows.map((row) => row.md5).sort();
    assert.deepEqual(md5s(pictureStore.needingThumbs(db, { now: SENT_AT, limit: 10 })), [OTHER_MD5, MD5].sort());
    assert.deepEqual(md5s(pictureStore.needingProbe(db, { now: SENT_AT, limit: 10 })), [OTHER_MD5]);
    assert.deepEqual(md5s(pictureStore.needingKeep(db, { now: SENT_AT, limit: 10, groupIds: ["7"] })), [OTHER_MD5]);
    assert.equal(pictureStore.picturesForRows(db, "7", ["m1"]).get("m1")[0].sticker, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a pictures table from before stickers were recorded gets the column on open", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "messages.db");
  const old = new Database(dbPath);
  // The v0.0.13 table: everything but the sticker column.
  old.prepare(`CREATE TABLE pictures (
    group_id TEXT NOT NULL, row_id TEXT NOT NULL, seq INTEGER NOT NULL, md5 TEXT NOT NULL,
    file_id TEXT NOT NULL DEFAULT '', legacy_path TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, format INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, row_id, seq))`).run();
  old.close();
  const db = messageStore.openStore(dbPath);
  try {
    assert.equal(db.prepare("PRAGMA table_info(pictures)").all().some((column) => column.name === "sticker"), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the one-time repair re-extracts stored rows and records that it ran", () => {
  const dir = tempDir();
  const db = ensureBriefingSchema(messageStore.openStore(path.join(dir, "messages.db")));
  try {
    const insert = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds) VALUES ('7', ?, ?, 'Ann', ?, ?, ?)");
    const leftover = `${MD5.toUpperCase()}.jpg [动画表情] multimedia.nt.qq.com.cn`;
    insert.run("101", SENT_AT, leftover, 0, "");
    insert.run("102", SENT_AT, `今天好热 ${leftover}`, 0, "");
    insert.run("103", SENT_AT, "普通的一句话", 0, "");
    insert.run("104", SENT_AT, leftover, 0, "");
    // Someone typed a lone md5-like file name; QQ no longer has the message.
    insert.run("107", SENT_AT, `${OTHER_MD5.toUpperCase()}.jpg`, 0, "");
    // A repost: earlier exports gave it no media row, only the leftover text.
    insert.run("106", SENT_AT + 5, leftover, 0, "");
    insert.run("m101", SENT_AT, "9481467651131 40 ayEko", 1, "image");
    insert.run("m105", SENT_AT, "报告.pdf", 1, "file");
    const bodies = {
      101: body(pictureElement(MD5, { subType: 1 })),
      102: body(textElement("今天好热"), pictureElement(MD5, { subType: 1 })),
      106: body(pictureElement(MD5, { subType: 1 })),
    };
    // 104 and 105 are no longer in QQ: cleaned by shape / left alone.
    const bodyOf = (groupId, rowId) => bodies[String(rowId).replace(/^m/u, "")] ?? null;

    const result = repair.repairStore({ store: db, bodyOf, now: SENT_AT });
    assert.deepEqual(result.text, { checked: 5, fromQq: 3, byShape: 1, updated: 1, removed: 3, mediaAdded: 2 });
    const text = (rowId) => db.prepare("SELECT text, media_kinds AS kinds FROM messages WHERE row_id = ?").get(rowId);
    assert.equal(text("101"), undefined);
    assert.equal(text("102").text, "今天好热");
    assert.equal(text("103").text, "普通的一句话");
    assert.equal(text("104"), undefined);
    assert.deepEqual(text("m101"), { text: "", kinds: "sticker" });
    assert.deepEqual(text("m105"), { text: "报告.pdf", kinds: "file" });
    // Picture-only messages without a media row keep their picture.
    assert.equal(text("106"), undefined);
    assert.deepEqual(text("m106"), { text: "", kinds: "sticker" });
    assert.deepEqual(text("m104"), { text: "", kinds: "sticker" });
    // Without the body and without the picture host, the text is left alone.
    assert.equal(text("107").text, `${OTHER_MD5.toUpperCase()}.jpg`);
    assert.equal(text("m107"), undefined);
    assert.equal(db.prepare("SELECT speaker, sent_at AS sentAt FROM messages WHERE row_id = 'm106'").get().sentAt, SENT_AT + 5);
    assert.deepEqual(getState(db, repair.REPAIR_STATE_KEY, null), { doneAt: SENT_AT });
    assert.equal(repair.stripLeftovers(`好 ${leftover}`), "好");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the chat shows stickers small and plays the original on click", () => {
  const messages = fs.readFileSync(path.join(__dirname, "..", "web", "messages.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "web", "app.css"), "utf8");
  assert.match(messages, /picture\.sticker \? remoteStickerNode\(picture\) : remotePictureNode\(picture\)/u);
  assert.match(messages, /pictureUrl\(picture\.md5, "original"\)/u);
  assert.match(css, /\.bubble-sticker \{[^}]*max-width: 140px/u);
});
