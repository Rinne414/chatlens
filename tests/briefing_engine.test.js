"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const engine = require("../src/briefing_engine");
const { createClient } = require("../src/llm_summarizer");
const { buildBriefing } = require("../src/briefing_view");

const NOW = 1_800_000_000;
const HOUR = 3600;

const pendingOf = (count, { start, step = 30 }) =>
  Array.from({ length: count }, (_, index) => ({
    groupId: "1",
    groupName: "g",
    rowId: String(index + 1),
    sentAt: start + index * step,
    speaker: "A",
    text: `message ${index}`,
  }));

test("closes full chunks immediately and the tail only once it is ripe", () => {
  // 450 fresh messages: one full 400 chunk; the 50-message tail is too young.
  const fresh = pendingOf(450, { start: NOW - 450 * 5 - 600, step: 5 });
  assert.deepEqual(engine.planChunks(fresh, { now: NOW }), [{ from: 0, to: 400 }]);

  // A small tail older than an hour closes once it has 5+ messages...
  assert.deepEqual(engine.planChunks(pendingOf(6, { start: NOW - 2 * HOUR }), { now: NOW }), [{ from: 0, to: 6 }]);
  // ...but 3 messages wait, unless they are 6h old or the user forces it.
  assert.deepEqual(engine.planChunks(pendingOf(3, { start: NOW - 2 * HOUR }), { now: NOW }), []);
  assert.deepEqual(engine.planChunks(pendingOf(3, { start: NOW - 7 * HOUR }), { now: NOW }), [{ from: 0, to: 3 }]);
  assert.deepEqual(engine.planChunks(pendingOf(3, { start: NOW - 2 * HOUR }), { now: NOW, force: true }), [{ from: 0, to: 3 }]);

  // Messages from the last 5 minutes stay pending (late rows may still land).
  const settling = pendingOf(10, { start: NOW - 60, step: 1 });
  assert.deepEqual(engine.planChunks(settling, { now: NOW }), []);
});

const mapReply = (body) => {
  const prompt = JSON.parse(body.messages[1].content);
  const lines = prompt.messages ?? [];
  const group = lines[0]?.match(/\] \[([^\]]+)\]/u)?.[1] ?? "?";
  return {
    summary: `${group} 聊了 ${lines.length} 条`,
    topics: [{ title: `${group}话题`, summary: "讨论", importance: "high", messageCountEstimate: lines.length, details: ["d"], evidence: ["e"] }],
    newThings: [{ kind: "model", name: `${group}-模型`, detail: "新发布", link: "https://example.com/m", speaker: "A", hkt: "2027-01-15 08:00" }],
    qa: [{ question: "怎么装?", answer: "看教程", asker: "B", answerer: "A", hkt: "2027-01-15 08:01", resolved: true }],
    timeline: [],
    uncategorized: [],
    links: [],
  };
};

const startMockLlm = () =>
  new Promise((resolve) => {
    const calls = { map: 0, reduce: 0 };
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const isReduce = body.messages[0].content.includes("合并器");
        calls[isReduce ? "reduce" : "map"] += 1;
        const content = isReduce
          ? { summary: "合并后的摘要", topics: [], newThings: [{ kind: "tool", name: "合并工具", detail: "d", link: null }], qa: [], timeline: [], uncategorized: [], links: [] }
          : mapReply(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });

const seedStore = () => {
  const db = briefingStore.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "briefing-")), "messages.db")),
  );
  const messages = [
    ...Array.from({ length: 420 }, (_, index) => ({
      groupId: "1001", rowId: String(1000 + index), msgSeq: String(index), sentAt: NOW - 3 * HOUR + index * 10,
      senderUin: "222", senderName: "Alice", text: `画图讨论 ${index}`, isSelf: false, atUins: [], atAll: false, replyTo: null,
    })),
    { groupId: "1001", rowId: "5000", msgSeq: "9000", sentAt: NOW - 2 * HOUR, senderUin: "999", senderName: "我自己", text: "我的发言", isSelf: true, atUins: [], atAll: false, replyTo: null },
    { groupId: "1001", rowId: "5001", msgSeq: "9001", sentAt: NOW - 2 * HOUR + 5, senderUin: "222", senderName: "Alice", text: "@我自己 看这个", isSelf: false, atUins: ["999"], atAll: false, replyTo: null },
    ...Array.from({ length: 8 }, (_, index) => ({
      groupId: "2002", rowId: String(7000 + index), msgSeq: String(index), sentAt: NOW - 2 * HOUR + index * 60,
      senderUin: "333", senderName: "Bob", text: `闲聊 ${index}`, isSelf: false, atUins: [], atAll: false, replyTo: null,
    })),
  ];
  messageStore.ingestExport(db, {
    groupIds: ["1001", "2002"],
    groupNames: { 1001: "画图群", 2002: "闲聊群" },
    startUnix: NOW - 26 * HOUR,
    endUnix: NOW,
    coveredFromUnix: NOW - 26 * HOUR,
    messages,
    mediaMessages: [],
  }, "run");
  return db;
};

test("background briefing: chunk once, map once, reduce per group, then serve a ready briefing", async () => {
  const mock = await startMockLlm();
  const db = seedStore();
  try {
    const client = createClient({ baseUrl: mock.url, apiKey: "test", model: "mock" });
    const groups = ["1001", "2002"];

    // 1001: 422 text messages -> one 400 chunk + a 22-message tail (old enough);
    // 2002: 8 messages two hours old -> one tail chunk.
    assert.equal(engine.closeChunks(db, groups, { now: NOW }), 3);
    const map = await engine.mapPendingChunks(db, client, { now: NOW });
    assert.deepEqual(map, { done: 3, failed: 0, skippedForBudget: 0 });
    const reduce = await engine.reduceBriefs(db, client, groups, { now: NOW });
    assert.equal(reduce.updated, 2);
    // Only the group with two chunks needed a reduce call.
    assert.deepEqual(mock.calls, { map: 3, reduce: 1 });

    // A second tick with nothing new costs nothing.
    assert.equal(engine.closeChunks(db, groups, { now: NOW + 60 }), 0);
    await engine.mapPendingChunks(db, client, { now: NOW + 60 });
    const again = await engine.reduceBriefs(db, client, groups, { now: NOW + 60 });
    assert.equal(again.unchanged, 2);
    assert.deepEqual(mock.calls, { map: 3, reduce: 1 });

    const briefing = buildBriefing({
      db,
      knowledgeDbPath: path.join(os.tmpdir(), "does-not-exist.db"),
      watchlist: [{ groupId: "1001", name: "画图群" }, { groupId: "2002", name: "闲聊群" }],
      nowUnix: NOW,
    });
    assert.equal(briefing.totals.textMessages, 430);
    assert.equal(briefing.totals.unsummarized, 0);
    assert.equal(briefing.groups[0].groupId, "1001");
    assert.equal(briefing.groups[0].summary, "合并后的摘要");
    assert.equal(briefing.groups[1].summary, "闲聊群 聊了 8 条");
    assert.deepEqual(briefing.mentions.map((item) => [item.kind, item.speaker]), [["at", "Alice"]]);
    assert.deepEqual(briefing.identity, { known: true, names: ["我自己"] });
    assert.ok(briefing.highlights.newThings.some((item) => item.name === "合并工具" && item.groupName === "画图群"));
    assert.ok(briefing.highlights.qa.some((item) => item.groupName === "闲聊群" && item.resolved));

    // "看完了": the next briefing starts empty and old chunks no longer count.
    engine.markBriefingSeen(db, NOW);
    const after = await engine.reduceBriefs(db, client, groups, { now: NOW + 120 });
    assert.equal(after.cleared, 2);
    const fresh = buildBriefing({ db, knowledgeDbPath: "", watchlist: [], nowUnix: NOW + 120 });
    assert.equal(fresh.totals.textMessages, 0);
  } finally {
    db.close();
    mock.server.close();
  }
});

test("daily LLM budget stops map calls instead of overspending", async () => {
  const mock = await startMockLlm();
  const db = seedStore();
  try {
    const client = createClient({ baseUrl: mock.url, apiKey: "test", model: "mock" });
    engine.closeChunks(db, ["1001", "2002"], { now: NOW });
    const map = await engine.mapPendingChunks(db, client, { now: NOW, dailyLlmCallLimit: 2, mapConcurrency: 1 });
    assert.equal(map.done, 2);
    assert.equal(map.skippedForBudget, 1);
    assert.equal(engine.budgetStatus(db, NOW, 2).exhausted, true);
  } finally {
    db.close();
    mock.server.close();
  }
});
