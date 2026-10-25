"use strict";

// 笔记库: the AI part -- merging names (src/things_aliases.js) and 群里的共识
// (src/things_consensus.js) -- with a fake LLM, so no call is ever made.

const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const { nameKey, linkKey, buildThings } = require("../src/things_index");
const { candidatePairs, runAliasPass, aliasEdges, judgedPairs, sameIndexes } = require("../src/things_aliases");
const { planConsensus, fillLines, runConsensusPass, loadConsensus, consensusOf, normalizeConsensus } = require("../src/things_consensus");
const { cappedGate } = require("../src/vault_ai");

const DAY = 86400;

const mention = (name, { chunkId = 1, groupId = "1", kind = "model", sentAt = 1000, detail = "" } = {}) => ({
  chunkId, index: 0, groupId, sentAt, kind, name, key: nameKey(name), detail, link: "", linkKey: linkKey(""), speaker: "",
});

const thingsOf = (spec) => buildThings(spec.flatMap(([name, groups, kind]) =>
  groups.map((groupId, index) => mention(name, { chunkId: index + 1, groupId, kind }))));

const fakeLlm = (answer) => {
  const calls = [];
  return { calls, callLlm: async (_client, build, meta) => {
    const prompt = build("detailed");
    calls.push({ prompt, meta });
    const raw = typeof answer === "function" ? answer(prompt) : answer;
    meta.validate?.(raw);
    return raw;
  } };
};

test("name pairs are candidates when one is a short form or holds the other's words", () => {
  const { keysMayMatch } = require("../src/things_aliases");
  assert.equal(keysMayMatch("k2", "krea2"), true);
  assert.equal(keysMayMatch("qwen21", "qwenimage21"), true);
  assert.equal(keysMayMatch("codex", "claude"), false);
  assert.equal(keysMayMatch("k2", "k2"), false);

  const things = thingsOf([["H3", ["1"]], ["MiniMax H3", ["1"]], ["Pixiv 作品 1", ["1"]], ["Pixiv 作品 2", ["1"]], ["H3 工具", ["1"], "tool"]]);
  const pairs = candidatePairs(things, new Map()).map(([left, right]) => [left.name, right.name].sort().join(" ~ "));

  assert.deepEqual(pairs, ["H3 ~ MiniMax H3"]);
});

test("an alias pass judges each candidate pair once and keeps only the same ones as edges", async () => {
  const db = new Database(":memory:");
  const things = thingsOf([["Krea2", ["1"]], ["k2", ["1"]], ["Kimi", ["1"]], ["kimi2", ["1"]]]);
  // The fake AI says only the Krea2 / k2 pair is one thing.
  const sameLine = (line) => line.startsWith("p") && line.includes("Krea2") && line.includes("k2（");
  const { calls, callLlm } = fakeLlm((prompt) => ({ same: prompt.user.split(/\r?\n/u).filter(sameLine).map((line) => line.split(" ")[0]) }));
  const run = () => runAliasPass(db, { things, callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix: 1 });

  const first = await run();
  const second = await run();

  assert.equal(first.edges, 1);
  assert.deepEqual(aliasEdges(db).map((edge) => edge.sort().join("~")), ["k2~krea2"]);
  assert.ok(judgedPairs(db).size > 1);
  assert.equal(second.calls, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt.user, /版本号不同/u);
});

test("a name that alone links two different things is not used; a group linked among itself is", () => {
  const db = new Database(":memory:");
  require("../src/things_aliases").ensureAliasSchema(db);
  const insert = db.prepare("INSERT INTO kb_alias_pairs (left_key, right_key, same, model, checked_at) VALUES (?, ?, ?, 'fake', 1)");
  [["k3", "kimik3", 1], ["k3", "krea3k3", 1], ["krea2", "k2", 1], ["krea2", "kr2", 1], ["k2", "kr2", 1], ["krea2", "krea3", 0]]
    .forEach((row) => insert.run(...row));

  const edges = aliasEdges(db).map((edge) => [...edge].sort().join("~")).sort();

  assert.deepEqual(edges, ["k2~kr2", "k2~krea2", "kr2~krea2"]);
});

test("unknown pair ids in the answer are ignored", () => {
  assert.deepEqual([...sameIndexes({ same: ["p1", "p9", "x", 3, "p2"] }, 2)].sort(), [0, 1]);
});

test("a refused gate stops the pass before any call", async () => {
  const db = new Database(":memory:");
  const { calls, callLlm } = fakeLlm({ same: [] });

  const outcome = await runAliasPass(db, { things: thingsOf([["Krea2", ["1"]], ["k2", ["1"]]]), callLlm, client: {}, model: () => "fake", gate: () => "paused", nowUnix: 1 });

  assert.equal(outcome.stoppedBy, "paused");
  assert.equal(calls.length, 0);
});

test("only things three groups talk about get a consensus; never-made first, a stale one after a week", () => {
  const things = thingsOf([["多群", ["1", "2", "3", "4"]], ["三群", ["1", "2", "3"]], ["两群", ["1", "2"]]]);
  const three = things.find((thing) => thing.name === "三群");
  const made = new Map([[three.anchor, { mentionCount: 2, madeAt: 0, keys: [three.anchor], result: {} }]]);

  assert.deepEqual(planConsensus(things, made, 6 * DAY).map((thing) => thing.name), ["多群"]);
  assert.deepEqual(planConsensus(things, made, 7 * DAY).map((thing) => thing.name), ["多群", "三群"]);
});

test("a thing split off a bigger one does not show the bigger one's consensus", () => {
  const [whole] = buildThings([mention("甲", { chunkId: 1 }), mention("乙", { chunkId: 2 })], { aliasEdges: [["甲", "乙"]] });
  const [part] = buildThings([mention("乙", { chunkId: 2 })]);
  const entry = { mentionCount: 2, madeAt: 1, keys: whole.keys, result: { what: "合起来的" } };
  const byKey = new Map(whole.keys.map((key) => [key, entry]));

  assert.equal(consensusOf(byKey, whole), entry);
  assert.equal(consensusOf(byKey, part), null);
});

test("a thing whose consensus call keeps failing waits a week instead of going first every refresh", async () => {
  const db = new Database(":memory:");
  const things = thingsOf([["甲", ["1", "2", "3"]], ["乙", ["1", "2", "3"]]]);
  const { calls, callLlm } = fakeLlm((prompt) => (prompt.user.includes("东西：甲") ? { nope: true } : { what: "乙", points: [] }));
  const run = (nowUnix) => runConsensusPass(db, { things, answersOf: () => [], groupNames: new Map(), callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix });

  await run(10);
  await run(20);
  const third = await run(30);

  assert.equal(third.pending, 0);
  assert.equal(calls.filter((call) => call.prompt.user.includes("东西：甲")).length, 2);
  assert.equal((await run(30 + 8 * DAY)).failed, 1);
});

test("the input is filled newest first and alternates mentions and answers within its size", () => {
  const [thing] = buildThings(Array.from({ length: 400 }, (_, index) => mention("大", { chunkId: index, sentAt: index * 60, detail: "很长的说明".repeat(30) })));
  const answers = Array.from({ length: 50 }, (_, index) => ({ sentAt: index, question: "问", answer: "答", groupId: "1" }));

  const lines = fillLines(thing, answers, new Map());

  assert.ok(lines.mentions.length < 400);
  assert.equal(lines.answers.length, Math.min(50, lines.mentions.length));
  assert.ok(lines.mentions.join("\n").length <= 24000);
});

test("a consensus pass writes what the AI says, kept short and clean, at most the gate allows", async () => {
  const db = new Database(":memory:");
  const things = thingsOf([["甲", ["1", "2", "3"]], ["乙", ["1", "2", "3"]], ["丙", ["1", "2", "3"]]]);
  const { callLlm } = fakeLlm({ what: " 一个模型 ", points: ["要点", "", 3], unsure: ["没定论"] });

  const outcome = await runConsensusPass(db, {
    things, answersOf: () => [], groupNames: new Map(), callLlm, client: {}, model: () => "fake", gate: cappedGate(() => null, 2), nowUnix: 10,
  });

  assert.equal(outcome.made, 2);
  assert.equal(outcome.stoppedBy, "notes-run-cap");
  const stored = consensusOf(loadConsensus(db), things.find((thing) => loadConsensus(db).has(thing.anchor)));
  assert.deepEqual(stored.result, { what: "一个模型", points: ["要点"], unsure: ["没定论"] });
});

test("a malformed consensus answer counts as failed and the rest still run", async () => {
  const db = new Database(":memory:");
  const things = thingsOf([["甲", ["1", "2", "3"]], ["乙", ["1", "2", "3"]]]);
  const { callLlm } = fakeLlm((prompt) => (prompt.user.includes("东西：甲") ? { nope: true } : { what: "乙", points: [] }));

  const outcome = await runConsensusPass(db, { things, answersOf: () => [], groupNames: new Map(), callLlm, client: {}, model: () => "fake", gate: () => null, nowUnix: 10 });

  assert.equal(outcome.made, 1);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(normalizeConsensus({ what: "x", points: "not a list" }), { what: "x", points: [], unsure: [] });
});
