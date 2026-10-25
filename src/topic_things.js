"use strict";

// 群 → 重要的事 (trial): one group's day as a few things worth knowing instead
// of every stretch of the chat. The AI timeline topics of the day are merged
// by one LLM call into things, each with its outcome first and a kind; how
// much each thing weighs is counted here from the stored messages (people,
// messages, time, followed words), never taken from the model.

const { hktToUnix } = require("./review_store");
const { rangePartials, topicTimeline } = require("./group_insights");
const { withTopicStats } = require("./topic_stats");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const DAY_SECONDS = 24 * 3600;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const KINDS = ["new", "qa", "resource", "group", "chat"];
// Small talk still counts, at a fraction, so a long one is not invisible.
const KIND_FACTOR = { new: 1.2, qa: 1, resource: 1.1, group: 1, chat: 0.35 };
const WATCH_BONUS = 1.5;

const SCHEMA = `CREATE TABLE IF NOT EXISTS topic_things (
  group_id TEXT NOT NULL,
  day TEXT NOT NULL,
  things_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  topic_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, day)
)`;

const ensureThingsSchema = (db) => {
  db.prepare(SCHEMA).run();
  return db;
};

const dayStartUnix = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 1000 - BEIJING_OFFSET_SECONDS;

// The day's timeline topics that have a time, oldest first, with their facts.
const dayTopics = (db, groupId, day) => {
  if (!DAY_PATTERN.test(day)) {
    throw new Error("日期无效。");
  }
  const fromUnix = dayStartUnix(day);
  const partials = rangePartials(db, String(groupId), { fromUnix: fromUnix - 3600, toUnix: fromUnix + DAY_SECONDS });
  const days = withTopicStats(db, groupId, topicTimeline(partials));
  return (days.find((entry) => entry.day === day)?.items ?? [])
    .filter((item) => item.stats !== undefined)
    .reverse();
};

/* ---------- the LLM call ---------- */

const topicLine = (item, index) => ({
  i: index,
  time: `${item.start.slice(11, 16)}-${item.end.slice(11, 16) || item.start.slice(11, 16)}`,
  messages: item.stats.messages,
  people: item.stats.people,
  title: item.title,
  summary: item.summary,
});

const buildThingsPrompt = ({ groupName, day, topics }) => [
  `下面是 QQ 群「${groupName}」${day} 这一天按时间切出的 ${topics.length} 段对话（AI 已各自写了标题和摘要，附消息数和人数）。`,
  "读者一天要看几十个群，读完常常记不住看了什么。请把这些段落整理成「值得知道的事」，输出 JSON（简体中文）：",
  '{"things": [{"title": "8-16 字，说清是什么事", "takeaway": "一句话结论：发生了什么 / 结论是什么 / 还缺什么，带上具体名称和数字", "kind": "new|qa|resource|group|chat", "status": "resolved|open|", "topics": [0, 3]}]}',
  "规则：",
  "- 讨论同一件事的段落合成一件（哪怕隔了几个小时），topics 列出它们的编号；每个编号恰好出现在一件事里。",
  "- kind：new = 新模型、新工具、新版本、新作品；qa = 有人提问或求助；resource = 分享了链接、参数、教程、文件；group = 群里的公告、规则、争执；chat = 闲聊、玩梗、没有信息的对话。",
  "- 所有闲聊合成一到三件 kind=chat 的事，takeaway 只写大致在聊什么。",
  "- status 只对 qa 填：问题得到回答写 resolved，没人答或没结论写 open；其他 kind 留空字符串。",
  "- takeaway 写结论，不要复述过程（不要写「A 问了，B 说了，C 补充」）。",
  "",
  JSON.stringify(topics.map(topicLine)),
].join("\n");

// Whatever the model answered, every topic ends up in exactly one thing:
// unknown or repeated numbers are dropped, forgotten ones become chat.
const normalizeThings = (raw, topicCount) => {
  const used = new Set();
  const things = (Array.isArray(raw?.things) ? raw.things : []).map((thing) => {
    // In time order, so a thing's stretches and parts read oldest first.
    const topics = (Array.isArray(thing?.topics) ? thing.topics : [])
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < topicCount && !used.has(index))
      .sort((left, right) => left - right);
    topics.forEach((index) => used.add(index));
    return {
      title: String(thing?.title ?? "").trim(),
      takeaway: String(thing?.takeaway ?? "").trim(),
      kind: KINDS.includes(thing?.kind) ? thing.kind : "chat",
      status: thing?.kind === "qa" && ["resolved", "open"].includes(thing?.status) ? thing.status : "",
      topics,
    };
  }).filter((thing) => thing.topics.length > 0 && thing.title.length > 0);
  const missing = [...Array(topicCount).keys()].filter((index) => !used.has(index));
  return missing.length === 0
    ? things
    : [...things, { title: "其他零散的对话", takeaway: "", kind: "chat", status: "", topics: missing }];
};

const validateThings = (raw) => {
  if (!Array.isArray(raw?.things) || raw.things.length === 0) {
    throw new Error("Invalid LLM JSON. Required array is missing: things");
  }
};

/* ---------- weight, from the store ---------- */

// Everyone, the nameless too, so the counts match the messages shown.
const peopleAcross = (db, groupId, ranges) => {
  const where = ranges.map(() => "(sent_at >= ? AND sent_at < ?)").join(" OR ");
  const args = ranges.flatMap((range) => [range.startAt, range.endAt]);
  return db.prepare(`
    SELECT CASE WHEN speaker = '' THEN '（未知）' ELSE speaker END AS name, COUNT(*) AS messages FROM messages
    WHERE group_id = ? AND (${where})
    GROUP BY speaker ORDER BY messages DESC
  `).all(String(groupId), ...args);
};

const mentionsWatchWord = (thing, topics, watchWords) => {
  const text = [thing.title, thing.takeaway, ...topics.map((topic) => `${topic.title} ${topic.summary}`)].join(" ").toLowerCase();
  return watchWords.filter((word) => text.includes(String(word).toLowerCase()));
};

// Weight grows with people more than with messages: ten people saying a
// little matters more than two people saying a lot.
const thingWeight = ({ messages, people, minutes, kind, watched }) =>
  Math.round(Math.sqrt(messages) * (1 + Math.log2(1 + people)) * (1 + Math.log2(1 + minutes) / 4) * KIND_FACTOR[kind] * (watched ? WATCH_BONUS : 1) * 10) / 10;

const weighThings = (db, groupId, things, topics, watchWords = []) => things.map((thing) => {
  const own = thing.topics.map((index) => topics[index]);
  const ranges = own.map((topic) => ({ startAt: topic.stats.startAt, endAt: topic.stats.endAt }));
  const people = peopleAcross(db, groupId, ranges);
  const messages = people.reduce((total, person) => total + person.messages, 0);
  const firstAt = Math.min(...own.map((topic) => topic.stats.firstAt ?? topic.stats.startAt));
  const lastAt = Math.max(...own.map((topic) => topic.stats.lastAt ?? topic.stats.endAt));
  const minutes = own.reduce((total, topic) => total + Math.max(0, (topic.stats.lastAt ?? topic.stats.startAt) - (topic.stats.firstAt ?? topic.stats.startAt)) / 60, 0);
  const watched = mentionsWatchWord(thing, own, watchWords);
  return {
    ...thing,
    ranges,
    firstAt,
    lastAt,
    minutes: Math.round(minutes),
    messages,
    people: people.length,
    speakers: people.slice(0, 8),
    watched,
    parts: own.map((topic) => ({ title: topic.title, summary: topic.summary, startAt: topic.stats.startAt, endAt: topic.stats.endAt, messages: topic.stats.messages })),
    weight: thingWeight({ messages, people: people.length, minutes, kind: thing.kind, watched: watched.length > 0 }),
  };
}).sort((left, right) => right.weight - left.weight);

/* ---------- storage ---------- */

// Things are stored by their topics' keys, not by position: a backfilled or
// re-summarized chunk can add, drop or reorder topics of the day.
const topicKey = (topic) => `${topic.stats.startAt}|${topic.title}`;

const thingsToKeys = (things, topics) => things.map(({ topics: indexes, ...thing }) => ({ ...thing, topicKeys: indexes.map((index) => topicKey(topics[index])) }));

const keysToThings = (stored, topics) => {
  const indexOf = new Map(topics.map((topic, index) => [topicKey(topic), index]));
  let lost = 0;
  const things = stored.map(({ topicKeys = [], ...thing }) => {
    const indexes = topicKeys.map((key) => indexOf.get(key)).filter((index) => index !== undefined);
    lost += topicKeys.length - indexes.length;
    return { ...thing, topics: indexes.sort((left, right) => left - right) };
  }).filter((thing) => thing.topics.length > 0);
  const placed = new Set(things.flatMap((thing) => thing.topics));
  return { things, lost, unsorted: topics.length - placed.size };
};

const saveThings = (db, { groupId, day, things, model, topicCount, nowUnix }) => {
  ensureThingsSchema(db).prepare(`
    INSERT INTO topic_things (group_id, day, things_json, model, topic_count, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (group_id, day) DO UPDATE SET things_json = excluded.things_json, model = excluded.model,
      topic_count = excluded.topic_count, created_at = excluded.created_at
  `).run(String(groupId), day, JSON.stringify(things), model, topicCount, nowUnix);
};

// The stored things of a day, re-weighed now (followed words may have
// changed). unsorted: topics of the day in no thing (arrived later, or
// rewritten); lost: stored topics that no longer exist.
const readThings = (db, groupId, day, watchWords = []) => {
  ensureThingsSchema(db);
  const topics = dayTopics(db, groupId, day);
  const row = db.prepare("SELECT things_json AS json, model, topic_count AS topicCount, created_at AS createdAt FROM topic_things WHERE group_id = ? AND day = ?").get(String(groupId), day);
  if (row === undefined) {
    return { day, topicCount: topics.length, things: null };
  }
  const { things, lost, unsorted } = keysToThings(JSON.parse(row.json), topics);
  return {
    day,
    topicCount: topics.length,
    madeFromTopics: row.topicCount,
    unsorted,
    lost,
    model: row.model,
    createdAt: row.createdAt,
    things: things.length > 0 ? weighThings(db, groupId, things, topics, watchWords) : null,
  };
};

module.exports = { ensureThingsSchema, dayTopics, buildThingsPrompt, normalizeThings, validateThings, weighThings, thingWeight, thingsToKeys, keysToThings, saveThings, readThings, KINDS };
