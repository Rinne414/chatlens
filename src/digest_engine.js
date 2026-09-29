"use strict";

// 每日总览 / 周报 / 月报: AI-written digests over what the briefing already
// summarized. A day's overview reads the cached per-chunk summaries of every
// group that day (never the raw messages, so it is one call however busy the
// day was); a week or month report reads that period's day overviews and
// writes any that are missing first. Stored in period_digests.

const { callLlm, currentModel, currentDetail } = require("./llm_summarizer");
const { profileFor } = require("./llm_profiles");
const periods = require("./digest_periods");
const digestStore = require("./digest_store");

// A period counts as over (its digest final) this long after it ends, so late
// chunks of its last hour are in.
const SETTLE_SECONDS = 90 * 60;
const TODAY_REFRESH_SECONDS = 3600;
const TRIM_ROUNDS = 3;
const URL_PATTERN = /^https?:\/\/\S+$/iu;
const IMPORTANCE = new Set(["high", "medium", "low"]);

const arrayOf = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 2000) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const strings = (value, max) => arrayOf(value).map((item) => text(item, max)).filter((item) => item.length > 0);
const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/* ---------- inputs ---------- */

const chunksBetween = (db, { startUnix, endUnix }) => db.prepare(`
  SELECT c.chunk_id AS chunkId, c.group_id AS groupId, COALESCE(NULLIF(n.name, ''), c.group_id) AS groupName,
         c.message_count AS messageCount, c.partial_json AS partialJson, COALESCE(c.detail, 'standard') AS detail
  FROM summary_chunks c LEFT JOIN group_names n ON n.group_id = c.group_id
  WHERE c.status = 'done' AND c.partial_json IS NOT NULL AND c.end_sent_at >= ? AND c.start_sent_at < ?
  ORDER BY c.group_id, c.start_sent_at
`).all(startUnix, endUnix);

// Text messages per group in a period, busiest first (local numbers the
// digest shows next to the AI text).
const groupVolumes = (db, { startUnix, endUnix }) => db.prepare(`
  SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, COUNT(*) AS messages
  FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
  WHERE m.is_media = 0 AND m.sent_at >= ? AND m.sent_at < ?
  GROUP BY m.group_id ORDER BY messages DESC
`).all(startUnix, endUnix);

const compactChunk = (partial, per) => ({
  summary: text(partial.summary, 400),
  topics: arrayOf(partial.topics).slice(0, per.topics).map((topic) => ({
    title: text(topic?.title, 80),
    summary: text(topic?.summary, 300),
    importance: topic?.importance,
    ...(per.details > 0 ? { details: strings(topic?.details, 200).slice(0, per.details) } : {}),
  })),
  newThings: arrayOf(partial.newThings).slice(0, per.newThings).map((item) => ({
    name: text(item?.name, 80),
    detail: text(item?.detail, 200),
    link: URL_PATTERN.test(text(item?.link)) ? text(item.link) : null,
  })),
  qa: arrayOf(partial.qa).slice(0, per.qa).map((item) => ({ question: text(item?.question, 200), answer: text(item?.answer, 300) || null })),
});

const halve = (per) => Object.fromEntries(Object.entries(per).map(([key, value]) => [key, key === "details" ? 0 : Math.max(1, Math.floor(value / 2))]));

const chunkKey = (chunks) => chunks.map((chunk) => (chunk.detail === "detailed" ? `${chunk.chunkId}d` : String(chunk.chunkId))).join(",");

// Every group's chunk summaries for the day, trimmed until they fit the
// level's input budget.
const dayInput = (chunks, volumes, profile) => {
  const byGroup = new Map();
  for (const chunk of chunks) {
    const entry = byGroup.get(chunk.groupId) ?? { groupName: chunk.groupName, chunks: [] };
    byGroup.set(chunk.groupId, { ...entry, chunks: [...entry.chunks, chunk] });
  }
  const volumeOf = new Map(volumes.map((row) => [row.groupId, row.messages]));
  let per = profile.digest.day.perChunk;
  let groups = [];
  for (let round = 0; round <= TRIM_ROUNDS; round += 1) {
    groups = [...byGroup.entries()]
      .map(([groupId, entry]) => ({
        group: entry.groupName,
        messages: volumeOf.get(groupId) ?? entry.chunks.reduce((total, chunk) => total + chunk.messageCount, 0),
        parts: entry.chunks.map((chunk) => compactChunk(parse(chunk.partialJson) ?? {}, per)),
      }))
      .sort((left, right) => right.messages - left.messages);
    if (JSON.stringify(groups).length <= profile.digest.day.inputChars) {
      return { groups, trimmed: round > 0 };
    }
    per = halve(per);
  }
  return { groups, trimmed: true };
};

/* ---------- prompts ---------- */

const DAY_SCHEMA = {
  headline: "string，一句话",
  summary: "string",
  highlights: [{ title: "string", detail: "string", groups: ["群名"], importance: "high | medium | low" }],
  crossGroup: [{ topic: "string", detail: "string", groups: ["群名"] }],
  newThings: [{ name: "string", detail: "string", groups: ["群名"], link: "string | null" }],
  openQuestions: [{ question: "string", group: "群名" }],
  groups: [{ group: "群名", oneLine: "string" }],
};

const PERIOD_SCHEMA = {
  headline: "string，一句话",
  summary: "string",
  trends: [{ title: "string", detail: "string" }],
  highlights: [{ title: "string", detail: "string", groups: ["群名"], days: ["YYYY-MM-DD"] }],
  groups: [{ group: "群名", summary: "string" }],
  newThings: [{ name: "string", detail: "string", groups: ["群名"], link: "string | null" }],
  bestQa: [{ question: "string", answer: "string", group: "群名" }],
};

const DETAILED_NOTE = "这是详细模式：宁可多写，每条 detail 用 2-4 句写清来龙去脉、各方观点和结论，不要为了简短丢掉信息。";

const buildDayPrompt = (day, input, detail) => {
  const { caps, summarySentences } = profileFor(detail).digest.day;
  return {
    system: [
      "你是多群日报的编辑。读者关注了下面这些 QQ 群，想用几分钟知道这一天各群发生了什么。",
      "输入是每个群这一天各段聊天的 AI 摘要。只根据输入写，不要编造。",
      "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
    ].join("\n"),
    user: JSON.stringify({
      task: `写 ${day} 这一天的跨群总览。`,
      rules: [
        ...(detail === "detailed" ? [DETAILED_NOTE] : []),
        "headline 用一句话点出这一天最值得知道的事。",
        `summary 用 ${summarySentences} 句跨群综合这一天，不要逐群复述。`,
        `highlights 是这一天最重要、最有用或最热的事，最多 ${caps.highlights} 条，按重要性排序；detail 写清是什么、为什么值得看；groups 写涉及的群名。`,
        `crossGroup 是在两个以上群都出现的同一话题或同一个东西，最多 ${caps.crossGroup} 条；没有就给空数组。`,
        `newThings 是最值得注意的新东西（新模型、工具、教程、资源、活动），最多 ${caps.newThings} 条，同一个东西只列一次，写明在哪些群出现，有链接就填 link。`,
        `openQuestions 是还没人回答、但值得注意的问题，最多 ${caps.openQuestions} 条。`,
        "groups 按消息量从多到少，每个群一句话概括它这一天；没什么内容的群简单写一句即可。",
      ],
      outputSchema: DAY_SCHEMA,
      input,
    }, null, 2),
    maxTokens: profileFor(detail).digest.day.maxTokens,
  };
};

const buildPeriodPrompt = (kind, period, input, detail) => {
  const { caps, summarySentences } = profileFor(detail).digest.period;
  const label = kind === "week" ? `${period} 开始的这一周` : `${period} 这个月`;
  return {
    system: [
      `你是多群${kind === "week" ? "周报" : "月报"}的编辑。读者关注了下面这些 QQ 群，想知道${label}各群发生了什么、有什么变化。`,
      "输入是这段时间每一天的跨群总览，以及各群的消息量。只根据输入写，不要编造。",
      "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
    ].join("\n"),
    user: JSON.stringify({
      task: `写${label}的${kind === "week" ? "周报" : "月报"}。`,
      rules: [
        ...(detail === "detailed" ? [DETAILED_NOTE] : []),
        "headline 用一句话点出这段时间最值得知道的事。",
        `summary 用 ${summarySentences} 句综合整段时间，讲变化和走向，不要逐日复述。`,
        `trends 是这段时间的走向：反复出现的话题、热度上升或下降的东西、群里风向的变化，最多 ${caps.trends} 条。`,
        `highlights 是这段时间最重要的事，最多 ${caps.highlights} 条，按重要性排序；days 写发生在哪几天。`,
        "groups 按消息量从多到少，每个群用一两句概括它这段时间。",
        `newThings 是这段时间出现的最值得注意的新东西，最多 ${caps.newThings} 条，同一个东西只列一次。`,
        `bestQa 是最有价值、值得保存的问答，最多 ${caps.bestQa} 条。`,
      ],
      outputSchema: PERIOD_SCHEMA,
      input,
    }, null, 2),
    maxTokens: profileFor(detail).digest.period.maxTokens,
  };
};

/* ---------- output ---------- */

// Lenient: an incomplete item is dropped, never the whole digest.
const normalizeItems = (items, required, shape) =>
  arrayOf(items).filter((item) => item && required.every((key) => text(item[key]).length > 0)).map(shape);

const linkOf = (value) => (URL_PATTERN.test(text(value)) ? text(value) : null);

const normalizeCommon = (raw) => {
  const headline = text(raw?.headline, 300);
  const summary = text(raw?.summary, 8000);
  if (headline.length === 0 && summary.length === 0) {
    throw new Error("Invalid digest JSON: no headline or summary");
  }
  return {
    headline,
    summary,
    newThings: normalizeItems(raw.newThings, ["name", "detail"], (item) => ({
      name: text(item.name, 120), detail: text(item.detail), groups: strings(item.groups, 80), link: linkOf(item.link),
    })),
  };
};

const normalizeDay = (raw) => ({
  ...normalizeCommon(raw),
  highlights: normalizeItems(raw.highlights, ["title", "detail"], (item) => ({
    title: text(item.title, 200), detail: text(item.detail), groups: strings(item.groups, 80),
    importance: IMPORTANCE.has(item.importance) ? item.importance : "medium",
  })),
  crossGroup: normalizeItems(raw.crossGroup, ["topic", "detail"], (item) => ({
    topic: text(item.topic, 200), detail: text(item.detail), groups: strings(item.groups, 80),
  })),
  openQuestions: normalizeItems(raw.openQuestions, ["question"], (item) => ({ question: text(item.question, 500), group: text(item.group, 80) })),
  groups: normalizeItems(raw.groups, ["group", "oneLine"], (item) => ({ group: text(item.group, 80), oneLine: text(item.oneLine, 500) })),
});

const normalizePeriod = (raw) => ({
  ...normalizeCommon(raw),
  trends: normalizeItems(raw.trends, ["title", "detail"], (item) => ({ title: text(item.title, 200), detail: text(item.detail) })),
  highlights: normalizeItems(raw.highlights, ["title", "detail"], (item) => ({
    title: text(item.title, 200), detail: text(item.detail), groups: strings(item.groups, 80), days: strings(item.days, 10),
  })),
  groups: normalizeItems(raw.groups, ["group", "summary"], (item) => ({ group: text(item.group, 80), summary: text(item.summary) })),
  bestQa: normalizeItems(raw.bestQa, ["question", "answer"], (item) => ({ question: text(item.question, 500), answer: text(item.answer), group: text(item.group, 80) })),
});

/* ---------- generation ---------- */

const isOver = (bounds, now) => now >= bounds.endUnix + SETTLE_SECONDS;

// Rewritten only when its input changed — and a final digest (written after
// its period was over) only if its input changed since.
const isCurrent = (existing, inputKey, bounds, now) =>
  existing !== null && existing.inputKey === inputKey && (existing.complete || !isOver(bounds, now));

// gate() returns a reason to stop spending (pause, budget) or null. force
// rewrites even an up-to-date digest (the user asked for it, e.g. after
// switching to the detailed level).
const generateDay = async (db, client, { day, now, gate = () => null, force = false }) => {
  const bounds = periods.periodBounds("day", day);
  const chunks = chunksBetween(db, bounds);
  if (chunks.length === 0) {
    return { status: "no-data" };
  }
  const inputKey = chunkKey(chunks);
  const existing = digestStore.getDigest(db, "day", day);
  if (!force && isCurrent(existing, inputKey, bounds, now)) {
    return { status: "unchanged", digest: existing };
  }
  const blocked = gate();
  if (blocked !== null) {
    return { status: "blocked", reason: blocked };
  }
  const volumes = groupVolumes(db, bounds);
  const raw = await callLlm(client, (detail) => buildDayPrompt(day, dayInput(chunks, volumes, profileFor(detail)), detail), { purpose: "digest", validate: normalizeDay });
  const digest = {
    kind: "day",
    period: day,
    ...bounds,
    inputKey,
    detail: currentDetail(client),
    model: currentModel(client),
    summary: {
      ...normalizeDay(raw),
      stats: { groups: new Set(chunks.map((chunk) => chunk.groupId)).size, chunks: chunks.length, volumes },
    },
    generatedAt: now,
    complete: isOver(bounds, now),
  };
  digestStore.saveDigest(db, digest);
  return { status: "done", digest };
};

const compactDay = (digest) => ({
  day: digest.period,
  headline: digest.summary.headline,
  summary: digest.summary.summary,
  highlights: arrayOf(digest.summary.highlights).map(({ title, detail, groups }) => ({ title, detail, groups })),
  crossGroup: digest.summary.crossGroup,
  newThings: arrayOf(digest.summary.newThings).map(({ name, detail, groups }) => ({ name, detail, groups })),
  openQuestions: digest.summary.openQuestions,
  groups: digest.summary.groups,
});

const periodInput = (days, volumes, profile) => {
  let entries = days.map(compactDay);
  for (let round = 0; round <= TRIM_ROUNDS; round += 1) {
    const input = { days: entries, groupVolumes: volumes.map(({ groupName, messages }) => ({ group: groupName, messages })) };
    if (JSON.stringify(input).length <= profile.digest.period.inputChars || round === TRIM_ROUNDS) {
      return input;
    }
    entries = entries.map((entry) => ({
      ...entry,
      highlights: entry.highlights.slice(0, Math.max(2, Math.floor(entry.highlights.length / 2))),
      newThings: entry.newThings.slice(0, Math.max(2, Math.floor(entry.newThings.length / 2))),
      groups: [],
    }));
  }
  return { days: entries, groupVolumes: [] };
};

// Writes the period's missing or outdated day overviews, then the report
// (force applies to the report only).
const generatePeriod = async (db, client, { kind, period, now, gate = () => null, force = false }) => {
  const bounds = periods.periodBounds(kind, period);
  for (const day of periods.daysIn(kind, period)) {
    if (periods.periodBounds("day", day).startUnix > now) {
      break;
    }
    const result = await generateDay(db, client, { day, now, gate });
    if (result.status === "blocked") {
      return result;
    }
  }
  const days = digestStore.digestsBetween(db, "day", bounds.startUnix, bounds.endUnix);
  if (days.length === 0) {
    return { status: "no-data" };
  }
  const inputKey = days.map((day) => `${day.period}@${day.generatedAt}`).join(",");
  const existing = digestStore.getDigest(db, kind, period);
  if (!force && isCurrent(existing, inputKey, bounds, now)) {
    return { status: "unchanged", digest: existing };
  }
  const blocked = gate();
  if (blocked !== null) {
    return { status: "blocked", reason: blocked };
  }
  const volumes = groupVolumes(db, bounds);
  const raw = await callLlm(client, (detail) => buildPeriodPrompt(kind, period, periodInput(days, volumes, profileFor(detail)), detail), { purpose: "digest", validate: normalizePeriod });
  const digest = {
    kind,
    period,
    ...bounds,
    inputKey,
    detail: currentDetail(client),
    model: currentModel(client),
    summary: { ...normalizePeriod(raw), stats: { days: days.length, volumes } },
    generatedAt: now,
    complete: isOver(bounds, now),
  };
  digestStore.saveDigest(db, digest);
  return { status: "done", digest };
};

const generate = (db, client, { kind, period, now, gate, force = false }) =>
  (kind === "day" ? generateDay(db, client, { day: period, now, gate, force }) : generatePeriod(db, client, { kind, period, now, gate, force }));

// Background schedule: yesterday's overview, today's (detailed level only,
// at most hourly), last week's and last month's reports. A report whose day
// overviews are still missing continues on later runs as the gate allows.
const runScheduledDigests = async (db, client, { now, gate }) => {
  const profile = profileFor(currentDetail(client));
  const today = periods.periodOf("day", now);
  const targets = [
    ["day", periods.previousPeriod("day", now)],
    ...(profile.digest.autoToday ? [["day", today]] : []),
    ["week", periods.previousPeriod("week", now)],
    ["month", periods.previousPeriod("month", now)],
  ];
  const outcome = [];
  for (const [kind, period] of targets) {
    const existing = digestStore.getDigest(db, kind, period);
    if (existing?.complete && kind !== "day") {
      continue;
    }
    if (kind === "day" && period === today && existing !== null && now - existing.generatedAt < TODAY_REFRESH_SECONDS) {
      continue;
    }
    try {
      const result = await generate(db, client, { kind, period, now, gate });
      outcome.push({ kind, period, status: result.status });
      if (result.status === "blocked") {
        break;
      }
    } catch (error) {
      outcome.push({ kind, period, status: "failed", error: String(error.message).slice(0, 200) });
    }
  }
  return outcome;
};

module.exports = {
  SETTLE_SECONDS,
  compactChunk,
  dayInput,
  normalizeDay,
  normalizePeriod,
  generate,
  generateDay,
  generatePeriod,
  runScheduledDigests,
};
