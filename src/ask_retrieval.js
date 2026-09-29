"use strict";

// 问群聊, step 2: find the chat that can answer a question, locally. Every
// keyword is a LIKE search over the message store; messages matching more
// keywords rank higher; each hit is widened with the messages around it (same
// group) and overlapping windows are merged. The cached chunk summaries add
// "clues" — topics, Q&A and new things that mention a keyword.

const ROW = "CAST(m.row_id AS INTEGER)";
const MAX_KEYWORDS = 8;

const escapeLike = (term) => term.replace(/[\\%_]/gu, (char) => `\\${char}`);
const hitKey = (message) => `${message.groupId}:${message.rowId}`;

const cleanKeywords = (keywords) =>
  [...new Set((Array.isArray(keywords) ? keywords : [])
    .map((keyword) => String(keyword ?? "").trim().toLowerCase())
    .filter((keyword) => keyword.length > 0 && keyword.length <= 40))]
    .slice(0, MAX_KEYWORDS);

const groupFilter = (groupIds) => (groupIds.length > 0 ? `AND m.group_id IN (${groupIds.map(() => "?").join(",")})` : "");

const searchKeyword = (db, keyword, { fromUnix, toUnix, groupIds, limit }) => db.prepare(`
  SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, m.row_id AS rowId,
         m.sent_at AS sentAt, m.speaker, m.text
  FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
  WHERE m.is_media = 0 AND m.text LIKE ? ESCAPE '\\' AND m.sent_at >= ? AND m.sent_at < ? ${groupFilter(groupIds)}
  ORDER BY m.sent_at DESC LIMIT ?
`).all(`%${escapeLike(keyword)}%`, fromUnix, toUnix, ...groupIds, limit);

// Earlier keywords matter more (the planner orders them by importance).
const rankHits = (db, keywords, options) => {
  const hits = new Map();
  keywords.forEach((keyword, index) => {
    const weight = 1 / (1 + index * 0.25);
    for (const message of searchKeyword(db, keyword, options)) {
      const key = hitKey(message);
      const entry = hits.get(key) ?? { message, score: 0, matched: [] };
      hits.set(key, { ...entry, score: entry.score + weight, matched: [...entry.matched, keyword] });
    }
  });
  return [...hits.values()].sort((left, right) => right.score - left.score || right.message.sentAt - left.message.sentAt);
};

const neighbours = (db, message, count, direction) => {
  const before = direction < 0;
  return db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, m.row_id AS rowId,
           m.sent_at AS sentAt, m.speaker, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.group_id = ? AND m.is_media = 0
      AND ${before ? `(m.sent_at < ? OR (m.sent_at = ? AND ${ROW} < CAST(? AS INTEGER)))` : `(m.sent_at > ? OR (m.sent_at = ? AND ${ROW} > CAST(? AS INTEGER)))`}
    ORDER BY m.sent_at ${before ? "DESC" : "ASC"}, ${ROW} ${before ? "DESC" : "ASC"}
    LIMIT ?
  `).all(message.groupId, message.sentAt, message.sentAt, message.rowId, count);
};

const byTime = (left, right) => left.sentAt - right.sentAt || Number(left.rowId) - Number(right.rowId);

// Windows around the best hits until the character budget is used; windows
// that share a message are merged.
const buildWindows = (db, ranked, { maxHits, context, inputChars }) => {
  const taken = new Map();
  let chars = 0;
  let hitsUsed = 0;
  for (const { message } of ranked.slice(0, maxHits)) {
    const window = [...neighbours(db, message, context, -1), message, ...neighbours(db, message, context, 1)];
    const fresh = window.filter((item) => !taken.has(hitKey(item)));
    const size = fresh.reduce((total, item) => total + item.text.length + item.speaker.length + 40, 0);
    if (chars + size > inputChars && hitsUsed > 0) {
      break;
    }
    for (const item of fresh) {
      taken.set(hitKey(item), item);
    }
    chars += size;
    hitsUsed += 1;
  }
  const hitKeys = new Set(ranked.slice(0, hitsUsed).map(({ message }) => hitKey(message)));
  const messages = [...taken.values()]
    .sort((left, right) => left.groupId.localeCompare(right.groupId) || byTime(left, right))
    .map((message, index) => ({ ...message, ref: index + 1, isHit: hitKeys.has(hitKey(message)) }));
  return { messages, hitsUsed, chars };
};

const summaryItems = (partial) => [
  ...(partial.topics ?? []).map((topic) => ({ kind: "topic", title: topic.title, text: [topic.summary, ...(topic.details ?? [])].join(" ") })),
  ...(partial.qa ?? []).map((item) => ({ kind: "qa", title: item.question, text: item.answer ?? "（没人回答）" })),
  ...(partial.newThings ?? []).map((item) => ({ kind: "newThing", title: item.name, text: item.detail })),
];

// Chunk-summary items that mention a keyword, most keywords first.
const summaryClues = (db, keywords, { fromUnix, toUnix, groupIds, limit }) => {
  if (keywords.length === 0) {
    return [];
  }
  const any = keywords.map(() => "c.partial_json LIKE ? ESCAPE '\\'").join(" OR ");
  const groupClause = groupIds.length > 0 ? `AND c.group_id IN (${groupIds.map(() => "?").join(",")})` : "";
  const chunks = db.prepare(`
    SELECT c.group_id AS groupId, COALESCE(NULLIF(n.name, ''), c.group_id) AS groupName, c.start_sent_at AS startSentAt,
           c.partial_json AS partialJson
    FROM summary_chunks c LEFT JOIN group_names n ON n.group_id = c.group_id
    WHERE c.status = 'done' AND c.end_sent_at >= ? AND c.start_sent_at < ? AND (${any}) ${groupClause}
    ORDER BY c.end_sent_at DESC LIMIT 400
  `).all(fromUnix, toUnix, ...keywords.map((keyword) => `%${escapeLike(keyword)}%`), ...groupIds);
  const clues = [];
  for (const chunk of chunks) {
    let partial;
    try {
      partial = JSON.parse(chunk.partialJson);
    } catch {
      continue;
    }
    for (const item of summaryItems(partial)) {
      const haystack = `${item.title} ${item.text}`.toLowerCase();
      const matched = keywords.filter((keyword) => haystack.includes(keyword));
      if (matched.length > 0) {
        clues.push({ ...item, groupName: chunk.groupName, sentAt: chunk.startSentAt, score: matched.length });
      }
    }
  }
  return clues.sort((left, right) => right.score - left.score || right.sentAt - left.sentAt).slice(0, limit);
};

// { messages (with ref numbers), clues, stats } for the answer step.
const findEvidence = (db, { keywords, fromUnix, toUnix, groupIds = [] }, limits) => {
  const terms = cleanKeywords(keywords);
  const scope = { fromUnix, toUnix, groupIds };
  const ranked = terms.length > 0 ? rankHits(db, terms, { ...scope, limit: limits.hitsPerKeyword }) : [];
  const windows = buildWindows(db, ranked, limits);
  return {
    keywords: terms,
    messages: windows.messages,
    clues: summaryClues(db, terms, { ...scope, limit: limits.summaryHits }),
    stats: { matchedMessages: ranked.length, hitsUsed: windows.hitsUsed, contextMessages: windows.messages.length },
  };
};

module.exports = { cleanKeywords, findEvidence };
