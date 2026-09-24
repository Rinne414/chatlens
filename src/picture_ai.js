"use strict";

// AI metadata from fetched picture bytes, and recording it in the knowledge
// base when the original itself is not kept (the user's choice: prompt,
// parameters and the full workflow, plus a 720px preview).

const fs = require("node:fs");
const path = require("node:path");
const { parseAiMetadata } = require("./ai_metadata");
const { readImageTextChunks } = require("./image_text_chunks");
const knowledgeStore = require("./knowledge_store");

let tempCounter = 0;

// The parsers read files, so the bytes (a head or a whole original) go to a
// private temp file for the duration of the parse.
const parseBytes = (bytes, ext, tmpDir) => {
  fs.mkdirSync(tmpDir, { recursive: true });
  tempCounter += 1;
  const tempPath = path.join(tmpDir, `picture-parse-${process.pid}-${tempCounter}.${ext}`);
  fs.writeFileSync(tempPath, bytes);
  try {
    const parsed = parseAiMetadata(tempPath, bytes.length);
    const container = readImageTextChunks(tempPath);
    return { parsed, chunks: container?.chunks ?? {} };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

// Sightings use the raw QQ row id; the message store prefixes media rows "m".
const rawRowId = (rowId) => (String(rowId).startsWith("m") ? String(rowId).slice(1) : String(rowId));

// Writes the parse into knowledge.db. A row that already has real metadata
// (e.g. harvested from QQ's own copy) keeps it; a "stripped" or unknown row is
// upgraded. Every place the picture was posted becomes a sighting.
const recordGenerated = ({ knowledgeDbPath, picture, parsed, chunks, occurrences, now = Math.floor(Date.now() / 1000) }) => {
  const db = knowledgeStore.openKnowledgeStore(knowledgeDbPath);
  db.pragma("busy_timeout = 5000");
  try {
    db.transaction(() => {
      const existing = db.prepare("SELECT generator FROM images WHERE hash = ?").get(picture.md5);
      if (existing === undefined || existing.generator === "stripped" || existing.generator === "unknown") {
        knowledgeStore.upsertImage(db, {
          ...parsed,
          hash: picture.md5,
          filePath: "",
          fileSize: picture.size,
          fileMtime: 0,
          width: parsed.width || picture.width,
          height: parsed.height || picture.height,
          parsedAt: now,
        });
      }
      knowledgeStore.saveImageChunks(db, picture.md5, chunks, now);
      for (const place of occurrences) {
        knowledgeStore.recordSighting(db, { ...place, hash: picture.md5, rowId: rawRowId(place.rowId) });
      }
    })();
  } finally {
    db.close();
  }
};

// Links a saved original to its knowledge row, when there is one.
const attachOriginal = ({ knowledgeDbPath, md5, objectPath }) => {
  if (!fs.existsSync(knowledgeDbPath)) {
    return;
  }
  const db = knowledgeStore.openKnowledgeStore(knowledgeDbPath);
  db.pragma("busy_timeout = 5000");
  try {
    knowledgeStore.attachMediaObject(db, { hash: md5, objectPath });
  } finally {
    db.close();
  }
};

const readChunks = ({ knowledgeDbPath, md5 }) => {
  if (!fs.existsSync(knowledgeDbPath)) {
    return null;
  }
  const db = knowledgeStore.openKnowledgeStore(knowledgeDbPath);
  try {
    return knowledgeStore.readImageChunks(db, md5);
  } finally {
    db.close();
  }
};

module.exports = { parseBytes, recordGenerated, attachOriginal, readChunks };
