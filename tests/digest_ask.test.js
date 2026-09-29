"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const digestStore = require("../src/digest_store");
const digestEngine = require("../src/digest_engine");
const periods = require("../src/digest_periods");
const { findEvidence } = require("../src/ask_retrieval");
const { ask } = require("../src/ask_history");
const { createClient } = require("../src/llm_summarizer");

const HOUR = 3600;
const DAY = 86400;
// Tuesday 2026-09-29 12:00 Beijing.
const NOW = Date.UTC(2026, 8, 29, 4) / 1000;
const YESTERDAY = "2026-09-28";

// Answers by prompt type; records what it was asked.
const startMock = () =>
  new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const system = body.messages[0].content;
        const prompt = JSON.parse(body.messages[1].content);
        let content;
        if (system.includes("日报")) {
          calls.push({ kind: "day", input: prompt.input });
          content = { headline: `日报 ${prompt.task}`, summary: "各群都很热闹", highlights: [{ title: "新模型", detail: "大家在试", groups: ["画图群"], importance: "high" }, { title: "缺 detail" }], crossGroup: [], newThings: [], openQuestions: [], groups: [{ group: "画图群", oneLine: "聊模型" }] };
        } else if (system.includes("周报") || system.includes("月报")) {
          calls.push({ kind: "period", input: prompt.input });
          content = { headline: "这周的报告", summary: "一周概览", trends: [{ title: "Flux", detail: "越来越热" }], highlights: [], groups: [], newThings: [], bestQa: [] };
        } else if (system.includes("拆成用于全文搜索的关键词")) {
          calls.push({ kind: "plan", question: prompt.question });
          content = { keywords: ["lora", "显存"], fromDay: null, toDay: null, groups: [] };
        } else {
          calls.push({ kind: "answer", messages: prompt.messages, clues: prompt.summaryClues });
          const ref = Number(prompt.messages.find((line) => line.includes("models/loras 就行"))?.match(/^#(\d+)/u)?.[1]);
          content = { answer: "放在 models/loras。", citations: [ref, 9999], confidence: "high", found: true, followUps: ["还有别的路径吗？"] };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });

const message = (groupId, index, sentAt, text) => ({
  groupId, rowId: String(index), msgSeq: String(index), sentAt, senderUin: String(100 + (index % 3)), senderName: ["阿杰", "小雨", "老王"][index % 3],
  text, isSelf: false, atUins: [], atAll: false, replyTo: null,
});

const seed = () => {
  const db = digestStore.ensureDigestSchema(briefingStore.ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "digest-ask-")), "messages.db")),
  ));
  const monday = periods.periodBounds("day", YESTERDAY).startUnix;
  const lines = [
    "今晚开黑吗", "ComfyUI 新版的 LoRA 放哪个文件夹", "LoRA 放 models/loras 就行", "谢啦", "3090 显存够跑 Flux 吗",
    "显存 24G 够了", "周六聚餐改周日", "好的", "有人要团购显卡吗", "不要",
  ];
  messageStore.ingestExport(db, {
    groupIds: ["1001", "2002"],
    groupNames: { 1001: "画图群", 2002: "闲聊群" },
    startUnix: monday - DAY,
    endUnix: NOW,
    coveredFromUnix: monday - DAY,
    messages: [
      ...lines.map((text, index) => message("1001", index + 1, monday + 10 * HOUR + index * 60, text)),
      ...lines.map((text, index) => message("2002", index + 101, monday + 14 * HOUR + index * 60, `闲聊 ${text}`)),
    ],
    mediaMessages: [],
  }, "run");
  const partial = (title) => ({
    summary: `${title} 的一段`, topics: [{ title, summary: "讨论了 LoRA", importance: "high", messageCountEstimate: 5, details: ["放 models/loras"], evidence: [] }],
    newThings: [{ kind: "model", name: "Flux LoRA", detail: "新出的", link: null }], qa: [{ question: "LoRA 放哪", answer: "models/loras" }], timeline: [], uncategorized: [], links: [],
  });
  for (const [groupId, start, title] of [["1001", monday + 10 * HOUR, "画图"], ["2002", monday + 14 * HOUR, "闲聊"]]) {
    const chunkId = briefingStore.insertChunk(db, { groupId, startSentAt: start, endSentAt: start + 600, firstRowId: "0", lastRowId: "999", messageCount: 10, createdAt: NOW });
    briefingStore.saveChunkResult(db, chunkId, { partial: partial(title) });
  }
  return db;
};

test("a day overview reads every group's chunk summaries once and is reused until they change", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const db = seed();
  const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });

  const first = await digestEngine.generateDay(db, client, { day: YESTERDAY, now: NOW });
  assert.equal(first.status, "done");
  assert.equal(first.digest.complete, true);
  const input = mock.calls[0].input;
  assert.deepEqual(input.groups.map((group) => group.group).sort(), ["画图群", "闲聊群"]);
  assert.equal(input.groups[0].messages, 10);
  // An item missing its detail is dropped, not the digest.
  assert.deepEqual(first.digest.summary.highlights.map((item) => item.title), ["新模型"]);
  assert.equal(first.digest.summary.stats.chunks, 2);

  assert.equal((await digestEngine.generateDay(db, client, { day: YESTERDAY, now: NOW })).status, "unchanged");
  assert.equal(mock.calls.length, 1);
  // Asked for explicitly (the page's 重新生成): rewritten anyway.
  assert.equal((await digestEngine.generate(db, client, { kind: "day", period: YESTERDAY, now: NOW, force: true })).status, "done");
  assert.equal(mock.calls.length, 2);
  assert.equal((await digestEngine.generateDay(db, client, { day: "2026-09-20", now: NOW })).status, "no-data");
});

test("a week report writes its missing day overviews first; a closed gate stops before spending", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const db = seed();
  const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });

  const blocked = await digestEngine.generatePeriod(db, client, { kind: "week", period: YESTERDAY, now: NOW, gate: () => "paused" });
  assert.equal(blocked.status, "blocked");
  assert.equal(mock.calls.length, 0);

  const week = await digestEngine.generatePeriod(db, client, { kind: "week", period: YESTERDAY, now: NOW });
  assert.equal(week.status, "done");
  assert.deepEqual(mock.calls.map((call) => call.kind), ["day", "period"]);
  assert.equal(mock.calls[1].input.days[0].day, YESTERDAY);
  assert.equal(week.digest.complete, false);
  assert.equal(digestStore.listDigests(db, "week")[0].headline, "这周的报告");
});

test("the background schedule respects a per-run cap", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const db = seed();
  const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
  let calls = 0;
  const gate = () => {
    if (calls >= 1) {
      return "cap";
    }
    calls += 1;
    return null;
  };
  // Next Monday noon: yesterday (Sunday) has no chunks; last week's report
  // first writes Monday's overview (the one allowed call), then stops.
  const nextMonday = NOW + 6 * DAY;
  const outcome = await digestEngine.runScheduledDigests(db, client, { now: nextMonday, gate });
  assert.deepEqual(outcome, [
    { kind: "day", period: "2026-10-04", status: "no-data" },
    { kind: "week", period: "2026-09-28", status: "blocked" },
  ]);
  assert.deepEqual(mock.calls.map((call) => call.kind), ["day"]);
  assert.notEqual(digestStore.getDigest(db, "day", YESTERDAY), null);
});

test("retrieval ranks messages matching more keywords and widens them with context", () => {
  const db = seed();
  const evidence = findEvidence(db, { keywords: ["LoRA", "models/loras", "LoRA"], fromUnix: 0, toUnix: NOW + DAY, groupIds: ["1001"] },
    { hitsPerKeyword: 50, maxHits: 1, context: 1, inputChars: 10000, summaryHits: 5 });
  assert.deepEqual(evidence.keywords, ["lora", "models/loras"]);
  const hit = evidence.messages.find((item) => item.isHit);
  assert.equal(hit.text, "LoRA 放 models/loras 就行");
  // One hit plus one message either side, numbered in time order.
  assert.deepEqual(evidence.messages.map((item) => item.text), ["ComfyUI 新版的 LoRA 放哪个文件夹", "LoRA 放 models/loras 就行", "谢啦"]);
  assert.deepEqual(evidence.messages.map((item) => item.ref), [1, 2, 3]);
  assert.ok(evidence.clues.length > 0);
  assert.ok(evidence.clues.every((clue) => clue.groupName === "画图群"));
});

test("asking plans keywords, answers from the found messages and keeps only real citations", async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const db = seed();
  const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
  const result = await ask(db, client, { question: "LoRA 放哪里？" });
  assert.deepEqual(mock.calls.map((call) => call.kind), ["plan", "answer"]);
  assert.equal(result.answer, "放在 models/loras。");
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].groupName, "画图群");
  assert.match(result.citations[0].text, /models\/loras/u);
  assert.deepEqual(result.followUps, ["还有别的路径吗？"]);
  assert.ok(mock.calls[1].messages.every((line) => /^#\d+ \[/u.test(line)));
});
