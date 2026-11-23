"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3-multiple-ciphers");
const store = require("../src/briefing_store");
const briefWindow = require("../src/brief_window");

const HOUR = 3600;
const T0 = 1_800_000_000;

const openDb = () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE messages (group_id TEXT, row_id TEXT, sent_at INTEGER, is_media INTEGER DEFAULT 0, speaker TEXT, text TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  store.ensureBriefingSchema(db);
  return db;
};

const since = (db) => store.getState(db, "briefing_since", null);
const visitAt = (db, now, extra = {}) => briefWindow.visit(db, { now, groupIds: ["1"], summarizing: false, ...extra });

test("auto: opening again after a while away starts where the last visit ended", () => {
  const db = openDb();
  assert.equal(briefWindow.windowInfo(db).mode, "auto");
  assert.equal(visitAt(db, T0), false);
  assert.equal(since(db), null, "the first visit moves nothing");
  assert.equal(visitAt(db, T0 + 8 * HOUR), true);
  assert.equal(since(db), T0);
  assert.equal(visitAt(db, T0 + 20 * HOUR), true);
  assert.equal(since(db), T0 + 8 * HOUR);
  assert.equal(briefWindow.windowInfo(db).previousStart, T0);
});

test("auto: opening again within the hour is the same sitting", () => {
  const db = openDb();
  visitAt(db, T0);
  visitAt(db, T0 + 8 * HOUR);
  assert.equal(visitAt(db, T0 + 8 * HOUR + 600), false);
  assert.equal(since(db), T0);
  // the sitting is counted up to its last look
  visitAt(db, T0 + 12 * HOUR);
  assert.equal(since(db), T0 + 8 * HOUR + 600);
});

test("manual: visits never move the start, 看完了 does, and one step back is kept", () => {
  const db = openDb();
  briefWindow.setMode(db, "manual");
  visitAt(db, T0);
  assert.equal(visitAt(db, T0 + 30 * HOUR), false);
  assert.equal(since(db), null);
  briefWindow.markSeen(db, { value: T0 + 31 * HOUR, now: T0 + 31 * HOUR });
  briefWindow.markSeen(db, { value: T0 + 40 * HOUR, now: T0 + 40 * HOUR });
  assert.equal(since(db), T0 + 40 * HOUR);
  assert.equal(briefWindow.windowInfo(db).previousStart, T0 + 31 * HOUR);
});

test("back to the last briefing swaps the two starts, and the next visit moves on from now", () => {
  const db = openDb();
  visitAt(db, T0);
  visitAt(db, T0 + 8 * HOUR);
  visitAt(db, T0 + 20 * HOUR);
  assert.equal(briefWindow.restorePrevious(db), true);
  briefWindow.recordLook(db, { now: T0 + 20 * HOUR + 60, groupIds: ["1"], summarizing: false });
  assert.equal(since(db), T0);
  assert.equal(briefWindow.windowInfo(db).previousStart, T0 + 8 * HOUR);
  assert.equal(visitAt(db, T0 + 30 * HOUR), true);
  assert.equal(since(db), T0 + 20 * HOUR + 60);
});

test("auto: a refresh an hour after the last look moves the start, so the next briefing is ready", () => {
  const db = openDb();
  visitAt(db, T0);
  assert.equal(briefWindow.settle(db, { now: T0 + 1800 }), false, "within the hour nothing moves");
  assert.equal(briefWindow.settle(db, { now: T0 + 2 * HOUR }), true);
  assert.equal(since(db), T0);
  assert.equal(briefWindow.settle(db, { now: T0 + 3 * HOUR }), false, "once per look");
  assert.equal(visitAt(db, T0 + 9 * HOUR), false, "the look finds it already moved");
  briefWindow.setMode(db, "manual");
  assert.equal(briefWindow.settle(db, { now: T0 + 30 * HOUR }), false);
});

test("going back brings the last briefing's group summaries with it", () => {
  const db = openDb();
  const briefOf = () => store.getGroupBrief(db, "1");
  briefWindow.markSeen(db, { value: T0, now: T0 });
  store.saveGroupBrief(db, "1", { windowStart: T0, chunkKey: "a", summary: { summary: "old" } });
  briefWindow.markSeen(db, { value: T0 + 9 * HOUR, now: T0 + 9 * HOUR });
  assert.equal(briefOf().windowStart, T0, "left in place until the new one is written");
  store.saveGroupBrief(db, "1", { windowStart: T0 + 9 * HOUR, chunkKey: "b", summary: { summary: "new" } });
  briefWindow.restorePrevious(db);
  assert.deepEqual([briefOf().windowStart, briefOf().summary.summary], [T0, "old"]);
  briefWindow.restorePrevious(db);
  assert.deepEqual([briefOf().windowStart, briefOf().summary.summary], [T0 + 9 * HOUR, "new"]);
});

test("nothing to go back to: restore reports it", () => {
  const db = openDb();
  assert.equal(briefWindow.restorePrevious(db), false);
});

test("messages still waiting for a summary at a look come round again", () => {
  const db = openDb();
  const now = T0 + 10 * HOUR;
  const add = (rowId, sentAt) => db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text) VALUES ('1', ?, ?, 'a', 'x')").run(String(rowId), sentAt);
  const chunk = (status, from, to) => db.prepare("INSERT INTO summary_chunks (group_id, start_sent_at, end_sent_at, first_row_id, last_row_id, message_count, status, created_at) VALUES ('1', ?, ?, '1', '1', 1, ?, ?)").run(from, to, status, now);
  add(1, now - 5 * HOUR);
  add(2, now - 1200);
  add(3, now - 60);
  const options = { groupIds: ["1"], since: T0, now };
  assert.equal(briefWindow.coveredUntil(db, { ...options, summarizing: false }), now - 60, "no AI: up to the newest stored message");
  assert.equal(briefWindow.coveredUntil(db, { ...options, summarizing: true }), now - 5 * HOUR, "the oldest message without a summary");
  chunk("done", now - 5 * HOUR, now - 5 * HOUR);
  assert.equal(briefWindow.coveredUntil(db, { ...options, summarizing: true }), now - 1200);
  chunk("pending", now - 1200, now - 60);
  assert.equal(briefWindow.coveredUntil(db, { ...options, summarizing: true }), now - 1200, "a queued chunk is waiting too");
  db.prepare("UPDATE summary_chunks SET status = 'done'").run();
  assert.equal(briefWindow.coveredUntil(db, { ...options, summarizing: true }), now - 60);
});

test("messages that have stopped coming in: the next briefing starts at the newest one stored", () => {
  const db = openDb();
  db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text) VALUES ('1', '1', ?, 'a', 'x')").run(T0 + 2 * HOUR);
  visitAt(db, T0 + 10 * HOUR);
  visitAt(db, T0 + 20 * HOUR);
  assert.equal(since(db), T0 + 2 * HOUR, "what was sent between 2 h and 10 h and arrives later is still in the next briefing");
});

test("a wrong mode is refused", () => {
  assert.throws(() => briefWindow.setMode(openDb(), "weekly"), /mode must be/u);
});
