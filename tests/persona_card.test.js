"use strict";

// 角色卡 end to end against a stand-in AI service: the material, the points
// tied to real lines, the card, and the blind test.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { ensureBriefingSchema } = require("../src/briefing_store");
const { ensureUsageSchema } = require("../src/llm_usage");
const { createClient } = require("../src/llm_summarizer");
const { gather, enough, HELD_OUT } = require("../src/persona_material");
const { realSide } = require("../src/persona_card");
const { ensurePersonaSchema, getPersona, deletePersona } = require("../src/persona_store");
const { run } = require("../src/persona_run");

const NOW = 1_800_000_000;
const ANNA = "20002";
const FRIENDS = [["30003", "鲍勃"], ["40004", "小周"], ["50005", "老李"]];

// 150 rounds: a friend says something, Anna answers it with a quoted reply;
// every fifth round she also holds forth on her own.
const seed = () => {
  const db = ensurePersonaSchema(ensureUsageSchema(ensureBriefingSchema(
    messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "persona-")), "messages.db")),
  )));
  const messages = [];
  let row = 0;
  const say = (groupId, uin, name, text, sentAt, replyTo = null) => {
    row += 1;
    messages.push({ groupId, rowId: String(row), msgSeq: String(row), sentAt, senderUin: uin, senderName: name, text, isSelf: false, atUins: [], atAll: false, replyTo });
    return row;
  };
  for (let round = 0; round < 150; round += 1) {
    const [uin, name] = FRIENDS[round % FRIENDS.length];
    const groupId = round % 2 === 0 ? "11111" : "22222";
    const at = NOW - (150 - round) * 3600;
    const asked = say(groupId, uin, name, `第 ${round} 轮：这个参数到底要怎么调才对`, at);
    say(groupId, ANNA, "安娜", `第 ${round} 轮我觉得先把步数降下来再说`, at + 30, { seq: String(asked), uin });
    if (round % 5 === 0) {
      say(groupId, ANNA, "安娜", `第 ${round} 轮的长篇大论：我一直认为调参这件事不能只看别人的截图，得自己跑一遍才知道`, at + 60);
    }
  }
  messageStore.ingestExport(db, {
    groupIds: ["11111", "22222"], groupNames: { 11111: "画图群", 22222: "闲聊群" },
    startUnix: NOW - 200 * 3600, endUnix: NOW, coveredFromUnix: NOW - 200 * 3600, messages, mediaMessages: [],
  }, "run");
  return db;
};

// Answers each of the four kinds of call; records what it was shown.
const startMock = () => new Promise((resolve) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const system = body.messages[0].content;
      const prompt = JSON.parse(body.messages[1].content);
      let content;
      if (prompt.material !== undefined) {
        const ids = prompt.material.map((line) => line.split(" ")[0]);
        calls.push({ kind: "observe", lines: prompt.material });
        content = {
          stances: [{ topic: "调参", view: "先降步数", ids: [ids[0], "E9999"] }, { topic: "编的", view: "没有依据", ids: ["E9999"] }],
          attitudes: [{ toward: "鲍勃", how: "耐心", ids: [ids[0]] }],
          humor: [], habits: [{ pattern: "爱说「再说」", ids: [ids[1]] }], interests: [{ what: "调参", ids: [ids[0]] }], facts: [],
        };
      } else if (prompt.observations !== undefined) {
        calls.push({ kind: "compose", observations: prompt.observations });
        const first = prompt.observations.stances[0];
        content = {
          oneLine: "爱自己动手试的调参人", portrait: "安娜遇到问题先动手，不信截图。", voice: { tone: "平和", sentences: "短句，常以「再说」收尾", catchphrases: ["再说"] },
          stances: [{ topic: "调参", view: "先降步数", ids: first.ids }], attitudes: [{ toward: "鲍勃", how: "耐心", ids: first.ids }],
          humor: [], interests: [], facts: [{ fact: "编的", ids: ["M9999"] }], examples: [...first.ids, "E9999"],
        };
      } else if (system.includes("扮演")) {
        calls.push({ kind: "reply", card: prompt.card, messages: prompt.messages });
        content = { replies: prompt.messages.map((item) => ({ n: item.n, reply: "先把步数降下来再说" })) };
      } else {
        calls.push({ kind: "judge", questions: prompt.questions });
        // Always says A: right exactly when the real one sits on A.
        content = { picks: prompt.questions.map((item) => ({ n: item.n, real: "A", why: "更口语" })) };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }));
});

test("the material: replies with what they answer, spread over partners, some held back for the test", () => {
  const db = seed();
  const material = gather(db, { uin: ANNA, now: NOW });
  assert.equal(enough(material), true);
  assert.equal(material.heldOut.length, HELD_OUT);
  assert.equal(material.stats.replies, 150);
  assert.equal(material.exchanges.length, 120, "40 per partner at most");
  assert.deepEqual([...new Set(material.exchanges.slice(0, 3).map((item) => item.partnerName))].sort(), ["小周", "老李", "鲍勃"].sort());
  const held = new Set(material.heldOut.map((item) => item.rowId));
  assert.equal(material.exchanges.some((item) => held.has(item.rowId)), false, "what is held back is never shown to the card's writer");
  assert.equal(material.batches.flat().some((line) => material.heldOut.some((item) => line.includes(item.reply))), false);
  assert.match(material.batches[0][0], /^E1 \[(画图群|闲聊群)\] .+：第 \d+ 轮：这个参数.+ → TA：第 \d+ 轮我觉得/u);
  assert.equal(material.monologues.length, 30);
  assert.equal(enough(gather(db, { uin: "99999", now: NOW })), false);
});

test("the card: points keep only lines that exist, the test compares real replies with written ones", async () => {
  const db = seed();
  const mock = await startMock();
  try {
    const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
    const steps = [];
    const result = await run(db, client, { uin: ANNA }, { now: NOW, log: (line) => steps.push(line) });
    assert.deepEqual(result, { uin: ANNA, name: "安娜" });
    const saved = getPersona(db, ANNA);
    assert.equal(saved.card.oneLine, "爱自己动手试的调参人");
    assert.equal(saved.model, "m");
    // made-up line numbers are gone, and a point left with none is dropped
    assert.equal(saved.card.stances.length, 1);
    assert.equal(saved.card.stances[0].ids.includes("E9999"), false);
    assert.deepEqual(saved.card.facts, []);
    assert.equal(saved.card.examples.includes("E9999"), false);
    for (const id of [...saved.card.stances[0].ids, ...saved.card.examples]) {
      assert.ok(saved.evidence[id].rowId, `evidence for ${id} leads to a real message`);
    }
    assert.match(saved.text, /## 说话方式[\s\S]*常用的词句：再说[\s\S]*## 真实对话/u);
    // the blind test: the judge said A every time, so it found the real one where the real one was on A
    assert.equal(saved.test.asked, HELD_OUT);
    assert.equal(saved.test.spotted, Array.from({ length: HELD_OUT }, (unused, index) => realSide(index + 1)).filter((side) => side === "A").length);
    assert.equal(saved.test.questions.every((question) => question.written === "先把步数降下来再说" && question.real.includes("我觉得先把步数降下来")), true);
    // what each call was shown
    const kinds = mock.calls.map((call) => call.kind);
    assert.deepEqual([...new Set(kinds)], ["observe", "compose", "reply", "judge"]);
    const reply = mock.calls.find((call) => call.kind === "reply");
    assert.equal(reply.messages.some((item) => item.reply !== undefined), false, "the writer of the test replies never sees the real ones");
    const judge = mock.calls.find((call) => call.kind === "judge");
    assert.equal(JSON.stringify(judge.questions).includes("爱自己动手试"), false, "the judge never sees the card");
    assert.deepEqual(steps.filter((line) => /step=(compose|test)/u.test(line)), ["persona step=compose 0/1", "persona step=test 0/1"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE purpose = 'persona'").get().n >= 0, true);
    assert.equal(deletePersona(db, ANNA), true);
    assert.equal(getPersona(db, ANNA), null);
  } finally {
    mock.server.close();
  }
});

test("too little to write from is said plainly, and no AI call is made", async () => {
  const db = seed();
  const mock = await startMock();
  try {
    const client = createClient({ baseUrl: mock.url, apiKey: "k", model: "m" });
    await assert.rejects(() => run(db, client, { uin: "30003" }, { now: NOW - 149 * 3600, log: () => {} }), /不到 60 条/u);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.server.close();
  }
});

test("the real reply sits on each side half of the time", () => {
  const sides = Array.from({ length: 8 }, (unused, index) => realSide(index + 1));
  assert.equal(sides.filter((side) => side === "A").length, 4);
});

test("the card's writer hears every batch in turn, and its prompt stays a size any model takes", () => {
  const { pointsForCompose, composePrompt, cleanPoints } = require("../src/persona_card");
  const long = "长".repeat(300);
  // the most an answer can hold once cleaned: every field as long as it may be
  const batch = (tag) => cleanPoints(Object.fromEntries(["stances", "attitudes", "humor", "habits", "interests", "facts"].map((kind) => [kind,
    Array.from({ length: 24 }, (unused, index) => ({ topic: `${tag}${index}`, view: long, toward: tag, how: long, kind: long, pattern: long, what: long, fact: long, ids: ["E1", "E2", "E3", "E4"] }))])), new Set(["E1", "E2", "E3", "E4"]));
  const points = pointsForCompose([batch("a"), batch("b"), batch("c"), batch("d"), batch("e"), batch("f")]);
  assert.equal(points.stances.length, 24);
  assert.deepEqual(points.stances.slice(0, 7).map((item) => item.topic), ["a0", "b0", "c0", "d0", "e0", "f0", "a1"]);
  const lineOf = new Map(["E1", "E2", "E3", "E4"].map((id) => [id, `${id} [群] 某人：${long} → TA：${long}`]));
  const prompt = composePrompt(points, lineOf, { names: ["安娜"], stats: { groups: 2, exchanges: 400, monologues: 180 } });
  assert.ok(prompt.user.length < 100_000, `compose prompt is ${prompt.user.length} characters`);
});
