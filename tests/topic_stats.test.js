"use strict";

// 群 → 在聊什么: each AI topic carries the facts counted from the stored
// messages between its start and end minute (src/topic_stats.js).

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const { withTopicStats } = require("../src/topic_stats");
const { hktToUnix } = require("../src/review_store");

const makeDb = (rows) => {
  const db = new Database(":memory:");
  db.prepare("CREATE TABLE messages (group_id TEXT, row_id TEXT, sent_at INTEGER, speaker TEXT, text TEXT, is_media INTEGER)").run();
  const insert = db.prepare("INSERT INTO messages VALUES ('1', ?, ?, ?, 'x', 0)");
  rows.forEach(([time, speaker], index) => insert.run(String(index), hktToUnix(`2026-10-23 ${time}`), speaker));
  return db;
};

test("a topic counts its messages through the end minute, and who spoke most", () => {
  const db = makeDb([["10:00:05", "甲"], ["10:01:00", "乙"], ["10:02:59", "甲"], ["10:03:00", "丙"]]);

  const [day] = withTopicStats(db, "1", [{ day: "2026-10-23", items: [{ title: "t", start: "2026-10-23 10:00", end: "2026-10-23 10:02" }] }]);
  const { stats } = day.items[0];

  assert.equal(stats.messages, 3);
  assert.equal(stats.people, 2);
  assert.deepEqual(stats.speakers.map((speaker) => [speaker.name, speaker.messages]), [["甲", 2], ["乙", 1]]);
  assert.equal(stats.lastAt, hktToUnix("2026-10-23 10:02:59"));
});

test("a topic without a start (summary topics) is left as it was", () => {
  const db = makeDb([]);
  const item = { title: "t", start: "", end: "" };

  const [day] = withTopicStats(db, "1", [{ day: "2026-10-23", items: [item] }]);

  assert.equal(day.items[0].stats, undefined);
});

const { thingsToKeys, keysToThings, normalizeThings } = require("../src/topic_things");

const topic = (startAt, title) => ({ title, stats: { startAt } });

test("重要的事 are stored by topic key, so a topic added in the middle of the day does not shift them", () => {
  const before = [topic(100, "甲"), topic(200, "乙"), topic(300, "丙")];
  const stored = thingsToKeys(normalizeThings({ things: [{ title: "事", kind: "new", topics: [2, 0] }] }, 3), before);
  const after = [topic(100, "甲"), topic(150, "新"), topic(200, "乙"), topic(300, "丙")];

  const { things, unsorted, lost } = keysToThings(stored, after);

  assert.deepEqual(things.find((thing) => thing.title === "事").topics, [0, 3]);
  assert.equal(lost, 0);
  assert.equal(unsorted, 1);
});

test("a rewritten topic is reported as lost instead of pointing at another one", () => {
  const stored = thingsToKeys(normalizeThings({ things: [{ title: "事", kind: "qa", topics: [0, 1] }] }, 2), [topic(100, "甲"), topic(200, "乙")]);

  const { things, lost } = keysToThings(stored, [topic(100, "甲"), topic(200, "乙（改写）")]);

  assert.deepEqual(things[0].topics, [0]);
  assert.equal(lost, 1);
});
