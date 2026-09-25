"use strict";

// 群: one group in depth, for any date range. Everything here is read from
// what the background has already stored -- raw messages, pictures, the cached
// per-chunk AI summaries and the prompt library -- so opening a group never
// calls the LLM. Lists are complete; the page decides how much to show first.

const { hktToUnix } = require("./review_store");

const DAY_SECONDS = 86400;
const BEIJING_OFFSET_SECONDS = 8 * 3600;
const CONTEXT_DAYS = 30;
const DEFAULT_DAYS = 7;
const GROUP_ID = /^\d{5,}$/u;

const beijingDay = (unix) => new Date((unix + BEIJING_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);

const parsePartial = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const groupName = (db, groupId) =>
  db.prepare("SELECT name FROM group_names WHERE group_id = ?").get(groupId)?.name || groupId;

// [fromUnix, toUnix): the requested range, or the last DEFAULT_DAYS days.
const resolveRange = ({ fromUnix, toUnix, nowUnix }) => {
  if (Number.isFinite(fromUnix) && Number.isFinite(toUnix) && toUnix > fromUnix) {
    return { fromUnix, toUnix };
  }
  return { fromUnix: nowUnix - DEFAULT_DAYS * DAY_SECONDS, toUnix: nowUnix + 60 };
};

/* ---------- activity ---------- */

// Messages per Beijing day, zero-filled: the selected range, widened to at
// least CONTEXT_DAYS days ending at its end, so a single day is seen in context.
const dailyActivity = (db, groupId, { fromUnix, toUnix }) => {
  const end = toUnix - 1;
  const firstDay = Math.min(fromUnix, end - (CONTEXT_DAYS - 1) * DAY_SECONDS);
  const days = Math.max(1, Math.round((end - firstDay) / DAY_SECONDS) + 1);
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', sent_at + ${BEIJING_OFFSET_SECONDS}, 'unixepoch') AS day,
           SUM(CASE WHEN is_media = 0 THEN 1 ELSE 0 END) AS text,
           SUM(CASE WHEN is_media = 1 THEN 1 ELSE 0 END) AS media
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?
    GROUP BY day
  `).all(groupId, end - days * DAY_SECONDS, toUnix);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: days }, (_, index) => {
    const day = beijingDay(end - (days - 1 - index) * DAY_SECONDS);
    const row = byDay.get(day);
    return { day, text: row?.text ?? 0, media: row?.media ?? 0 };
  });
};

// 7 x 24 message counts over the range; row 0 is Monday.
const weeklyHeatmap = (db, groupId, { fromUnix, toUnix }) => {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', sent_at + ${BEIJING_OFFSET_SECONDS}, 'unixepoch') AS INTEGER) AS weekday,
           CAST(strftime('%H', sent_at + ${BEIJING_OFFSET_SECONDS}, 'unixepoch') AS INTEGER) AS hour,
           COUNT(*) AS n
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?
    GROUP BY weekday, hour
  `).all(groupId, fromUnix, toUnix);
  for (const row of rows) {
    grid[(row.weekday + 6) % 7][row.hour] = row.n;
  }
  return grid;
};

const rangeTotals = (db, groupId, { fromUnix, toUnix }) => {
  const messages = db.prepare(`
    SELECT COUNT(*) AS messages, COUNT(DISTINCT CASE WHEN speaker_uin <> '' THEN speaker_uin ELSE speaker END) AS speakers
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?
  `).get(groupId, fromUnix, toUnix);
  const pictures = db.prepare(`
    SELECT COUNT(*) AS pictures, COALESCE(SUM(CASE WHEN f.probe = 'ai' THEN 1 ELSE 0 END), 0) AS ai
    FROM (SELECT DISTINCT md5 FROM pictures WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND sticker = 0) d
    LEFT JOIN picture_files f ON f.md5 = d.md5
  `).get(groupId, fromUnix, toUnix);
  const first = db.prepare("SELECT MIN(sent_at) AS first FROM messages WHERE group_id = ?").get(groupId).first;
  return { ...messages, ...pictures, firstSentAt: first ?? null };
};

/* ---------- people ---------- */

const activePeople = (db, groupId, { fromUnix, toUnix }) => db.prepare(`
  SELECT MAX(speaker) AS name, MAX(speaker_uin) AS uin, COUNT(*) AS count
  FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND speaker <> ''
  GROUP BY CASE WHEN speaker_uin <> '' THEN speaker_uin ELSE speaker END
  ORDER BY count DESC
`).all(groupId, fromUnix, toUnix);

const picturePosters = (db, groupId, { fromUnix, toUnix }) => db.prepare(`
  SELECT MAX(m.speaker) AS name, MAX(m.speaker_uin) AS uin, COUNT(DISTINCT p.md5) AS count,
         COUNT(DISTINCT CASE WHEN f.probe = 'ai' THEN p.md5 END) AS ai
  FROM pictures p
  JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
  LEFT JOIN picture_files f ON f.md5 = p.md5
  WHERE p.group_id = ? AND p.sent_at >= ? AND p.sent_at < ? AND p.sticker = 0 AND m.speaker <> ''
  GROUP BY CASE WHEN m.speaker_uin <> '' THEN m.speaker_uin ELSE m.speaker END
  ORDER BY count DESC
`).all(groupId, fromUnix, toUnix);

// The LLM writes "A / B" when several people answered; each gets the credit.
const answerers = (partials) => {
  const counts = new Map();
  for (const partial of partials) {
    for (const item of partial.qa ?? []) {
      for (const name of String(item.answerer ?? "").split(/[/、,，&]+/u).map((part) => part.trim()).filter(Boolean)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count);
};

/* ---------- what was discussed (cached AI summaries) ---------- */

const rangePartials = (db, groupId, { fromUnix, toUnix }) => db.prepare(`
  SELECT start_sent_at AS startAt, partial_json AS json FROM summary_chunks
  WHERE group_id = ? AND status = 'done' AND partial_json IS NOT NULL AND end_sent_at >= ? AND start_sent_at < ?
  ORDER BY start_sent_at
`).all(groupId, fromUnix, toUnix)
  .map((row) => ({ startAt: row.startAt, ...(parsePartial(row.json) ?? {}) }));

const dedupeBy = (items, keyOf) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (key === "" || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const normalizeKey = (value) => String(value ?? "").toLowerCase().replace(/\s+/gu, "");

// Newest day first, and newest first within a day.
const topicTimeline = (partials) => {
  const byDay = new Map();
  for (const partial of partials) {
    const entries = (partial.timeline ?? []).length > 0
      ? partial.timeline.map((item) => ({ title: item.title, summary: item.summary, start: item.start, end: item.end }))
      : (partial.topics ?? []).map((topic) => ({ title: topic.title, summary: topic.summary, start: "", end: "" }));
    const day = beijingDay(partial.startAt);
    byDay.set(day, [...(byDay.get(day) ?? []), ...entries]);
  }
  return [...byDay].sort(([left], [right]) => right.localeCompare(left)).map(([day, items]) => ({
    day,
    items: dedupeBy([...items].reverse(), (item) => normalizeKey(item.title)),
  }));
};

const collectLists = (partials) => {
  const newest = [...partials].reverse();
  return {
    newThings: dedupeBy(newest.flatMap((partial) => partial.newThings ?? []), (item) => normalizeKey(item.name)),
    qa: dedupeBy(newest.flatMap((partial) => partial.qa ?? []), (item) => normalizeKey(item.question)),
    links: dedupeBy(newest.flatMap((partial) => partial.links ?? []), (item) => String(item.url ?? "").trim()),
  };
};

const currentBrief = (db, groupId) => {
  const row = db.prepare("SELECT summary_json AS json, updated_at AS updatedAt FROM group_briefs WHERE group_id = ?").get(groupId);
  const brief = row === undefined ? null : parsePartial(row.json);
  return brief === null
    ? null
    : { summary: brief.summary ?? "", topics: (brief.topics ?? []).map((topic) => topic.title), updatedAt: row.updatedAt };
};

/* ---------- AIGC (prompt library) ---------- */

// Models and LoRAs this group used in the range, next to the equally long
// period just before it. `kb` is a read-only knowledge.db connection, or null.
const aigcSetups = (kb, groupId, { fromUnix, toUnix }) => {
  if (kb === null) {
    return { models: [], loras: [], asks: { total: 0, answered: 0 } };
  }
  const args = { groupId, from: fromUnix, to: toUnix, before: fromUnix - (toUnix - fromUnix) };
  const setup = (column, join) => kb.prepare(`
    SELECT ${column} AS name,
           COUNT(DISTINCT CASE WHEN s.sent_at >= @from THEN s.hash END) AS current,
           COUNT(DISTINCT CASE WHEN s.sent_at < @from THEN s.hash END) AS previous
    FROM sightings s ${join}
    WHERE s.group_id = @groupId AND s.sent_at >= @before AND s.sent_at < @to AND ${column} <> ''
    GROUP BY ${column}
    ORDER BY current DESC, previous DESC
  `).all(args);
  const hasRequests = kb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prompt_requests'").get() !== undefined;
  const asks = hasRequests
    ? kb.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN answer_text <> '' OR answer_by <> '' THEN 1 ELSE 0 END), 0) AS answered
      FROM prompt_requests WHERE group_id = @groupId AND ask_sent_at >= @from AND ask_sent_at < @to
    `).get(args)
    : { total: 0, answered: 0 };
  return {
    models: setup("i.checkpoint", "JOIN images i ON i.hash = s.hash"),
    loras: setup("l.lora_name", "JOIN image_loras l ON l.hash = s.hash"),
    asks,
  };
};

const groupInsights = (db, kb, { groupId, nowUnix, fromUnix = null, toUnix = null }) => {
  if (!GROUP_ID.test(String(groupId))) {
    throw new Error("群号无效。");
  }
  const id = String(groupId);
  const range = resolveRange({ fromUnix, toUnix, nowUnix });
  const partials = rangePartials(db, id, range);
  return {
    groupId: id,
    name: groupName(db, id),
    range,
    totals: rangeTotals(db, id, range),
    daily: dailyActivity(db, id, range),
    heatmap: weeklyHeatmap(db, id, range),
    people: { active: activePeople(db, id, range), posters: picturePosters(db, id, range), helpers: answerers(partials) },
    brief: currentBrief(db, id),
    timeline: topicTimeline(partials),
    ...collectLists(partials),
    aigc: aigcSetups(kb, id, range),
  };
};

// The cached AI timeline entries of one group between two moments, for the
// chat's side panel. Oldest first, like the chat.
const timelineBetween = (db, { groupId, fromUnix, toUnix }) => {
  if (!GROUP_ID.test(String(groupId)) || !Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error("范围无效。");
  }
  const items = rangePartials(db, String(groupId), { fromUnix, toUnix }).flatMap((partial) => (partial.timeline ?? []).map((item) => ({
    title: item.title,
    summary: item.summary,
    startAt: hktToUnix(item.start),
    endAt: hktToUnix(item.end),
  }))).filter((item) => item.startAt !== null && item.startAt >= fromUnix - 3600 && item.startAt < toUnix);
  return { items: dedupeBy(items, (item) => `${item.startAt}|${normalizeKey(item.title)}`) };
};

module.exports = { groupInsights, timelineBetween, dailyActivity, weeklyHeatmap, topicTimeline, answerers };
