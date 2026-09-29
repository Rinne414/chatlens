"use strict";

// 关注词: words the user follows across every group (a model, an artist, a
// tool, the name of their own work). The briefing lists where each was said
// in its window, newest first; the full history is one click away in 回顾.

const { namePattern } = require("./trends");

const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 40;
// Per word the briefing carries the newest hits; 回顾 search pages through all.
const LATEST_PER_WORD = 20;

// Trimmed, non-empty, at most MAX_WORD_LENGTH characters, each word once
// (case-insensitive), in the order given.
const normalizeWords = (words) => {
  if (!Array.isArray(words)) {
    throw new Error("关注词应为列表。");
  }
  const seen = new Set();
  const result = [];
  for (const raw of words) {
    const word = String(raw ?? "").trim().replace(/\s+/gu, " ");
    if (word === "") {
      continue;
    }
    // One character ("的", "a") would match most of the window.
    if ([...word].length < 2) {
      throw new Error(`关注词至少 2 个字：${word}`);
    }
    if ([...word].length > MAX_WORD_LENGTH) {
      throw new Error(`关注词太长（最多 ${MAX_WORD_LENGTH} 个字）：${word.slice(0, MAX_WORD_LENGTH)}…`);
    }
    if (namePattern(word) === null) {
      throw new Error(`关注词至少要有一个字母、数字或汉字：${word}`);
    }
    const key = word.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(word);
    }
  }
  if (result.length > MAX_WORDS) {
    throw new Error(`关注词最多 ${MAX_WORDS} 个。`);
  }
  return result;
};

const escapeLike = (value) => String(value).replace(/[\\%_]/gu, (match) => `\\${match}`);

// The LIKE prefilter uses the word's longest letter/digit run; the exact
// pattern (whole Latin words, any spacing between parts) decides.
const prefilterOf = (word) =>
  (String(word).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).reduce((longest, part) => (part.length > longest.length ? part : longest), "");

// Where each word was said by someone else between fromUnix and toUnix:
// [{ word, total, groups: [{ groupId, groupName, count }], latest: [...] }].
const wordHits = (db, { fromUnix, toUnix, words }) => {
  const select = db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.speaker, m.speaker_uin AS speakerUin, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    -- "+is_self": keeps SQLite on the time index (see message_store.getMentions).
    WHERE m.is_media = 0 AND +m.is_self = 0 AND m.sent_at >= ? AND m.sent_at < ? AND m.text LIKE ? ESCAPE '\\'
    ORDER BY m.sent_at DESC, CAST(m.row_id AS INTEGER) DESC
  `);
  return words.map((word) => {
    const pattern = namePattern(word);
    const rows = select.all(fromUnix, toUnix, `%${escapeLike(prefilterOf(word))}%`)
      .filter((row) => pattern.test(row.text));
    const groups = new Map();
    for (const row of rows) {
      const entry = groups.get(row.groupId) ?? { groupId: row.groupId, groupName: row.groupName, count: 0 };
      groups.set(row.groupId, { ...entry, count: entry.count + 1 });
    }
    return {
      word,
      total: rows.length,
      groups: [...groups.values()].sort((left, right) => right.count - left.count),
      latest: rows.slice(0, LATEST_PER_WORD),
    };
  });
};

module.exports = { MAX_WORDS, LATEST_PER_WORD, normalizeWords, wordHits };
