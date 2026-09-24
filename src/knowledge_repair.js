"use strict";

// One-time clean-up of rows parsed before PARSER_VERSION 3, when any EXIF
// comment counted as a prompt: phone photos ("oplus_2097152"), screenshots and
// AIGC-label JSON showed up as WebUI images, and Civitai's big-endian UTF-16
// comments were stored as mojibake. Only those rows are re-parsed (from the
// file when QQ still has it, else from the stored raw chunks); the ones without
// real generation data become plain "stripped" cards, keeping who posted them
// and any prompt people pasted in chat.

const fs = require("node:fs");
const { parseAiMetadata, detectAndParse, PARSER_VERSION } = require("./ai_metadata");
const { repairUtf16ByteOrder } = require("./image_text_chunks");
const { upsertImage, applyChatPrompt } = require("./knowledge_store");

const NO_METADATA = { generator: "unknown", prompt: "", negativePrompt: "", checkpoint: "", modelHash: "", loras: [], params: {} };

const suspectRows = (db) =>
  db.prepare(`
    SELECT hash, file_path AS filePath, file_size AS fileSize, file_mtime AS fileMtime,
           container, width, height, raw_chunks_json AS rawChunksJson, file_missing AS fileMissing
    FROM images
    WHERE parser_version < 3 AND generator IN ('webui', 'forge') AND params_json = '{}'
  `).all();

const storedChunks = (json) => {
  try {
    const chunks = JSON.parse(json);
    return chunks !== null && typeof chunks === "object" ? chunks : {};
  } catch {
    return {};
  }
};

// fileRead: whether this pass actually read the file (so it is not missing).
const reparse = (row) => {
  if (row.filePath !== "" && fs.existsSync(row.filePath)) {
    const result = parseAiMetadata(row.filePath, row.fileSize);
    if (result.container !== null) {
      return { ...result, fileRead: true };
    }
  }
  const chunks = storedChunks(row.rawChunksJson);
  if (typeof chunks.UserComment === "string") {
    chunks.UserComment = repairUtf16ByteOrder(chunks.UserComment);
  }
  return { ...(detectAndParse(chunks) ?? NO_METADATA), container: row.container, width: row.width, height: row.height, rawChunks: chunks, fileRead: false };
};

const repairExifPrompts = (db, now = Math.floor(Date.now() / 1000)) => {
  const rows = suspectRows(db);
  const outcome = { checked: rows.length, recovered: 0, stripped: 0 };
  if (rows.length === 0) {
    return outcome;
  }
  // upsertImage assumes a freshly seen file; keep an evicted one marked missing.
  const keepMissing = db.prepare("UPDATE images SET file_missing = 1 WHERE hash = ?");
  const chatPrompts = db.prepare("SELECT answer_text AS text FROM prompt_requests WHERE image_hash = ? AND answer_kind = 'text'");
  db.transaction(() => {
    for (const row of rows) {
      const result = reparse(row);
      const usable = result.generator !== "unknown";
      upsertImage(db, {
        ...(usable ? result : NO_METADATA),
        generator: usable ? result.generator : "stripped",
        hash: row.hash,
        filePath: row.filePath,
        fileSize: row.fileSize,
        fileMtime: row.fileMtime,
        container: result.container ?? row.container,
        width: result.width || row.width,
        height: result.height || row.height,
        rawChunks: result.rawChunks ?? {},
        parserVersion: PARSER_VERSION,
        parsedAt: now,
      });
      if (row.fileMissing === 1 && !result.fileRead) {
        keepMissing.run(row.hash);
      }
      if (usable) {
        outcome.recovered += 1;
        continue;
      }
      outcome.stripped += 1;
      for (const answer of chatPrompts.all(row.hash)) {
        applyChatPrompt(db, { hash: row.hash, prompt: answer.text });
      }
    }
  })();
  return outcome;
};

module.exports = { repairExifPrompts };
