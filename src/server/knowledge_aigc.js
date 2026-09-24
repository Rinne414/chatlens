"use strict";

// AIGC helpers for 画廊 and 咒语库, read-only on store/knowledge.db:
//   badgesFor      — which gallery pictures carry generation data, how many
//                    people asked for their prompt, and whether anyone answered;
//   relatedImages  — for a detail view: more from the same author, and other
//                    pictures made with the same model / LoRA setup.

const fs = require("node:fs");
const Database = require("better-sqlite3-multiple-ciphers");
const knowledge = require("./knowledge_ops");

const HASH_PATTERN = /^[a-f0-9]{32}$/u;
// The request body is capped at 64 KB (~1800 hashes); the page sends batches.
const MAX_BADGE_HASHES = 1500;
const BADGE_BATCH = 400;
const RELATED_LIMIT = 8;
const PLACEHOLDER_GENERATOR = "stripped";

const openReadOnly = (toolRoot) => {
  const storePath = knowledge.knowledgeDbPath(toolRoot);
  return fs.existsSync(storePath) ? new Database(storePath, { readonly: true, fileMustExist: true }) : null;
};

const validHashes = (hashes) =>
  [...new Set((Array.isArray(hashes) ? hashes : [])
    .map((hash) => String(hash ?? "").toLowerCase())
    .filter((hash) => HASH_PATTERN.test(hash)))].slice(0, MAX_BADGE_HASHES);

const batches = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

// { hash: { generator, params, prompt, asks, answers } } for the hashes the
// library knows something useful about; plain pictures are left out.
const badgesFor = (toolRoot, hashes) => {
  const wanted = validHashes(hashes);
  const db = wanted.length === 0 ? null : openReadOnly(toolRoot);
  if (db === null) {
    return {};
  }
  try {
    const result = {};
    for (const batch of batches(wanted, BADGE_BATCH)) {
      const marks = batch.map(() => "?").join(",");
      const asks = new Map(db.prepare(`
        SELECT image_hash AS hash, COUNT(*) AS asks,
               SUM(CASE WHEN answer_kind IN ('text', 'media') THEN 1 ELSE 0 END) AS answers
        FROM prompt_requests WHERE image_hash IN (${marks}) GROUP BY image_hash
      `).all(...batch).map((row) => [row.hash, row]));
      for (const row of db.prepare(`SELECT hash, generator, prompt <> '' AS hasPrompt FROM images WHERE hash IN (${marks})`).all(...batch)) {
        const asked = asks.get(row.hash);
        const params = row.generator !== PLACEHOLDER_GENERATOR;
        if (params || asked !== undefined) {
          result[row.hash] = {
            generator: row.generator,
            params,
            prompt: row.hasPrompt === 1,
            asks: asked?.asks ?? 0,
            answers: asked?.answers ?? 0,
          };
        }
      }
    }
    return result;
  } finally {
    db.close();
  }
};

// Same rule the library uses for "has a local file": still in QQ's cache, or
// saved to store/media-objects. Checked in SQL; per-file stats were ~1 s here.
const VISIBLE = "((i.file_missing = 0 AND i.file_path <> '') OR i.object_path <> '')";

const byAuthor = (db, hash, author) => {
  const where = author.uin !== "" ? "s.speaker_uin = @who" : "s.speaker = @who";
  return db.prepare(`
    SELECT s.hash, MAX(s.sent_at) AS sentAt FROM sightings s JOIN images i ON i.hash = s.hash
    WHERE ${where} AND s.hash <> @hash AND i.generator <> '${PLACEHOLDER_GENERATOR}' AND ${VISIBLE}
    GROUP BY s.hash ORDER BY sentAt DESC LIMIT ${RELATED_LIMIT}
  `).all({ who: author.uin !== "" ? author.uin : author.speaker, hash });
};

// Same checkpoint (ranked by LoRAs in common), or — without a checkpoint —
// any picture sharing a LoRA.
const bySetup = (db, hash, checkpoint, loras) => {
  if (checkpoint === "" && loras.length === 0) {
    return [];
  }
  const loraMarks = loras.map(() => "?").join(",");
  const shared = loras.length > 0
    ? `(SELECT COUNT(*) FROM image_loras l WHERE l.hash = i.hash AND l.lora_name IN (${loraMarks}))`
    : "0";
  const filter = checkpoint !== ""
    ? "i.checkpoint = ?"
    : `EXISTS (SELECT 1 FROM image_loras l WHERE l.hash = i.hash AND l.lora_name IN (${loraMarks}))`;
  const args = [...loras, ...(checkpoint !== "" ? [checkpoint] : loras), hash];
  return db.prepare(`
    SELECT i.hash, ${shared} AS shared FROM images i
    WHERE ${filter} AND i.hash <> ? AND i.generator <> '${PLACEHOLDER_GENERATOR}' AND ${VISIBLE}
    ORDER BY shared DESC, i.file_mtime DESC LIMIT ${RELATED_LIMIT}
  `).all(...args);
};

const relatedImages = (toolRoot, hash) => {
  if (!HASH_PATTERN.test(String(hash ?? ""))) {
    throw new Error("图片 hash 无效。");
  }
  const db = openReadOnly(toolRoot);
  if (db === null) {
    return { author: null, setup: null };
  }
  try {
    const self = db.prepare("SELECT checkpoint FROM images WHERE hash = ?").get(hash);
    if (self === undefined) {
      return { author: null, setup: null };
    }
    const pick = (rows) => rows.map((row) => ({ hash: row.hash }));
    const author = db.prepare("SELECT speaker, speaker_uin AS uin FROM sightings WHERE hash = ? ORDER BY sent_at ASC LIMIT 1").get(hash);
    const loras = db.prepare("SELECT lora_name AS name FROM image_loras WHERE hash = ?").all(hash).map((row) => row.name);
    const authorItems = author === undefined ? [] : pick(byAuthor(db, hash, { speaker: author.speaker, uin: author.uin ?? "" }));
    const setupItems = pick(bySetup(db, hash, self.checkpoint, loras));
    return {
      author: authorItems.length > 0 ? { name: author.speaker, items: authorItems } : null,
      setup: setupItems.length > 0 ? { checkpoint: self.checkpoint, loras, items: setupItems } : null,
    };
  } finally {
    db.close();
  }
};

module.exports = { badgesFor, relatedImages };
