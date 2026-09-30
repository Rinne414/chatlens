"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const background = require("../src/server/background");

const NOW = Math.floor(Date.now() / 1000);

const hit = (rowId, sentAt, extra = {}) => ({ groupId: "100", groupName: "炼丹群", rowId: String(rowId), sentAt, speaker: "阿明", text: `anima 新版本 ${rowId}`, ...extra });

const briefingWith = ({ watch = [], mentions = [] } = {}) => ({
  watch,
  mentions,
  totals: { textMessages: 0, mediaMessages: 0, groups: 0 },
  groups: [],
  highlights: { newThings: [], qa: [] },
});

// One tick against an in-memory app_state; returns what was sent.
const tick = async ({ saved, briefing, notifyWatchWords = true, notifyMentions = true, lateBefore = null }) => {
  const sent = [];
  const store = { notify_state: saved };
  await background.notifyAfterTick({
    db: null,
    briefing,
    lateBefore,
    getState: (_db, key, fallback) => store[key] ?? fallback,
    setState: (_db, key, value) => {
      store[key] = value;
    },
    current: { ...background.DEFAULTS, notifyDaily: false, notifyMentions, notifyWatchWords },
    send: async (notice) => {
      sent.push(notice);
      return true;
    },
  });
  return { sent, saved: store.notify_state };
};

test("followed words are not notified unless switched on", () => {
  assert.equal(background.DEFAULTS.notifyWatchWords, false);
});

test("old replies the reply backfill added (older than the group's window this refresh) are not news; new ones still are", async () => {
  const mention = (rowId, sentAt, text) => ({ kind: "reply", groupId: "100", groupName: "炼丹群", rowId, sentAt, speaker: "阿明", text });
  const { sent, saved } = await tick({
    saved: { lastWatchAt: NOW - 3000, lastMentionAt: NOW - 3000 },
    lateBefore: { 100: NOW - 900 },
    briefing: briefingWith({
      mentions: [mention("9", NOW - 60, "刚刚的回复"), mention("7", NOW - 2000, "二十小时前的回复")],
      watch: [{ word: "anima", total: 2, latest: [hit(10, NOW - 30), hit(8, NOW - 1500)] }],
    }),
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body, "刚刚的回复");
  assert.equal(sent[1].body, "阿明：anima 新版本 10");
  assert.equal(saved.lastMentionAt, NOW - 60);
  assert.equal(saved.lastWatchAt, NOW - 30);
});

test("with only old backfilled replies, nothing is sent and the marks move past them", async () => {
  const { sent, saved } = await tick({
    saved: { lastWatchAt: NOW - 3000, lastMentionAt: NOW - 3000 },
    lateBefore: { 100: NOW - 900 },
    briefing: briefingWith({
      mentions: [{ kind: "reply", groupId: "100", groupName: "炼丹群", rowId: "7", sentAt: NOW - 2000, speaker: "阿明", text: "旧回复" }],
      watch: [{ word: "anima", total: 1, latest: [hit(8, NOW - 1500)] }],
    }),
  });
  assert.equal(sent.length, 0);
  assert.equal(saved.lastMentionAt, NOW - 2000);
  assert.equal(saved.lastWatchAt, NOW - 1500);
});

test("the first tick only remembers where it is, so old hits never fire at once", async () => {
  const { sent, saved } = await tick({
    saved: {},
    briefing: briefingWith({ watch: [{ word: "anima", total: 1, latest: [hit(1, NOW - 600)] }] }),
  });
  assert.deepEqual(sent, []);
  assert.ok(saved.lastWatchAt >= NOW);
});

test("one new hit names the word, the group, who said it and what", async () => {
  const { sent, saved } = await tick({
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ watch: [{ word: "anima", total: 2, latest: [hit(2, NOW - 60), hit(1, NOW - 600)] }] }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "「anima」出现在「炼丹群」");
  assert.equal(sent[0].body, "阿明：anima 新版本 2");
  assert.equal(saved.lastWatchAt, NOW - 60);
});

test("several hits fold into one notice; a message matching two words counts once", async () => {
  const both = hit(3, NOW - 30, { text: "anima 和 NovelAI 对比" });
  const { sent } = await tick({
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ watch: [
      { word: "anima", total: 2, latest: [both, hit(2, NOW - 60, { groupId: "200", groupName: "" })] },
      { word: "NovelAI", total: 1, latest: [both] },
    ] }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "关注的词有 2 条新消息");
  assert.equal(sent[0].body, "「anima」「NovelAI」 · 炼丹群、200");
});

test("a hit that already is an @ / reply to you is not notified twice", async () => {
  const mention = { ...hit(5, NOW - 20), kind: "at", youWereThere: false };
  const { sent } = await tick({
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ mentions: [mention], watch: [{ word: "anima", total: 1, latest: [hit(5, NOW - 20)] }] }),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /@了你/u);
});

test("switched off, hits still move the mark, so switching on later does not replay them", async () => {
  const { sent, saved } = await tick({
    notifyWatchWords: false,
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ watch: [{ word: "anima", total: 1, latest: [hit(2, NOW - 60)] }] }),
  });
  assert.deepEqual(sent, []);
  assert.equal(saved.lastWatchAt, NOW - 60);
});

test("a message of the mark's own second that arrives a refresh later is still notified, once", async () => {
  const first = await tick({
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ watch: [{ word: "anima", total: 1, latest: [hit(2, NOW - 60)] }] }),
  });
  assert.equal(first.sent.length, 1);
  const later = await tick({
    saved: first.saved,
    briefing: briefingWith({ watch: [{ word: "anima", total: 2, latest: [hit(3, NOW - 60), hit(2, NOW - 60)] }] }),
  });
  assert.equal(later.sent.length, 1);
  assert.equal(later.sent[0].body, "阿明：anima 新版本 3");
  const again = await tick({ saved: later.saved, briefing: briefingWith({ watch: [{ word: "anima", total: 2, latest: [hit(3, NOW - 60), hit(2, NOW - 60)] }] }) });
  assert.deepEqual(again.sent, []);
});

test("an @ that was not notified (mentions switched off) still counts as a followed-word hit", async () => {
  const mention = { ...hit(5, NOW - 20), kind: "at", youWereThere: false };
  const { sent } = await tick({
    notifyMentions: false,
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ mentions: [mention], watch: [{ word: "anima", total: 1, latest: [hit(5, NOW - 20)] }] }),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /anima/u);
});

test("a message dated in the future cannot push the mark past now", async () => {
  const { saved } = await tick({
    saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 },
    briefing: briefingWith({ watch: [{ word: "anima", total: 1, latest: [hit(9, NOW + 86400)] }] }),
  });
  assert.ok(saved.lastWatchAt <= Math.floor(Date.now() / 1000) + 60);
});

test("a message dated in the future is not notified again on every refresh", async () => {
  const future = briefingWith({ watch: [{ word: "anima", total: 1, latest: [hit(9, NOW + 86400)] }] });
  const first = await tick({ saved: { lastWatchAt: NOW - 300, lastMentionAt: NOW - 300 }, briefing: future });
  const second = await tick({ saved: first.saved, briefing: future });
  assert.equal(first.sent.length + second.sent.length, 0);
});
