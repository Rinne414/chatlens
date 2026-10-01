"use strict";

// Pictures recorded as "stripped" by an older parser are read once more with
// the current one, which also reads pixel-hidden data, WebP EXIF and the JPEG
// comment segment. Measured on the user's library: 314 such pictures had a
// readable prompt.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { PARSER_VERSION } = require("../src/ai_metadata");
const { openKnowledgeStore, upsertImage, recordPromptRequest } = require("../src/knowledge_store");
const { reparseStrippedRows } = require("../src/knowledge_repair");
const { makePng } = require("./png_fixture");

const NAI_METADATA = {
  Software: "NovelAI",
  Description: "1girl, solo, rain",
  Comment: JSON.stringify({ prompt: "1girl, solo, rain", uc: "lowres", steps: 28, scale: 5, seed: 42 }),
};

const strippedRow = (hash, filePath, parserVersion = 3) => ({
  hash,
  filePath,
  fileSize: 0,
  fileMtime: 5,
  container: null,
  width: 0,
  height: 0,
  generator: "stripped",
  prompt: "",
  negativePrompt: "",
  checkpoint: "",
  modelHash: "",
  loras: [],
  params: {},
  rawChunks: {},
  parserVersion,
  parsedAt: 1,
});

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-reparse-"));
  const db = openKnowledgeStore(path.join(dir, "knowledge.db"));
  // Windows will not delete the folder while the database is open.
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (name, bytes) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  };
  const stealth = write("nai.png", makePng({ signature: "stealth_pngcomp", payload: zlib.gzipSync(Buffer.from(JSON.stringify(NAI_METADATA))) }));
  const plain = write("photo.png", makePng({}));
  return { db, dir, stealth, plain };
};

const row = (db, hash) => db.prepare(`
  SELECT generator, prompt, parser_version AS version, file_missing AS missing, object_path AS objectPath
  FROM images WHERE hash = ?`).get(hash);

test("stripped pictures are read again once, and only those a newer parser can help", (t) => {
  const { db, dir, stealth, plain } = setup(t);
  upsertImage(db, strippedRow("a".repeat(32), stealth));
  upsertImage(db, strippedRow("b".repeat(32), plain));
  upsertImage(db, strippedRow("c".repeat(32), path.join(dir, "evicted.png")));
  upsertImage(db, strippedRow("d".repeat(32), stealth, PARSER_VERSION));

  assert.deepEqual(reparseStrippedRows(db, { now: 1000 }), { checked: 3, recovered: 1, noFile: 1, remaining: 0 });

  assert.deepEqual(
    { ...row(db, "a".repeat(32)), objectPath: undefined },
    { generator: "nai", prompt: "1girl, solo, rain", version: PARSER_VERSION, missing: 0, objectPath: undefined },
  );
  assert.equal(row(db, "b".repeat(32)).generator, "stripped");
  assert.equal(row(db, "b".repeat(32)).version, PARSER_VERSION);
  assert.equal(row(db, "c".repeat(32)).version, PARSER_VERSION);
  // Already read by the current parser: left alone.
  assert.equal(row(db, "d".repeat(32)).generator, "stripped");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM images_fts WHERE images_fts MATCH 'rain'").get().n, 1);

  assert.deepEqual(reparseStrippedRows(db, { now: 2000 }), { checked: 0, recovered: 0, noFile: 0, remaining: 0 });
});

test("the kept copy is read when QQ's file is gone, and the row stays marked as evicted", (t) => {
  const { db, dir, stealth } = setup(t);
  upsertImage(db, strippedRow("e".repeat(32), path.join(dir, "evicted.png")));
  db.prepare("UPDATE images SET object_path = ?, file_missing = 1 WHERE hash = ?").run(stealth, "e".repeat(32));

  assert.equal(reparseStrippedRows(db, { now: 1000 }).recovered, 1);

  const recovered = row(db, "e".repeat(32));
  assert.equal(recovered.generator, "nai");
  assert.equal(recovered.missing, 1);
  assert.equal(recovered.objectPath, stealth);
});

test("a longer prompt someone pasted in chat still wins over the file's", (t) => {
  const { db, stealth } = setup(t);
  upsertImage(db, strippedRow("f".repeat(32), stealth));
  recordPromptRequest(db, {
    groupId: "1", askRowId: "9", askSentAt: 10, groupName: "g", intent: "prompt", rule: "reply", asker: "A", askText: "求咒语",
    imageHash: "f".repeat(32), imageOwner: "B", imageSentAt: 5, targetVia: "reply", confidence: "high",
    answerText: "1girl, solo, rain, umbrella, night city, neon", answerKind: "text", answerSentAt: 12, answerBy: "B",
  });

  reparseStrippedRows(db, { now: 1000 });

  assert.equal(row(db, "f".repeat(32)).prompt, "1girl, solo, rain, umbrella, night city, neon");
});

test("a row pointing at a small thumbnail is read from QQ's 720 preview beside it", (t) => {
  const { db, dir } = setup(t);
  const hash = "9".repeat(32);
  const thumbDir = path.join(dir, "Pic", "2026-09", "Thumb");
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumb = path.join(thumbDir, `${hash}_0.png`);
  fs.writeFileSync(thumb, makePng({}));
  fs.copyFileSync(path.join(__dirname, "fixtures", "webp", "lossy-alpha-stealth.webp"), path.join(thumbDir, `${hash}_720.webp`));
  upsertImage(db, strippedRow(hash, thumb));

  assert.equal(reparseStrippedRows(db, { now: 1000 }).recovered, 1);
  assert.equal(row(db, hash).prompt, "1girl, solo, rain");
});

test("a limit stops a long backfill and the next call carries on", (t) => {
  const { db, plain } = setup(t);
  for (const letter of ["1", "2", "3"]) {
    upsertImage(db, strippedRow(letter.repeat(32), plain));
  }

  assert.deepEqual(reparseStrippedRows(db, { now: 1000, limit: 2 }), { checked: 2, recovered: 0, noFile: 0, remaining: 1 });
  assert.deepEqual(reparseStrippedRows(db, { now: 1000, limit: 2 }), { checked: 1, recovered: 0, noFile: 0, remaining: 0 });
});
