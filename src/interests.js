"use strict";

// 「你在意的事」: the reader writes, in a sentence, what they want to hear
// about ("有人分享新的 LoRA 训练教程"); after each refresh the AI is shown the
// groups' newly summarized topics and says which of them is one of those.
// A followed word (关注词) finds the word; this finds the matter, however it
// was worded.
//
// No sentence written, no AI call. What a run could not get to (the daily
// cap, a failed call) is looked at by the next one.

const store = require("./briefing_store");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS interest_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interest_id INTEGER NOT NULL,
    chunk_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    why TEXT NOT NULL DEFAULT '',
    found_at INTEGER NOT NULL,
    UNIQUE (interest_id, chunk_id, title)
  )`,
];

const CURSOR_KEY = "interests_checked_chunk";
const MAX_INTERESTS = 8;
const MIN_CHARS = 4;
const MAX_CHARS = 120;
const ITEMS_PER_CALL = 80;
const MAX_CALLS_PER_RUN = 2;
// Topics older than this when a sentence is written are not gone back over.
const LOOKBACK_SECONDS = 3 * 86400;
const HITS_KEPT_SECONDS = 60 * 86400;
const MAX_TOKENS = 1500;
const SUMMARY_CHARS = 160;

const SYSTEM_PROMPT = "你帮读者从群聊话题里找他在意的事。只在话题确实是在讲那件事时才算命中，沾边、只是提到同一个词的不算；宁可漏掉，不要凑数。输出必须是合法 JSON。";

const ensureInterestSchema = (db) => {
  // The notes it reads and the place it keeps its cursor are the briefing's.
  store.ensureBriefingSchema(db);
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const clip = (value, max) => [...String(value ?? "").replace(/\s+/gu, " ").trim()].slice(0, max).join("");

const listInterests = (db) => ensureInterestSchema(db).prepare("SELECT id, text, created_at AS createdAt FROM interests ORDER BY id").all();

const addInterest = (db, { text, now }) => {
  const sentence = clip(text, MAX_CHARS);
  if ([...sentence].length < MIN_CHARS) {
    throw new Error(`写得再具体一点（至少 ${MIN_CHARS} 个字）：例如「有人分享新的 LoRA 训练教程」。`);
  }
  const existing = listInterests(db);
  if (existing.some((item) => item.text === sentence)) {
    throw new Error("这一条已经有了。");
  }
  if (existing.length >= MAX_INTERESTS) {
    throw new Error(`最多 ${MAX_INTERESTS} 条：每多一条，每次刷新给 AI 看的内容就多一些。先删掉一条不用的。`);
  }
  const id = Number(db.prepare("INSERT INTO interests (text, created_at) VALUES (?, ?)").run(sentence, now).lastInsertRowid);
  // A new sentence is tried on the last few days too: the pass starts again from there.
  const from = db.prepare("SELECT COALESCE(MIN(chunk_id), 0) - 1 AS at FROM summary_chunks WHERE status = 'done' AND end_sent_at >= ?").get(now - LOOKBACK_SECONDS).at;
  store.setState(db, CURSOR_KEY, Math.min(Number(store.getState(db, CURSOR_KEY, 0)) || 0, Math.max(0, from)));
  return { id, text: sentence };
};

const removeInterest = (db, id) => {
  ensureInterestSchema(db);
  db.prepare("DELETE FROM interest_hits WHERE interest_id = ?").run(Number(id));
  return db.prepare("DELETE FROM interests WHERE id = ?").run(Number(id)).changes > 0;
};

// The topics, new things and questions of the chunks summarized since the last pass.
const pendingItems = (db, { nowUnix }) => {
  const cursor = Number(store.getState(db, CURSOR_KEY, 0)) || 0;
  const chunks = db.prepare(`
    SELECT c.chunk_id AS chunkId, c.group_id AS groupId, COALESCE(NULLIF(n.name, ''), c.group_id) AS groupName,
           c.start_sent_at AS sentAt, c.partial_json AS json
    FROM summary_chunks c LEFT JOIN group_names n ON n.group_id = c.group_id
    WHERE c.status = 'done' AND c.chunk_id > ? AND c.end_sent_at >= ?
    ORDER BY c.chunk_id
  `).all(cursor, nowUnix - LOOKBACK_SECONDS);
  const items = [];
  for (const chunk of chunks) {
    let partial = null;
    try {
      partial = JSON.parse(chunk.json);
    } catch {
      continue;
    }
    const add = (title, summary) => {
      if (typeof title === "string" && title.trim() !== "") {
        items.push({ chunkId: chunk.chunkId, groupId: chunk.groupId, groupName: chunk.groupName, sentAt: chunk.sentAt, title: clip(title, 80), summary: clip(summary, SUMMARY_CHARS) });
      }
    };
    (partial?.topics ?? []).forEach((topic) => add(topic?.title, topic?.summary));
    (partial?.newThings ?? []).forEach((thing) => add(thing?.name, thing?.detail));
    (partial?.qa ?? []).forEach((item) => add(item?.question, item?.answer));
  }
  return { items, lastChunk: chunks.length === 0 ? cursor : chunks[chunks.length - 1].chunkId };
};

const buildPrompt = (interests, items) => JSON.stringify({
  interests: interests.map((interest) => ({ id: interest.id, text: interest.text })),
  topics: items.map((item, index) => ({ i: index, g: item.groupName, t: item.title, s: item.summary })),
  task: "对每一条 interests，找出 topics 里确实在讲这件事的条目。一个话题可以命中多条；没有命中的就不要列。why 用一句话说它为什么算（20 字以内）。",
  outputSchema: { hits: [{ interest: 1, topic: 0, why: "string" }] },
});

const validateAnswer = (raw) => {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.hits)) {
    throw new Error("Invalid LLM JSON. Required array is missing: hits");
  }
};

// Whole chunks only, so the cursor can move past exactly what was shown.
const takeBatch = (items) => {
  if (items.length <= ITEMS_PER_CALL) {
    return items;
  }
  const lastWhole = items[ITEMS_PER_CALL].chunkId;
  const batch = items.slice(0, ITEMS_PER_CALL).filter((item) => item.chunkId !== lastWhole);
  return batch.length > 0 ? batch : items.filter((item) => item.chunkId === items[0].chunkId);
};

// gate() returns a reason to stop (pause, daily cap, money budget) or null.
const runInterestPass = async (db, { callLlm, client, gate, nowUnix, shouldFallBack = () => false }) => {
  ensureInterestSchema(db);
  const outcome = { calls: 0, looked: 0, found: 0, failed: 0, stoppedBy: null };
  const interests = listInterests(db);
  if (interests.length === 0) {
    return { ...outcome, stoppedBy: "none" };
  }
  db.prepare("DELETE FROM interest_hits WHERE sent_at < ?").run(nowUnix - HITS_KEPT_SECONDS);
  const known = new Set(interests.map((interest) => interest.id));
  for (;;) {
    const { items, lastChunk } = pendingItems(db, { nowUnix });
    if (items.length === 0) {
      // Chunks without anything to show are behind us as well.
      store.setState(db, CURSOR_KEY, lastChunk);
      break;
    }
    if (outcome.calls >= MAX_CALLS_PER_RUN) {
      outcome.stoppedBy = "run-cap";
      break;
    }
    const blocked = gate();
    if (blocked) {
      outcome.stoppedBy = blocked;
      break;
    }
    const batch = takeBatch(items);
    try {
      const raw = await callLlm(
        client,
        () => ({ system: SYSTEM_PROMPT, user: buildPrompt(interests, batch), maxTokens: MAX_TOKENS, temperature: 0 }),
        { purpose: "interests", messages: batch.length, validate: validateAnswer },
      );
      const insert = db.prepare(`
        INSERT OR IGNORE INTO interest_hits (interest_id, chunk_id, group_id, sent_at, title, summary, why, found_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const hit of raw.hits) {
        const item = batch[Number(hit?.topic)];
        if (item !== undefined && known.has(Number(hit?.interest))) {
          outcome.found += insert.run(Number(hit.interest), item.chunkId, item.groupId, item.sentAt, item.title, item.summary, clip(hit.why, 80), nowUnix).changes;
        }
      }
      store.setState(db, CURSOR_KEY, batch[batch.length - 1].chunkId);
      outcome.calls += 1;
      outcome.looked += batch.length;
    } catch (error) {
      // Nothing is skipped: the same topics are shown again on a later refresh.
      outcome.failed += 1;
      outcome.error = String(error.message).slice(0, 200);
      outcome.stoppedBy = shouldFallBack(error) ? "ai-down" : "failed";
      break;
    }
  }
  return outcome;
};

// For the page: every sentence with what was found for it, the newest first.
const interestsWithHits = (db) => {
  const hits = ensureInterestSchema(db).prepare(`
    SELECT h.id, h.interest_id AS interestId, h.group_id AS groupId, COALESCE(NULLIF(n.name, ''), h.group_id) AS groupName,
           h.sent_at AS sentAt, h.title, h.summary, h.why
    FROM interest_hits h LEFT JOIN group_names n ON n.group_id = h.group_id
    ORDER BY h.sent_at DESC
  `).all();
  return listInterests(db).map((interest) => ({ ...interest, hits: hits.filter((hit) => hit.interestId === interest.id).map(({ interestId, ...hit }) => hit) }));
};

module.exports = { ensureInterestSchema, listInterests, addInterest, removeInterest, runInterestPass, interestsWithHits, MAX_INTERESTS };
