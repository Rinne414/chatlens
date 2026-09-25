"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { tokenizeQuery, tokenLabel, removeToken, addToken, toggleToken, quoteValue } = require("../web/kb_tokens");
const { tokenize } = require("../src/knowledge_query");

test("splits the query exactly like the server parser", () => {
  const query = 'model:"wai illustrious" -tag:nsfw steps>=30 1girl';
  assert.deepEqual(tokenizeQuery(query), tokenize(query));
});

test("labels terms in plain Chinese", () => {
  assert.deepEqual(tokenLabel("has:prompt"), { text: "有咒语", tone: "flag" });
  assert.deepEqual(tokenLabel("no:file"), { text: "没有本地原图", tone: "flag" });
  assert.deepEqual(tokenLabel('model:"wai v1"'), { text: "模型：wai v1", tone: "include" });
  assert.deepEqual(tokenLabel("-tag:nsfw"), { text: "排除标签：nsfw", tone: "exclude" });
  assert.deepEqual(tokenLabel("generator:comfyui"), { text: "来源：ComfyUI", tone: "include" });
  assert.deepEqual(tokenLabel("steps>=30"), { text: "steps ≥ 30", tone: "include" });
  assert.deepEqual(tokenLabel("aspect:portrait"), { text: "竖图", tone: "include" });
  assert.deepEqual(tokenLabel("1girl"), { text: "“1girl”", tone: "free" });
});

test("removing a chip removes exactly that term", () => {
  assert.equal(removeToken('lora:a model:"x y" 1girl', 'model:"x y"'), "lora:a 1girl");
  assert.equal(removeToken("lora:a", "lora:b"), "lora:a");
});

test("adding a term is idempotent and toggling flips it", () => {
  assert.equal(addToken("1girl", "has:params"), "1girl has:params");
  assert.equal(addToken("1girl has:params", "has:params"), "1girl has:params");
  assert.equal(toggleToken("1girl has:params", "has:params"), "1girl");
  assert.equal(toggleToken("", "has:request"), "has:request");
});

test("values with spaces are quoted", () => {
  assert.equal(quoteValue("wai illustrious"), '"wai illustrious"');
  assert.equal(quoteValue("anima"), "anima");
});
