"use strict";

// 群 → one person, for the dates the 群 page shows: how much and when they
// talk, whom they reply to / @ and who does so to them, how each of those
// pairs changes over time (the page's "好感度趋势": replies and @s between two
// people per day or week), the other groups they talk in, and everything
// they said (paged). From stored messages only, no AI.

const { latestNames, rangeNames, splitUins } = require("./group_relations");

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const BEIJING_OFFSET_SECONDS = 8 * 3600;
// The trend is per hour up to HOURLY_UP_TO_DAYS, per day up to
// DAILY_UP_TO_DAYS, beyond that per week.
const HOURLY_UP_TO_DAYS = 2;
const DAILY_UP_TO_DAYS = 31;
const TREND_SERIES = 4;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const GROUP_ID = /^\d{5,}$/u;
const UIN = /^\d+$/u;

const validate = (groupId, uin) => {
  if (!GROUP_ID.test(String(groupId))) {
    throw new Error("群号无效。");
  }
  if (!UIN.test(String(uin))) {
    throw new Error("QQ 号无效。");
  }
};

const beijingDayStart = (unix) => unix - (((unix + BEIJING_OFFSET_SECONDS) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;

// The name each person used last in the range (as the 关系网 shows it), or
// last ever for someone who did not speak in it.
const namesFor = (db, groupId, uins, range) => {
  const spoken = rangeNames(db, groupId, range);
  const missing = uins.filter((uin) => !spoken.has(uin));
  const older = latestNames(db, groupId, missing);
  return new Map(uins.map((uin) => [uin, spoken.get(uin) ?? older.get(uin) ?? uin]));
};

const summary = (db, groupId, uin, { fromUnix, toUnix }, names) => {
  const inRange = db.prepare(`
    SELECT COUNT(*) AS messages, COALESCE(SUM(is_media), 0) AS media, MIN(sent_at) AS firstAt, MAX(sent_at) AS lastAt,
           COUNT(DISTINCT (sent_at + ${BEIJING_OFFSET_SECONDS}) / ${DAY_SECONDS}) AS activeDays
    FROM messages WHERE group_id = ? AND speaker_uin = ? AND sent_at >= ? AND sent_at < ?
  `).get(groupId, uin, fromUnix, toUnix);
  const ever = db.prepare("SELECT MIN(sent_at) AS firstEverAt, MAX(is_self) AS isSelf FROM messages WHERE group_id = ? AND speaker_uin = ?")
    .get(groupId, uin);
  return {
    uin,
    name: names.get(uin),
    isSelf: ever.isSelf === 1,
    messages: inRange.messages,
    media: inRange.media,
    activeDays: inRange.activeDays,
    firstAt: inRange.firstAt ?? null,
    lastAt: inRange.lastAt ?? null,
    firstEverAt: ever.firstEverAt ?? null,
  };
};

// Messages per Beijing hour of day.
const hours = (db, groupId, uin, { fromUnix, toUnix }) => {
  const counts = new Array(24).fill(0);
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', sent_at + ${BEIJING_OFFSET_SECONDS}, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n
    FROM messages WHERE group_id = ? AND speaker_uin = ? AND sent_at >= ? AND sent_at < ?
    GROUP BY hour
  `).all(groupId, uin, fromUnix, toUnix);
  for (const row of rows) {
    counts[row.hour] = row.n;
  }
  return counts;
};

// Every reply / @ between the person and someone else, and the person's own
// messages, in one group or (groupId null) in all of them:
// events [{ groupId, sentAt, partner, direction: "out" | "back", kind }],
// own [sentAt], ownRows [{ groupId, sentAt, name, isMedia }].
const interactions = (db, groupId, uin, { fromUnix, toUnix }) => {
  const inGroup = groupId === null ? "" : "group_id = @groupId AND";
  const rows = db.prepare(`
    SELECT group_id AS groupId, sent_at AS sentAt, speaker_uin AS speaker, speaker AS name, is_media AS isMedia,
           reply_to_uin AS replyTo, at_uins AS ats
    FROM messages WHERE ${inGroup} sent_at >= @fromUnix AND sent_at < @toUnix
      AND (speaker_uin = @uin OR reply_to_uin = @uin OR (',' || at_uins || ',') LIKE '%,' || @uin || ',%')
  `).all({ ...(groupId === null ? {} : { groupId }), uin, fromUnix, toUnix });
  const events = [];
  const ownRows = [];
  for (const row of rows) {
    const at = { groupId: row.groupId, sentAt: row.sentAt };
    if (row.speaker === uin) {
      ownRows.push({ ...at, name: row.name, isMedia: row.isMedia === 1 });
      if (row.replyTo !== "" && row.replyTo !== uin) {
        events.push({ ...at, partner: row.replyTo, direction: "out", kind: "replies" });
      }
      for (const target of splitUins(row.ats).filter((item) => item !== uin)) {
        events.push({ ...at, partner: target, direction: "out", kind: "ats" });
      }
    } else if (row.speaker !== "") {
      if (row.replyTo === uin) {
        events.push({ ...at, partner: row.speaker, direction: "back", kind: "replies" });
      }
      if (splitUins(row.ats).includes(uin)) {
        events.push({ ...at, partner: row.speaker, direction: "back", kind: "ats" });
      }
    }
  }
  return { events, own: ownRows.map((row) => row.sentAt), ownRows };
};

const partnersFrom = (events, names) => {
  const byPartner = new Map();
  for (const event of events) {
    const partner = byPartner.get(event.partner) ?? {
      uin: event.partner, name: names.get(event.partner) ?? event.partner, out: { replies: 0, ats: 0 }, back: { replies: 0, ats: 0 }, total: 0,
    };
    partner[event.direction][event.kind] += 1;
    partner.total += 1;
    byPartner.set(event.partner, partner);
  }
  return [...byPartner.values()].sort((left, right) => right.total - left.total || left.uin.localeCompare(right.uin));
};

const trendUnit = (seconds) => {
  if (seconds <= HOURLY_UP_TO_DAYS * DAY_SECONDS) {
    return { unit: "hour", size: HOUR_SECONDS };
  }
  return seconds <= DAILY_UP_TO_DAYS * DAY_SECONDS ? { unit: "day", size: DAY_SECONDS } : { unit: "week", size: WEEK_SECONDS };
};

// Per hour, day or week (by the range's length) from Beijing midnight of the start.
const trendOf = ({ events, own }, partners, { fromUnix, toUnix }) => {
  const origin = beijingDayStart(fromUnix);
  const { unit, size } = trendUnit(toUnix - fromUnix);
  const starts = Array.from({ length: Math.max(1, Math.ceil((toUnix - origin) / size)) }, (_, index) => origin + index * size);
  const bucketOf = (sentAt) => Math.min(starts.length - 1, Math.floor((sentAt - origin) / size));
  const series = partners.slice(0, TREND_SERIES).map((partner) => ({ uin: partner.uin, name: partner.name, values: new Array(starts.length).fill(0) }));
  const byUin = new Map(series.map((line) => [line.uin, line]));
  for (const event of events) {
    const line = byUin.get(event.partner);
    if (line !== undefined) {
      line.values[bucketOf(event.sentAt)] += 1;
    }
  }
  const ownCounts = new Array(starts.length).fill(0);
  for (const sentAt of own) {
    ownCounts[bucketOf(sentAt)] += 1;
  }
  return { unit, starts, series, own: ownCounts };
};

// Second half of the range against the first: who talks with them more, who less.
const changesOf = (events, partners, { fromUnix, toUnix }) => {
  const middle = fromUnix + (toUnix - fromUnix) / 2;
  const halves = new Map(partners.map((partner) => [partner.uin, { uin: partner.uin, name: partner.name, before: 0, after: 0 }]));
  for (const event of events) {
    halves.get(event.partner)[event.sentAt < middle ? "before" : "after"] += 1;
  }
  const all = [...halves.values()];
  return {
    rising: all.filter((item) => item.after > item.before).sort((left, right) => (right.after - right.before) - (left.after - left.before) || right.after - left.after),
    falling: all.filter((item) => item.before > item.after).sort((left, right) => (right.before - right.after) - (left.before - left.after) || right.before - left.before),
  };
};

const otherGroups = (db, groupId, uin, { fromUnix, toUnix }) => db.prepare(`
  SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS name, COUNT(*) AS messages
  FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
  WHERE m.speaker_uin = ? AND m.sent_at >= ? AND m.sent_at < ? AND m.group_id <> ?
  GROUP BY m.group_id
  ORDER BY messages DESC
`).all(uin, fromUnix, toUnix, groupId);

const personProfile = (db, groupId, uin, range) => {
  validate(groupId, uin);
  const id = String(groupId);
  const who = String(uin);
  const found = interactions(db, id, who, range);
  const names = namesFor(db, id, [...new Set([who, ...found.events.map((event) => event.partner)])], range);
  const partners = partnersFrom(found.events, names);
  return {
    groupId: id,
    range,
    person: summary(db, id, who, range, names),
    hours: hours(db, id, who, range),
    partners,
    trend: trendOf(found, partners, range),
    changes: changesOf(found.events, partners, range),
    otherGroups: otherGroups(db, id, who, range),
  };
};

// Newest first; the next page starts before the last item returned. With
// groupId null, from every group (each item says which).
const personMessages = (db, { groupId, uin, fromUnix, toUnix, beforeSentAt, beforeRowId, limit = DEFAULT_PAGE }) => {
  validate(groupId ?? "00000", uin);
  const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(limit) || DEFAULT_PAGE));
  const paging = Number.isFinite(beforeSentAt) && typeof beforeRowId === "string" && beforeRowId !== "";
  const rows = db.prepare(`
    SELECT group_id AS groupId, row_id AS rowId, sent_at AS sentAt, text, is_media AS isMedia, media_kinds AS mediaKinds,
           reply_to_uin AS replyToUin, at_uins AS atUins
    FROM messages
    WHERE ${groupId === null ? "" : "group_id = @groupId AND"} speaker_uin = @uin AND sent_at >= @fromUnix AND sent_at < @toUnix
      ${paging ? "AND (sent_at < @beforeSentAt OR (sent_at = @beforeSentAt AND row_id < @beforeRowId))" : ""}
    ORDER BY sent_at DESC, row_id DESC
    LIMIT @take
  `).all({ ...(groupId === null ? {} : { groupId: String(groupId) }), uin: String(uin), fromUnix, toUnix, take: pageSize + 1, ...(paging ? { beforeSentAt, beforeRowId } : {}) });
  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
};

module.exports = { personProfile, personMessages, interactions, trendOf, changesOf, validate, UIN };
