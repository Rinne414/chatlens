"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { normalizeWords, wordHits } = require("../src/watch_words");

const openTemp = () => messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-words-")), "messages.db"));

const msg = (groupId, rowId, sentAt, text, fields = {}) => ({
  groupId, rowId: String(rowId), msgSeq: String(rowId), sentAt, senderUin: "2", senderName: "Alice", text,
  isSelf: false, atUins: [], atAll: false, replyTo: null, ...fields,
});

test("words are trimmed, deduplicated case-insensitively and checked", () => {
  assert.deepEqual(normalizeWords(["  Anima ", "anima", "Qwen  Image", "", "示例群"]), ["Anima", "Qwen Image", "示例群"]);
  assert.throws(() => normalizeWords(["???"]), /至少要有一个字母/u);
  assert.throws(() => normalizeWords(["x".repeat(41)]), /太长/u);
  assert.throws(() => normalizeWords(["的"]), /至少 2 个字/u);
  assert.throws(() => normalizeWords("anima"), /列表/u);
});

test("finds each word in the window, whole Latin words only, newest first, never my own lines", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1", "2"],
      groupNames: { 1: "一群", 2: "二群" },
      startUnix: 1000,
      endUnix: 9000,
      coveredFromUnix: 1000,
      messages: [
        msg("1", 1, 1100, "anima 新版出了"),
        msg("2", 2, 1200, "Anima真好用"),
        msg("2", 3, 1300, "animation 不算"),
        msg("1", 4, 1400, "qwen-image 和 Qwen Image 2.1"),
        msg("1", 5, 1500, "我说 anima", { senderUin: "9", senderName: "我", isSelf: true }),
        msg("1", 6, 50, "anima 太早了"),
        msg("2", 7, 1600, "100% anima_v2"),
      ],
      mediaMessages: [],
    }, "run");
    const [anima, qwen] = wordHits(db, { fromUnix: 1000, toUnix: 9000, words: ["anima", "Qwen Image"] });
    assert.equal(anima.total, 3);
    assert.deepEqual(anima.latest.map((row) => row.rowId), ["7", "2", "1"]);
    assert.deepEqual(anima.groups, [{ groupId: "2", groupName: "二群", count: 2 }, { groupId: "1", groupName: "一群", count: 1 }]);
    assert.equal(qwen.total, 1);
    assert.equal(qwen.latest[0].rowId, "4");
  } finally {
    db.close();
  }
});
