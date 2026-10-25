"use strict";

// Facts about one AI timeline topic, counted from the stored messages between
// its start and end: how many messages, how many people, who spoke most, and
// when the first and last of them were sent. The AI gives minutes, so the
// end minute is counted whole.

const { hktToUnix } = require("./review_store");

const TOP_SPEAKERS = 3;
const MINUTE_SECONDS = 60;

const topicBounds = (item) => {
  const startAt = hktToUnix(item.start);
  const endMinute = hktToUnix(item.end);
  if (startAt === null) {
    return null;
  }
  const endAt = endMinute === null || endMinute < startAt ? startAt + MINUTE_SECONDS : endMinute + MINUTE_SECONDS;
  return { startAt, endAt };
};

const statsQueries = (db) => ({
  totals: db.prepare(`
    SELECT COUNT(*) AS messages, COUNT(DISTINCT speaker) AS people, MIN(sent_at) AS firstAt, MAX(sent_at) AS lastAt
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?
  `),
  speakers: db.prepare(`
    SELECT speaker AS name, COUNT(*) AS messages
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND speaker <> ''
    GROUP BY speaker ORDER BY messages DESC, MIN(sent_at) LIMIT ${TOP_SPEAKERS}
  `),
});

const statsFor = (queries, groupId, bounds) => {
  const totals = queries.totals.get(groupId, bounds.startAt, bounds.endAt);
  if (!totals || totals.messages === 0) {
    return { ...bounds, messages: 0, people: 0, firstAt: null, lastAt: null, speakers: [] };
  }
  return {
    ...bounds,
    messages: totals.messages,
    people: totals.people,
    firstAt: totals.firstAt,
    lastAt: totals.lastAt,
    speakers: queries.speakers.all(groupId, bounds.startAt, bounds.endAt),
  };
};

// days: topicTimeline()'s [{ day, items }]. Items without a start (topics of
// a summary that gave no timeline) are returned as they are.
const withTopicStats = (db, groupId, days) => {
  const queries = statsQueries(db);
  return days.map((day) => ({
    ...day,
    items: day.items.map((item) => {
      const bounds = topicBounds(item);
      return bounds === null ? item : { ...item, stats: statsFor(queries, String(groupId), bounds) };
    }),
  }));
};

module.exports = { withTopicStats, topicBounds };
