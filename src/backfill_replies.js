"use strict";

// One-time backfill (v0.0.21) of replies. Before it, the export kept only
// msg_type1 2, so every reply to someone (msg_type1 9, a fifth to a third
// of chat on real data) was missing from the store: from chats, summaries, "someone replied to me"
// and the relationship map. The refresh exports only replies over each
// group's stored span (QQ_EXPORT_REPLIES_ONLY) and this script adds the ones
// inside spans the store had scanned, group by group until every group's
// export has completed. Coverage is left alone: a replies-only export does
// not mean the span was fully scanned.
//
//   node src/backfill_replies.js <exportJson> <storeDb>
// Prints one line: backfillResult={...json}

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("./message_store");
const { ensureBriefingSchema, getState, setState } = require("./briefing_store");

const REPLY_BACKFILL_KEY = "reply_messages_backfill_v1";
const REPLY_TYPE = "9";
// QQ writing heavily can make the copy unreadable for a group (the export
// then flags it incomplete); such a group is tried again on later refreshes,
// up to this many times. QQ can stay that busy for an hour or more (seen on
// 2026-09-30: the three busiest groups failed several refreshes in a row),
// so this is about five hours of refreshes.
const MAX_TRIES = 20;

// State: { at, replies, inserted, lastInserted (by the latest run), groups:
// [done group ids], tries: { groupId: failed attempts } }.
const loadState = (db) => getState(db, REPLY_BACKFILL_KEY, null) ?? { replies: 0, inserted: 0, groups: [], tries: {} };

// Oldest stored message of each group still to do; groups done, given up or
// with nothing stored are skipped.
const backfillStarts = (db, groupIds) => {
  const state = loadState(db);
  const done = new Set(state.groups ?? []);
  const stmt = db.prepare("SELECT min(sent_at) AS start FROM messages WHERE group_id = ?");
  const starts = {};
  for (const groupId of groupIds.map(String)) {
    if (done.has(groupId) || (state.tries?.[groupId] ?? 0) >= MAX_TRIES) {
      continue;
    }
    const start = Number(stmt.get(groupId)?.start);
    if (Number.isFinite(start) && start > 0) {
      starts[groupId] = start;
    }
  }
  return starts;
};

// A group's scanned spans, touching and overlapping ones merged, oldest first.
const mergedSpans = (db, groupId) => {
  const spans = [];
  const ranges = db.prepare("SELECT start_unix AS start, end_unix AS end FROM scan_ranges WHERE group_id = ? ORDER BY start_unix").all(groupId);
  for (const range of ranges) {
    const last = spans.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      spans.push({ start: range.start, end: range.end });
    }
  }
  return spans;
};

// Only replies inside a span the store scanned: a stored span with gaps
// (days the app never read) must not turn into chats of nothing but replies.
// Spans are read once per group (a refresh adds one every 15 minutes, so a
// query per reply grew with both) and searched by halving.
const insideScannedSpan = (db) => {
  const spansByGroup = new Map();
  return (message) => {
    const groupId = String(message.groupId);
    if (!spansByGroup.has(groupId)) {
      spansByGroup.set(groupId, mergedSpans(db, groupId));
    }
    const spans = spansByGroup.get(groupId);
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (message.sentAt < spans[middle].start) {
        high = middle - 1;
      } else if (message.sentAt >= spans[middle].end) {
        low = middle + 1;
      } else {
        return true;
      }
    }
    return false;
  };
};

// Replies of an incomplete group are kept too (they are real messages); the
// group itself is only marked done once its export completes.
const ingestReplies = (db, exportData, { now }) => {
  const scanned = insideScannedSpan(db);
  const replies = (exportData.messages ?? [])
    .filter((message) => String(message.msgType1) === REPLY_TYPE && scanned(message));
  const { inserted } = messageStore.ingestExport(db, { messages: replies, mediaMessages: [] }, "reply-backfill");
  const previous = loadState(db);
  const incomplete = new Set((exportData.incompleteGroups ?? []).map(String));
  const exported = Object.keys(exportData.groupStarts ?? {});
  const tries = { ...(previous.tries ?? {}) };
  for (const groupId of exported.filter((id) => incomplete.has(id))) {
    tries[groupId] = (tries[groupId] ?? 0) + 1;
  }
  const completed = exported.filter((id) => !incomplete.has(id));
  for (const groupId of completed) {
    delete tries[groupId];
  }
  const result = {
    at: now,
    replies: (previous.replies ?? 0) + replies.length,
    inserted: (previous.inserted ?? 0) + inserted,
    // Above 0: this refresh's notices skip messages older than each group's
    // window (these old replies), which are not news.
    lastInserted: inserted,
    groups: [...new Set([...(previous.groups ?? []), ...completed])],
    tries,
  };
  setState(db, REPLY_BACKFILL_KEY, result);
  return result;
};

// The replies-only export failed before writing anything (a crash, or too
// big to write): a try for every group it was for, or it would run again on
// every refresh without end.
const recordFailedExport = (db, groupIds) => {
  const state = loadState(db);
  const tries = { ...(state.tries ?? {}) };
  for (const groupId of groupIds.map(String)) {
    tries[groupId] = (tries[groupId] ?? 0) + 1;
  }
  setState(db, REPLY_BACKFILL_KEY, { ...state, tries });
};

const main = () => {
  const [exportJson, storeDb] = process.argv.slice(2);
  if (exportJson === undefined || storeDb === undefined) {
    throw new Error("Usage: node backfill_replies.js <exportJson> <storeDb>");
  }
  const exportData = JSON.parse(fs.readFileSync(exportJson, "utf8"));
  const db = ensureBriefingSchema(messageStore.openStore(path.resolve(storeDb)));
  try {
    const result = ingestReplies(db, exportData, { now: Math.floor(Date.now() / 1000) });
    console.log(`backfillResult=${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
};

if (require.main === module) {
  main();
}

module.exports = { REPLY_BACKFILL_KEY, backfillStarts, ingestReplies, recordFailedExport };
