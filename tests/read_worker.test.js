"use strict";

// The 咒语库 queries run in a worker thread so a slow scan cannot freeze the
// console; the answers must be the same as calling knowledge_ops directly.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const knowledge = require("../src/server/knowledge_ops");
const knowledgeWorker = require("../src/server/read_worker");
const { openKnowledgeStore, upsertImage } = require("../src/knowledge_store");

const makeToolRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kworker-"));
  const db = openKnowledgeStore(path.join(root, "store", "knowledge.db"));
  for (const [hash, generator] of [["a".repeat(32), "forge"], ["b".repeat(32), "comfyui"]]) {
    upsertImage(db, {
      hash,
      filePath: `C:\\nt_data\\Pic\\2026-08\\Ori\\${hash}.png`,
      fileSize: 2048,
      fileMtime: 1700000000,
      container: "png",
      width: 1024,
      height: 1536,
      generator,
      prompt: "masterpiece, 1girl, green hair",
      negativePrompt: "",
      checkpoint: "someCheckpoint",
      modelHash: "abc123",
      params: {},
      rawChunks: {},
      loras: [],
      parserVersion: 2,
      parsedAt: 1700000001,
    });
  }
  db.close();
  return root;
};

test("the worker answers exactly what knowledge_ops answers", async (t) => {
  t.after(() => knowledgeWorker.stop());
  const root = makeToolRoot();
  const options = { query: "green", scope: "prompt" };
  const [facets, search] = await Promise.all([
    knowledgeWorker.call("facets", root, options),
    knowledgeWorker.call("searchImages", root, { query: "green", sort: "recent" }),
  ]);
  assert.deepEqual(facets, knowledge.facets(root, options));
  assert.deepEqual(search, knowledge.searchImages(root, { query: "green", sort: "recent" }));
  assert.equal(search.items.length, 2);
});

test("unknown queries and failing ones are rejected, and the worker keeps serving", async (t) => {
  t.after(() => knowledgeWorker.stop());
  await assert.rejects(knowledgeWorker.call("imageFilePath", "x", "y"), /Unknown read query/u);
  // A tool root without a store is "not available", not an error.
  assert.equal((await knowledgeWorker.call("overview", path.join(os.tmpdir(), "no-such-root-kworker"))).available, false);
  await assert.rejects(knowledgeWorker.call("facets", null, {}), Error);
  assert.equal((await knowledgeWorker.call("overview", makeToolRoot())).available, true);
});
