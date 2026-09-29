"use strict";

// The detailed-level job over past days: redo + backfill chunks are done
// only by the detailed provider, never cost API money when it is down, and a
// declined redo keeps its old summary.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const store = require("../src/briefing_store");
const engine = require("../src/briefing_engine");
const review = require("../src/review_store");
const usage = require("../src/llm_usage");
const pricing = require("../src/llm_pricing");
const { createClient, setUsageRecorder } = require("../src/llm_summarizer");

const HOUR = 3600;
const DAY = 86400;
const NOW = 1_800_000_000;

// grokMode: "ok" | "refuse" (empty summary) | "down" (HTTP 429).
const startProviders = (grokMode) =>
  new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const provider = request.url.startsWith("/grok") ? "grok" : "api";
        seen.push(provider);
        if (provider === "grok" && grokMode === "down") {
          response.writeHead(429, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        const refused = provider === "grok" && grokMode === "refuse";
        const content = {
          summary: refused ? null : `${provider} 的摘要`,
          topics: refused ? [] : [{ title: "话题", summary: "s", importance: "high", messageCountEstimate: 3, details: [], evidence: [] }],
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 50 }, cost_in_usd_ticks: 1e8 },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });

const makeClient = (mock, detail = "detailed") => createClient(
  { baseUrl: `${mock.base}/grok`, apiKey: "t", model: "grok-4.7", provider: "grok-subscription", detail },
  { fallback: { baseUrl: `${mock.base}/api`, apiKey: "k", model: "deepseek-v4-flash", detail: "standard" } },
);

// One group, one day: 30 messages, the first 10 summarized (standard), the
// other 20 never summarized.
const seed = () => {
  const db = usage.ensureUsageSchema(store.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "detail-job-")), "messages.db")),
  ));
  const start = NOW - 3 * DAY;
  messageStore.ingestExport(db, {
    groupIds: ["1001"], groupNames: { 1001: "画图群" }, startUnix: start - DAY, endUnix: NOW, coveredFromUnix: start - DAY,
    messages: Array.from({ length: 30 }, (_, index) => ({
      groupId: "1001", rowId: String(100 + index), msgSeq: String(index), sentAt: start + index * 60,
      senderUin: "2", senderName: "A", text: `消息 ${index}`, isSelf: false, atUins: [], atAll: false, replyTo: null,
    })),
    mediaMessages: [],
  }, "run");
  const chunkId = store.insertChunk(db, { groupId: "1001", startSentAt: start, endSentAt: start + 9 * 60, firstRowId: "100", lastRowId: "109", messageCount: 10, createdAt: NOW });
  store.saveChunkResult(db, chunkId, { partial: { summary: "旧的标准摘要", topics: [] } });
  const day = new Date((start + 8 * HOUR) * 1000).toISOString().slice(0, 10);
  return { db, chunkId, day, start };
};

const queueJob = ({ db, day, start }) => {
  store.markChunksForRedo(db, { fromUnix: start - DAY });
  return review.backfillDay(db, { day, now: NOW, asDetailedJob: true, maxMessages: 250 });
};

test("the job queues a redo plus a backfill of the uncovered messages at the detailed chunk size", () => {
  const fixture = seed();
  const backfill = queueJob(fixture);
  assert.deepEqual(backfill, { chunks: 1, messages: 20 });
  assert.deepEqual(store.redoStats(fixture.db), { queued: 2, messages: 30 });
  const queue = store.chunksToSummarize(fixture.db, 10);
  assert.ok(queue.every((chunk) => chunk.redo === 1));
  assert.deepEqual(queue.map((chunk) => chunk.hasPartial).sort(), [0, 1]);
});

test("job chunks wait while the client works at the standard level", async (t) => {
  const mock = await startProviders("ok");
  t.after(() => mock.server.close());
  const fixture = seed();
  queueJob(fixture);
  const outcome = await engine.mapPendingChunks(fixture.db, makeClient(mock, "standard"), { now: NOW });
  assert.equal(outcome.jobDeferred, 2);
  assert.deepEqual(mock.seen, []);
});

test("a detailed job replaces both summaries and records usage per group and day", async (t) => {
  const mock = await startProviders("ok");
  t.after(() => mock.server.close());
  const fixture = seed();
  queueJob(fixture);
  setUsageRecorder((entry) => usage.recordUsage(fixture.db, entry));
  t.after(() => setUsageRecorder(null));
  const outcome = await engine.mapPendingChunks(fixture.db, makeClient(mock), { now: NOW });
  assert.equal(outcome.jobDone, 2);
  assert.equal(store.redoStats(fixture.db).queued, 0);
  const chunks = store.doneChunksInWindow(fixture.db, "1001", 0);
  assert.deepEqual(chunks.map((chunk) => chunk.detail), ["detailed", "detailed"]);
  const rows = usage.usageByGroupDay(fixture.db, { sinceUnix: 0, fromDay: fixture.day, toDay: fixture.day, prices: pricing.priceTable({}) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].groupId, "1001");
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].reasoningTokens, 100);
  assert.equal(rows[0].subscriptionListUsd, 0.02);
});

test("a declined redo keeps its old summary; a declined backfill is answered by the fallback", async (t) => {
  const mock = await startProviders("refuse");
  t.after(() => mock.server.close());
  const fixture = seed();
  queueJob(fixture);
  const outcome = await engine.mapPendingChunks(fixture.db, makeClient(mock), { now: NOW, mapConcurrency: 1 });
  assert.equal(outcome.jobKeptOld, 1);
  assert.equal(outcome.jobDone, 1);
  const chunks = store.doneChunksInWindow(fixture.db, "1001", 0);
  const redone = chunks.find((chunk) => chunk.chunkId === fixture.chunkId);
  assert.equal(JSON.parse(redone.partialJson).summary, "旧的标准摘要");
  const backfilled = chunks.find((chunk) => chunk.chunkId !== fixture.chunkId);
  assert.equal(JSON.parse(backfilled.partialJson).summary, "api 的摘要");
  // Labelled after the model that really answered.
  assert.equal(backfilled.detail, "standard");
  assert.equal(store.redoStats(fixture.db).queued, 0);
});

test("with the detailed provider down, the redo stays queued and costs no API money", async (t) => {
  const mock = await startProviders("down");
  t.after(() => mock.server.close());
  const fixture = seed();
  store.markChunksForRedo(fixture.db, { fromUnix: 0 });
  const outcome = await engine.mapPendingChunks(fixture.db, makeClient(mock), { now: NOW });
  assert.equal(outcome.jobDeferred, 1);
  assert.equal(store.redoStats(fixture.db).queued, 1);
  assert.ok(mock.seen.every((provider) => provider === "grok"));
});
