"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { REMOTE_LIFETIME_SECONDS } = require("../src/picture_store");
const lateRows = require("../src/late_rows");

const SENT_AT = 1_700_000_000;
const MD5 = "cd".repeat(16);

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "late-rows-"));
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const text = (rowId, value) => ({ groupId: "7", rowId, sentAt: SENT_AT, senderName: "Ann", senderUin: "42", text: value });
const media = (rowId, pictures) => ({ groupId: "7", rowId, sentAt: SENT_AT, senderName: "Ann", senderUin: "42", mediaRefs: [], pictures });
const picture = (seq) => ({ md5: MD5, fileId: "fid", size: 10, width: 1, height: 1, format: 1000, expiresAt: SENT_AT + 9, seq });

test("a late re-read keeps only messages and pictures the store does not have, and records no coverage", () => {
  withStore((db) => {
    messageStore.ingestExport(db, { groupIds: ["7"], startUnix: SENT_AT - 60, endUnix: SENT_AT + 60, messages: [text("1", "hello")], mediaMessages: [media("2", [picture(0)])] }, "run-1");
    const reread = {
      groupIds: ["7"],
      startUnix: SENT_AT - 3600,
      endUnix: SENT_AT + 60,
      messages: [text("1", "hello"), text("3", "written late")],
      mediaMessages: [media("2", [picture(0)]), media("4", [picture(0)]), media("5", [picture(0), picture(2000)])],
    };
    messageStore.ingestExport(db, { messages: [], mediaMessages: [media("5", [picture(0)])] }, "run-2");

    const part = lateRows.unstoredPart(db, reread);

    assert.deepEqual(part.messages.map((message) => message.rowId), ["3"]);
    assert.deepEqual(part.mediaMessages.map((message) => message.rowId), ["4", "5"]);
    assert.deepEqual(part.groupIds, []);
    const ranges = () => db.prepare("SELECT COUNT(*) AS n FROM scan_ranges").get().n;
    const before = ranges();
    messageStore.ingestExport(db, part, "late-1");
    assert.equal(ranges(), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pictures WHERE row_id = 'm5'").get().n, 2);
    assert.equal(db.prepare("SELECT text FROM messages WHERE row_id = '3'").get().text, "written late");
  });
});

test("the one-time re-read walks back from the late window to 31 days in slices, then stops", () => {
  const now = SENT_AT;
  const first = lateRows.recoverySlice(null, now);
  assert.equal(first.toUnix, now - lateRows.LATE_REREAD_SECONDS);
  assert.equal(first.fromUnix, first.toUnix - lateRows.RECOVERY_SLICE_SECONDS);

  let saved = null;
  let slices = 0;
  for (let slice = lateRows.recoverySlice(saved, now); slice !== null; slice = lateRows.recoverySlice(saved, now)) {
    assert.ok(slice.fromUnix < slice.toUnix);
    assert.ok(slice.fromUnix >= now - REMOTE_LIFETIME_SECONDS);
    saved = lateRows.recoveryStateAfter(slice, now);
    slices += 1;
    assert.ok(slices < 50, "never ends");
  }
  assert.deepEqual(saved, { done: true, at: now });
  assert.equal(slices, Math.ceil((REMOTE_LIFETIME_SECONDS - lateRows.LATE_REREAD_SECONDS) / lateRows.RECOVERY_SLICE_SECONDS));
  assert.equal(lateRows.recoverySlice(saved, now + 86400), null);
  // A week later the 31 days are read again, from the newest slice.
  const later = now + lateRows.RECOVERY_REPEAT_SECONDS;
  assert.deepEqual(lateRows.recoverySlice(saved, later), {
    fromUnix: later - lateRows.LATE_REREAD_SECONDS - lateRows.RECOVERY_SLICE_SECONDS,
    toUnix: later - lateRows.LATE_REREAD_SECONDS,
  });
});

test("a message with no text is never counted as missing (the store never keeps it)", () => {
  withStore((db) => {
    const part = lateRows.unstoredPart(db, { messages: [text("7", ""), text("8", " \u0007 "), text("9", "hi")], mediaMessages: [] });
    assert.deepEqual(part.messages.map((message) => message.rowId), ["9"]);
  });
});

test("a slice some group could not be read through is tried again, then given up on", () => {
  const now = SENT_AT;
  const slice = lateRows.recoverySlice(null, now);
  let saved = null;
  for (let attempt = 1; attempt < lateRows.RECOVERY_TRIES; attempt += 1) {
    saved = lateRows.recoveryStateAfter(slice, now, { complete: false, saved });
    assert.deepEqual(lateRows.recoverySlice(saved, now), slice, `attempt ${attempt} reads the same slice again`);
  }
  saved = lateRows.recoveryStateAfter(slice, now, { complete: false, saved });
  assert.deepEqual(saved, { cursor: slice.fromUnix });
  assert.equal(lateRows.recoveryStateAfter(slice, now, { complete: true, saved: { cursor: slice.toUnix, tries: 1 } }).tries, undefined);
});
