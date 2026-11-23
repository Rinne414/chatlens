"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3-multiple-ciphers");
const store = require("../src/briefing_store");
const interests = require("../src/interests");

const NOW = 1_800_000_000;

const openDb = () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE group_names (group_id TEXT PRIMARY KEY, name TEXT); INSERT INTO group_names VALUES ('11111', '画图群');");
  db.exec("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  interests.ensureInterestSchema(db);
  return db;
};

const chunk = (db, at, partial) => {
  const id = store.insertChunk(db, { groupId: "11111", startSentAt: at, endSentAt: at + 600, firstRowId: "1", lastRowId: "2", messageCount: 5, createdAt: at });
  store.saveChunkResult(db, id, { partial });
  return id;
};

// An AI that says the first topic it is shown is about every interest.
const fakeAi = (calls, answer = (prompt) => ({ hits: prompt.interests.map((interest) => ({ interest: interest.id, topic: 0, why: "就是在讲这个" })) })) =>
  async (client, build) => {
    const prompt = JSON.parse(build().user);
    calls.push(prompt);
    return answer(prompt);
  };

const pass = (db, callLlm, extra = {}) => interests.runInterestPass(db, { callLlm, client: {}, gate: () => null, nowUnix: NOW, ...extra });

test("nothing written, nothing asked", async () => {
  const db = openDb();
  chunk(db, NOW - 3600, { topics: [{ title: "新 LoRA 教程", summary: "有人发了训练教程" }] });
  const calls = [];
  assert.deepEqual((await pass(db, fakeAi(calls))).stoppedBy, "none");
  assert.equal(calls.length, 0);
});

test("a sentence is looked for in the newly summarized topics, once, and what is found is listed", async () => {
  const db = openDb();
  chunk(db, NOW - 7200, { topics: [{ title: "新 LoRA 教程", summary: "有人发了训练教程" }], qa: [{ question: "显存够吗", answer: "够" }] });
  const { id } = interests.addInterest(db, { text: "有人分享新的 LoRA 训练教程", now: NOW });
  const calls = [];
  const first = await pass(db, fakeAi(calls));
  assert.deepEqual([first.calls, first.looked, first.found], [1, 2, 1]);
  assert.deepEqual(calls[0].topics.map((topic) => topic.t), ["新 LoRA 教程", "显存够吗"]);
  const listed = interests.interestsWithHits(db);
  assert.deepEqual(listed[0].hits.map((hit) => [hit.title, hit.groupName, hit.why]), [["新 LoRA 教程", "画图群", "就是在讲这个"]]);
  // nothing new: no call
  assert.equal((await pass(db, fakeAi(calls))).calls, 0);
  assert.equal(calls.length, 1);
  // a new chunk: only that one is shown
  chunk(db, NOW - 600, { topics: [{ title: "又一个教程", summary: "更详细" }] });
  await pass(db, fakeAi(calls));
  assert.deepEqual(calls[1].topics.map((topic) => topic.t), ["又一个教程"]);
  assert.equal(interests.interestsWithHits(db)[0].hits.length, 2);
  // taking the sentence away takes what was found for it
  assert.equal(interests.removeInterest(db, id), true);
  assert.deepEqual(interests.interestsWithHits(db), []);
});

test("a sentence written later is tried on the last three days, not on older topics", async () => {
  const db = openDb();
  chunk(db, NOW - 10 * 86400, { topics: [{ title: "很久以前", summary: "x" }] });
  chunk(db, NOW - 86400, { topics: [{ title: "昨天的事", summary: "x" }] });
  interests.addInterest(db, { text: "第一条在意的事", now: NOW });
  const calls = [];
  await pass(db, fakeAi(calls));
  interests.addInterest(db, { text: "第二条在意的事", now: NOW });
  await pass(db, fakeAi(calls));
  assert.deepEqual(calls.map((call) => call.topics.map((topic) => topic.t)), [["昨天的事"], ["昨天的事"]]);
  assert.equal(calls[1].interests.length, 2);
  // the same hit for the first sentence is not stored twice
  assert.deepEqual(interests.interestsWithHits(db).map((item) => item.hits.length), [1, 1]);
});

test("a failed call or a closed gate skips nothing: the same topics come round again", async () => {
  const db = openDb();
  chunk(db, NOW - 3600, { topics: [{ title: "话题", summary: "x" }] });
  interests.addInterest(db, { text: "某件在意的事", now: NOW });
  const failing = async () => {
    throw new Error("timeout");
  };
  assert.equal((await pass(db, failing)).stoppedBy, "failed");
  assert.equal((await pass(db, failing, { gate: () => "call-limit" })).stoppedBy, "call-limit");
  const calls = [];
  assert.equal((await pass(db, fakeAi(calls))).found, 1);
  assert.deepEqual(calls[0].topics.map((topic) => topic.t), ["话题"]);
});

test("answers that point nowhere are ignored, and the sentences have limits", async () => {
  const db = openDb();
  chunk(db, NOW - 3600, { topics: [{ title: "话题", summary: "x" }] });
  interests.addInterest(db, { text: "某件在意的事", now: NOW });
  const calls = [];
  const outcome = await pass(db, fakeAi(calls, () => ({ hits: [{ interest: 999, topic: 0 }, { interest: 1, topic: 42 }] })));
  assert.equal(outcome.found, 0);
  assert.throws(() => interests.addInterest(db, { text: "短", now: NOW }), /具体一点/u);
  assert.throws(() => interests.addInterest(db, { text: "某件在意的事", now: NOW }), /已经有了/u);
  for (let index = 0; index < interests.MAX_INTERESTS - 1; index += 1) {
    interests.addInterest(db, { text: `第 ${index} 件在意的事`, now: NOW });
  }
  assert.throws(() => interests.addInterest(db, { text: "再多一件在意的事", now: NOW }), /最多/u);
});
