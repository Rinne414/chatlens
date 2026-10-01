"use strict";

// One-time clean-up of rows parsed before PARSER_VERSION 3, when any EXIF
// comment counted as a prompt: phone photos ("oplus_2097152"), screenshots and
// AIGC-label JSON showed up as WebUI images, and Civitai's big-endian UTF-16
// comments were stored as mojibake. Only those rows are re-parsed (from the
// file when QQ still has it, else from the stored raw chunks); the ones without
// real generation data become plain "stripped" cards, keeping who posted them
// and any prompt people pasted in chat.

const fs = require("node:fs");
const path = require("node:path");
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

// Pictures earlier parsers found nothing in ("stripped") are read once more:
// version 4 also reads data hidden in PNG pixels (NovelAI writes it into
// every picture), WebP EXIF and the JPEG comment segment. The kept copy
// (object_path) is preferred, since QQ's own path may be a thumbnail or gone.
// Rows with no readable file are only marked as checked. Batched commits and
// a time budget keep one refresh from stalling on a large library.
// QQ keeps a 720px preview next to each thumbnail (<md5>_720.webp): lossy
// colour, but a lossless alpha plane, so a prompt hidden in the alpha
// survives in it even when PC QQ never downloaded the original.
const QQ_THUMB_NAME = /^([a-f0-9]{32})_[^\\/]+$/iu;

const qqPreviewFor = (thumbPath) => {
  if (typeof thumbPath !== "string" || path.basename(path.dirname(thumbPath)).toLowerCase() !== "thumb") {
    return null;
  }
  const match = QQ_THUMB_NAME.exec(path.basename(thumbPath));
  const preview = match === null ? null : path.join(path.dirname(thumbPath), `${match[1].toLowerCase()}_720.webp`);
  return preview !== null && fs.existsSync(preview) ? preview : null;
};

const REPARSE_LIMIT = 50000;
const REPARSE_BUDGET_MS = 20000;
const REPARSE_COMMIT_EVERY = 500;

const reparseStrippedRows = (db, { now = Math.floor(Date.now() / 1000), limit = REPARSE_LIMIT, budgetMs = REPARSE_BUDGET_MS, clock = Date.now } = {}) => {
  const pending = db.prepare("SELECT COUNT(*) AS n FROM images WHERE generator = 'stripped' AND parser_version < ?").get(PARSER_VERSION).n;
  const rows = db.prepare(`
    SELECT hash, file_path AS filePath, object_path AS objectPath, file_mtime AS fileMtime, file_missing AS fileMissing
    FROM images WHERE generator = 'stripped' AND parser_version < ? LIMIT ?
  `).all(PARSER_VERSION, limit);
  const markChecked = db.prepare("UPDATE images SET parser_version = ? WHERE hash = ?");
  const keepMissing = db.prepare("UPDATE images SET file_missing = 1 WHERE hash = ?");
  const chatPrompts = db.prepare("SELECT answer_text AS text FROM prompt_requests WHERE image_hash = ? AND answer_kind = 'text'");
  const outcome = { checked: 0, recovered: 0, noFile: 0, remaining: 0 };

  const reparseOne = (row) => {
    outcome.checked += 1;
    const sources = [row.objectPath, row.filePath, qqPreviewFor(row.filePath)]
      .filter((candidate) => typeof candidate === "string" && candidate !== "" && fs.existsSync(candidate));
    if (sources.length === 0) {
      outcome.noFile += 1;
      markChecked.run(PARSER_VERSION, row.hash);
      return;
    }
    let source = null;
    let size = 0;
    let parsed = null;
    for (const candidate of new Set(sources)) {
      size = fs.statSync(candidate).size;
      parsed = parseAiMetadata(candidate, size);
      if (parsed.generator !== "unknown") {
        source = candidate;
        break;
      }
    }
    if (source === null) {
      markChecked.run(PARSER_VERSION, row.hash);
      return;
    }
    upsertImage(db, { ...parsed, hash: row.hash, filePath: row.filePath, fileSize: size, fileMtime: row.fileMtime, parsedAt: now });
    if (row.fileMissing === 1 && source !== row.filePath) {
      keepMissing.run(row.hash);
    }
    // A longer prompt pasted in chat stays the searchable one, as at harvest.
    for (const answer of chatPrompts.all(row.hash)) {
      applyChatPrompt(db, { hash: row.hash, prompt: answer.text });
    }
    outcome.recovered += 1;
  };
  const commitBatch = db.transaction((batch) => batch.forEach(reparseOne));

  const started = clock();
  for (let index = 0; index < rows.length && clock() - started <= budgetMs; index += REPARSE_COMMIT_EVERY) {
    commitBatch(rows.slice(index, index + REPARSE_COMMIT_EVERY));
  }
  outcome.remaining = Math.max(0, pending - outcome.checked);
  return outcome;
};

module.exports = { repairExifPrompts, reparseStrippedRows, qqPreviewFor };
