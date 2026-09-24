"use strict";

// One-time repair (v0.0.14) of rows stored by earlier versions.
// - Text rows: the text extractor used to read picture elements too, so a
//   sticker-only message was stored as "<MD5>.jpg [动画表情] multimedia.nt.qq.com.cn"
//   (about a third of all text rows). Each affected row is read again from
//   QQ's database by its row id (the primary key) and re-extracted; a row
//   left without text is removed, and its picture is kept as a media row:
//   earlier exports gave a picture only to its FIRST post in a group (to
//   skip quotes), so a repost had nothing but the leftover text row.
//   Rows QQ no longer has are cleaned by shape instead.
// - Media rows: their text was a protobuf snippet ("9481467651131 40 ...").
//   Only a shared file's name is kept, and rows whose own pictures are all
//   stickers get the "sticker" kind.
//
//   NTQQ_DB_KEY=... node src/repair_picture_text.js <qqMessageDb> <storeDb>
// Prints one line: repairResult={...json}

const Database = require("better-sqlite3-multiple-ciphers");
const messageStore = require("./message_store");
const { ensureBriefingSchema, setState } = require("./briefing_store");
const { getMessageText, extractMediaRefs, labelStickerRefs } = require("./export_group_recent");
const { messagePictures } = require("./picture_elements");

const REPAIR_STATE_KEY = "picture_text_repair_v1";
const LEFTOVER = /(?:\{[0-9A-Fa-f-]{36}\}|[0-9A-Fa-f]{32})\.[A-Za-z0-9]{2,5}|multimedia\.nt\.qq\.com\.cn/u;
const LEFTOVER_ALL = /(?:\{[0-9A-Fa-f-]{36}\}|[0-9A-Fa-f]{32})\.[A-Za-z0-9]{2,5}(?: \[[^\]\n]{1,20}\])?|multimedia\.nt\.qq\.com\.cn/gu;

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

const openQq = (databasePath, key) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  for (const pragma of ["cipher='sqlcipher'", "legacy=4", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"]) {
    db.pragma(pragma);
  }
  db.pragma(`key=${sqlQuote(key)}`);
  db.pragma("query_only=ON");
  return db;
};

// Without the QQ body, only text carrying the picture host is taken for a
// leftover: every NT picture element wrote it, and a person typing a lone
// md5-like "xxxx.jpg" must not lose that message.
const PICTURE_HOST = /multimedia\.nt\.qq\.com\.cn/u;

// Without the QQ body: drop the leftovers by their shape.
const stripLeftovers = (text) => text.replace(LEFTOVER_ALL, " ").replace(/ {2,}/gu, " ").trim();

// Body of one stored row from QQ, or null when QQ no longer has it (or the
// id belongs to another group, which would mean it is not the same message).
const bodyLookup = (qq) => {
  const stmt = qq.prepare("SELECT [40027] AS groupId, hex([40800]) AS hex FROM group_msg_table WHERE [40001] = ?");
  stmt.safeIntegers(true);
  return (groupId, rowId) => {
    const qqRowId = String(rowId).replace(/^m/u, "");
    if (!/^\d+$/u.test(qqRowId)) {
      return null;
    }
    try {
      const hit = stmt.get(BigInt(qqRowId));
      return hit !== undefined && String(hit.groupId) === String(groupId) && hit.hex ? hit.hex : null;
    } catch {
      return null;
    }
  };
};

// Kinds of the media row a picture-only message should have: from its own
// picture elements, or from the stored leftovers when QQ no longer has it.
const pictureKinds = (hex, text) => {
  if (hex === null) {
    return /\[动画表情\]/u.test(text) ? "sticker" : "image";
  }
  const pictures = messagePictures(hex);
  return [...new Set(pictures.map((picture) => (picture.sticker ? "sticker" : "image")))].join(",");
};

// The media row a removed text row's message still needs. Returns true when
// one was added.
const ensureMediaRow = (store, row, hex) => {
  const mediaRowId = `m${row.rowId}`;
  const exists = store.prepare("SELECT 1 FROM messages WHERE group_id = ? AND row_id = ?").get(row.groupId, mediaRowId) !== undefined;
  const kinds = pictureKinds(hex, row.text);
  if (exists || kinds === "") {
    return false;
  }
  store.prepare(`
    INSERT OR IGNORE INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
    VALUES (?, ?, ?, ?, '', 1, ?, ?)
  `).run(row.groupId, mediaRowId, row.sentAt, row.speaker, kinds, row.speakerUin);
  return true;
};

const repairTextRows = (store, bodyOf) => {
  const rows = store.prepare(`
    SELECT group_id AS groupId, row_id AS rowId, sent_at AS sentAt, speaker, speaker_uin AS speakerUin, text
    FROM messages WHERE is_media = 0
  `).all().filter((row) => LEFTOVER.test(row.text));
  const update = store.prepare("UPDATE messages SET text = ? WHERE group_id = ? AND row_id = ?");
  const remove = store.prepare("DELETE FROM messages WHERE group_id = ? AND row_id = ?");
  const result = { checked: rows.length, fromQq: 0, byShape: 0, updated: 0, removed: 0, mediaAdded: 0 };
  for (const row of rows) {
    const hex = bodyOf(row.groupId, row.rowId);
    if (hex === null && !PICTURE_HOST.test(row.text)) {
      continue;
    }
    const fresh = hex === null ? stripLeftovers(row.text) : messageStore.lightCleanText(getMessageText(hex));
    result[hex === null ? "byShape" : "fromQq"] += 1;
    if (fresh === "") {
      remove.run(row.groupId, row.rowId);
      result.removed += 1;
      if (ensureMediaRow(store, row, hex)) {
        result.mediaAdded += 1;
      }
    } else if (fresh !== row.text) {
      update.run(fresh, row.groupId, row.rowId);
      result.updated += 1;
    }
  }
  return result;
};

const stickerKinds = (kinds) => [...new Set(kinds.split(",").filter(Boolean).map((kind) => (kind === "image" ? "sticker" : kind)))].join(",");

const repairMediaRows = (store, bodyOf) => {
  const rows = store.prepare("SELECT group_id AS groupId, row_id AS rowId, text, media_kinds AS kinds FROM messages WHERE is_media = 1").all();
  const update = store.prepare("UPDATE messages SET text = ?, media_kinds = ? WHERE group_id = ? AND row_id = ?");
  const result = { checked: rows.length, fromQq: 0, updated: 0, stickers: 0 };
  for (const row of rows) {
    const hex = bodyOf(row.groupId, row.rowId);
    let { kinds } = row;
    let text = kinds.split(",").some((kind) => kind === "file" || kind === "video") ? row.text : "";
    if (hex !== null) {
      result.fromQq += 1;
      const pictures = messagePictures(hex);
      // The stored kinds already leave out pictures the message only quoted;
      // only relabel when all of the message's own pictures are stickers.
      if (pictures.length > 0 && pictures.every((picture) => picture.sticker)) {
        kinds = stickerKinds(kinds);
      }
      text = messageStore.mediaText({ mediaRefs: labelStickerRefs(extractMediaRefs(hex), pictures) }).text;
    }
    if (kinds !== row.kinds) {
      result.stickers += 1;
    }
    if (text !== row.text || kinds !== row.kinds) {
      update.run(text, kinds, row.groupId, row.rowId);
      result.updated += 1;
    }
  }
  return result;
};

const repairStore = ({ store, bodyOf, now = Math.floor(Date.now() / 1000) }) => {
  let result = null;
  store.transaction(() => {
    result = { text: repairTextRows(store, bodyOf), media: repairMediaRows(store, bodyOf) };
    setState(store, REPAIR_STATE_KEY, { doneAt: now });
  })();
  return result;
};

const main = () => {
  const [qqMessageDb, storeDb] = process.argv.slice(2);
  const key = process.env.NTQQ_DB_KEY;
  if (!storeDb || !key) {
    throw new Error("Usage: NTQQ_DB_KEY=... node repair_picture_text.js <qqMessageDb> <storeDb>");
  }
  const qq = openQq(qqMessageDb, key);
  const store = ensureBriefingSchema(messageStore.openStore(storeDb));
  try {
    const result = repairStore({ store, bodyOf: bodyLookup(qq) });
    console.log(`repairResult=${JSON.stringify(result)}`);
  } finally {
    store.close();
    qq.close();
  }
};

if (require.main === module) {
  main();
}

module.exports = { REPAIR_STATE_KEY, repairStore, ensureMediaRow, stripLeftovers, stickerKinds };
