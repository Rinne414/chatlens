"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const review = require("../src/review_store");

// Beijing wall clock -> unix seconds (UTC+8, no DST).
const beijing = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
const NOW = beijing(2026, 9, 24, 20);

const message = (groupId, rowId, sentAt, text) => ({
  groupId, rowId: String(rowId), msgSeq: String(rowId), sentAt,
  senderUin: "222", senderName: "Alice", text, isSelf: false, atUins: [], atAll: false, replyTo: null,
});

const PARTIAL = {
  summary: "讨论 Qwen Image 的 int8 精度",
  topics: [{ title: "Qwen Image int8 CLIP 问题", summary: "int8 导致构图偏移", importance: "high", details: ["换 bf16 就好"] }],
  newThings: [
    { kind: "model", name: "Qwen Image", detail: "图像模型", hkt: "2026-09-22 10:12:00" },
    { kind: "tool", name: "前一天的东西", detail: "不该出现在 22 日", hkt: "2026-09-21 23:59:00" },
  ],
  qa: [{ question: "5070ti 能跑吗？", answer: "能", resolved: true, hkt: "2026-09-22 10:15:00" }],
  timeline: [{ start: "2026-09-22 10:10", end: "2026-09-22 10:19", title: "int8 讨论", summary: "换 bf16 解决" }],
  links: [],
};

// Group 1001: 30 messages on 09-22 from 10:00 (rows 100-129) with rows
// 110-119 already summarized, plus 10 fresh ones on 09-24. Group 2002: five
// messages on 09-22 afternoon.
const seed = () => {
  const db = briefingStore.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "review-")), "messages.db")),
  );
  const morning = beijing(2026, 9, 22, 10);
  const messages = [
    ...Array.from({ length: 30 }, (_, index) => message("1001", 100 + index, morning + index * 60, `画图 ${index}`)),
    ...Array.from({ length: 10 }, (_, index) => message("1001", 500 + index, beijing(2026, 9, 24, 18) + index * 60, `今天 ${index}`)),
    ...Array.from({ length: 5 }, (_, index) => message("2002", 700 + index, beijing(2026, 9, 22, 15) + index * 60, `Flux 模型 100% 好用 ${index}`)),
  ];
  messageStore.ingestExport(db, {
    groupIds: ["1001", "2002"],
    groupNames: { 1001: "画图群", 2002: "闲聊群" },
    startUnix: beijing(2026, 9, 20, 0),
    endUnix: NOW,
    coveredFromUnix: beijing(2026, 9, 20, 0),
    messages,
    mediaMessages: [],
  }, "run");
  const chunkId = briefingStore.insertChunk(db, {
    groupId: "1001",
    startSentAt: morning + 10 * 60,
    endSentAt: morning + 19 * 60,
    firstRowId: "110",
    lastRowId: "119",
    messageCount: 10,
    createdAt: NOW - 3 * 86400,
  });
  briefingStore.saveChunkResult(db, chunkId, { partial: PARTIAL });
  // The live briefing window began yesterday evening.
  briefingStore.setState(db, "briefing_since", NOW - 86400);
  return db;
};

test("dayBounds maps a Beijing date to its unix range and rejects bad dates", () => {
  assert.deepEqual(review.dayBounds("2026-09-24"), { start: beijing(2026, 9, 24, 0), end: beijing(2026, 9, 25, 0) });
  assert.throws(() => review.dayBounds("2026-02-30"), /无效/u);
  assert.throws(() => review.dayBounds("24/09/2026"), /格式/u);
  assert.equal(review.hktToUnix("2026-09-22 10:12"), beijing(2026, 9, 22, 10, 12));
  assert.equal(review.hktToUnix("not a time"), null);
});

test("tagCoverage compares row ids numerically across a digit rollover", () => {
  const at = 1000;
  const messages = [
    { sentAt: at, rowId: "9999998" },
    { sentAt: at, rowId: "9999999" },
    { sentAt: at, rowId: "10000000" },
    { sentAt: at + 1, rowId: "10000001" },
  ];
  const chunks = [{ startSentAt: at, firstRowId: "9999999", endSentAt: at, lastRowId: "10000000", status: "done" }];
  const tags = review.tagCoverage(messages, chunks);
  assert.deepEqual(tags, [null, "done", "done", null]);
  assert.deepEqual(review.uncoveredRuns(messages, tags).map((run) => run.map((item) => item.rowId)), [["9999998"], ["10000001"]]);
});

test("calendar reports volume per day and which days have AI summaries", () => {
  const db = seed();
  const result = review.calendar(db, { fromDay: "2026-09-20", toDay: "2026-09-24" });
  assert.equal(result.firstDay, "2026-09-22");
  assert.equal(result.lastDay, "2026-09-24");
  assert.deepEqual(result.days, [
    { day: "2026-09-22", textMessages: 35, mediaMessages: 0, groups: 2, summarized: true },
    { day: "2026-09-24", textMessages: 10, mediaMessages: 0, groups: 1, summarized: false },
  ]);
  db.close();
});

test("dayReview assembles a day from cached summaries without calling AI", () => {
  const db = seed();
  const day = review.dayReview(db, { day: "2026-09-22", now: NOW });
  assert.deepEqual(day.totals, { groups: 2, textMessages: 35, mediaMessages: 0, summarized: 10, queued: 0, uncovered: 25, backfillable: 25 });
  const drawing = day.groups.find((group) => group.groupId === "1001");
  assert.equal(drawing.name, "画图群");
  assert.equal(drawing.sections.length, 1);
  assert.equal(drawing.sections[0].timeline[0].startSentAt, beijing(2026, 9, 22, 10, 10));
  // Items stamped with another day are left out of this day's view.
  assert.deepEqual(day.highlights.newThings.map((item) => [item.name, item.groupName]), [["Qwen Image", "画图群"]]);
  assert.equal(day.highlights.qa.length, 1);
  db.close();
});

test("backfill turns only uncovered, pre-live messages into chunks, once", () => {
  const db = seed();
  const plans = review.planBackfill(db, { day: "2026-09-22", now: NOW });
  // 1001 splits around the summarized rows 110-119; 2002 is one run.
  assert.deepEqual(plans.map((plan) => [plan.groupId, plan.firstRowId, plan.lastRowId, plan.messageCount]), [
    ["1001", "100", "109", 10],
    ["1001", "120", "129", 10],
    ["2002", "700", "704", 5],
  ]);
  assert.deepEqual(review.backfillDay(db, { day: "2026-09-22", now: NOW }), { chunks: 3, messages: 25 });
  const after = review.dayReview(db, { day: "2026-09-22", now: NOW });
  assert.equal(after.totals.queued, 25);
  assert.equal(after.totals.uncovered, 0);
  assert.deepEqual(review.backfillDay(db, { day: "2026-09-22", now: NOW }), { chunks: 0, messages: 0 });

  // Today's messages are the live chunker's; backfill leaves them alone.
  const today = review.dayReview(db, { day: "2026-09-24", now: NOW });
  assert.equal(today.totals.uncovered, 10);
  assert.equal(today.totals.backfillable, 0);
  assert.deepEqual(review.planBackfill(db, { day: "2026-09-24", now: NOW }), []);
  db.close();
});

test("search finds topics in cached summaries and raw messages, by day", () => {
  const db = seed();
  const topic = review.search(db, { query: "qwen  INT8" });
  assert.deepEqual(topic.terms, ["qwen", "int8"]);
  assert.deepEqual(topic.summaries.items.map((hit) => [hit.kind, hit.title, hit.groupName, hit.day]), [
    ["topic", "Qwen Image int8 CLIP 问题", "画图群", "2026-09-22"],
  ]);
  assert.deepEqual(topic.summaries.byDay, [{ day: "2026-09-22", count: 1 }]);

  const raw = review.search(db, { query: "flux" });
  assert.equal(raw.summaries.total, 0);
  assert.equal(raw.messages.total, 5);
  assert.deepEqual(raw.messages.byDay, [{ day: "2026-09-22", count: 5 }]);
  assert.equal(raw.messages.items[0].groupName, "闲聊群");

  // LIKE wildcards in the query are literal.
  assert.equal(review.search(db, { query: "100%" }).messages.total, 5);
  assert.equal(review.search(db, { query: "_" }).messages.total, 0);
  assert.equal(review.search(db, { query: "   " }).terms.length, 0);
  db.close();
});
