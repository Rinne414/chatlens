"use strict";

// QQ's own 收藏 (favorites) as a list of pictures, read from QQNT's
// collection.db. QQ's collection page makes saving them painful (one picture
// at a time) and syncs it in jumps without saying how far it got; this module
// gives every picture with the md5 that identifies it, and how far QQ synced.
//
// Layout (probed on real QQNT 9.9 data, 2026-09-30; numbers are column /
// protobuf field ids):
//   collection_list_info_table
//     180001 id, 180002 type (8 = pictures and mixed notes, 6 file, 5 video,
//     2 link, 4 text; NULL = a placeholder whose content QQ never downloaded),
//     180011 collected at (unix ms), 180004 / 180015 content
//   a picture element is any protobuf message at path .../181453 in 180015:
//     180550 its collector URL http://shp.qpic.cn/collector/<uin>/<uuid>/
//            (stored with no size; /0 is the original, /100 /200 /400 are
//            resized; a request carrying a Referer gets a hotlink placeholder)
//     180551 md5 of the original (16 bytes; downloads match it exactly)
//     180555 width, 180556 height (180557 is NOT the file size)
//   misc_info_table (48901 key, 48902 value)
//     Collection_Top_Timstamp          newest item QQ synced here (ms)
//     Collection_ModiGroupId_Timstamp  when QQ last talked to the server (s)

const fs = require("node:fs");
const path = require("node:path");
const { parseFields } = require("./message_meta");
const { extractOriPaths, remapNtDataPath } = require("./export_collection_photos");

const PHOTO_TYPE = 8;
const PICTURE_ELEMENT = 181453;
const FIELD_URL = 180550;
const FIELD_MD5 = 180551;
const FIELD_WIDTH = 180555;
const FIELD_HEIGHT = 180556;
const MAX_DEPTH = 8;
const COLLECTOR_URL = /^https?:\/\/shp\.qpic\.cn\/collector\/(\d+)\/([0-9a-fA-F-]{36})\/\d*$/u;
const QQ_FAKE_HEADER = Buffer.from("SQLite header 3\0", "latin1");
const QQ_PREFIX_BYTES = 1024;
const COPY_ATTEMPTS = 4;

const varintOf = (fields, fieldNumber) => fields.find((field) => field.fieldNumber === fieldNumber && field.value !== undefined)?.value ?? null;
const sliceOf = (fields, fieldNumber) => fields.find((field) => field.fieldNumber === fieldNumber && field.slice !== undefined)?.slice ?? null;

// Every picture element in one content blob, in order: { md5, uin, uuid, width, height }.
const pictureElements = (blob) => {
  const found = [];
  const walk = (buf, parentField, depth) => {
    const fields = parseFields(buf);
    if (fields === null) {
      return;
    }
    if (parentField === PICTURE_ELEMENT) {
      const md5 = sliceOf(fields, FIELD_MD5);
      const url = COLLECTOR_URL.exec(sliceOf(fields, FIELD_URL)?.toString("latin1") ?? "");
      if (md5 !== null && md5.length === 16 && url !== null) {
        found.push({
          md5: md5.toString("hex"),
          uin: url[1],
          uuid: url[2].toLowerCase(),
          width: varintOf(fields, FIELD_WIDTH) ?? 0,
          height: varintOf(fields, FIELD_HEIGHT) ?? 0,
        });
      }
      return;
    }
    if (depth >= MAX_DEPTH) {
      return;
    }
    for (const field of fields) {
      if (field.slice !== undefined && field.slice.length > 1) {
        walk(field.slice, field.fieldNumber, depth + 1);
      }
    }
  };
  if (Buffer.isBuffer(blob)) {
    walk(blob, 0, 0);
  }
  return found;
};

const blobText = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : "");

// Pictures of every photo row, one entry per md5 (a picture collected twice
// sits at its latest collection time), newest first. `localFilesOf(rowText)`
// returns the row's original files that still exist on disk.
const collectionPictures = (rows, localFilesOf = () => []) => {
  const byMd5 = new Map();
  for (const row of rows) {
    if (row.type !== PHOTO_TYPE) {
      continue;
    }
    const collectedAt = Number(row.ts) || 0;
    const elements = pictureElements(row.b15);
    if (elements.length === 0) {
      continue;
    }
    const localFiles = localFilesOf(`${blobText(row.b4)}\n${blobText(row.b15)}`);
    for (const element of elements) {
      const known = byMd5.get(element.md5);
      if (known !== undefined && known.collectedAt >= collectedAt) {
        known.localFiles = [...new Set([...known.localFiles, ...localFiles])];
        continue;
      }
      byMd5.set(element.md5, { ...element, collectedAt, localFiles: [...new Set([...(known?.localFiles ?? []), ...localFiles])] });
    }
  }
  return [...byMd5.values()].sort((left, right) => right.collectedAt - left.collectedAt || left.md5.localeCompare(right.md5));
};

// How far QQ synced its collection to this computer.
const syncInfo = (miscRows, rows) => {
  const misc = new Map(miscRows.map((row) => [String(row.key), String(row.value ?? "")]));
  const number = (key) => {
    const value = Number(misc.get(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const checked = number("Collection_ModiGroupId_Timstamp");
  return {
    newestAt: number("Collection_Top_Timstamp"),
    checkedAt: checked === null ? null : checked * 1000,
    placeholders: rows.filter((row) => row.type === null || row.type === undefined).length,
    rows: rows.length,
  };
};

/* ---------- reading QQ's database ---------- */

const sqlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

// A consistent copy of collection.db (5 MB): WAL / SHM first, then the main
// file without QQ's 1024-byte fake header; again if QQ wrote the main file
// meanwhile (same reasoning as db_mirror.js).
const copyCollectionDb = (ntDbDir, targetDir) => {
  const source = path.join(ntDbDir, "collection.db");
  const target = path.join(targetDir, "collection.clean.db");
  fs.mkdirSync(targetDir, { recursive: true });
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    const before = fs.statSync(source);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(`${source}${suffix}`)) {
        fs.copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
      } else {
        fs.rmSync(`${target}${suffix}`, { force: true });
      }
    }
    const raw = fs.readFileSync(source);
    const after = fs.statSync(source);
    const prefix = raw.subarray(0, QQ_FAKE_HEADER.length).equals(QQ_FAKE_HEADER) ? QQ_PREFIX_BYTES : 0;
    fs.writeFileSync(target, raw.subarray(prefix));
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return target;
    }
  }
  return target;
};

const openCollectionDb = (Database, databasePath, key) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    for (const pragma of ["cipher='sqlcipher'", "legacy=4", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"]) {
      db.pragma(pragma);
    }
    db.pragma(`key=${sqlQuote(key)}`);
    db.pragma("query_only=ON");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

// Everything the page needs from QQ: { sync, pictures }.
const readCollection = ({ Database, ntDbDir, ntDataDir, key, workDir }) => {
  const db = openCollectionDb(Database, copyCollectionDb(ntDbDir, workDir), key);
  try {
    const rows = db.prepare(`SELECT "180001" AS id, "180002" AS type, "180011" AS ts, "180004" AS b4, "180015" AS b15 FROM collection_list_info_table`).all();
    const miscRows = db.prepare(`SELECT "48901" AS key, "48902" AS value FROM misc_info_table`).all();
    const localFilesOf = (text) => [...new Set(extractOriPaths(text).map((file) => remapNtDataPath(file, ntDataDir)))]
      .filter((file) => fs.existsSync(file));
    return { sync: syncInfo(miscRows, rows), pictures: collectionPictures(rows, localFilesOf) };
  } finally {
    db.close();
  }
};

const collectorUrl = (picture, size = 0) => `https://shp.qpic.cn/collector/${picture.uin}/${picture.uuid}/${size}`;

module.exports = { pictureElements, collectionPictures, syncInfo, copyCollectionDb, readCollection, collectorUrl };
