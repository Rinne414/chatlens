"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseQqPaste,
  parseTimeToken,
  normalizeText,
  isMediaPlaceholder,
} = require("../src/qq_paste");

test("parseTimeToken reads QQNT slash dates as Beijing time", () => {
  const unix = parseTimeToken("2026/8/24 13:45:01");
  assert.equal(unix, Date.UTC(2026, 7, 24, 13, 45, 1) / 1000 - 8 * 3600);
});

test("parses QQNT desktop copy: name and time on one line", () => {
  const paste = [
    "小明 2026/8/24 13:45:01",
    "今晚还开吗",
    "",
    "小红 2026/8/24 13:46:10",
    "[图片]",
  ].join("\n");

  const parsed = parseQqPaste(paste);
  assert.equal(parsed.format, "qqnt-header");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].speaker, "小明");
  assert.equal(parsed.messages[0].text, "今晚还开吗");
  assert.equal(parsed.messages[0].unix, parseTimeToken("2026/8/24 13:45:01"));
  assert.equal(parsed.messages[1].speaker, "小红");
  assert.equal(parsed.messages[1].isMediaPlaceholder, true);
});

test("parses a 【群名】 prefix on the header line", () => {
  const parsed = parseQqPaste("【绘星海】小明 2026-08-24 13:45:01\n今晚还开吗\n");
  assert.equal(parsed.messages[0].groupHint, "绘星海");
  assert.equal(parsed.messages[0].speaker, "小明");
});

test("parses [time] name headers", () => {
  const parsed = parseQqPaste("[2026/08/24 13:45:01] 小明\n今晚还开吗\n");
  assert.equal(parsed.messages[0].speaker, "小明");
  assert.equal(parsed.messages[0].unix, parseTimeToken("2026/08/24 13:45:01"));
});

test("parses stacked mobile blocks: name, time, body", () => {
  const paste = [
    "小明",
    "2026年8月24日 13:45:01",
    "今晚还开吗",
    "",
    "小红",
    "2026年8月24日 13:46:10",
    "开",
  ].join("\n");
  const parsed = parseQqPaste(paste);
  assert.equal(parsed.format, "stacked");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].speaker, "小明");
  assert.equal(parsed.messages[1].text, "开");
});

test("parses colon lines when there is no timestamp", () => {
  const parsed = parseQqPaste("小明：今晚还开吗\n小红: 开");
  assert.equal(parsed.format, "colon");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].speaker, "小明");
  assert.equal(parsed.messages[0].unix, null);
  assert.equal(parsed.messages[1].text, "开");
});

test("empty paste yields no messages", () => {
  assert.equal(parseQqPaste("   \n\n").messages.length, 0);
  assert.equal(parseQqPaste("").format, "empty");
});

test("isMediaPlaceholder covers QQ copy tokens", () => {
  assert.equal(isMediaPlaceholder("[图片]"), true);
  assert.equal(isMediaPlaceholder("[語音]"), true);
  assert.equal(isMediaPlaceholder("今晚还开吗"), false);
});

test("normalizeText collapses QQ copy whitespace", () => {
  assert.equal(normalizeText("  今晚  还开吗\r\n"), "今晚 还开吗");
});
