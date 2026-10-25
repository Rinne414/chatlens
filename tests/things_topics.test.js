"use strict";

// 笔记库 → 主题 (src/things_topics.js): where each thing goes, how a topic
// sums up its members, and the AI pass with a fake LLM, so no call is made.

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const { nameKey, linkKey, buildThings } = require("../src/things_index");
const {
  ITEMS_PER_CALL, loadTopics, placeThings, buildTopics, isNotable, readAnswer, runTopicPass, consensusSubject, buildTopicPrompt,
} = require("../src/things_topics");

const mention = (name, { chunkId = 1, groupId = "1", kind = "model", sentAt = 1000, link = "" } = {}) => ({
  chunkId, index: 0, groupId, sentAt, kind, name, key: nameKey(name), detail: `${name} 的说明`, link, linkKey: linkKey(link), speaker: "",
});

// [name, groups, kind] -> things, one chunk per group.
const thingsOf = (spec) => buildThings(spec.flatMap(([name, groups, kind = "model"]) =>
  groups.map((groupId, index) => mention(name, { chunkId: index + 1 + name.length * 100, groupId, kind }))));

const byName = (things) => new Map(things.map((thing) => [thing.name, thing]));

const fakeLlm = (answer) => {
  const calls = [];
  return { calls, callLlm: async (_client, build, meta) => {
    const prompt = build("detailed");
    calls.push({ prompt, meta });
    const raw = typeof answer === "function" ? answer(prompt, calls.length) : answer;
    meta.validate?.(raw);
    return raw;
  } };
};

test("a thing goes where most of its mentions' names were placed, and a user's pin outranks the AI", () => {
  const things = thingsOf([["Krea2", ["1", "2", "3"]], ["Moss", ["1"]], ["新东西", ["1"]]]);
  const members = new Map([["krea2", { topicKey: "krea", role: "main", what: "Krea 第二代" }], ["moss", { topicKey: "", role: "other", what: "" }]]);
  const named = byName(things);

  const placed = placeThings(things, members, new Map([["moss", "mossimage"]]));

  assert.deepEqual(placed.get(named.get("Krea2")), { topicKey: "krea", role: "main", what: "Krea 第二代" });
  assert.deepEqual(placed.get(named.get("Moss")), { topicKey: "mossimage", role: "main", what: "" });
  assert.equal(placed.get(named.get("新东西")), null);
});

test("a topic sums up its members: the main ones name it, the others are listed by role", () => {
  const things = thingsOf([["Krea2", ["1", "2"]], ["k2", ["2"]], ["Krea2 动漫 LoRA", ["3"], "resource"], ["孤零零", ["1"]], ["大家都在讲", ["1", "2", "3"]]]);
  const named = byName(things);
  const placement = new Map([
    [named.get("Krea2"), { topicKey: "krea", role: "main", what: "" }],
    [named.get("k2"), { topicKey: "krea", role: "version", what: "" }],
    [named.get("Krea2 动漫 LoRA"), { topicKey: "krea", role: "derived", what: "动漫 LoRA" }],
    [named.get("孤零零"), { topicKey: "", role: "other", what: "" }],
    [named.get("大家都在讲"), null],
  ]);
  const stored = new Map([["krea", { key: "krea", name: "Krea", category: "image", what: "图像模型" }]]);

  const topics = buildTopics(things, placement, stored);

  assert.deepEqual(topics.map((topic) => topic.name), ["Krea", "大家都在讲"]);
  const [krea, alone] = topics;
  assert.deepEqual(krea.core.map((thing) => thing.name), ["Krea2"]);
  assert.deepEqual(krea.groups.map((group) => group.groupId).sort(), ["1", "2", "3"]);
  assert.equal(krea.mentions.length, 4);
  assert.equal(krea.mentions[0].thing !== undefined, true);
  // A heavy thing nobody placed stands alone until it is; a light one has no topic.
  assert.equal(alone.key, "thing:大家都在讲");
  assert.equal(alone.category, "other");
  assert.equal(isNotable(krea), true);
});

test("the answer becomes topics and places; a topic named but not defined is defined from its first member", () => {
  const things = thingsOf([["Krea2", ["1"]], ["k2", ["1"]], ["瞎聊", ["1"], "other"]]);
  const known = new Map([["krea", { key: "krea", name: "Krea", category: "image" }]]);
  const raw = {
    items: [{ i: 1, topic: "Krea", role: "main", what: "Krea 第二代" }, { i: 2, topic: "Kimi", role: "bogus", what: "x".repeat(50) }],
    topics: [{ name: "Krea", category: "image" }],
  };

  const { topics, places } = readAnswer(raw, things, known);

  assert.deepEqual(topics.map((topic) => [topic.key, topic.category]), [["kimi", "other"]]);
  assert.deepEqual(places.map((place) => [place.topicKey, place.role]), [["krea", "main"], ["kimi", "other"], ["", "other"]]);
  assert.equal([...places[1].what].length, 30);
});

test("the topic pass asks once per thing, the first batch alone, and lists the topics it made", async () => {
  const db = new Database(":memory:");
  const things = thingsOf(Array.from({ length: ITEMS_PER_CALL + 5 }, (_, index) => [`模型${index}`, ["1"]]));
  const { calls, callLlm } = fakeLlm((prompt) => {
    const lines = prompt.user.split("\n").filter((line) => /^\d+ \| /u.test(line));
    return { items: lines.map((line) => ({ i: Number(line.split(" | ")[0]), topic: "大家族", role: "derived", what: "某个模型" })), topics: [{ name: "大家族", category: "image", what: "一族模型" }] };
  });
  const run = () => runTopicPass(db, { things, callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix: 1 });

  const first = await run();
  const second = await run();

  assert.equal(first.calls, 2);
  assert.equal(first.placed, ITEMS_PER_CALL + 5);
  assert.equal(second.calls, 0);
  // The second call already knew the topic the first one made.
  assert.match(calls[1].prompt.user, /已有主题[\s\S]*大家族（image）/u);
  const { topics, members } = loadTopics(db);
  assert.equal(topics.get("大家族").what, "一族模型");
  assert.equal(members.get("模型0").topicKey, "大家族");
});

test("a batch the AI cannot answer counts as no topic; a provider that is down stops the pass", async () => {
  const things = thingsOf([["甲", ["1"]], ["乙", ["1"]]]);
  const broken = new Database(":memory:");
  const { callLlm } = fakeLlm({ nothing: true });

  const failed = await runTopicPass(broken, { things, callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix: 1 });

  assert.equal(failed.failed, 1);
  assert.equal(loadTopics(broken).members.get("甲").topicKey, "");

  const down = new Database(":memory:");
  const offline = async () => {
    const error = new Error("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  const stopped = await runTopicPass(down, { things, callLlm: offline, client: {}, model: () => "fake", gate: () => null, nowUnix: 1 });

  assert.equal(stopped.stoppedBy, "provider-down");
  assert.equal(loadTopics(down).members.size, 0);
});

test("the gate stops the pass before a call", async () => {
  const db = new Database(":memory:");
  const things = thingsOf([["甲", ["1"]]]);
  const { calls, callLlm } = fakeLlm({ items: [] });

  const outcome = await runTopicPass(db, { things, callLlm, client: {}, model: () => "fake", gate: () => "paused", nowUnix: 1 });

  assert.equal(outcome.stoppedBy, "paused");
  assert.equal(calls.length, 0);
});

test("a topic's consensus input puts its own mentions before its LoRAs'", () => {
  const things = thingsOf([["Moss", ["1"]], ["Moss 风格 LoRA", ["1", "2"], "resource"]]);
  const named = byName(things);
  const placement = new Map([
    [named.get("Moss"), { topicKey: "moss", role: "main", what: "" }],
    [named.get("Moss 风格 LoRA"), { topicKey: "moss", role: "derived", what: "" }],
  ]);
  const [topic] = buildTopics(things, placement, new Map([["moss", { key: "moss", name: "MOSS-Image", category: "image", what: "" }]]));

  const subject = consensusSubject(topic, []);

  assert.equal(subject.anchor, "topic:moss");
  assert.equal(subject.mentions[0].name, "Moss");
  assert.deepEqual(subject.memberNames, ["Moss 风格 LoRA"]);
});

test("the prompt lists every thing with its counts and what the chat said", () => {
  const things = thingsOf([["Krea2", ["1", "2"]]]);

  const prompt = buildTopicPrompt(things, [{ name: "Krea", category: "image" }]);

  assert.match(prompt, /^1 \| Krea2 \| model \| 2群2次 \| Krea2 的说明$/mu);
  assert.match(prompt, /Krea（image）/u);
});

test("a thing whose names were placed apart goes where most of its mentions are, with that name's role", () => {
  // One thing under two spellings (one shared project link), placed in two topics.
  const link = "https://github.com/someone/krea2";
  const things = buildThings([
    ...[1, 2, 3].map((chunkId) => mention("Krea2", { chunkId, link })),
    mention("k2", { chunkId: 4, link }),
  ]);
  const members = new Map([
    ["krea2", { topicKey: "krea", role: "main", what: "Krea 第二代" }],
    ["k2", { topicKey: "kimi", role: "version", what: "Kimi K2" }],
  ]);

  const placed = placeThings(things, members);

  assert.equal(things.length, 1);
  assert.deepEqual(placed.get(things[0]), { topicKey: "krea", role: "main", what: "Krea 第二代" });
});

test("things the AI could not answer about are asked again a day later, in smaller batches", async () => {
  const db = new Database(":memory:");
  const things = thingsOf(Array.from({ length: 25 }, (_, index) => [`模型${index}`, ["1"]]));
  const { ensureTopicSchema } = require("../src/things_topics");
  ensureTopicSchema(db);
  things.forEach((thing) => db.prepare("INSERT INTO kb_topic_members (thing_key, topic_key, role, what, model, checked_at) VALUES (?, '', 'other', '', 'failed', 100)").run(thing.anchor));
  const { calls, callLlm } = fakeLlm((prompt) => ({ items: prompt.user.split("\n").filter((line) => /^\d+ \| /u.test(line)).map((line) => ({ i: Number(line.split(" | ")[0]), topic: "", role: "other" })) }));
  const run = (nowUnix) => runTopicPass(db, { things, callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix });

  assert.equal((await run(100 + 3600)).calls, 0);
  const later = await run(100 + 25 * 3600);

  assert.equal(later.calls, 2);
  assert.ok(calls.every((call) => call.prompt.user.split("\n").filter((line) => /^\d+ \| /u.test(line)).length <= 20));
  assert.equal(loadTopics(db).members.get("模型0").failed, false);
});
