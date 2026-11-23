"use strict";

// More about one person, for their page (web/person_extras.js): the names
// they used, what they say again and again, what passed between them and the
// reader, and the questions the summaries say they answered. Counting only,
// no AI. groupId null = every group.

const { validate } = require("./group_person");

const PHRASE_MIN_TIMES = 3;
const PHRASE_MIN_CHARS = 2;
const PHRASE_MAX_CHARS = 24;
const PHRASE_LIMIT = 20;
const WITH_ME_RECENT = 8;
const ANSWER_LIMIT = 40;
const TEXT_PREVIEW_CHARS = 160;

const scope = (groupId) => (groupId === null ? "" : "m.group_id = @groupId AND");
const base = ({ groupId, fromUnix, toUnix }) => ({ ...(groupId === null ? {} : { groupId: String(groupId) }), fromUnix, toUnix });

// "(',' || m.at_uins || ',') LIKE '%,123,%'" for each uin, plus the reply column.
const aimedAt = (uins, prefix, params) => uins.flatMap((uin, index) => {
  params[`${prefix}${index}`] = String(uin);
  return [`m.reply_to_uin = @${prefix}${index}`, `(',' || m.at_uins || ',') LIKE '%,' || @${prefix}${index} || ',%'`];
}).join(" OR ");

const spokenBy = (uins, prefix, params) => uins.map((uin, index) => {
  params[`${prefix}${index}`] = String(uin);
  return `@${prefix}${index}`;
}).join(", ");

// Every name the number spoke under in the range, the latest first.
const namesUsed = (db, uin, range) => db.prepare(`
  SELECT m.speaker AS name, COUNT(*) AS messages, MIN(m.sent_at) AS firstAt, MAX(m.sent_at) AS lastAt
  FROM messages m
  WHERE ${scope(range.groupId)} m.speaker_uin = @uin AND m.sent_at >= @fromUnix AND m.sent_at < @toUnix AND m.speaker <> ''
  GROUP BY m.speaker
  ORDER BY lastAt DESC
`).all({ ...base(range), uin });

// Short messages sent word for word at least three times (not picture or
// sticker placeholders, not a bare @).
const phrases = (db, uin, range) => db.prepare(`
  SELECT m.text AS text, COUNT(*) AS times, MAX(m.sent_at) AS lastAt
  FROM messages m
  WHERE ${scope(range.groupId)} m.speaker_uin = @uin AND m.sent_at >= @fromUnix AND m.sent_at < @toUnix
    AND m.is_media = 0 AND length(m.text) BETWEEN ${PHRASE_MIN_CHARS} AND ${PHRASE_MAX_CHARS}
    AND m.text NOT LIKE '[%' AND m.text NOT LIKE '@%' AND m.text NOT GLOB 'nt_[0-9]*'
  GROUP BY m.text
  HAVING times >= ${PHRASE_MIN_TIMES}
  ORDER BY times DESC, lastAt DESC
  LIMIT ${PHRASE_LIMIT}
`).all({ ...base(range), uin });

const clip = (text) => {
  const chars = [...String(text ?? "")];
  return chars.length > TEXT_PREVIEW_CHARS ? `${chars.slice(0, TEXT_PREVIEW_CHARS).join("")}…` : chars.join("");
};

// What passed between the person and the reader: how often each turned to the
// other (a reply or an @), and the latest of those messages.
const withMe = (db, uin, selfUins, range) => {
  if (selfUins.length === 0 || selfUins.includes(uin)) {
    return null;
  }
  const toMeParams = { ...base(range), uin };
  const toMeWhere = `${scope(range.groupId)} m.speaker_uin = @uin AND m.sent_at >= @fromUnix AND m.sent_at < @toUnix AND (${aimedAt(selfUins, "me", toMeParams)})`;
  const fromMeParams = { ...base(range) };
  const mine = spokenBy(selfUins, "me", fromMeParams);
  const fromMeWhere = `${scope(range.groupId)} m.speaker_uin IN (${mine}) AND m.sent_at >= @fromUnix AND m.sent_at < @toUnix AND (${aimedAt([uin], "them", fromMeParams)})`;
  const count = (where, params) => db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params).n;
  const latest = (where, params, direction) => db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.text, m.is_media AS isMedia
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE ${where}
    ORDER BY m.sent_at DESC
    LIMIT ${WITH_ME_RECENT}
  `).all(params).map((row) => ({ ...row, text: clip(row.text), direction }));
  const recent = [...latest(toMeWhere, toMeParams, "toMe"), ...latest(fromMeWhere, fromMeParams, "fromMe")]
    .sort((left, right) => right.sentAt - left.sentAt)
    .slice(0, WITH_ME_RECENT);
  return { toMe: count(toMeWhere, toMeParams), fromMe: count(fromMeWhere, fromMeParams), recent };
};

const splitNames = (value) => String(value ?? "").split(/[/、,，&]+/u).map((part) => part.trim()).filter(Boolean);

// Questions the summaries credit to one of the person's names, newest first.
// The summaries name people by the name shown at the time, so a name shared
// with someone else in the same group cannot be told apart.
const answersGiven = (db, names, range) => {
  if (names.length === 0) {
    return [];
  }
  const known = new Set(names);
  let chunks = [];
  try {
    chunks = db.prepare(`
      SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, m.start_sent_at AS startAt,
             m.end_sent_at AS endAt, m.partial_json AS json
      FROM summary_chunks m LEFT JOIN group_names n ON n.group_id = m.group_id
      WHERE ${scope(range.groupId)} m.status = 'done' AND m.end_sent_at >= @fromUnix AND m.start_sent_at < @toUnix
        AND m.partial_json LIKE '%"answerer"%'
      ORDER BY m.end_sent_at DESC
    `).all(base(range));
  } catch {
    // A store that has never been summarized has no such table.
    return [];
  }
  const found = [];
  for (const chunk of chunks) {
    let partial = null;
    try {
      partial = JSON.parse(chunk.json);
    } catch {
      continue;
    }
    for (const item of partial?.qa ?? []) {
      if (item?.answer && splitNames(item.answerer).some((name) => known.has(name))) {
        found.push({ groupId: chunk.groupId, groupName: chunk.groupName, startAt: chunk.startAt, endAt: chunk.endAt, question: String(item.question ?? ""), answer: String(item.answer) });
        if (found.length >= ANSWER_LIMIT) {
          return found;
        }
      }
    }
  }
  return found;
};

const personExtras = (db, { uin, groupId = null, fromUnix, toUnix, selfUins = [] }) => {
  validate(groupId ?? "00000", uin);
  const who = String(uin);
  const range = { groupId: groupId === null ? null : String(groupId), fromUnix, toUnix };
  const names = namesUsed(db, who, range);
  return {
    uin: who,
    groupId: range.groupId,
    names,
    phrases: phrases(db, who, range),
    withMe: withMe(db, who, selfUins.map(String), range),
    answers: answersGiven(db, names.map((item) => item.name), range),
  };
};

module.exports = { personExtras, PHRASE_MIN_TIMES };
