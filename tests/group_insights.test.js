"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const { groupInsights, timelineBetween, answerers } = require("../src/group_insights");

// 2026-09-21 is a Monday; 21:00 Beijing = 13:00 UTC.
const MONDAY_9PM = Date.UTC(2026, 8, 21, 13, 0, 0) / 1000;
const NOW = MONDAY_9PM + 3600;

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-"));
  const db = briefingStore.ensureBriefingSchema(messageStore.openStore(path.join(dir, "messages.db")));
  try {
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const seed = (db) => {
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('12345', '测试群')").run();
  const message = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text, is_media) VALUES ('12345', ?, ?, ?, ?, ?, ?)");
  message.run("1", MONDAY_9PM, "Alice", "1", "hi", 0);
  message.run("2", MONDAY_9PM + 60, "Alice", "1", "again", 0);
  message.run("3", MONDAY_9PM + 120, "Bob", "2", "", 1);
  const partial = (title, start) => JSON.stringify({
    timeline: [{ title, summary: `${title} 的经过`, start, end: start }],
    qa: [{ question: "怎么装?", answer: "看教程", answerer: "Bob / Carol" }],
    newThings: [{ kind: "model", name: "anima", detail: "新版" }],
    links: [{ title: "教程", url: "https://example.com/a", why: "" }],
  });
  const chunk = db.prepare(`INSERT INTO summary_chunks (group_id, start_sent_at, end_sent_at, first_row_id, last_row_id, message_count, status, partial_json, created_at)
    VALUES ('12345', ?, ?, '1', '3', 3, 'done', ?, ?)`);
  chunk.run(MONDAY_9PM - 7200, MONDAY_9PM - 3600, partial("早些的话题", "2026-09-21 19:00:00"), NOW);
  chunk.run(MONDAY_9PM, MONDAY_9PM + 120, partial("晚上的话题", "2026-09-21 21:00:00"), NOW);
};

test("activity is zero-filled per Beijing day and the heatmap starts on Monday", () => {
  withStore((db) => {
    seed(db);
    const result = groupInsights(db, null, { groupId: "12345", nowUnix: NOW });
    assert.equal(result.name, "测试群");
    assert.equal(result.daily.length, 30);
    assert.deepEqual(result.daily.at(-1), { day: "2026-09-21", text: 2, media: 1 });
    assert.equal(result.heatmap[0][21], 3);
    assert.equal(result.totals.messages, 3);
    assert.equal(result.totals.speakers, 2);
  });
});

test("people, topics and lists come from the store and the cached summaries", () => {
  withStore((db) => {
    seed(db);
    const result = groupInsights(db, null, { groupId: "12345", nowUnix: NOW });
    assert.deepEqual(result.people.active.map((row) => [row.name, row.count]), [["Alice", 2], ["Bob", 1]]);
    assert.deepEqual(result.people.helpers.map((row) => [row.name, row.count]), [["Bob", 2], ["Carol", 2]]);
    assert.deepEqual(result.timeline[0].items.map((item) => item.title), ["晚上的话题", "早些的话题"]);
    assert.equal(result.newThings.length, 1);
    assert.equal(result.links.length, 1);
    assert.deepEqual(result.aigc.models, []);
  });
});

test("answer credit splits names joined by slashes and commas", () => {
  assert.deepEqual(answerers([{ qa: [{ answerer: "A、B" }, { answerer: "A / C" }] }]).map((row) => [row.name, row.count]),
    [["A", 2], ["B", 1], ["C", 1]]);
});

test("the chat panel gets the timeline entries inside the range", () => {
  withStore((db) => {
    seed(db);
    const { items } = timelineBetween(db, { groupId: "12345", fromUnix: MONDAY_9PM - 600, toUnix: NOW });
    assert.deepEqual(items.map((item) => item.title), ["晚上的话题"]);
    assert.equal(items[0].startAt, MONDAY_9PM);
  });
});

test("rejects a bad group id or range", () => {
  withStore((db) => {
    assert.throws(() => groupInsights(db, null, { groupId: "../1", nowUnix: NOW }), /群号/u);
    assert.throws(() => timelineBetween(db, { groupId: "12345", fromUnix: 10, toUnix: 5 }), /范围/u);
  });
});
