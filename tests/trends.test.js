"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const { trends, normalizeUrl, namePattern, keyIsSpecific } = require("../src/trends");

const NOW = 1_790_000_000;
const HOUR = 3600;

test("links are normalised: host case, www, tracking parameters, trailing punctuation", () => {
  assert.equal(normalizeUrl("https://WWW.Civitai.com/models/12?utm_source=x&id=3。").key, "civitai.com/models/12?id=3");
  assert.equal(normalizeUrl("https://example.com/a/").key, "example.com/a");
  assert.equal(normalizeUrl("https://gchat.qpic.cn/abc"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("names match whole words for Latin names, anywhere for Chinese", () => {
  assert.equal(namePattern("sol").test("console.log"), false);
  assert.equal(namePattern("sol").test("GPT-6 Sol 很强"), true);
  assert.equal(namePattern("Qwen Image 2.1").test("qwen-image2.1 出了"), true);
  assert.equal(namePattern("豆包").test("用豆包画的"), true);
});

test("too-short or numeric names are not specific enough", () => {
  assert.equal(keyIsSpecific("ai"), false);
  assert.equal(keyIsSpecific("123"), false);
  assert.equal(keyIsSpecific("nai5"), true);
  assert.equal(keyIsSpecific("豆包"), true);
});

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trends-"));
  const db = briefingStore.ensureBriefingSchema(messageStore.openStore(path.join(dir, "messages.db")));
  try {
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const seed = (db) => {
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('1', '一群'), ('2', '二群'), ('3', '三群')").run();
  const message = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text) VALUES (?, ?, ?, ?, ?, ?)");
  message.run("1", "a1", NOW - 5 * HOUR, "Alice", "1", "anima 新版出了，https://civitai.com/models/7?utm_source=qq");
  message.run("2", "b1", NOW - 3 * HOUR, "Bob", "2", "Anima 真好用 https://civitai.com/models/7");
  message.run("3", "c1", NOW - 2 * HOUR, "Carol", "3", "有人用过 anima 吗");
  message.run("2", "b2", NOW - HOUR, "Bob", "2", "我的主页 https://me.example.com");
  message.run("2", "b3", NOW - HOUR + 5, "Bob", "2", "再发一次 https://me.example.com");
  message.run("1", "a2", NOW - HOUR, "Alice", "1", "console 报错了");
  const partial = { newThings: [{ kind: "model", name: "Anima", detail: "一群说新版出了" }, { kind: "tool", name: "sol", detail: "" }] };
  db.prepare(`INSERT INTO summary_chunks (group_id, start_sent_at, end_sent_at, first_row_id, last_row_id, message_count, status, partial_json, created_at)
    VALUES ('1', ?, ?, 'a1', 'a2', 2, 'done', ?, ?)`).run(NOW - 5 * HOUR, NOW - HOUR, JSON.stringify(partial), NOW);
};

test("a named thing mentioned in several groups becomes one event with its spread", () => {
  withStore((db) => {
    seed(db);
    const result = trends(db, { nowUnix: NOW, days: 1 });
    const anima = result.events.find((event) => event.id === "thing:anima");
    assert.ok(anima, "anima event");
    assert.equal(anima.groupCount, 3);
    assert.equal(anima.origin.groupName, "一群");
    assert.deepEqual(anima.groups.map((record) => record.groupId), ["1", "2", "3"]);
    assert.equal(anima.groups[0].take, "一群说新版出了");
    assert.equal(anima.label, "模型");
    // "sol" only appears inside "console": no event.
    assert.equal(result.events.some((event) => event.id === "thing:sol"), false);
  });
});

test("a link posted by different people in different groups is an event; a self-repeated one is not", () => {
  withStore((db) => {
    seed(db);
    const result = trends(db, { nowUnix: NOW, days: 1 });
    const link = result.events.find((event) => event.kind === "link");
    assert.equal(link.id, "link:civitai.com/models/7");
    assert.equal(link.groupCount, 2);
    assert.equal(result.events.some((event) => event.id === "link:me.example.com"), false);
  });
});

test("a picture posted in two groups is an event", () => {
  withStore((db) => {
    seed(db);
    db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, sent_at, expires_at) VALUES
      ('1', 'p1', 0, ?, ?, ?), ('2', 'p2', 0, ?, ?, ?)`).run("f".repeat(32), NOW - 4 * HOUR, NOW + 86400, "f".repeat(32), NOW - HOUR, NOW + 86400);
    const result = trends(db, { nowUnix: NOW, days: 1 });
    const picture = result.events.find((event) => event.kind === "picture");
    assert.equal(picture.md5, "f".repeat(32));
    assert.equal(picture.groupCount, 2);
  });
});

test("the window is clamped to 1..7 days and the spark covers it", () => {
  withStore((db) => {
    seed(db);
    const result = trends(db, { nowUnix: NOW, days: 30 });
    assert.equal(result.days, 7);
    assert.ok(result.events.every((event) => event.spark.length === 28));
  });
});
