"use strict";

// 笔记库: everything the notes show, assembled from the store in one pass:
// the things (src/things_index.js) arranged into topics (src/things_topics.js)
// with their answers, each day's groups with their AI timeline, answers and
// links, each group's topics and days, and how much of the chat the AI has not
// summarized yet. Read-only.

const { readChunks, readGroupNames, collectMentions, collectAnswers, buildThings, isNoteworthy, answersByThing } = require("./things_index");
const { aliasEdges } = require("./things_aliases");
const { loadTopics, placeThings, buildTopics, isNotable } = require("./things_topics");
const { topicTimeline } = require("./group_insights");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const dayOf = (unix) => new Date((unix + BEIJING_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);

const answerId = (answer) => `${answer.chunkId}:${answer.index}`;

// pins: name key -> topic key the user chose in Obsidian ('' = no topic).
const loadKnowledge = (db, { pins = new Map() } = {}) => {
  const chunks = readChunks(db);
  const groupNames = readGroupNames(db);
  const mentions = collectMentions(chunks);
  const answers = collectAnswers(chunks);
  const things = buildThings(mentions, { aliasEdges: aliasEdges(db) }).filter(isNoteworthy);
  const byIndex = answersByThing(things, answers);
  const answersOfThing = new Map(things.map((thing, index) => [thing, byIndex.get(index) ?? []]));
  const stored = loadTopics(db);
  const placement = placeThings(things, stored.members, pins);
  const topics = buildTopics(things, placement, stored.topics);
  const answersOfTopic = (topic) => [...new Map(topic.members.flatMap(({ thing }) => answersOfThing.get(thing) ?? [])
    .map((answer) => [answerId(answer), answer])).values()]
    .sort((left, right) => right.sentAt - left.sentAt);
  return {
    chunks,
    groupNames,
    answers,
    things,
    topics,
    // Things the AI has not placed yet.
    unplaced: things.filter((thing) => placement.get(thing) === null),
    hasTopics: stored.topics.size > 0,
    answersOf: answersOfTopic,
  };
};

/* ---------- days ---------- */

const messageCounts = (db) => db.prepare(`
  SELECT group_id AS groupId, strftime('%Y-%m-%d', sent_at + ${BEIJING_OFFSET_SECONDS}, 'unixepoch') AS day, COUNT(*) AS n
  FROM messages GROUP BY group_id, day
`).all();

const dayDigests = (db) => {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_digests'").get() !== undefined;
  if (!hasTable) {
    return new Map();
  }
  return new Map(db.prepare("SELECT period, summary_json AS json FROM period_digests WHERE kind = 'day'").all()
    .map((row) => {
      try {
        return [row.period, JSON.parse(row.json)];
      } catch {
        return [row.period, null];
      }
    }));
};

const linksOf = (partial) => (Array.isArray(partial.links) ? partial.links : [])
  .filter((link) => typeof link?.url === "string" && /^https?:\/\//iu.test(link.url.trim()))
  .map((link) => ({ title: String(link.title ?? "").trim(), url: link.url.trim(), why: String(link.why ?? "").trim() }));

const uniqueBy = (items, keyOf) => [...new Map(items.map((item) => [keyOf(item), item])).values()];

// thing -> the topic with a note it belongs to.
const listedTopicOf = (topics) => new Map(topics.filter(isNotable).flatMap((topic) => topic.members.map(({ thing }) => [thing, topic])));

// The day's topics (with the groups and things that brought them up) and the
// things of the day that have no topic note.
const dayTopics = (things, topicOf, day) => {
  const topics = new Map();
  const loose = [];
  for (const { thing, groupIds } of things) {
    const topic = topicOf.get(thing);
    if (topic === undefined) {
      loose.push({ thing, groupIds });
      continue;
    }
    const entry = topics.get(topic) ?? { topic, groupIds: new Set(), things: [] };
    groupIds.forEach((groupId) => entry.groupIds.add(groupId));
    entry.things.push(thing);
    topics.set(topic, entry);
  }
  return {
    topics: [...topics.values()].sort((left, right) => right.groupIds.size - left.groupIds.size || right.topic.mentions.length - left.topic.mentions.length),
    loose: loose.sort((left, right) => right.groupIds.size - left.groupIds.size || right.thing.mentions.length - left.thing.mentions.length)
      .map((entry) => entry.thing),
    day,
  };
};

// Newest day first; in a day, the busiest group first.
const buildDays = (db, { chunks, answers, things, topics }) => {
  const days = new Map();
  const groupOf = (day, groupId) => {
    if (!days.has(day)) {
      days.set(day, { day, groups: new Map(), things: new Map() });
    }
    const entry = days.get(day);
    if (!entry.groups.has(groupId)) {
      entry.groups.set(groupId, { groupId, topics: [], answers: [], links: [], messages: 0 });
    }
    return entry.groups.get(groupId);
  };
  const chunksByGroup = new Map();
  for (const chunk of chunks) {
    chunksByGroup.set(chunk.groupId, [...(chunksByGroup.get(chunk.groupId) ?? []), chunk]);
    const group = groupOf(dayOf(chunk.startAt), chunk.groupId);
    group.links = uniqueBy([...group.links, ...linksOf(chunk.partial)], (link) => link.url);
  }
  for (const [groupId, list] of chunksByGroup) {
    for (const { day, items } of topicTimeline(list.map((chunk) => ({ startAt: chunk.startAt, ...chunk.partial })))) {
      groupOf(day, groupId).topics = items;
    }
  }
  for (const answer of [...answers].sort((left, right) => right.sentAt - left.sentAt)) {
    groupOf(dayOf(answer.sentAt), answer.groupId).answers.push(answer);
  }
  for (const thing of things) {
    for (const mention of thing.mentions) {
      const entry = days.get(dayOf(mention.sentAt));
      if (entry !== undefined) {
        entry.things.set(thing, (entry.things.get(thing) ?? new Set()).add(mention.groupId));
      }
    }
  }
  const topicOf = listedTopicOf(topics);
  const counts = new Map(messageCounts(db).map((row) => [`${row.day}|${row.groupId}`, row.n]));
  const digests = dayDigests(db);
  return [...days.values()]
    .sort((left, right) => right.day.localeCompare(left.day))
    .map((entry) => ({
      day: entry.day,
      digest: digests.get(entry.day) ?? null,
      groups: [...entry.groups.values()]
        .map((group) => ({ ...group, messages: counts.get(`${entry.day}|${group.groupId}`) ?? 0 }))
        .sort((left, right) => right.messages - left.messages || left.groupId.localeCompare(right.groupId)),
      ...dayTopics([...entry.things].map(([thing, groupIds]) => ({ thing, groupIds })), topicOf, entry.day),
    }));
};

/* ---------- groups ---------- */

const groupTotals = (db) => new Map(db.prepare(`
  SELECT group_id AS groupId, COUNT(*) AS messages, MIN(sent_at) AS firstAt, MAX(sent_at) AS lastAt FROM messages GROUP BY group_id
`).all().map((row) => [row.groupId, row]));

const buildGroups = (db, { topics, groupNames }, days) => {
  const totals = groupTotals(db);
  const groups = new Map();
  const groupOf = (groupId) => {
    if (!groups.has(groupId)) {
      const total = totals.get(groupId);
      groups.set(groupId, {
        groupId,
        name: groupNames.get(groupId) ?? groupId,
        messages: total?.messages ?? 0,
        firstDay: total ? dayOf(total.firstAt) : null,
        lastDay: total ? dayOf(total.lastAt) : null,
        topics: new Map(),
        days: [],
      });
    }
    return groups.get(groupId);
  };
  for (const entry of days) {
    for (const group of entry.groups) {
      groupOf(group.groupId).days.push({ day: entry.day, messages: group.messages, topics: group.topics.length });
    }
  }
  for (const topic of topics.filter(isNotable)) {
    for (const mention of topic.mentions) {
      const group = groupOf(mention.groupId);
      const seen = group.topics.get(topic) ?? { topic, count: 0, lastAt: 0 };
      group.topics.set(topic, { ...seen, count: seen.count + 1, lastAt: Math.max(seen.lastAt, mention.sentAt) });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    topics: [...group.topics.values()].sort((left, right) => right.count - left.count || right.lastAt - left.lastAt),
  }));
};

// Text messages the AI has summarized versus all stored ones.
const coverageOf = (db) => {
  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE is_media = 0 AND text <> ''").get().n;
  const summarized = db.prepare("SELECT COALESCE(SUM(message_count), 0) AS n FROM summary_chunks WHERE status = 'done'").get().n;
  return { messages, summarized, unsummarized: Math.max(0, messages - summarized) };
};

module.exports = { loadKnowledge, buildDays, buildGroups, coverageOf, dayOf };
