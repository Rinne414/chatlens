"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { ensureBriefingSchema, getState, setState } = require("../src/briefing_store");
const { REPLY_BACKFILL_KEY, backfillStarts, ingestReplies, recordFailedExport } = require("../src/backfill_replies");

const withStore = (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-reply-backfill-"));
  const db = ensureBriefingSchema(messageStore.openStore(path.join(tempDir, "messages.db")));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const message = (rowId, sentAt, fields) => ({
  groupId: "1001", rowId, sentAt, msgSeq: rowId, senderUin: "111", senderName: "Alice", ...fields,
});

test("backfill starts each group at its oldest stored message, skipping groups done or given up", () => {
  withStore((db) => {
    const insert = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text) VALUES (?, ?, ?, 'A', 'x')");
    insert.run("1001", "1", 5000);
    insert.run("1001", "2", 9000);
    insert.run("1002", "3", 7000);
    insert.run("1004", "4", 7000);
    insert.run("1005", "5", 7000);
    setState(db, REPLY_BACKFILL_KEY, { groups: ["1004"], tries: { "1005": 20, "1002": 1 } });
    assert.deepEqual(backfillStarts(db, ["1001", "1002", "1003", "1004", "1005"]), { "1001": 5000, "1002": 7000 });
  });
});

test("a group QQ's copy failed on is tried again next time; one that keeps failing is given up", () => {
  withStore((db) => {
    const exportOf = (incompleteGroups) => ({ groupStarts: { 1001: 1000, 1002: 1000 }, incompleteGroups, messages: [] });
    ingestReplies(db, exportOf(["1002"]), { now: 1 });
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null).groups, ["1001"]);
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null).tries, { 1002: 1 });
    for (let attempt = 2; attempt <= 20; attempt += 1) {
      ingestReplies(db, { ...exportOf(["1002"]), groupStarts: { 1002: 1000 } }, { now: attempt });
    }
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null).tries, { 1002: 20 });
    db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text) VALUES ('1002', '1', 1000, 'A', 'x')").run();
    assert.deepEqual(backfillStarts(db, ["1001", "1002"]), {});
  });
});

test("replies outside the spans the store scanned are left out, so no chat shows only replies", () => {
  withStore((db) => {
    db.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES ('1001', 1000, 3000, 'r')").run();
    const result = ingestReplies(db, {
      messages: [
        message("10", 2000, { msgType1: "9", text: "inside" }),
        message("11", 3000, { msgType1: "9", text: "at the end, outside" }),
        message("12", 5000, { msgType1: "9", text: "never scanned" }),
        { ...message("13", 2000, { msgType1: "9", text: "other group" }), groupId: "1002" },
      ],
    }, { now: 9999 });
    assert.deepEqual(db.prepare("SELECT row_id AS rowId FROM messages").all().map((row) => row.rowId), ["10"]);
    assert.equal(result.replies, 1);
  });
});

test("only reply rows are added, with their reply target, and coverage is left alone", () => {
  withStore((db) => {
    db.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES ('1001', 1000, 9000, 'r')").run();
    const result = ingestReplies(db, {
      groupStarts: { 1001: 1000 },
      incompleteGroups: [],
      messages: [
        message("10", 2000, { msgType1: "9", text: "同意", replyTo: { uin: "222", seq: "9", sentAt: 1900 } }),
        message("11", 2100, { msgType1: "2", text: "not a reply" }),
      ],
      mediaMessages: [{ groupId: "1001", rowId: "12", sentAt: 2200, mediaRefs: [{ kind: "image" }] }],
    }, { now: 9999 });

    const rows = db.prepare("SELECT row_id AS rowId, reply_to_uin AS replyToUin FROM messages").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ rowId: "10", replyToUin: "222" }]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM scan_ranges").get().n, 1);
    assert.equal(result.inserted, 1);
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null), { at: 9999, replies: 1, inserted: 1, lastInserted: 1, groups: ["1001"], tries: {} });
  });
});

test("scanned spans that touch or overlap (one per refresh) are one span", () => {
  withStore((db) => {
    const range = db.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES ('1001', ?, ?, 'r')");
    range.run(2500, 4000);
    range.run(1000, 2000);
    range.run(2000, 3000);
    range.run(6000, 7000);
    ingestReplies(db, {
      messages: [999, 1000, 2000, 3999, 4000, 5000, 6500].map((sentAt) => message(String(sentAt), sentAt, { msgType1: "9", text: "r" })),
    }, { now: 9999 });
    const kept = db.prepare("SELECT sent_at AS sentAt FROM messages ORDER BY sent_at").all().map((row) => row.sentAt);
    assert.deepEqual(kept, [1000, 2000, 3999, 6500]);
  });
});

test("a reply export that failed outright (no file) counts as a try for each of its groups", () => {
  withStore((db) => {
    setState(db, REPLY_BACKFILL_KEY, { groups: ["1003"], tries: { 1002: 3 } });
    recordFailedExport(db, ["1001", "1002"]);
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null).tries, { 1001: 1, 1002: 4 });
    assert.deepEqual(getState(db, REPLY_BACKFILL_KEY, null).groups, ["1003"]);
  });
});
