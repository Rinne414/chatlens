"use strict";

// 简报 → 值得知道的事 (src/brief_things.js, web/brief_things.js): the window's
// group topics merged into things, stored by topic key, weighed from the
// data, and shown as a few heavy things with the rest folded.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const Database = require("better-sqlite3-multiple-ciphers");

const briefingStore = require("../src/briefing_store");
const bt = require("../src/brief_things");
const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

const WINDOW = 1_800_000_000;

const makeDb = (briefs) => {
  const db = briefingStore.ensureBriefingSchema(new Database(":memory:"));
  db.prepare("CREATE TABLE IF NOT EXISTS group_names (group_id TEXT PRIMARY KEY, name TEXT)").run();
  for (const [groupId, topics, windowStart = WINDOW] of briefs) {
    briefingStore.saveGroupBrief(db, groupId, { windowStart, chunkKey: "k", summary: { topics } });
  }
  return db;
};

const topic = (title, messageCountEstimate, importance = "medium") => ({ title, summary: `${title}的摘要`, importance, messageCountEstimate });

test("the window's topics come from every followed group's brief of this window, low importance left out", () => {
  const db = makeDb([
    ["1", [topic("显卡涨价", 120, "high"), topic("闲扯", 5, "low")]],
    ["2", [topic("5090 价格", 80)]],
    ["3", [topic("上一窗口的话题", 50)], WINDOW - 3600],
  ]);

  const topics = bt.windowTopics(db, [{ groupId: "1", name: "甲群" }, { groupId: "2", name: "乙群" }, { groupId: "3", name: "丙群" }], WINDOW);

  assert.deepEqual(topics.map((item) => item.key), ["1|显卡涨价", "2|5090 价格"]);
  assert.equal(topics[1].groupName, "乙群");
});

test("one matter in more groups weighs more than the same talk in one group", () => {
  const spread = bt.briefThingWeight({ messages: 200, groups: 5, importance: "medium", kind: "new", watched: false });
  const single = bt.briefThingWeight({ messages: 200, groups: 1, importance: "medium", kind: "new", watched: false });
  const chat = bt.briefThingWeight({ messages: 200, groups: 5, importance: "medium", kind: "chat", watched: false });

  assert.ok(spread > single * 2);
  assert.ok(chat < spread / 2);
});

test("stored things follow their topics by key and turn stale only when enough moved and enough time passed", () => {
  const db = makeDb([["1", [topic("显卡涨价", 120, "high")]], ["2", [topic("5090 价格", 80), topic("模型横评", 60)]]]);
  const watchlist = [{ groupId: "1", name: "甲群" }, { groupId: "2", name: "乙群" }];
  const topics = bt.windowTopics(db, watchlist, WINDOW);
  const things = bt.normalizeThings({ things: [{ title: "显卡涨价", takeaway: "涨了", kind: "new", topics: [1, 0] }] }, topics.length);
  bt.saveBriefThings(db, { windowStart: WINDOW, things: bt.thingsToKeys(things, topics), model: "m", topicCount: topics.length, nowUnix: WINDOW + 60 });

  const result = bt.readBriefThings(db, { watchlist, windowStart: WINDOW, nowUnix: WINDOW + 120 });
  const gpu = result.things.find((thing) => thing.title === "显卡涨价");

  assert.deepEqual(gpu.groups.map((group) => group.name), ["甲群", "乙群"]);
  assert.equal(gpu.messages, 200);
  assert.equal(result.unsorted, 0);
  assert.equal(result.stale, false);
  assert.equal(bt.isStale({ ...result, unsorted: 10, topicCount: 20, createdAt: WINDOW }, WINDOW + 60 * 60), true);
  assert.equal(bt.isStale({ ...result, unsorted: 10, topicCount: 20, createdAt: WINDOW }, WINDOW + 10 * 60), false);
  assert.equal(bt.isStale({ ...result, things: null, topicCount: 6 }, WINDOW), true);
});

const loadPage = () => {
  const context = vm.createContext(makeSandbox());
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // Render paths may throw in the fake DOM; the helpers under test are pure.
    }
  }
  vm.runInContext("setTimeout = () => 0", context);
  return (expression) => vm.runInContext(expression, context);
};

test("the map and the open list carry the heavy things; the light ones and small talk are folded, not dropped", () => {
  const run = loadPage();
  const weights = [50, 30, 10, 5, 2, 1, 1, 1, 0.5, 0.5];
  const things = [...weights.map((weight, index) => ({ key: `k${index}`, kind: "new", weight, messages: 10, groups: [] })), { key: "chat", kind: "chat", weight: 40, messages: 300, groups: [] }];

  const parts = JSON.parse(run(`JSON.stringify(splitBriefThings(${JSON.stringify(things)}))`));
  const other = JSON.parse(run(`JSON.stringify(otherBubble(${JSON.stringify(parts.tail)}, ${JSON.stringify(parts.chat)}, ${JSON.stringify(parts.head)}))`));

  assert.equal(parts.head.length, 6);
  assert.equal(parts.head.length + parts.tail.length, weights.length);
  assert.deepEqual(parts.chat.map((thing) => thing.key), ["chat"]);
  assert.ok(other.weight <= parts.head[Math.floor(parts.head.length / 2)].weight);
  assert.match(other.title, /其他 4 件小事和闲聊/u);
});

test("the first merge of a window waits for a few topics, and a rewritten topic counts once", () => {
  assert.equal(bt.isStale({ things: null, topicCount: 2 }, WINDOW), false);
  assert.equal(bt.isStale({ things: null, topicCount: 5 }, WINDOW), true);
  const made = { things: [], topicCount: 20, createdAt: WINDOW };
  assert.equal(bt.isStale({ ...made, unsorted: 4, lost: 4 }, WINDOW + 3600), false);
  assert.equal(bt.isStale({ ...made, unsorted: 5, lost: 1 }, WINDOW + 3600), true);
});

test("two topics of one group with the same title keep keys of their own", () => {
  const db = makeDb([["1", [topic("出图", 30), topic("出图", 50)]]]);

  const topics = bt.windowTopics(db, [{ groupId: "1", name: "甲群" }], WINDOW);

  assert.deepEqual(topics.map((item) => item.key), ["1|出图", "1|出图#2"]);
});

test("a thing whose topics a later group merge retitled stays on the map from its copy until the next merge", () => {
  const watchlist = [{ groupId: "1", name: "甲群" }, { groupId: "2", name: "乙群" }];
  const db = makeDb([["1", [topic("显卡涨价", 120, "high")]], ["2", [topic("5090 价格", 80), topic("模型横评", 60)]]]);
  const topics = bt.windowTopics(db, watchlist, WINDOW);
  const things = bt.normalizeThings({ things: [{ title: "显卡涨价", takeaway: "涨了", kind: "new", topics: [0, 1] }, { title: "横评", takeaway: "比了", kind: "qa", topics: [2] }] }, topics.length);
  bt.saveBriefThings(db, { windowStart: WINDOW, things: bt.thingsToKeys(things, topics), model: "m", topicCount: topics.length, nowUnix: WINDOW + 60 });
  // The next merge of both groups' briefs words every topic anew.
  briefingStore.saveGroupBrief(db, "1", { windowStart: WINDOW, chunkKey: "k2", summary: { topics: [topic("显卡又涨了", 150, "high")] } });
  briefingStore.saveGroupBrief(db, "2", { windowStart: WINDOW, chunkKey: "k2", summary: { topics: [topic("5090 报价", 90), topic("几个模型横向对比", 70)] } });

  const result = bt.readBriefThings(db, { watchlist, windowStart: WINDOW, nowUnix: WINDOW + 120 });
  const gpu = result.things.find((thing) => thing.title === "显卡涨价");

  assert.equal(result.things.length, 2);
  assert.deepEqual(gpu.groups.map((group) => group.name), ["甲群", "乙群"]);
  assert.equal(gpu.messages, 200);
  assert.equal(gpu.sources[0].title, "显卡涨价");
  assert.equal(result.lost, 3);
  assert.equal(result.unsorted, 3);

  // A group no longer followed takes its copies with it.
  const one = bt.readBriefThings(db, { watchlist: watchlist.slice(0, 1), windowStart: WINDOW, nowUnix: WINDOW + 120 });
  assert.deepEqual(one.things.map((thing) => thing.title), ["显卡涨价"]);
  assert.deepEqual(one.things[0].groups.map((group) => group.name), ["甲群"]);
});

test("the head line says how many topics came after the merge instead of passing an old merge off as the whole window", () => {
  const run = loadPage();
  const made = { createdAt: WINDOW, madeFromTopics: 40, model: "grok-4.7", things: [], job: null, stale: false };
  const line = (data) => run(`briefThingsHeadLine(${JSON.stringify({ ...made, ...data })})`);

  assert.match(line({ unsorted: 7, auto: "on" }), /之后各群总结有更新，7 个话题还没整理进来，攒够了会自动重新整理/u);
  assert.match(line({ unsorted: 7, auto: "paused", stale: true }), /7 个话题还没整理进来 · AI 整理暂停中，有新话题时不会自动更新/u);
  assert.doesNotMatch(line({ unsorted: 0, auto: "on" }), /还没整理进来/u);
  assert.match(line({ unsorted: 7, auto: "on", job: { status: "running" } }), /正在按新的话题重新整理/u);
});

test("a merge another process still runs counts as running, so a restarted console does not pay for a second one", (t) => {
  const os = require("node:os");
  const { isLockHeld } = require("../src/vault_files");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlens-merge-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = (pid, ageMs) => fs.writeFileSync(path.join(dir, `${bt.MERGE_LOCK}.lock`), JSON.stringify({ pid, at: Date.now() - ageMs }));
  const held = () => isLockHeld(dir, bt.MERGE_LOCK, { staleMs: bt.MERGE_LOCK_STALE_MS });

  assert.equal(held(), false);
  // The parent of this test process is alive: a merge it started 5 minutes ago.
  lock(process.ppid, 5 * 60 * 1000);
  assert.equal(held(), true);
  lock(process.ppid, bt.MERGE_LOCK_STALE_MS + 1000);
  assert.equal(held(), false);
  lock(process.pid, 1000);
  assert.equal(held(), false);
});

test("the home page's 各群总览 folds under 值得知道的事 once there are things, and opening it is remembered", () => {
  const run = loadPage();

  assert.equal(run("briefThings.data = null; digestHomeFold()"), null);
  assert.equal(run("briefThings.data = { things: [{ key: 'a' }] }; digestHomeFold().folded"), true);
  try {
    run("digestHomeFold().toggle()");
  } catch {
    // Its redraw may fail in the fake DOM; the choice is stored first.
  }
  assert.equal(run("digestHomeFold().folded"), false);
});

test("the server and the child read the followed groups the same way", () => {
  assert.deepEqual(bt.followedGroups({ watchlist: [" 123", { groupId: "456", name: "乙" }, "abc"] }).map((group) => group.groupId), ["123", "456"]);
});
