"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3-multiple-ciphers");
const { personExtras } = require("../src/person_extras");

const ME = "10001";
const ANNA = "20002";
const BOB = "30003";
const T0 = 1_800_000_000;

const openDb = () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (group_id TEXT, row_id TEXT, sent_at INTEGER, speaker TEXT, text TEXT, is_media INTEGER DEFAULT 0,
      speaker_uin TEXT, is_self INTEGER DEFAULT 0, at_uins TEXT DEFAULT '', reply_to_uin TEXT DEFAULT '');
    CREATE TABLE group_names (group_id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE summary_chunks (group_id TEXT, start_sent_at INTEGER, end_sent_at INTEGER, status TEXT, partial_json TEXT);
    INSERT INTO group_names VALUES ('11111', '一群'), ('22222', '二群');
  `);
  let row = 0;
  const say = (groupId, uin, speaker, text, at, extra = {}) => {
    row += 1;
    db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, speaker_uin, is_self, at_uins, reply_to_uin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(groupId, String(row), T0 + at, speaker, text, extra.media ?? 0, uin, uin === ME ? 1 : 0, extra.at ?? "", extra.reply ?? "");
  };
  return { db, say };
};

const all = (db, options = {}) => personExtras(db, { uin: ANNA, fromUnix: T0, toUnix: T0 + 100_000, selfUins: [ME], ...options });

test("the names a person used, the latest first, in one group or in all", () => {
  const { db, say } = openDb();
  say("11111", ANNA, "安娜", "早", 10);
  say("11111", ANNA, "安娜", "在吗", 20);
  say("11111", ANNA, "安娜（忙）", "晚点说", 500);
  say("22222", ANNA, "Anna", "hello", 300);
  assert.deepEqual(all(db).names.map((item) => [item.name, item.messages]), [["安娜（忙）", 1], ["Anna", 1], ["安娜", 2]]);
  assert.deepEqual(all(db, { groupId: "11111" }).names.map((item) => item.name), ["安娜（忙）", "安娜"]);
});

test("what a person keeps saying: the same short text three times or more", () => {
  const { db, say } = openDb();
  for (let index = 0; index < 4; index += 1) {
    say("11111", ANNA, "安娜", "好耶", index);
  }
  for (let index = 0; index < 3; index += 1) {
    say("11111", ANNA, "安娜", "[图片]", 10 + index, { media: 1 });
    say("11111", ANNA, "安娜", "@鲍勃 来", 20 + index);
    say("11111", BOB, "鲍勃", "草", 30 + index);
  }
  say("11111", ANNA, "安娜", "只说两次", 40);
  say("11111", ANNA, "安娜", "只说两次", 41);
  assert.deepEqual(all(db).phrases.map((item) => [item.text, item.times]), [["好耶", 4]]);
});

test("你和 TA: replies and @ in both directions, with the latest of them", () => {
  const { db, say } = openDb();
  say("11111", ANNA, "安娜", "你看这个", 10, { at: `${BOB},${ME}` });
  say("11111", ANNA, "安娜", "回你了", 20, { reply: ME });
  say("11111", ANNA, "安娜", "跟别人说", 30, { reply: BOB });
  say("22222", ME, "我", "收到", 40, { reply: ANNA });
  say("11111", ME, "我", "跟鲍勃说", 50, { reply: BOB });
  const found = all(db).withMe;
  assert.deepEqual([found.toMe, found.fromMe], [2, 1]);
  assert.deepEqual(found.recent.map((item) => [item.direction, item.text, item.groupName]), [["fromMe", "收到", "二群"], ["toMe", "回你了", "一群"], ["toMe", "你看这个", "一群"]]);
  assert.deepEqual([all(db, { groupId: "11111" }).withMe.toMe, all(db, { groupId: "11111" }).withMe.fromMe], [2, 0]);
  // a uin that only starts with mine is someone else
  say("11111", ANNA, "安娜", "找别人", 60, { at: `${ME}9` });
  assert.equal(all(db).withMe.toMe, 2);
});

test("your own page has no 你和 TA, and neither does a store that does not know you", () => {
  const { db, say } = openDb();
  say("11111", ME, "我", "自言自语", 10);
  say("11111", ANNA, "安娜", "嗯", 20, { reply: ME });
  assert.equal(personExtras(db, { uin: ME, fromUnix: T0, toUnix: T0 + 1000, selfUins: [ME] }).withMe, null);
  assert.equal(personExtras(db, { uin: ANNA, fromUnix: T0, toUnix: T0 + 1000, selfUins: [] }).withMe, null);
});

test("questions the summaries credit to one of the person's names", () => {
  const { db, say } = openDb();
  say("11111", ANNA, "安娜", "用这个参数", 10);
  const chunk = (groupId, at, qa) => db.prepare("INSERT INTO summary_chunks VALUES (?, ?, ?, 'done', ?)").run(groupId, T0 + at, T0 + at + 50, JSON.stringify({ qa }));
  chunk("11111", 0, [
    { question: "怎么调", answer: "把步数降下来", asker: "鲍勃", answerer: "安娜" },
    { question: "没人理", answer: null, asker: "鲍勃", answerer: null },
    { question: "别人答的", answer: "重启", asker: "安娜", answerer: "鲍勃" },
  ]);
  chunk("22222", 100, [{ question: "两个人答", answer: "都说行", asker: "x", answerer: "鲍勃、安娜" }]);
  assert.deepEqual(all(db).answers.map((item) => [item.question, item.groupName]), [["两个人答", "二群"], ["怎么调", "一群"]]);
  assert.deepEqual(all(db, { groupId: "11111" }).answers.map((item) => item.question), ["怎么调"]);
});

test("a bad uin is refused", () => {
  const { db } = openDb();
  assert.throws(() => personExtras(db, { uin: "abc", fromUnix: T0, toUnix: T0 + 1, selfUins: [] }));
});
