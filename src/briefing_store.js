"use strict";

// Persistence for the always-ready briefing, inside the message store
// (store/messages.db):
//   summary_chunks — consecutive slices of one group's text messages. A closed
//                    chunk never changes, so its LLM "map" result is cached
//                    forever and every message is summarized exactly once.
//   group_briefs   — per-group merged summary for the current briefing window
//                    (cache key = the exact set of chunks that fed it).
//   app_state      — small key/value facts (briefing window start, LLM budget).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS summary_chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    start_sent_at INTEGER NOT NULL,
    end_sent_at INTEGER NOT NULL,
    first_row_id TEXT NOT NULL,
    last_row_id TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    partial_json TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    summarized_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS idx_summary_chunks_group ON summary_chunks(group_id, end_sent_at)",
  "CREATE INDEX IF NOT EXISTS idx_summary_chunks_status ON summary_chunks(status)",
  `CREATE TABLE IF NOT EXISTS group_briefs (
    group_id TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    chunk_key TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

const MAX_CHUNK_ATTEMPTS = 3;

const ensureBriefingSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const getState = (db, key, fallback = null) => {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
  if (row === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
};

const setState = (db, key, value) => {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
};

// Text rows' row_id is QQ's global insert counter stored as TEXT; compare it
// numerically, or "9999999" > "10000000" would skip a message at every
// digit-count rollover when two messages share a sent_at second.
const ROW_NUMBER = "CAST(m.row_id AS INTEGER)";

// End of the newest chunk: new chunks start strictly after it.
const lastChunkBoundary = (db, groupId) =>
  db.prepare(`
    SELECT end_sent_at AS sentAt, last_row_id AS rowId FROM summary_chunks
    WHERE group_id = ? ORDER BY end_sent_at DESC, chunk_id DESC LIMIT 1
  `).get(String(groupId)) ?? null;

// Text messages not yet in any chunk, oldest first.
const pendingMessages = (db, groupId, { after, fromUnix, limit = 5000 }) => {
  const params = { groupId: String(groupId), fromUnix, limit };
  let keyset = "";
  if (after !== null && after.sentAt >= fromUnix) {
    keyset = `AND (m.sent_at > @afterSentAt OR (m.sent_at = @afterSentAt AND ${ROW_NUMBER} > CAST(@afterRowId AS INTEGER)))`;
    params.afterSentAt = after.sentAt;
    params.afterRowId = after.rowId;
  }
  return db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.speaker, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.group_id = @groupId AND m.is_media = 0 AND m.sent_at >= @fromUnix ${keyset}
    ORDER BY m.sent_at ASC, ${ROW_NUMBER} ASC
    LIMIT @limit
  `).all(params);
};

const insertChunk = (db, chunk) =>
  db.prepare(`
    INSERT INTO summary_chunks (group_id, start_sent_at, end_sent_at, first_row_id, last_row_id, message_count, created_at)
    VALUES (@groupId, @startSentAt, @endSentAt, @firstRowId, @lastRowId, @messageCount, @createdAt)
  `).run(chunk).lastInsertRowid;

const chunksToSummarize = (db, limit) =>
  db.prepare(`
    SELECT chunk_id AS chunkId, group_id AS groupId, start_sent_at AS startSentAt, end_sent_at AS endSentAt,
           first_row_id AS firstRowId, last_row_id AS lastRowId, message_count AS messageCount, attempts
    FROM summary_chunks
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ${MAX_CHUNK_ATTEMPTS})
    ORDER BY end_sent_at DESC
    LIMIT ?
  `).all(limit);

const chunkMessages = (db, chunk) =>
  db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
           m.speaker, m.text
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.group_id = @groupId AND m.is_media = 0
      AND (m.sent_at > @startSentAt OR (m.sent_at = @startSentAt AND ${ROW_NUMBER} >= CAST(@firstRowId AS INTEGER)))
      AND (m.sent_at < @endSentAt OR (m.sent_at = @endSentAt AND ${ROW_NUMBER} <= CAST(@lastRowId AS INTEGER)))
    ORDER BY m.sent_at ASC, ${ROW_NUMBER} ASC
  `).all(chunk);

const saveChunkResult = (db, chunkId, { partial, error }) => {
  if (partial !== undefined && partial !== null) {
    db.prepare(`
      UPDATE summary_chunks SET status = 'done', partial_json = ?, error = NULL, attempts = attempts + 1, summarized_at = ?
      WHERE chunk_id = ?
    `).run(JSON.stringify(partial), Math.floor(Date.now() / 1000), chunkId);
    return;
  }
  db.prepare("UPDATE summary_chunks SET status = 'failed', error = ?, attempts = attempts + 1 WHERE chunk_id = ?")
    .run(String(error ?? "unknown error").slice(0, 500), chunkId);
};

// Summarized chunks that overlap the briefing window, oldest first.
const doneChunksInWindow = (db, groupId, fromUnix) =>
  db.prepare(`
    SELECT chunk_id AS chunkId, start_sent_at AS startSentAt, end_sent_at AS endSentAt,
           message_count AS messageCount, partial_json AS partialJson
    FROM summary_chunks
    WHERE group_id = ? AND status = 'done' AND end_sent_at >= ?
    ORDER BY end_sent_at ASC, chunk_id ASC
  `).all(String(groupId), fromUnix);

const chunkStatsInWindow = (db, fromUnix) =>
  db.prepare(`
    SELECT group_id AS groupId,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status = 'pending' OR (status = 'failed' AND attempts < ${MAX_CHUNK_ATTEMPTS}) THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'failed' AND attempts >= ${MAX_CHUNK_ATTEMPTS} THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'done' THEN message_count ELSE 0 END) AS summarizedMessages
    FROM summary_chunks WHERE end_sent_at >= ? GROUP BY group_id
  `).all(fromUnix);

const getGroupBrief = (db, groupId) => {
  const row = db.prepare("SELECT window_start AS windowStart, chunk_key AS chunkKey, summary_json AS summaryJson, updated_at AS updatedAt FROM group_briefs WHERE group_id = ?")
    .get(String(groupId));
  if (row === undefined) {
    return null;
  }
  try {
    return { ...row, summary: JSON.parse(row.summaryJson) };
  } catch {
    return null;
  }
};

const saveGroupBrief = (db, groupId, { windowStart, chunkKey, summary }) => {
  db.prepare(`
    INSERT INTO group_briefs (group_id, window_start, chunk_key, summary_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET window_start = excluded.window_start, chunk_key = excluded.chunk_key,
      summary_json = excluded.summary_json, updated_at = excluded.updated_at
  `).run(String(groupId), windowStart, chunkKey, JSON.stringify(summary), Math.floor(Date.now() / 1000));
};

const deleteGroupBrief = (db, groupId) => {
  db.prepare("DELETE FROM group_briefs WHERE group_id = ?").run(String(groupId));
};

module.exports = {
  MAX_CHUNK_ATTEMPTS,
  ensureBriefingSchema,
  getState,
  setState,
  lastChunkBoundary,
  pendingMessages,
  insertChunk,
  chunksToSummarize,
  chunkMessages,
  saveChunkResult,
  doneChunksInWindow,
  chunkStatsInWindow,
  getGroupBrief,
  saveGroupBrief,
  deleteGroupBrief,
};
