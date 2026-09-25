"use strict";

// 热点: what is going around several groups at once. Three kinds of "thing",
// each matched exactly rather than guessed:
//   - links: the same URL (normalised) posted in the messages;
//   - named things: the models, tools and news the cached AI summaries listed
//     as "新东西", counted by their name in the raw messages of every group;
//   - pictures: the same file (md5) posted in several groups.
// For each: where and by whom it appeared first (事件), when it reached each
// group (传播), and what each group said about it (对比). No LLM calls.

const gallery = require("./gallery_store");

const DAY_SECONDS = 86400;
const MAX_EVENTS = 40;
const MAX_CANDIDATE_NAMES = 400;
const MIN_ASCII_KEY = 3;
const MIN_CJK_KEY = 2;
const GENERIC_SHARE = 0.02;
const SOLO_GROUP_MENTIONS = 12;
const SPREAD_PICTURES = 12;
const SAMPLE_CHARS = 140;
const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、）)\]】》]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?'"~。，！？、）)】》]+$/u;
const IGNORED_HOSTS = [/(^|\.)qpic\.cn$/u, /^multimedia\.nt\.qq\.com\.cn$/u, /(^|\.)qlogo\.cn$/u];
const KIND_LABELS = { model: "模型", tool: "工具", tutorial: "教程", resource: "资源", news: "新闻", event: "活动", other: "新东西" };

const parsePartial = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// Lower-case, no spaces or punctuation: "NAI 5.5" and "nai5.5" are one thing.
const normalizeName = (value) => String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

// The exact pattern for a name in raw text: its parts in order with any
// spacing or punctuation between them, and -- where the name starts or ends
// with a Latin letter or digit -- not inside a longer word ("sol" must not
// match "console"). Parts are letters and digits only, so need no escaping.
const namePattern = (name) => {
  const parts = String(name ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (parts.length === 0) {
    return null;
  }
  const body = parts.join(/[\s\p{P}\p{S}]*/u.source);
  const head = /^[a-z0-9]/u.test(parts[0]) ? "(?<![a-z0-9])" : "";
  const tail = /[a-z0-9]$/u.test(parts[parts.length - 1]) ? "(?![a-z0-9])" : "";
  return new RegExp(head + body + tail, "iu");
};

const keyIsSpecific = (key) => {
  const cjk = /\p{Script=Han}/u.test(key);
  return [...key].length >= (cjk ? MIN_CJK_KEY : MIN_ASCII_KEY) && !/^\d+$/u.test(key);
};

const normalizeUrl = (raw) => {
  let url;
  try {
    url = new URL(String(raw).replace(TRAILING_PUNCTUATION, ""));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (IGNORED_HOSTS.some((pattern) => pattern.test(host))) {
    return null;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_|spm|share|from|si$|vd_source)/u.test(name)) {
      url.searchParams.delete(name);
    }
  }
  const query = url.searchParams.toString();
  const pathPart = url.pathname.replace(/\/+$/u, "");
  return { key: `${host}${pathPart}${query ? `?${query}` : ""}`, href: `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}`, host };
};

const clip = (text) => {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  return value.length > SAMPLE_CHARS ? `${value.slice(0, SAMPLE_CHARS)}…` : value;
};

/* ---------- gathering ---------- */

const windowMessages = (db, fromUnix, groupIds) => {
  const filter = groupIds === null ? "" : `AND m.group_id IN (SELECT value FROM json_each(@groups))`;
  return db.prepare(`
    SELECT m.group_id AS groupId, m.row_id AS rowId, m.sent_at AS sentAt, m.speaker, m.text,
           COALESCE(g.name, '') AS groupName
    FROM messages m LEFT JOIN group_names g ON g.group_id = m.group_id
    WHERE m.sent_at >= @fromUnix AND m.is_media = 0 AND m.text <> '' ${filter}
    ORDER BY m.sent_at, m.row_id
  `).all({ fromUnix, groups: JSON.stringify(groupIds ?? []) });
};

const windowPartials = (db, fromUnix, groupIds) => {
  const filter = groupIds === null ? "" : `AND group_id IN (SELECT value FROM json_each(@groups))`;
  return db.prepare(`
    SELECT group_id AS groupId, partial_json AS json FROM summary_chunks
    WHERE status = 'done' AND partial_json IS NOT NULL AND end_sent_at >= @fromUnix ${filter}
  `).all({ fromUnix, groups: JSON.stringify(groupIds ?? []) })
    .map((row) => ({ groupId: row.groupId, partial: parsePartial(row.json) }))
    .filter((row) => row.partial !== null);
};

// Adds one mention to an event's per-group record.
const addMention = (groups, message) => {
  const record = groups.get(message.groupId) ?? {
    groupId: message.groupId,
    groupName: message.groupName,
    firstAt: message.sentAt,
    lastAt: message.sentAt,
    mentions: 0,
    speakers: new Set(),
    times: [],
    sample: { speaker: message.speaker, text: clip(message.text), sentAt: message.sentAt, rowId: message.rowId },
  };
  record.mentions += 1;
  record.lastAt = Math.max(record.lastAt, message.sentAt);
  record.speakers.add(message.speaker);
  record.times.push(message.sentAt);
  groups.set(message.groupId, record);
};

const finishEvent = (base, groups) => {
  const list = [...groups.values()].sort((left, right) => left.firstAt - right.firstAt);
  const speakers = new Set(list.flatMap((record) => [...record.speakers]));
  const first = list[0];
  return {
    ...base,
    groups: list.map(({ speakers: groupSpeakers, times, ...record }) => ({ ...record, speakers: groupSpeakers.size })),
    times: list.flatMap((record) => record.times),
    origin: { groupId: first.groupId, groupName: first.groupName, ...first.sample },
    groupCount: list.length,
    totalMentions: list.reduce((sum, record) => sum + record.mentions, 0),
    speakerCount: speakers.size,
    firstAt: first.firstAt,
    lastAt: Math.max(...list.map((record) => record.lastAt)),
  };
};

/* ---------- the three kinds ---------- */

const linkEvents = (messages, partials) => {
  const titles = new Map();
  for (const { partial } of partials) {
    for (const link of partial.links ?? []) {
      const normalized = normalizeUrl(link.url);
      if (normalized !== null && link.title) {
        titles.set(normalized.key, link.title);
      }
    }
  }
  const byKey = new Map();
  for (const message of messages) {
    for (const raw of message.text.match(URL_PATTERN) ?? []) {
      const normalized = normalizeUrl(raw);
      if (normalized === null) {
        continue;
      }
      const entry = byKey.get(normalized.key) ?? { normalized, groups: new Map() };
      addMention(entry.groups, message);
      byKey.set(normalized.key, entry);
    }
  }
  return [...byKey.values()].map((entry) => finishEvent({
    id: `link:${entry.normalized.key}`,
    kind: "link",
    label: "链接",
    title: titles.get(entry.normalized.key) ?? entry.normalized.key,
    link: entry.normalized.href,
  }, entry.groups))
    // One person pasting the same link (often a signature) is not news.
    .filter((event) => event.speakerCount >= 2 && (event.groupCount >= 2 || event.speakerCount >= 3));
};

const nameCandidates = (partials) => {
  const byKey = new Map();
  for (const { groupId, partial } of partials) {
    for (const thing of partial.newThings ?? []) {
      const key = normalizeName(thing.name);
      if (!keyIsSpecific(key)) {
        continue;
      }
      const entry = byKey.get(key) ?? { key, name: thing.name, kind: thing.kind, link: thing.link ?? null, takes: new Map(), seen: 0 };
      entry.seen += 1;
      if (thing.detail && !entry.takes.has(groupId)) {
        entry.takes.set(groupId, thing.detail);
      }
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((left, right) => right.seen - left.seen).slice(0, MAX_CANDIDATE_NAMES);
};

const thingEvents = (messages, partials) => {
  const candidates = nameCandidates(partials);
  const normalizedTexts = messages.map((message) => normalizeName(message.text));
  return candidates.flatMap((candidate) => {
    const pattern = namePattern(candidate.name);
    const groups = new Map();
    // The cheap substring test first; the exact pattern only on its hits.
    normalizedTexts.forEach((text, index) => {
      if (text.includes(candidate.key) && (pattern === null || pattern.test(messages[index].text))) {
        addMention(groups, messages[index]);
      }
    });
    const total = [...groups.values()].reduce((sum, record) => sum + record.mentions, 0);
    // A "name" that half the messages contain is a common word, not a thing.
    if (total === 0 || total > messages.length * GENERIC_SHARE + 50) {
      return [];
    }
    if (groups.size < 2 && total < SOLO_GROUP_MENTIONS) {
      return [];
    }
    const event = finishEvent({
      id: `thing:${candidate.key}`,
      kind: "thing",
      label: KIND_LABELS[candidate.kind] ?? KIND_LABELS.other,
      title: candidate.name,
      link: typeof candidate.link === "string" && /^https?:\/\//iu.test(candidate.link) ? candidate.link : null,
    }, groups);
    return [{ ...event, key: candidate.key, groups: event.groups.map((record) => ({ ...record, take: candidate.takes.get(record.groupId) ?? "" })) }];
  });
};

const pictureEvents = (db, fromUnix, toUnix, groupIds) => {
  const page = gallery.listPictures(db, { fromUnix, toUnix, sort: "spread", limit: SPREAD_PICTURES * 3 });
  return page.items
    .filter((item) => item.groups >= 2 && (groupIds === null || groupIds.includes(item.origin?.groupId)))
    .slice(0, SPREAD_PICTURES)
    .map((item) => {
      const detail = gallery.pictureDetail(db, item.md5);
      const groups = new Map();
      for (const posting of detail.occurrences) {
        addMention(groups, { ...posting, text: "" });
      }
      return finishEvent({
        id: `picture:${item.md5}`,
        kind: "picture",
        label: item.ai ? "AI 图" : "图片",
        title: item.ai ? "一张 AI 图在多个群流传" : "一张图在多个群流传",
        md5: item.md5,
        ai: item.ai,
        generator: item.generator,
      }, groups);
    });
};

/* ---------- ranking ---------- */

// A picture travelling is mostly a reaction meme; an AI picture travelling is
// what an AI-art reader wants to see, so it keeps the full weight.
const GROUP_WEIGHT = { thing: 10, link: 10, picture: 6 };
const MAX_PICTURE_EVENTS = 8;

const groupWeight = (event) =>
  (event.kind === "picture" ? (event.ai ? GROUP_WEIGHT.thing : GROUP_WEIGHT.picture) : GROUP_WEIGHT[event.kind] ?? GROUP_WEIGHT.thing);

const score = (event, nowUnix) =>
  event.groupCount * groupWeight(event)
  + Math.log2(event.totalMentions + 1) * 3
  + Math.min(event.speakerCount, 20) * 0.5
  + (nowUnix - event.lastAt < DAY_SECONDS ? 5 : 0);

// "qwen", "Qwen Image" and "qwen image 2.1" are one story: a named thing whose
// key contains a higher-ranked thing's key is listed under it as related.
const MAX_RELATED = 6;

const foldRelated = (ranked) => {
  const kept = [];
  for (const event of ranked) {
    const parent = event.kind === "thing"
      ? kept.find((other) => other.kind === "thing" && event.key.includes(other.key))
      : undefined;
    if (parent === undefined) {
      kept.push({ ...event, related: [] });
    } else if (parent.related.length < MAX_RELATED) {
      parent.related.push({ title: event.title, groupCount: event.groupCount, totalMentions: event.totalMentions });
    }
  }
  return kept;
};

// Mentions per bucket across the window, for the small spark line.
const sparkOf = (times, fromUnix, nowUnix, buckets) => {
  const size = Math.max(1, (nowUnix - fromUnix) / buckets);
  const counts = new Array(buckets).fill(0);
  for (const sentAt of times) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((sentAt - fromUnix) / size)));
    counts[index] += 1;
  }
  return counts;
};

const trends = (db, { nowUnix, days = 3, groupIds = null }) => {
  const span = Math.min(7, Math.max(1, Number.parseInt(days, 10) || 3));
  const fromUnix = nowUnix - span * DAY_SECONDS;
  const ids = Array.isArray(groupIds) && groupIds.length > 0 ? groupIds.map(String) : null;
  const messages = windowMessages(db, fromUnix, ids);
  const partials = windowPartials(db, fromUnix, ids);
  const events = [
    ...thingEvents(messages, partials),
    ...linkEvents(messages, partials),
    ...pictureEvents(db, fromUnix, nowUnix + 60, ids),
  ];
  let pictures = 0;
  const ranked = foldRelated(events
    .map((event) => ({ ...event, score: score(event, nowUnix) }))
    .sort((left, right) => right.score - left.score))
    .filter((event) => event.kind !== "picture" || (pictures += 1) <= MAX_PICTURE_EVENTS)
    .slice(0, MAX_EVENTS)
    .map(({ times, ...event }) => ({ ...event, spark: sparkOf(times, fromUnix, nowUnix, span * 4) }));
  return { days: span, fromUnix, toUnix: nowUnix, messages: messages.length, summarizedChunks: partials.length, events: ranked };
};

module.exports = { trends, normalizeName, normalizeUrl, keyIsSpecific, namePattern };
