"use strict";

// 回顾: look back at any day, and find when a topic was discussed. Built from
// what the background briefing already paid for — the cached per-chunk AI
// summaries (summary_chunks.partial_json) — plus the raw message store, so
// browsing and searching never call the LLM. Days that were never summarized
// can be "补齐": their uncovered messages become ordinary chunks that the
// background map step summarizes once, like any other.

const briefingStore = require("./briefing_store");
const engine = require("./briefing_engine");
const { formatHkt } = require("./unviewed_range");
const { interleave } = require("./briefing_view");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const DAY_SECONDS = 86400;
// Raw-message hits come a page at a time (a common word can match tens of
// thousands); every page is reachable. Summary hits come complete.
const MESSAGE_PAGE = 200;
const MAX_TERMS = 5;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const dayOf = (unix) => formatHkt(unix).slice(0, 10);

const dayBounds = (day) => {
  if (!DAY_PATTERN.test(String(day))) {
    throw new Error("日期格式应为 YYYY-MM-DD。");
  }
  const [year, month, date] = day.split("-").map(Number);
  const start = Date.UTC(year, month - 1, date) / 1000 - BEIJING_OFFSET_SECONDS;
  if (!Number.isFinite(start) || dayOf(start) !== day) {
    throw new Error("日期无效。");
  }
  return { start, end: start + DAY_SECONDS };
};

const parsePartial = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// "2026-09-24 07:52[:27]" (Beijing, as the LLM echoes it) -> unix, or null.
const hktToUnix = (text) => {
  const match = String(text ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/u);
  if (match === null) {
    return null;
  }
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? 0)) / 1000 - BEIJING_OFFSET_SECONDS;
};

/* ---------- calendar ---------- */

// Per Beijing day: message volume, and whether any AI summary covers it.
const calendar = (db, { fromDay, toDay }) => {
  briefingStore.ensureBriefingSchema(db);
  const from = dayBounds(fromDay).start;
  const to = dayBounds(toDay).end;
  const rows = db.prepare(`
    SELECT (sent_at + ${BEIJING_OFFSET_SECONDS}) / ${DAY_SECONDS} AS dayNumber,
           SUM(CASE WHEN is_media = 0 THEN 1 ELSE 0 END) AS textMessages,
           SUM(CASE WHEN is_media = 1 THEN 1 ELSE 0 END) AS mediaMessages,
           COUNT(DISTINCT group_id) AS groups
    FROM messages WHERE sent_at >= ? AND sent_at < ?
    GROUP BY dayNumber ORDER BY dayNumber
  `).all(from, to);
  const summarizedDays = new Set();
  const chunks = db.prepare(`
    SELECT start_sent_at AS startSentAt, end_sent_at AS endSentAt FROM summary_chunks
    WHERE status = 'done' AND end_sent_at >= ? AND start_sent_at < ?
  `).all(from, to);
  for (const chunk of chunks) {
    for (let unix = Math.max(chunk.startSentAt, from); unix <= Math.min(chunk.endSentAt, to - 1); unix += DAY_SECONDS) {
      summarizedDays.add(dayOf(unix));
    }
    summarizedDays.add(dayOf(Math.min(chunk.endSentAt, to - 1)));
  }
  const range = db.prepare("SELECT MIN(sent_at) AS first, MAX(sent_at) AS last FROM messages").get();
  return {
    firstDay: range.first === null ? null : dayOf(range.first),
    lastDay: range.last === null ? null : dayOf(range.last),
    days: rows.map((row) => {
      const day = dayOf(row.dayNumber * DAY_SECONDS - BEIJING_OFFSET_SECONDS + 3600);
      return {
        day,
        textMessages: row.textMessages,
        mediaMessages: row.mediaMessages,
        groups: row.groups,
        summarized: summarizedDays.has(day),
      };
    }),
  };
};

/* ---------- coverage: which of a day's messages a chunk already holds ---------- */

const rowNumber = (rowId) => Number(rowId);

// (sentAt, rowId) keyset comparison, the same order the chunker uses.
const compareKey = (leftSentAt, leftRow, rightSentAt, rightRow) =>
  leftSentAt - rightSentAt || rowNumber(leftRow) - rowNumber(rightRow);

// Pure: tags each message (sorted by sentAt, rowId) with the status of the
// chunk that contains it, or null. Chunks never overlap each other.
const tagCoverage = (messages, chunks) => {
  const sorted = [...chunks].sort((left, right) => compareKey(left.startSentAt, left.firstRowId, right.startSentAt, right.firstRowId));
  let index = 0;
  return messages.map((message) => {
    while (index < sorted.length && compareKey(sorted[index].endSentAt, sorted[index].lastRowId, message.sentAt, message.rowId) < 0) {
      index += 1;
    }
    const chunk = sorted[index];
    const inside = chunk !== undefined
      && compareKey(chunk.startSentAt, chunk.firstRowId, message.sentAt, message.rowId) <= 0;
    return inside ? chunk.status : null;
  });
};

// Pure: consecutive runs of uncovered messages (a covered message ends a
// run), so a backfilled chunk can never enclose an existing one.
const uncoveredRuns = (messages, tags) => {
  const runs = [];
  let current = [];
  messages.forEach((message, index) => {
    if (tags[index] === null) {
      current.push(message);
      return;
    }
    if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
};

const dayTextMessages = (db, groupId, { start, end }) =>
  db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.speaker, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.group_id = ? AND m.is_media = 0 AND m.sent_at >= ? AND m.sent_at < ?
    ORDER BY m.sent_at ASC, CAST(m.row_id AS INTEGER) ASC
  `).all(String(groupId), start, end);

const chunksOverlapping = (db, groupId, { start, end }) =>
  db.prepare(`
    SELECT chunk_id AS chunkId, start_sent_at AS startSentAt, end_sent_at AS endSentAt,
           first_row_id AS firstRowId, last_row_id AS lastRowId, message_count AS messageCount,
           status, partial_json AS partialJson
    FROM summary_chunks
    WHERE group_id = ? AND end_sent_at >= ? AND start_sent_at < ?
    ORDER BY start_sent_at ASC, chunk_id ASC
  `).all(String(groupId), start, end);

// Messages at or after this belong to the live briefing chunker; backfill
// stays strictly before it so the two never race for the same messages.
const liveCutoff = (db, groupId, now) => {
  const since = engine.briefingSince(db, now);
  const fromUnix = Math.max(since, now - engine.DEFAULTS.maxLookbackSeconds);
  const boundary = briefingStore.lastChunkBoundary(db, groupId);
  return Math.max(fromUnix, boundary?.sentAt ?? fromUnix);
};

/* ---------- one day ---------- */

const inDay = (bounds) => (item, fallback) => {
  const at = hktToUnix(item.hkt ?? item.start) ?? fallback;
  return at >= bounds.start && at < bounds.end;
};

const groupActivity = (db, { start, end }) =>
  db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS name,
           SUM(CASE WHEN m.is_media = 0 THEN 1 ELSE 0 END) AS textMessages,
           SUM(CASE WHEN m.is_media = 1 THEN 1 ELSE 0 END) AS mediaMessages,
           COUNT(DISTINCT m.speaker) AS speakers,
           MIN(m.sent_at) AS firstSentAt, MAX(m.sent_at) AS lastSentAt
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.sent_at >= ? AND m.sent_at < ?
    GROUP BY m.group_id
    ORDER BY COUNT(*) DESC
  `).all(start, end);

const reviewGroup = (db, activity, bounds, now) => {
  const messages = dayTextMessages(db, activity.groupId, bounds);
  const chunks = chunksOverlapping(db, activity.groupId, bounds);
  const tags = tagCoverage(messages, chunks);
  const cutoff = liveCutoff(db, activity.groupId, now);
  const count = (status) => tags.filter((tag) => tag === status).length;
  const backfillable = messages.filter((message, index) => tags[index] === null && message.sentAt < cutoff).length;
  const withinDay = inDay(bounds);

  const sections = [];
  const topics = [];
  const newThings = [];
  const qa = [];
  const links = [];
  for (const chunk of chunks.filter((item) => item.status === "done")) {
    const partial = parsePartial(chunk.partialJson);
    if (partial === null) {
      continue;
    }
    const chunkAt = Math.max(chunk.startSentAt, bounds.start);
    sections.push({
      chunkId: chunk.chunkId,
      startSentAt: chunk.startSentAt,
      endSentAt: chunk.endSentAt,
      messageCount: chunk.messageCount,
      straddles: chunk.startSentAt < bounds.start || chunk.endSentAt >= bounds.end,
      summary: partial.summary ?? "",
      timeline: (partial.timeline ?? []).filter((item) => withinDay(item, chunkAt)).map((item) => ({
        ...item,
        startSentAt: hktToUnix(item.start) ?? chunkAt,
      })),
    });
    topics.push(...(partial.topics ?? []).map((topic) => ({ ...topic, chunkId: chunk.chunkId })));
    newThings.push(...(partial.newThings ?? []).filter((item) => withinDay(item, chunkAt)));
    qa.push(...(partial.qa ?? []).filter((item) => withinDay(item, chunkAt)));
    links.push(...(partial.links ?? []));
  }
  return {
    groupId: activity.groupId,
    name: activity.name || activity.groupId,
    textMessages: activity.textMessages,
    mediaMessages: activity.mediaMessages,
    speakers: activity.speakers,
    firstSentAt: activity.firstSentAt,
    lastSentAt: activity.lastSentAt,
    summarized: count("done"),
    queued: count("pending") + count("failed"),
    uncovered: count(null),
    backfillable,
    sections,
    topics,
    newThings,
    qa,
    links,
  };
};

const withGroupName = (group) => (item) => ({ ...item, groupId: group.groupId, groupName: group.name });


const dayReview = (db, { day, now }) => {
  briefingStore.ensureBriefingSchema(db);
  const bounds = dayBounds(day);
  const groups = groupActivity(db, bounds).map((activity) => reviewGroup(db, activity, bounds, now));
  const sum = (key) => groups.reduce((total, group) => total + group[key], 0);
  return {
    day,
    start: bounds.start,
    end: bounds.end,
    totals: {
      groups: groups.length,
      textMessages: sum("textMessages"),
      mediaMessages: sum("mediaMessages"),
      summarized: sum("summarized"),
      queued: sum("queued"),
      uncovered: sum("uncovered"),
      backfillable: sum("backfillable"),
    },
    highlights: {
      newThings: interleave(groups.map((group) => group.newThings.map(withGroupName(group)))),
      qa: interleave(groups.map((group) => group.qa.filter((item) => item.resolved).map(withGroupName(group))))
        .concat(interleave(groups.map((group) => group.qa.filter((item) => !item.resolved).map(withGroupName(group))))),
    },
    groups,
  };
};

/* ---------- 补齐: turn a day's uncovered messages into chunks ---------- */

const planBackfill = (db, { day, now, groupIds = null }) => {
  const bounds = dayBounds(day);
  const activity = groupActivity(db, bounds).filter((row) => groupIds === null || groupIds.includes(row.groupId));
  const plans = [];
  for (const row of activity) {
    const cutoff = liveCutoff(db, row.groupId, now);
    const messages = dayTextMessages(db, row.groupId, bounds).filter((message) => message.sentAt < cutoff);
    const tags = tagCoverage(messages, chunksOverlapping(db, row.groupId, bounds));
    for (const run of uncoveredRuns(messages, tags)) {
      for (const slice of engine.planChunks(run, { now, force: true })) {
        const part = run.slice(slice.from, slice.to);
        plans.push({
          groupId: row.groupId,
          startSentAt: part[0].sentAt,
          endSentAt: part.at(-1).sentAt,
          firstRowId: part[0].rowId,
          lastRowId: part.at(-1).rowId,
          messageCount: part.length,
        });
      }
    }
  }
  return plans;
};

const backfillDay = (db, { day, now }) => {
  briefingStore.ensureBriefingSchema(db);
  const plans = planBackfill(db, { day, now });
  db.transaction(() => {
    for (const plan of plans) {
      briefingStore.insertChunk(db, { ...plan, createdAt: now });
    }
  })();
  return { chunks: plans.length, messages: plans.reduce((total, plan) => total + plan.messageCount, 0) };
};

/* ---------- 话题搜索 ---------- */

const searchTerms = (query) =>
  [...new Set(String(query ?? "").trim().toLowerCase().split(/\s+/u).filter((term) => term.length > 0))].slice(0, MAX_TERMS);

const escapeLike = (term) => term.replace(/[\\%_]/gu, (char) => `\\${char}`);

const matchesAll = (terms, ...fields) => {
  const text = fields.flat().filter((value) => typeof value === "string").join("\n").toLowerCase();
  return terms.every((term) => text.includes(term));
};

// One chunk's partial -> the individual items that mention every term.
const chunkHits = (partial, terms, chunk) => {
  const base = { chunkId: chunk.chunkId, groupId: chunk.groupId, groupName: chunk.groupName || chunk.groupId };
  const at = (item) => hktToUnix(item.hkt ?? item.start) ?? chunk.startSentAt;
  const hits = [
    ...(partial.topics ?? []).filter((topic) => matchesAll(terms, topic.title, topic.summary, topic.details ?? []))
      .map((topic) => ({ kind: "topic", title: topic.title, text: topic.summary, sentAt: chunk.startSentAt })),
    ...(partial.newThings ?? []).filter((item) => matchesAll(terms, item.name, item.detail))
      .map((item) => ({ kind: "newThing", title: item.name, text: item.detail, sentAt: at(item) })),
    ...(partial.qa ?? []).filter((item) => matchesAll(terms, item.question, item.answer))
      .map((item) => ({ kind: "qa", title: item.question, text: item.answer ?? "", sentAt: at(item) })),
    ...(partial.timeline ?? []).filter((item) => matchesAll(terms, item.title, item.summary))
      .map((item) => ({ kind: "timeline", title: item.title, text: item.summary, sentAt: at(item) })),
  ];
  if (hits.length === 0 && matchesAll(terms, partial.summary)) {
    hits.push({ kind: "summary", title: "", text: partial.summary, sentAt: chunk.startSentAt });
  }
  return hits.map((hit) => ({ ...base, ...hit, day: dayOf(hit.sentAt) }));
};

const searchSummaries = (db, terms) => {
  const where = terms.map(() => "c.partial_json LIKE ? ESCAPE '\\'").join(" AND ");
  const chunks = db.prepare(`
    SELECT c.chunk_id AS chunkId, c.group_id AS groupId, COALESCE(n.name, '') AS groupName,
           c.start_sent_at AS startSentAt, c.end_sent_at AS endSentAt, c.partial_json AS partialJson
    FROM summary_chunks c LEFT JOIN group_names n ON n.group_id = c.group_id
    WHERE c.status = 'done' AND ${where}
    ORDER BY c.end_sent_at DESC
  `).all(...terms.map((term) => `%${escapeLike(term)}%`));
  return chunks.flatMap((chunk) => {
    const partial = parsePartial(chunk.partialJson);
    return partial === null ? [] : chunkHits(partial, terms, chunk);
  });
};

const searchMessages = (db, terms, offset = 0) => {
  const where = terms.map(() => "m.text LIKE ? ESCAPE '\\'").join(" AND ");
  const params = terms.map((term) => `%${escapeLike(term)}%`);
  const hits = db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.speaker, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.is_media = 0 AND ${where}
    ORDER BY m.sent_at DESC LIMIT ${MESSAGE_PAGE} OFFSET ?
  `).all(...params, Math.max(0, Number.parseInt(offset, 10) || 0));
  const byDay = db.prepare(`
    SELECT (m.sent_at + ${BEIJING_OFFSET_SECONDS}) / ${DAY_SECONDS} AS dayNumber, COUNT(*) AS count
    FROM messages m WHERE m.is_media = 0 AND ${where}
    GROUP BY dayNumber ORDER BY dayNumber DESC
  `).all(...params);
  return {
    total: byDay.reduce((total, row) => total + row.count, 0),
    byDay: byDay.map((row) => ({ day: dayOf(row.dayNumber * DAY_SECONDS - BEIJING_OFFSET_SECONDS + 3600), count: row.count })),
    items: hits.map((hit) => ({ ...hit, groupName: hit.groupName || hit.groupId, day: dayOf(hit.sentAt) })),
  };
};

const search = (db, { query, messageOffset = 0 }) => {
  briefingStore.ensureBriefingSchema(db);
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return { terms, summaries: { total: 0, byDay: [], items: [] }, messages: { total: 0, byDay: [], items: [] } };
  }
  const summaryHits = searchSummaries(db, terms).sort((left, right) => right.sentAt - left.sentAt);
  const summaryDays = new Map();
  for (const hit of summaryHits) {
    summaryDays.set(hit.day, (summaryDays.get(hit.day) ?? 0) + 1);
  }
  return {
    terms,
    summaries: {
      total: summaryHits.length,
      byDay: [...summaryDays.entries()].map(([day, count]) => ({ day, count })),
      items: summaryHits,
    },
    messages: searchMessages(db, terms, messageOffset),
  };
};

module.exports = {
  dayBounds,
  hktToUnix,
  calendar,
  tagCoverage,
  uncoveredRuns,
  dayReview,
  planBackfill,
  backfillDay,
  searchTerms,
  search,
};
