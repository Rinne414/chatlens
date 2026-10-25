"use strict";

// 简报 → 值得知道的事: the briefing window's hot topics of every followed
// group merged by one LLM call into a few things, the same matter in several
// groups being one thing. The model writes each thing's outcome and kind;
// how much it weighs (groups, messages, importance, followed words) is
// counted here. Things are stored by their topics' keys (group|title), so
// later merges of a group's brief can add or rewrite topics without the
// stored things pointing at the wrong ones.

const briefingStore = require("./briefing_store");
const { normalizeThings, validateThings } = require("./topic_things");

const IMPORTANCE_FACTOR = { high: 1.35, medium: 1, low: 0.7 };
const KIND_FACTOR = { new: 1.2, qa: 1, resource: 1.1, group: 1, chat: 0.35 };
const WATCH_BONUS = 1.5;
const MAX_SUMMARY_CHARS = 120;
// A newer result is made once this share of the window's topics is in no
// thing, but never more often than STALE_AFTER_SECONDS.
const STALE_SHARE = 0.15;
const STALE_MIN_TOPICS = 5;
const STALE_AFTER_SECONDS = 45 * 60;
// store/<MERGE_LOCK>.lock: held by the merge child (src/brief_things_run.js)
// while it runs; one merge takes ~5-10 minutes on Grok.
const MERGE_LOCK = "brief-things";
const MERGE_LOCK_STALE_MS = 30 * 60 * 1000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS brief_things (
  window_start INTEGER PRIMARY KEY,
  things_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  topic_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`;

const ensureBriefThingsSchema = (db) => {
  db.prepare(SCHEMA).run();
  return db;
};

const clip = (text, limit) => {
  const chars = Array.from(String(text ?? "").replace(/\s+/gu, " ").trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
};

// The window's hot topics of the followed groups, the way the briefing shows
// them (topics marked low importance are left out there too).
const windowTopics = (db, watchlist, windowStart) => watchlist.flatMap((entry) => {
  const stored = briefingStore.getGroupBrief(db, entry.groupId);
  if (stored === null || stored.windowStart !== windowStart) {
    return [];
  }
  const groupName = entry.name || db.prepare("SELECT name FROM group_names WHERE group_id = ?").get(String(entry.groupId))?.name || String(entry.groupId);
  // Two topics of a group with the same title still get keys of their own.
  const seen = new Map();
  const keyOf = (title) => {
    const base = `${entry.groupId}|${title}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };
  return (stored.summary?.topics ?? [])
    .filter((topic) => typeof topic?.title === "string" && topic.title.trim() !== "" && topic.importance !== "low")
    .map((topic) => ({
      key: keyOf(topic.title),
      groupId: String(entry.groupId),
      groupName,
      title: topic.title,
      summary: String(topic.summary ?? ""),
      importance: topic.importance ?? "medium",
      messages: Math.max(0, Number(topic.messageCountEstimate) || 0),
      details: Array.isArray(topic.details) ? topic.details.map(String) : [],
      evidence: Array.isArray(topic.evidence) ? topic.evidence.map(String) : [],
    }));
});

// The followed groups, read the same way by the server and by the child that
// makes the things (the stored keys carry the group id).
const followedGroups = (config) => (config.watchlist ?? [])
  .map((item) => (typeof item === "string" ? { groupId: item.trim(), name: "" } : { groupId: String(item?.groupId ?? "").trim(), name: String(item?.name ?? "") }))
  .filter((item) => /^\d+$/u.test(item.groupId));

/* ---------- the LLM call ---------- */

const buildBriefThingsPrompt = ({ topics }) => [
  `下面是读者关注的群在这段时间里各自的热门话题，共 ${topics.length} 个（g = 群名，n = 估计消息数）。`,
  "读者一天要看几十个群，读完常常记不住看了什么。请把它们整理成「值得知道的事」，输出 JSON（简体中文）：",
  '{"things": [{"title": "8-16 字，说清是什么事", "takeaway": "60 字以内的一句话结论：发生了什么 / 结论是什么 / 还缺什么，带上具体名称和数字", "kind": "new|qa|resource|group", "status": "resolved|open|", "topics": [0, 7, 12]}]}',
  "规则：",
  "- 不同群在聊同一件事（同一个模型、工具、新闻、问题），合成一件，topics 列出所有相关话题的编号；每个编号最多出现在一件事里。",
  "- kind：new = 新模型、新工具、新版本、新作品、新闻；qa = 有人提问或求助；resource = 分享了链接、参数、教程、文件；group = 群里的公告、规则、争执。",
  "- 闲聊、玩梗、没有信息的话题不要列出来：没列出的编号会自动归为闲聊。有信息的话题一个都不要漏。",
  "- status 只对 qa 填：问题得到回答写 resolved，没人答或没结论写 open；其他 kind 留空字符串。",
  "- takeaway 写结论，不要复述过程，不要罗列群名。",
  "",
  JSON.stringify(topics.map((topic, index) => ({ i: index, g: topic.groupName, t: topic.title, s: clip(topic.summary, MAX_SUMMARY_CHARS), n: topic.messages }))),
].join("\n");

/* ---------- stored by key ---------- */

// Each thing keeps a copy of its topics as they were: a group's brief is
// merged again every couple of hours and most topics come back with new
// titles (2026-10-26: 202 of 264 keys gone after one round, 89 of 124 things
// would have vanished until the next merge).
const thingsToKeys = (things, topics) => things.map(({ topics: indexes, ...thing }) => ({
  ...thing,
  topicKeys: indexes.map((index) => topics[index].key),
  snapshots: indexes.map((index) => topics[index]),
}));

// A key no longer in the window is lost; its copy stands in (appended after
// the window's topics, so indexes >= topics.length are copies) as long as its
// group is still followed. unsorted counts the window's topics in no thing.
const keysToThings = (stored, topics, { followed = null } = {}) => {
  const indexOf = new Map(topics.map((topic, index) => [topic.key, index]));
  const kept = [];
  let lost = 0;
  const things = stored.map(({ topicKeys = [], snapshots = [], ...thing }) => {
    const indexes = [];
    topicKeys.forEach((key, at) => {
      const index = indexOf.get(key);
      if (index !== undefined) {
        indexes.push(index);
        return;
      }
      lost += 1;
      const copy = snapshots[at];
      if (copy?.key === key && (followed === null || followed.has(copy.groupId))) {
        kept.push(copy);
        indexes.push(topics.length + kept.length - 1);
      }
    });
    return { ...thing, topics: indexes.sort((left, right) => left - right) };
  }).filter((thing) => thing.topics.length > 0);
  const placed = new Set(things.flatMap((thing) => thing.topics).filter((index) => index < topics.length));
  return { things, lost, unsorted: topics.length - placed.size, kept };
};

/* ---------- weight ---------- */

const mentionsWatchWord = (thing, sources, watchWords) => {
  const text = [thing.title, thing.takeaway, ...sources.map((source) => `${source.title} ${source.summary}`)].join(" ").toLowerCase();
  return watchWords.filter((word) => text.includes(String(word).toLowerCase()));
};

// More groups weigh most: the same matter coming up in five groups is what a
// reader should not miss, even when each group said little.
const briefThingWeight = ({ messages, groups, importance, kind, watched }) =>
  Math.round(Math.sqrt(Math.max(messages, 1)) * (1 + 1.2 * Math.log2(Math.max(groups, 1))) * (IMPORTANCE_FACTOR[importance] ?? 1) * KIND_FACTOR[kind] * (watched ? WATCH_BONUS : 1) * 10) / 10;

const topImportance = (sources) => (sources.some((source) => source.importance === "high") ? "high"
  : sources.some((source) => source.importance === "medium") ? "medium" : "low");

const weighBriefThings = (things, topics, watchWords = []) => things.map((thing) => {
  const sources = thing.topics.map((index) => topics[index]);
  const groups = [...new Map(sources.map((source) => [source.groupId, source.groupName]))].map(([groupId, name]) => ({
    groupId,
    name,
    messages: sources.filter((source) => source.groupId === groupId).reduce((total, source) => total + source.messages, 0),
  })).sort((left, right) => right.messages - left.messages);
  const messages = sources.reduce((total, source) => total + source.messages, 0);
  const importance = topImportance(sources);
  const watched = mentionsWatchWord(thing, sources, watchWords);
  return {
    title: thing.title,
    takeaway: thing.takeaway,
    kind: thing.kind,
    status: thing.status,
    key: sources[0].key,
    messages,
    importance,
    groups,
    watched,
    sources: sources.map(({ key, ...source }) => source),
    weight: briefThingWeight({ messages, groups: groups.length, importance, kind: thing.kind, watched: watched.length > 0 }),
  };
}).sort((left, right) => right.weight - left.weight);

/* ---------- storage ---------- */

const saveBriefThings = (db, { windowStart, things, model, topicCount, nowUnix }) => {
  ensureBriefThingsSchema(db).prepare(`
    INSERT INTO brief_things (window_start, things_json, model, topic_count, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (window_start) DO UPDATE SET things_json = excluded.things_json, model = excluded.model,
      topic_count = excluded.topic_count, created_at = excluded.created_at
  `).run(windowStart, JSON.stringify(things), model, topicCount, nowUnix);
  // Older windows (before the last 看完了) are never shown again.
  db.prepare("DELETE FROM brief_things WHERE window_start < ?").run(windowStart);
};

// The first merge of a window waits for a few topics (just after 看完了 the
// first group brief alone is not worth a call). A rewritten topic is both
// lost (old key) and unsorted (new key): counted once.
const isStale = (result, nowUnix) => {
  if (result.things === null) {
    return result.topicCount >= STALE_MIN_TOPICS;
  }
  const changed = Math.max(result.unsorted, result.lost);
  return changed >= Math.max(STALE_MIN_TOPICS, result.topicCount * STALE_SHARE) && nowUnix - result.createdAt >= STALE_AFTER_SECONDS;
};

// The window's things re-weighed now, plus how far the window moved on since
// they were made (unsorted: topics in no thing; lost: rewritten ones).
const readBriefThings = (db, { watchlist, windowStart, watchWords = [], nowUnix }) => {
  ensureBriefThingsSchema(db);
  const topics = windowTopics(db, watchlist, windowStart);
  const row = db.prepare("SELECT things_json AS json, model, topic_count AS topicCount, created_at AS createdAt FROM brief_things WHERE window_start = ?").get(windowStart);
  if (row === undefined) {
    const result = { windowStart, topicCount: topics.length, things: null };
    return { ...result, stale: isStale(result, nowUnix) };
  }
  const followed = new Set(watchlist.map((entry) => String(entry.groupId)));
  const { things, lost, unsorted, kept } = keysToThings(JSON.parse(row.json), topics, { followed });
  const result = {
    windowStart,
    topicCount: topics.length,
    madeFromTopics: row.topicCount,
    unsorted,
    lost,
    model: row.model,
    createdAt: row.createdAt,
    things: things.length > 0 ? weighBriefThings(things, [...topics, ...kept], watchWords) : null,
  };
  return { ...result, stale: isStale(result, nowUnix) };
};

const windowStartOf = (db, nowUnix) => Number(briefingStore.getState(db, "briefing_since", nowUnix - 24 * 3600));

module.exports = {
  ensureBriefThingsSchema,
  followedGroups,
  windowTopics,
  windowStartOf,
  buildBriefThingsPrompt,
  normalizeThings,
  validateThings,
  thingsToKeys,
  keysToThings,
  weighBriefThings,
  briefThingWeight,
  saveBriefThings,
  readBriefThings,
  isStale,
  MERGE_LOCK,
  MERGE_LOCK_STALE_MS,
};
