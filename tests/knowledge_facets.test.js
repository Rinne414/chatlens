"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const knowledge = require("../src/server/knowledge_ops");
const { openKnowledgeStore, upsertImage, recordSighting } = require("../src/knowledge_store");

const hash = (seed) => seed.repeat(32).slice(0, 32);

const image = (id, overrides) => ({
  hash: hash(id),
  filePath: "",
  fileSize: 1000,
  fileMtime: 1_700_000_000,
  container: "png",
  width: 1024,
  height: 1024,
  generator: "comfyui",
  prompt: "1girl, solo",
  negativePrompt: "",
  checkpoint: "anima.safetensors",
  modelHash: "",
  params: {},
  rawChunks: {},
  loras: [],
  parserVersion: 3,
  parsedAt: 1,
  ...overrides,
});

// Three images: two ComfyUI on one model (one with a LoRA and a known
// sender), one NovelAI with no prompt.
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kfacets-"));
  const db = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  upsertImage(db, image("a", { loras: [{ name: "styleA", weight: 0.8 }] }));
  upsertImage(db, image("b"));
  upsertImage(db, image("c", { generator: "nai", prompt: "", checkpoint: "NAI v5" }));
  recordSighting(db, { hash: hash("a"), groupId: "100", rowId: "r1", sentAt: 1_700_000_100, speaker: "Alice", groupName: "一群" });
  db.close();
  return root;
};

test("facets count each dimension under the current filter", () => {
  const root = makeRoot();
  try {
    const facets = knowledge.facets(root, { scope: "prompt" });
    assert.equal(facets.available, true);
    assert.deepEqual(facets.scopes, { all: 3, prompt: 2, sender: 1 });
    assert.equal(facets.total, 2);
    assert.deepEqual(facets.generators, [{ value: "comfyui", count: 2 }]);
    assert.deepEqual(facets.checkpoints, [{ value: "anima.safetensors", count: 2 }]);
    assert.deepEqual(facets.loras, [{ value: "styleA", count: 1 }]);
    assert.deepEqual(facets.groups, [{ value: "100", label: "一群", count: 1 }]);
    assert.deepEqual(facets.senders, [{ value: "Alice", count: 1 }]);
    assert.equal(facets.flags.params, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scope counts ignore the scope itself; other filters narrow them", () => {
  const root = makeRoot();
  try {
    const all = knowledge.facets(root, { scope: "all" });
    assert.equal(all.total, 3);
    assert.equal(all.generators.length, 2);
    const narrowed = knowledge.facets(root, { scope: "all", query: "lora:styleA" });
    assert.deepEqual(narrowed.scopes, { all: 1, prompt: 1, sender: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the overview's per-image scan reads only the covering index", () => {
  const root = makeRoot();
  const Database = require("better-sqlite3-multiple-ciphers");
  const db = new Database(path.join(root, "store", "knowledge.db"), { readonly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT i.file_mtime, i.file_path, i.file_missing, i.object_path,
             EXISTS (SELECT 1 FROM sightings s WHERE s.hash = i.hash) AS has_sighting
      FROM images i`).all().map((row) => row.detail).join(" | ");
    assert.match(plan, /COVERING INDEX idx_images_availability/u);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no library means no facets, not an error", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kfacets-empty-"));
  try {
    assert.equal(knowledge.facets(empty, {}).available, false);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
