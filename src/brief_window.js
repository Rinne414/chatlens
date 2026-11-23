"use strict";

// Where the briefing starts. "auto": an hour after the briefing was last
// looked at, it starts where that look had got to, so the next time it is
// opened it holds only what came since (and the refresh in between has
// already put the new one together). "manual": it starts
// where 「看完了」 was last pressed. The start replaced last is kept, so one
// step back is always possible.

const store = require("./briefing_store");

const SINCE_KEY = "briefing_since";
const MODE_KEY = "briefing_window_mode";
const VISIT_KEY = "briefing_visit";
const PREVIOUS_KEY = "briefing_since_previous";

const MODES = ["auto", "manual"];
// Opening the briefing again sooner than this is the same sitting.
const SAME_VISIT_SECONDS = 3600;
// Messages not summarized yet when the briefing was read come round again.
// Older than this they are never summarized (the engine's own lookback), so
// they no longer hold the start in place.
const CARRY_OVER_SECONDS = 7 * 86400;

const modeOf = (db) => {
  const mode = store.getState(db, MODE_KEY, "auto");
  return MODES.includes(mode) ? mode : "auto";
};

const sinceOf = (db) => {
  const value = Number(store.getState(db, SINCE_KEY, null));
  return Number.isFinite(value) && value > 0 ? value : null;
};

const previousOf = (db) => {
  const value = Number(store.getState(db, PREVIOUS_KEY, null));
  return Number.isFinite(value) && value > 0 ? value : null;
};

// Up to where a briefing read at `now` has covered the followed groups: the
// newest stored message (when messages have not come in for a while, what
// arrives next still belongs to the next briefing), or the oldest message
// still waiting for its summary.
const coveredUntil = (db, { groupIds, since, now, summarizing }) => {
  const newest = db.prepare("SELECT MAX(sent_at) AS at FROM messages").get().at;
  const stored = Math.max(since ?? 0, Math.min(now, newest ?? now));
  if (!summarizing) {
    return stored;
  }
  const floor = Math.max(since ?? 0, now - CARRY_OVER_SECONDS);
  const oldest = groupIds.reduce((soFar, groupId) => {
    const boundary = store.lastChunkBoundary(db, groupId);
    const from = Math.max(floor, boundary === null ? 0 : boundary.sentAt + 1);
    const loose = db.prepare("SELECT MIN(sent_at) AS at FROM messages WHERE group_id = ? AND is_media = 0 AND sent_at >= ?")
      .get(String(groupId), from).at;
    const queued = db.prepare(`
      SELECT MIN(start_sent_at) AS at FROM summary_chunks
      WHERE group_id = ? AND end_sent_at >= ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?))
    `).get(String(groupId), floor, store.MAX_CHUNK_ATTEMPTS).at;
    return Math.min(soFar, loose ?? now, queued ?? now);
  }, now);
  return Math.max(floor, Math.min(stored, oldest));
};

const windowInfo = (db) => ({ mode: modeOf(db), previousStart: previousOf(db) });

// The groups' summaries belong to one start. The ones being left are put
// aside, and the ones put aside for the start being returned to come back, so
// 「回到上一份」 shows its summaries at once instead of asking the AI again.
const KEPT_BRIEFS = `CREATE TABLE IF NOT EXISTS group_briefs_kept (
  group_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  chunk_key TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const BRIEF_COLUMNS = "group_id, window_start, chunk_key, summary_json, updated_at";

const swapBriefs = (db, value) => {
  db.prepare(KEPT_BRIEFS).run();
  const returning = db.prepare(`SELECT ${BRIEF_COLUMNS} FROM group_briefs_kept WHERE window_start = ?`).all(value);
  db.prepare("DELETE FROM group_briefs_kept").run();
  db.prepare(`INSERT INTO group_briefs_kept (${BRIEF_COLUMNS}) SELECT ${BRIEF_COLUMNS} FROM group_briefs`).run();
  const put = db.prepare(`INSERT OR REPLACE INTO group_briefs (${BRIEF_COLUMNS}) VALUES (@group_id, @window_start, @chunk_key, @summary_json, @updated_at)`);
  for (const row of returning) {
    put.run(row);
  }
};

const moveStart = (db, value) => {
  db.transaction(() => {
    const since = sinceOf(db);
    if (since === value) {
      return;
    }
    if (since !== null) {
      store.setState(db, PREVIOUS_KEY, since);
    }
    swapBriefs(db, value);
    store.setState(db, SINCE_KEY, value);
  }).immediate();
};

// On 自动 and an hour after the last look: the start moves to where that look
// had got to. Called by every refresh and by every look. Returns whether it moved.
// The page's server and the refresh are two processes: check and move in one
// write transaction, so a 「看完了」 in between is not undone.
const settle = (db, { now }) => db.transaction(() => {
  const last = store.getState(db, VISIT_KEY, null);
  if (modeOf(db) !== "auto" || last === null || !Number.isFinite(Number(last.at)) || now - Number(last.at) < SAME_VISIT_SECONDS) {
    return false;
  }
  const target = Math.min(Number(last.until) || 0, now);
  if (target <= (sinceOf(db) ?? 0)) {
    return false;
  }
  moveStart(db, target);
  return true;
}).immediate();

const recordLook = (db, { now, groupIds, summarizing }) => {
  store.setState(db, VISIT_KEY, { at: now, until: coveredUntil(db, { groupIds, since: sinceOf(db), now, summarizing }) });
};

// The briefing is being looked at (opened, come back to, or still on screen).
// Returns whether the start moved.
const visit = (db, { now, groupIds, summarizing }) => {
  const moved = settle(db, { now });
  recordLook(db, { now, groupIds, summarizing });
  return moved;
};

// 「看完了」: everything up to `value` is behind the reader, in either mode.
const markSeen = (db, { value, now }) => {
  moveStart(db, value);
  store.setState(db, VISIT_KEY, { at: now, until: value });
};

// 「回到上一份」: the start goes back one step and the two swap, so the same
// button leads forward again.
// This sitting then reads the older briefing (the next one starts after
// it): the caller records the look.
const restorePrevious = (db) => {
  const previous = previousOf(db);
  if (previous === null) {
    return false;
  }
  moveStart(db, previous);
  return true;
};

// Switching to auto counts from this sitting, not from an old one: the caller
// records the look.
const setMode = (db, mode) => {
  if (!MODES.includes(mode)) {
    throw new Error("mode must be auto or manual");
  }
  store.setState(db, MODE_KEY, mode);
};

module.exports = { visit, settle, recordLook, markSeen, restorePrevious, setMode, windowInfo, coveredUntil, modeOf, SAME_VISIT_SECONDS, CARRY_OVER_SECONDS };
