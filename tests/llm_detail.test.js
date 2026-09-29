"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const store = require("../src/briefing_store");
const engine = require("../src/briefing_engine");
const { profileFor } = require("../src/llm_profiles");
const { createClient, mergeBriefPartials } = require("../src/llm_summarizer");

const NOW = 1_800_000_000;
const HOUR = 3600;

// Records every request; answers a map, a full merge or an overview-only
// merge according to the prompt it received.
const startMock = () =>
  new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const prompt = JSON.parse(body.messages[1].content);
        const kind = prompt.partials === undefined ? "map" : prompt.outputSchema.newThings === undefined ? "overview" : "full";
        calls.push({ kind, maxTokens: body.max_tokens, rules: prompt.rules ?? [], partials: prompt.partials ?? [] });
        const topic = { title: "话题", summary: "讨论", importance: "high", messageCountEstimate: 3, details: ["A 说了细节"], evidence: ["A：原话"] };
        const content = kind === "overview"
          ? { summary: "总览", topics: [{ title: "话题", summary: "讨论", importance: "high", messageCountEstimate: 3 }] }
          : { summary: `${kind} 摘要`, topics: [topic], newThings: [], qa: [], timeline: [], uncategorized: [], links: [] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });

const partial = (index) => ({
  summary: `第 ${index} 段`,
  topics: [{ title: `话题${index}`, summary: "s", importance: "high", messageCountEstimate: 5, details: ["d1", "d2", "d3"], evidence: ["e1", "e2"] }],
  newThings: [], qa: [], timeline: [], uncategorized: [], links: [],
});

test("the detailed level runs the full merge and keeps topic details; standard stays overview-only", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const partials = [partial(1), partial(2)];

  const standard = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
  const cheap = await mergeBriefPartials(standard, {}, partials, { model: "m" });
  assert.equal(cheap.mode, "brief-merge");
  assert.deepEqual(cheap.summary.topics[0].details, []);

  const detailed = createClient({ baseUrl: mock.url, apiKey: "k", model: "m", detail: "detailed" });
  const full = await mergeBriefPartials(detailed, {}, partials, { model: "m" });
  assert.equal(full.mode, "mapreduce");
  assert.deepEqual(full.summary.topics[0].details, ["A 说了细节"]);

  const fullCall = mock.calls.find((call) => call.kind === "full");
  assert.equal(fullCall.maxTokens, profileFor("detailed").reduce.maxTokens);
  // Detailed trimming keeps more of each chunk than the standard 2 details / 1 quote.
  assert.deepEqual(fullCall.partials[0].topics[0].details, ["d1", "d2", "d3"]);
  assert.deepEqual(fullCall.partials[0].topics[0].evidence, ["e1", "e2"]);
  assert.ok(fullCall.rules.some((rule) => rule.includes("topics 最多 25 个")));
});

const seed = () => {
  const db = store.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-detail-")), "messages.db")),
  );
  messageStore.ingestExport(db, {
    groupIds: ["1001"],
    groupNames: { 1001: "画图群" },
    startUnix: NOW - 30 * HOUR,
    endUnix: NOW,
    coveredFromUnix: NOW - 30 * HOUR,
    messages: Array.from({ length: 30 }, (_, index) => ({
      groupId: "1001", rowId: String(100 + index), msgSeq: String(index), sentAt: NOW - 20 * HOUR + index * 60,
      senderUin: "222", senderName: "Alice", text: `消息 ${index}`, isSelf: false, atUins: [], atAll: false, replyTo: null,
    })),
    mediaMessages: [],
  }, "run");
  return db;
};

test("a detailed redo re-maps old chunks, keeps them visible meanwhile, then re-merges the brief", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const db = seed();
  const options = { now: NOW, maxMessages: 10, force: true };

  // Standard first: 3 chunks mapped, one brief merged.
  const standard = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
  engine.closeChunks(db, ["1001"], options);
  await engine.mapPendingChunks(db, standard, options);
  await engine.reduceBriefs(db, standard, ["1001"], options);
  const before = store.getGroupBrief(db, "1001");
  assert.equal(before.chunkKey.includes("d"), false);

  // Queue the redo: nothing disappears while it waits.
  assert.equal(store.markChunksForRedo(db, { fromUnix: NOW - 24 * HOUR }), 3);
  assert.equal(store.redoStats(db).queued, 3);
  assert.equal(store.doneChunksInWindow(db, "1001", 0).length, 3);
  // A brand-new chunk is served before redo work.
  messageStore.ingestExport(db, {
    groupIds: ["1001"], groupNames: { 1001: "画图群" }, startUnix: NOW - HOUR, endUnix: NOW, coveredFromUnix: NOW - HOUR,
    messages: [{ groupId: "1001", rowId: "999", msgSeq: "999", sentAt: NOW - 60, senderUin: "222", senderName: "Alice", text: "新消息", isSelf: false, atUins: [], atAll: false, replyTo: null }],
    mediaMessages: [],
  }, "run");
  store.insertChunk(db, { groupId: "1001", startSentAt: NOW - 60, endSentAt: NOW - 60, firstRowId: "999", lastRowId: "999", messageCount: 1, createdAt: NOW });
  const queue = store.chunksToSummarize(db, 10);
  assert.equal(queue.length, 4);
  assert.equal(queue[0].lastRowId, "999");

  const detailed = createClient({ baseUrl: mock.url, apiKey: "k", model: "m", detail: "detailed" });
  const mapped = await engine.mapPendingChunks(db, detailed, options);
  assert.equal(mapped.done, 4);
  assert.equal(store.redoStats(db).queued, 0);
  assert.ok(mock.calls.filter((call) => call.kind === "map").slice(-4).every((call) => call.maxTokens === profileFor("detailed").map.singleMaxTokens));

  const reduced = await engine.reduceBriefs(db, detailed, ["1001"], { ...options, reduceIntervalSeconds: 0 });
  assert.equal(reduced.updated, 1);
  assert.match(store.getGroupBrief(db, "1001").chunkKey, /^\d+d,\d+d,\d+d/u);
});

test("a failed redo keeps the old summary and gives up after the usual attempts", () => {
  const db = seed();
  const id = store.insertChunk(db, { groupId: "1001", startSentAt: NOW - 20 * HOUR, endSentAt: NOW - 19 * HOUR, firstRowId: "100", lastRowId: "110", messageCount: 11, createdAt: NOW });
  store.saveChunkResult(db, id, { partial: partial(1) });
  store.markChunksForRedo(db, { fromUnix: 0 });
  for (let attempt = 0; attempt < store.MAX_CHUNK_ATTEMPTS; attempt += 1) {
    assert.equal(store.chunksToSummarize(db, 10).length, 1);
    store.saveChunkResult(db, id, { error: "boom" });
  }
  assert.equal(store.chunksToSummarize(db, 10).length, 0);
  const [chunk] = store.doneChunksInWindow(db, "1001", 0);
  assert.equal(chunk.detail, "standard");
  assert.equal(JSON.parse(chunk.partialJson).summary, "第 1 段");
});

test("the detailed level asks for more on every call", () => {
  const standard = profileFor("standard");
  const detailed = profileFor("detailed");
  assert.equal(profileFor("nonsense"), standard);
  assert.ok(detailed.map.maxTokens > standard.map.maxTokens);
  assert.ok(detailed.engine.dailyLlmCallLimit > standard.engine.dailyLlmCallLimit);
  assert.ok(detailed.engine.maxReduceChunks > standard.engine.maxReduceChunks);
  assert.equal(detailed.engine.reduceIntervalSeconds, 0);
  assert.equal(standard.userTunable, true);
  assert.equal(detailed.userTunable, false);
});

test("a merge of many large chunk summaries is trimmed to fit the level's input budget", () => {
  const { buildReducePrompt } = require("../src/llm_summarizer");
  const big = (index) => ({
    summary: "s".repeat(400),
    topics: Array.from({ length: 20 }, (_, topic) => ({
      title: `话题${index}-${topic}`, summary: "x".repeat(300), importance: "high", messageCountEstimate: 5,
      details: Array.from({ length: 8 }, () => "d".repeat(150)), evidence: Array.from({ length: 4 }, () => "e".repeat(100)),
    })),
    newThings: [], qa: [], timeline: [], uncategorized: [], links: [],
  });
  const partials = Array.from({ length: 40 }, (_, index) => big(index));
  const prompt = JSON.parse(buildReducePrompt({}, partials, "detailed").user);
  assert.ok(JSON.stringify(prompt.partials).length <= profileFor("detailed").reduce.inputChars);
  // Every chunk is still represented, just with fewer points each.
  assert.equal(prompt.partials.length, 40);
  assert.ok(prompt.partials.every((partial) => partial.topics.length >= 1));
});
