"use strict";

// Pictures only (no text) for the given groups and window, read from the
// mirrored QQ message database. Used once after upgrading to fill the picture
// table for the last 31 days - the span Tencent still serves originals for -
// which the regular refresh (new messages only) would never revisit.
//
//   NTQQ_DB_KEY=... node src/export_pictures.js <messageDb> <groupIdsCsv> <fromUnix> <toUnix> <outputJson>

const fs = require("node:fs");
const Database = require("better-sqlite3-multiple-ciphers");
const { extractPictures, isSticker } = require("./picture_elements");

// Walked newest-first through the (group, msg_seq) index; msg_seq follows
// sent_at within a group, so a long run of older rows ends the group.
const OLDER_STREAK_LIMIT = 2000;

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

const openDatabase = (databasePath, key) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  for (const pragma of ["cipher='sqlcipher'", "legacy=4", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"]) {
    db.pragma(pragma);
  }
  db.pragma(`key=${sqlQuote(key)}`);
  db.pragma("query_only=ON");
  return db;
};

const exportPictures = ({ db, groupIds, fromUnix, toUnix }) => {
  const stmt = db.prepare(`
    SELECT [40001] AS row_id, [40050] AS sent_at, [40800] AS body
    FROM group_msg_table WHERE [40027] = ? AND [40050] < ? ORDER BY [40003] DESC
  `);
  stmt.safeIntegers(true);
  const items = [];
  const failedGroups = [];
  for (const groupId of groupIds) {
    let older = 0;
    try {
      for (const row of stmt.iterate(BigInt(groupId), BigInt(toUnix))) {
        const sentAt = Number(row.sent_at);
        if (sentAt < fromUnix) {
          older += 1;
          if (older > OLDER_STREAK_LIMIT) {
            break;
          }
          continue;
        }
        older = 0;
        if (!Buffer.isBuffer(row.body)) {
          continue;
        }
        const pictures = extractPictures(row.body).filter((picture) => !isSticker(picture));
        if (pictures.length > 0) {
          items.push({ groupId, rowId: String(row.row_id), sentAt, pictures });
        }
      }
    } catch (error) {
      // A corrupt page ends this group only; the rest still export.
      failedGroups.push({ groupId, message: error.message });
    }
  }
  return { items, failedGroups };
};

const main = () => {
  const [databasePath, groupCsv, fromText, toText, outputPath] = process.argv.slice(2);
  const key = process.env.NTQQ_DB_KEY;
  if (!outputPath || !key) {
    throw new Error("Usage: NTQQ_DB_KEY=... node export_pictures.js <messageDb> <groupIdsCsv> <fromUnix> <toUnix> <outputJson>");
  }
  const groupIds = groupCsv.split(",").map((value) => value.trim()).filter((value) => /^\d+$/u.test(value));
  const db = openDatabase(databasePath, key);
  try {
    const result = exportPictures({ db, groupIds, fromUnix: Number(fromText), toUnix: Number(toText) });
    fs.writeFileSync(outputPath, JSON.stringify(result), "utf8");
    console.log(`pictureExport items=${result.items.length} failedGroups=${result.failedGroups.length}`);
  } finally {
    db.close();
  }
};

if (require.main === module) {
  main();
}

module.exports = { exportPictures };
