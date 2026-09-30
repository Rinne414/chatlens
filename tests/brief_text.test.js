"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { splitSentences, summaryParts } = require("../web/brief_text");

test("splits Chinese and English sentences, keeping closing quotes with their sentence", () => {
  assert.deepEqual(splitSentences("群里吵了一架。有人说「这是我家」。Then? OK!"), ["群里吵了一架。", "有人说「这是我家」。", "Then?", "OK!"]);
  assert.deepEqual(splitSentences("  没有句号的一句  "), ["没有句号的一句"]);
  assert.deepEqual(splitSentences(""), []);
});

test("a line without a full stop is its own sentence, never dropped", () => {
  assert.deepEqual(splitSentences("1. 模型更新\n2. 画师讨论\n3. 其他"), ["1. 模型更新", "2. 画师讨论", "3. 其他"]);
  const text = "大家在聊 Flux.1 :)\n另外有人问 LoRA 怎么练…\n最后一句。";
  const { lead, paragraphs } = summaryParts(text);
  assert.equal([lead, ...paragraphs].join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
});

test("English sentences keep the space between them", () => {
  assert.deepEqual(summaryParts("Hello! How are you? 中文。Fine."), { lead: "Hello! How are you?", paragraphs: ["中文。Fine."] });
});

test("a long summary becomes a short lead and paragraphs of two sentences", () => {
  const text = "一。二。三。四。五。";
  assert.deepEqual(summaryParts(text), { lead: "一。二。", paragraphs: ["三。四。", "五。"] });
  assert.deepEqual(summaryParts("只有一句。"), { lead: "只有一句。", paragraphs: [] });
});

test("one very long sentence is not left as a wall: it is cut at its commas", () => {
  const long = `${"甲乙丙丁戊己庚辛".repeat(10)}，${"子丑寅卯辰巳".repeat(10)}，${"天地玄黄".repeat(10)}。`;
  const { lead, paragraphs } = summaryParts(long);
  assert.ok(lead.length < long.length, "the lead is shorter than the whole sentence");
  assert.equal([lead, ...paragraphs].join(""), long);
});
