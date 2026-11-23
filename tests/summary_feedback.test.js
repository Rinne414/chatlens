"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3-multiple-ciphers");
const feedback = require("../src/summary_feedback");
const { buildBriefThingsPrompt } = require("../src/brief_things");

const NOW = 1_800_000_000;
const DAY = 86400;

test("what the reader says about a thing is kept, once per thing and verdict, and can be taken back", () => {
  const db = new Database(":memory:");
  feedback.addFeedback(db, { verdict: "unimportant", title: "群里吵架", takeaway: "两个人吵了一下午", kind: "group", groups: ["一群", "二群"], now: NOW });
  feedback.addFeedback(db, { verdict: "wrong", title: "新模型发布", takeaway: "说成了明天发布", now: NOW + 10 });
  feedback.addFeedback(db, { verdict: "unimportant", title: "群里吵架", now: NOW + 20 });
  const items = feedback.listFeedback(db);
  assert.deepEqual(items.map((item) => [item.verdict, item.title]), [["unimportant", "群里吵架"], ["wrong", "新模型发布"]]);
  assert.deepEqual([...feedback.hiddenTitles(db)].sort(), ["新模型发布", "群里吵架"].sort());
  assert.equal(feedback.removeFeedback(db, items[1].id), true);
  assert.deepEqual([...feedback.hiddenTitles(db)], ["群里吵架"]);
  assert.equal(feedback.removeFeedback(db, 9999), false);
});

test("a verdict that is not one of the two, or a thing without a title, is refused", () => {
  const db = new Database(":memory:");
  assert.throws(() => feedback.addFeedback(db, { verdict: "great", title: "x", now: NOW }), /verdict/u);
  assert.throws(() => feedback.addFeedback(db, { verdict: "wrong", title: "  ", now: NOW }), /title/u);
});

test("only what was marked 不重要 lately shapes the next briefing, and it is said in the prompt", () => {
  const db = new Database(":memory:");
  feedback.addFeedback(db, { verdict: "unimportant", title: "很久以前的闲事", now: NOW - 90 * DAY });
  feedback.addFeedback(db, { verdict: "unimportant", title: "群里吵架", now: NOW - DAY });
  feedback.addFeedback(db, { verdict: "wrong", title: "讲错的那件", now: NOW - DAY });
  assert.deepEqual(feedback.tasteTitles(db, NOW), ["群里吵架"]);
  const topics = [{ groupName: "一群", title: "话题", summary: "内容", messages: 3 }];
  const withTaste = buildBriefThingsPrompt({ topics, disliked: feedback.tasteTitles(db, NOW) });
  assert.match(withTaste, /标成了「不重要」.*\["群里吵架"\]/u);
  assert.equal(buildBriefThingsPrompt({ topics }).includes("不重要"), false, "nothing is said when the reader marked nothing");
});
