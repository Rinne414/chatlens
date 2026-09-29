"use strict";

// An AI account that refuses every call (no balance, dead key, rate limit,
// outage) is not the chunks' fault: they keep their attempts, the run stops
// asking, the cause is remembered for the home page, and chunks that were
// given up on for such a reason can be queued again.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const store = require("../src/briefing_store");
const engine = require("../src/briefing_engine");
const { createClient } = require("../src/llm_summarizer");

const NOW = 1_800_000_000;
const HOUR = 3600;
const BALANCE_ERROR = 'LLM request failed. StatusCode=402 Body={"error":{"message":"Insufficient Balance"}}';

// mode.value: "ok" | "broke" (HTTP 402 for everything).
const startProvider = (mode) =>
  new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        calls.push(mode.value);
        if (mode.value === "broke") {
          response.writeHead(402, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
          return;
        }
        const content = { summary: "摘要", topics: [{ title: "话题", summary: "s", importance: "high", messageCountEstimate: 3, details: [], evidence: [] }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });

// Three groups, each with one closed chunk of 6 two-hour-old messages.
const seed = () => {
  const db = store.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-outage-")), "messages.db")),
  );
  const groups = ["1001", "1002", "1003"];
  messageStore.ingestExport(db, {
    groupIds: groups,
    groupNames: { 1001: "一群", 1002: "二群", 1003: "三群" },
    startUnix: NOW - 26 * HOUR,
    endUnix: NOW,
    coveredFromUnix: NOW - 26 * HOUR,
    messages: groups.flatMap((groupId, groupIndex) => Array.from({ length: 6 }, (_, index) => ({
      groupId, rowId: String(1000 * (groupIndex + 1) + index), msgSeq: String(index), sentAt: NOW - 2 * HOUR + index * 60,
      senderUin: "2", senderName: "A", text: `消息 ${index}`, isSelf: false, atUins: [], atAll: false, replyTo: null,
    }))),
    mediaMessages: [],
  }, "run");
  assert.equal(engine.closeChunks(db, groups, { now: NOW }), 3);
  return db;
};

const attemptsOf = (db) => db.prepare("SELECT status, attempts FROM summary_chunks ORDER BY chunk_id").all();

test("an account refusing every call keeps the chunks' attempts and stops the run", async (t) => {
  const mode = { value: "broke" };
  const mock = await startProvider(mode);
  t.after(() => mock.server.close());
  const db = seed();
  const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "deepseek-v4-flash" });

  const outcome = await engine.mapPendingChunks(db, client, { now: NOW, mapConcurrency: 1 });
  assert.equal(outcome.done, 0);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.routeDown.status, 402);
  // One refused chunk plus one tiny probe to confirm it is the account; 402 is not retried.
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(attemptsOf(db), Array.from({ length: 3 }, () => ({ status: "pending", attempts: 0 })));
  const problem = engine.routeProblem(db);
  assert.equal(problem.status, 402);
  assert.equal(problem.model, "deepseek-v4-flash");
  assert.equal(problem.at, NOW);

  // Once the account works again everything is summarized and the problem is gone.
  mode.value = "ok";
  const later = await engine.mapPendingChunks(db, client, { now: NOW + 900 });
  assert.equal(later.done, 3);
  assert.equal(later.routeDown, null);
  assert.equal(engine.routeProblem(db), null);
});

test("a refusal from the fallback after the primary declined one chunk is that chunk's failure", async (t) => {
  // Primary answers with an empty summary (declined content), fallback is broke.
  const mode = { value: "broke" };
  const fallback = await startProvider(mode);
  const primary = await new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ summary: null, topics: [] }) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
  t.after(() => {
    fallback.server.close();
    primary.server.close();
  });
  const db = seed();
  const client = createClient(
    { baseUrl: primary.url, apiKey: "t", model: "grok-4.7", detail: "standard" },
    { fallback: { baseUrl: fallback.url, apiKey: "k", model: "deepseek-v4-flash", detail: "standard" } },
  );
  const outcome = await engine.mapPendingChunks(db, client, { now: NOW, mapConcurrency: 1 });
  // The primary is fine, so every chunk is tried and each failure counts.
  assert.equal(outcome.routeDown, null);
  assert.equal(outcome.failed, 3);
  assert.deepEqual(attemptsOf(db).map((row) => row.attempts), [1, 1, 1]);
});

test("chunks given up on because the account refused are queued again, others are not", () => {
  const db = seed();
  const [first, second, third] = db.prepare("SELECT chunk_id AS id FROM summary_chunks ORDER BY chunk_id").all().map((row) => row.id);
  for (let attempt = 0; attempt < store.MAX_CHUNK_ATTEMPTS; attempt += 1) {
    store.saveChunkResult(db, first, { error: BALANCE_ERROR });
    store.saveChunkResult(db, second, { error: "Invalid LLM JSON: summary must be a string" });
  }
  store.saveChunkResult(db, third, { error: 'LLM request failed. StatusCode=500 Body={}' });

  assert.deepEqual(engine.failedChunkReasons(db, 0), [
    { status: 402, kind: "balance", text: "AI 服务余额不足", chunks: 1, messages: 6 },
    { status: null, kind: "other", text: "AI 没有给出可用的结果", chunks: 1, messages: 6 },
  ]);

  // Account-level failures only; into the detailed job queue when asked.
  assert.equal(engine.requeueFailedChunks(db, { onlyAccountErrors: true, asJob: true }), 1);
  const rows = db.prepare("SELECT chunk_id AS id, status, attempts, redo FROM summary_chunks ORDER BY chunk_id").all();
  assert.deepEqual(rows[0], { id: first, status: "pending", attempts: 0, redo: 1 });
  assert.equal(rows[1].status, "failed");
  // Still being retried on its own (1 of 3 attempts used): left alone.
  assert.deepEqual(rows[2], { id: third, status: "failed", attempts: 1, redo: 0 });

  // "重试" on the home page: everything that was given up on.
  assert.equal(engine.requeueFailedChunks(db, {}), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM summary_chunks WHERE status = 'failed' AND attempts >= 3").get().n, 0);
});

test("describes AI errors in words a user can act on", () => {
  assert.equal(engine.describeAiError({ status: 402 }).kind, "balance");
  assert.equal(engine.describeAiError({ status: 401 }).kind, "key");
  assert.equal(engine.describeAiError({ status: 429 }).kind, "rate-limit");
  assert.equal(engine.describeAiError({ status: 503 }).kind, "outage");
  assert.equal(engine.describeAiError({ status: null, message: "connect ECONNREFUSED 1.2.3.4:443" }).kind, "network");
  assert.equal(engine.describeAiError({ status: 402 }).text, "AI 服务余额不足");
});

test("an unexpected error is the chunk's failure, not an outage that stalls the queue", async (t) => {
  // A provider that answers 200 with a body that is not an OpenAI answer at all.
  const server = await new Promise((resolve) => {
    const instance = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ unexpected: true }));
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve({ instance, url: `http://127.0.0.1:${instance.address().port}/v1` }));
  });
  t.after(() => server.instance.close());
  const db = seed();
  const outcome = await engine.mapPendingChunks(db, createClient({ baseUrl: server.url, apiKey: "k", model: "m" }), { now: NOW, mapConcurrency: 1 });
  assert.equal(outcome.routeDown, null);
  assert.equal(outcome.failed, 3);
  assert.equal(engine.routeProblem(db), null);
});

test("one chunk that always fails with a 500 is that chunk's failure: the probe shows the account works", async (t) => {
  const server = await new Promise((resolve) => {
    const instance = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (body.includes("一群")) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        const content = { summary: "摘要", topics: [], ok: true };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve({ instance, url: `http://127.0.0.1:${instance.address().port}/v1` }));
  });
  t.after(() => server.instance.close());
  const db = seed();
  const outcome = await engine.mapPendingChunks(db, createClient({ baseUrl: server.url, apiKey: "k", model: "m" }), { now: NOW, mapConcurrency: 1 });
  assert.equal(outcome.routeDown, null);
  assert.equal(outcome.done, 2);
  assert.equal(outcome.failed, 1);
  assert.equal(engine.routeProblem(db), null);
});

test("chunks whose stored summary is a refusal are summarized again, others stay done", () => {
  const { isDeclinedSummary } = require("../src/llm_summarizer");
  const db = seed();
  const [refused, quiet, real] = db.prepare("SELECT chunk_id AS id FROM summary_chunks ORDER BY chunk_id").all().map((row) => row.id);
  const partial = (summary, topics = []) => ({ summary, topics, newThings: [], qa: [], timeline: [], uncategorized: [], links: [] });
  store.saveChunkResult(db, refused, { partial: partial("这批消息里有涉及未成年人的性化内容，我不能整理、摘录或复述。") });
  store.saveChunkResult(db, quiet, { partial: partial("这段消息很少，主要是群友之间的互相调侃。") });
  store.saveChunkResult(db, real, { partial: partial("在聊显卡。", [{ title: "显卡", summary: "3090 够用" }]) });

  assert.equal(store.requeueDeclined(db, isDeclinedSummary), 1);
  const rows = db.prepare("SELECT chunk_id AS id, status, redo, partial_json AS partial FROM summary_chunks ORDER BY chunk_id").all();
  assert.deepEqual(rows.map((row) => [row.status, row.redo, row.partial === null]), [["pending", 0, true], ["done", 0, false], ["done", 0, false]]);
  assert.equal(store.requeueDeclined(db, isDeclinedSummary), 0);
});
