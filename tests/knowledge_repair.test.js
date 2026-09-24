"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectAndParse } = require("../src/ai_metadata");
const { decodeUserComment, repairUtf16ByteOrder } = require("../src/image_text_chunks");
const { openKnowledgeStore, upsertImage, recordPromptRequest } = require("../src/knowledge_store");
const { repairExifPrompts } = require("../src/knowledge_repair");

const A1111_EXIF = "1girl, solo, masterpiece\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, CFG scale: 5, Seed: 42, Size: 832x1216";
const COMFY_GRAPH = JSON.stringify({
  "resource-stack": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "urn:air:sdxl:checkpoint:civitai:1@2" } },
  3: { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["7", 0], seed: 1, steps: 20, cfg: 5 } },
  6: { class_type: "CLIPTextEncode", inputs: { text: "score_9, 1girl" } },
  7: { class_type: "CLIPTextEncode", inputs: { text: "lowres" } },
});

const userComment = (text, { bigEndian }) => {
  const body = Buffer.from(text, "utf16le");
  return Buffer.concat([Buffer.from("UNICODE\0", "latin1"), bigEndian ? Buffer.from(body).swap16() : body]);
};

test("EXIF notes from phones and apps are not prompts", () => {
  for (const note of ["Oplus_16908288", "oplus_2097152", "Screenshot", "0; fileterIntensity: 0.0; filterMask: 0", '{"AIGC":{"Label":"1","ContentProducer":"NETA"}}']) {
    assert.equal(detectAndParse({ UserComment: note }), null, note);
    assert.equal(detectAndParse({ ImageDescription: note }), null, note);
  }
});

test("EXIF still yields a full A1111 block or an embedded ComfyUI graph", () => {
  const a1111 = detectAndParse({ UserComment: A1111_EXIF });
  assert.equal(a1111.generator, "webui");
  assert.equal(a1111.prompt, "1girl, solo, masterpiece");
  assert.equal(a1111.params.steps, 28);

  const comfy = detectAndParse({ UserComment: COMFY_GRAPH });
  assert.equal(comfy.generator, "comfyui");
  assert.equal(comfy.prompt, "score_9, 1girl");

  // A PNG parameters chunk keeps the old, looser rule: a prompt alone counts.
  assert.equal(detectAndParse({ parameters: "just a prompt" }).prompt, "just a prompt");
});

test("UTF-16 UserComment is read in whichever byte order makes sense", () => {
  // Civitai writes big-endian even inside a little-endian JPEG.
  assert.equal(decodeUserComment(userComment(COMFY_GRAPH, { bigEndian: true }), true), COMFY_GRAPH);
  assert.equal(decodeUserComment(userComment(COMFY_GRAPH, { bigEndian: false }), true), COMFY_GRAPH);
  assert.equal(decodeUserComment(userComment(A1111_EXIF, { bigEndian: false }), false), A1111_EXIF);
  // CJK-only text has no ASCII to vote with: the container order is kept.
  assert.equal(decodeUserComment(userComment("女孩", { bigEndian: false }), true), "女孩");

  const mojibake = Buffer.from(COMFY_GRAPH, "utf16le").swap16().toString("utf16le");
  assert.equal(repairUtf16ByteOrder(mojibake), COMFY_GRAPH);
  assert.equal(repairUtf16ByteOrder("already fine"), "already fine");
});

const legacyRow = (hash, prompt, rawChunks, extra = {}) => ({
  hash,
  filePath: "",
  fileSize: 100,
  fileMtime: 1,
  container: "jpeg",
  width: 800,
  height: 600,
  generator: "webui",
  prompt,
  negativePrompt: "",
  checkpoint: "",
  modelHash: "",
  loras: [],
  params: {},
  rawChunks,
  parserVersion: 2,
  parsedAt: 1,
  ...extra,
});

test("repairExifPrompts demotes phone photos, recovers mojibake graphs, once", () => {
  const db = openKnowledgeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-repair-")), "knowledge.db"));
  const mojibake = Buffer.from(COMFY_GRAPH, "utf16le").swap16().toString("utf16le");
  upsertImage(db, legacyRow("a".repeat(32), "oplus_2097152", { UserComment: "oplus_2097152" }));
  upsertImage(db, legacyRow("b".repeat(32), mojibake, { UserComment: mojibake }));
  upsertImage(db, legacyRow("c".repeat(32), "Screenshot", { ImageDescription: "Screenshot" }));
  db.prepare("UPDATE images SET file_missing = 1 WHERE hash = ?").run("c".repeat(32));
  // A real A1111 row is never touched.
  upsertImage(db, legacyRow("d".repeat(32), "keep me", { parameters: A1111_EXIF }, { params: { steps: 28 } }));
  recordPromptRequest(db, {
    groupId: "1", askRowId: "9", askSentAt: 10, groupName: "g", intent: "prompt", rule: "reply", asker: "A", askText: "求咒语",
    imageHash: "a".repeat(32), imageOwner: "B", imageSentAt: 5, targetVia: "reply", confidence: "high",
    answerText: "chat prompt, 1girl", answerKind: "text", answerSentAt: 12, answerBy: "B",
  });

  assert.deepEqual(repairExifPrompts(db, 1000), { checked: 3, recovered: 1, stripped: 2 });
  const rows = Object.fromEntries(db.prepare("SELECT hash, generator, prompt, file_missing AS missing, parser_version AS version FROM images").all()
    .map((row) => [row.hash[0], row]));
  assert.equal(rows.a.generator, "stripped");
  assert.equal(rows.a.prompt, "chat prompt, 1girl");
  assert.equal(rows.b.generator, "comfyui");
  assert.equal(rows.b.prompt, "score_9, 1girl");
  assert.equal(rows.c.generator, "stripped");
  assert.equal(rows.c.missing, 1);
  assert.equal(rows.d.prompt, "keep me");
  assert.equal(rows.d.version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM images_fts WHERE images_fts MATCH 'oplus_2097152'").get().n, 0);

  assert.deepEqual(repairExifPrompts(db, 2000), { checked: 0, recovered: 0, stripped: 0 });
  db.close();
});

// A minimal real PNG (IHDR + IEND) with no text chunks: a phone photo's worth
// of metadata, i.e. none.
const plainPng = () => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(640, 0);
  header.writeUInt32BE(480, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IEND", Buffer.alloc(0))]);
};

test("a stale file_missing flag is cleared when the repair actually reads the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-repair-file-"));
  const db = openKnowledgeStore(path.join(dir, "knowledge.db"));
  const filePath = path.join(dir, "photo.png");
  fs.writeFileSync(filePath, plainPng());
  upsertImage(db, legacyRow("e".repeat(32), "oplus_2097152", { UserComment: "oplus_2097152" }, { filePath }));
  db.prepare("UPDATE images SET file_missing = 1 WHERE hash = ?").run("e".repeat(32));

  assert.deepEqual(repairExifPrompts(db, 1000), { checked: 1, recovered: 0, stripped: 1 });
  const row = db.prepare("SELECT generator, file_missing AS missing, width FROM images WHERE hash = ?").get("e".repeat(32));
  assert.deepEqual(row, { generator: "stripped", missing: 0, width: 640 });
  db.close();
});
