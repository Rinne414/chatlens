"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");

test("coverage timeline separates scan coverage from useful activity details", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-timeline-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const insertRange = db.prepare(
      "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
    );
    insertRange.run("1001", 100000, 101200, "run-a");
    insertRange.run("1001", 100800, 102000, "run-b");
    insertRange.run("1002", 100500, 101500, "run-c");
    insertRange.run("1003", 100000, 102000, "run-d");

    const insertMessage = db.prepare(`
      INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `);
    insertMessage.run("1001", "1", 100100, "Alice", "first", 0, "");
    insertMessage.run("1001", "2", 100800, "Alice", "follow up", 0, "");
    insertMessage.run("1001", "4", 100900, "Bob", "latest", 0, "");
    insertMessage.run("1001", "3", 101100, "Carol", "image caption", 1, "image");
    db.prepare("INSERT INTO group_names (group_id, name) VALUES (?, ?)").run("1001", "Test group");

    const groups = messageStore.getCoverageTimeline(db, ["1001", "1002", "1003"], 100000, 102000, 1000);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].name, "Test group");
    assert.deepEqual(groups[0].slots.map((slot) => slot.coverageRatio), [1, 1]);
    assert.equal(groups[0].slots[0].messageCount, 3);
    assert.equal(groups[0].slots[0].textCount, 3);
    assert.equal(groups[0].slots[0].mediaCount, 0);
    assert.equal(groups[0].slots[0].speakerCount, 2);
    assert.deepEqual(groups[0].slots[0].topSpeakers, [
      { speaker: "Alice", messageCount: 2 },
      { speaker: "Bob", messageCount: 1 },
    ]);
    assert.equal(groups[0].slots[0].firstMessageUnix, 100100);
    assert.equal(groups[0].slots[0].lastMessageUnix, 100900);
    assert.equal(groups[0].slots[0].busiestHourStartUnix, 100000);
    assert.equal(groups[0].slots[0].busiestHourMessageCount, 3);
    assert.equal(groups[0].slots[1].mediaCount, 1);
    assert.equal(groups[0].slots[1].textCount, 0);
    assert.deepEqual(groups[1].slots.map((slot) => slot.coverageRatio), [0.5, 0.5]);
    assert.equal(groups[1].slots[0].coverageStartUnix, 100500);
    assert.equal(groups[1].slots[0].coverageEndUnix, 101000);
    assert.equal(groups[1].slots[0].coverageSegmentCount, 1);
    assert.deepEqual(groups[1].slots[0].coverageSegments, [{ startUnix: 100500, endUnix: 101000 }]);
    assert.equal(groups[1].slots[0].messageCount, 0);
    assert.deepEqual(groups[1].slots[0].topSpeakers, []);
    assert.deepEqual(groups[2].slots.map((slot) => slot.coverageRatio), [1, 1]);
    assert.deepEqual(groups[2].slots.map((slot) => slot.messageCount), [0, 0]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("coverage health returns exact gaps and groups identical rescan batches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-gaps-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const insertRange = db.prepare(
      "INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, ?)",
    );
    insertRange.run("1001", 100000, 100500, "run-a");
    insertRange.run("1001", 100700, 101000, "run-b");
    insertRange.run("1002", 100000, 100500, "run-a");
    insertRange.run("1002", 100700, 101000, "run-b");
    insertRange.run("1003", 100200, 101000, "run-c");

    const health = messageStore.getCoverageHealth(db, ["1001", "1002", "1003"], 100000, 101000);

    assert.equal(health.coveredSeconds, 2400);
    assert.equal(health.totalSeconds, 3000);
    assert.equal(health.coverageRatio, 0.8);
    assert.equal(health.missingSeconds, 600);
    assert.equal(health.affectedGroupCount, 3);
    assert.equal(health.earliestGapUnix, 100000);
    assert.deepEqual(health.gaps, [
      { groupId: "1001", startUnix: 100500, endUnix: 100700 },
      { groupId: "1002", startUnix: 100500, endUnix: 100700 },
      { groupId: "1003", startUnix: 100000, endUnix: 100200 },
    ]);
    assert.deepEqual(health.batches, [
      { groupIds: ["1003"], startUnix: 100000, endUnix: 100200 },
      { groupIds: ["1001", "1002"], startUnix: 100500, endUnix: 100700 },
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("message ingestion keeps old history instead of applying a retention cutoff", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-permanent-store-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));

  try {
    const result = messageStore.ingestExport(db, {
      groupIds: ["1001"],
      groupNames: { "1001": "Archive group" },
      startUnix: 1,
      endUnix: 10,
      coveredFromUnix: 1,
      messages: [{
        groupId: "1001",
        rowId: "1",
        sentAt: 2,
        senderName: "Alice",
        senderUin: "2001",
        text: "permanent history",
      }],
      mediaMessages: [],
    }, "archive-run");

    assert.equal(result.inserted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
    assert.deepEqual(messageStore.getCoverage(db, "1001"), [{ startUnix: 1, endUnix: 10 }]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ingest records per-group coverage when groupStarts is present", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-group-starts-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1", "2"],
      groupNames: { 1: "A", 2: "B" },
      startUnix: 100,
      endUnix: 500,
      coveredFromUnix: 100,
      groupStarts: { 1: 100, 2: 400 },
      messages: [],
      mediaMessages: [],
    }, "split-run");

    assert.deepEqual(messageStore.getCoverage(db, "1"), [{ startUnix: 100, endUnix: 500 }]);
    assert.deepEqual(messageStore.getCoverage(db, "2"), [{ startUnix: 400, endUnix: 500 }]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a group whose export stopped early (corrupt page while QQ writes) gets no coverage, so the next refresh reads it again", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-incomplete-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1", "2"],
      groupNames: { 1: "A", 2: "B" },
      startUnix: 100,
      endUnix: 500,
      coveredFromUnix: null,
      groupStarts: { 1: 100, 2: 400 },
      incompleteGroups: ["2"],
      messages: [{ groupId: "2", rowId: "9", sentAt: 480, senderName: "Bob", text: "read before the corrupt page" }],
      mediaMessages: [],
    }, "stopped-run");

    assert.deepEqual(messageStore.getCoverage(db, "1"), [{ startUnix: 100, endUnix: 500 }]);
    assert.deepEqual(messageStore.getCoverage(db, "2"), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = '2'").get().n, 1, "what was read is kept");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("without per-group starts (a manual run), the groups that completed are covered even when another stopped early", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-manual-incomplete-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1", "2"],
      startUnix: 100,
      endUnix: 500,
      coveredFromUnix: null,
      incompleteGroups: ["2"],
      groupReadFrom: { 2: 300 },
      messages: [],
      mediaMessages: [],
    }, "manual-run");
    assert.deepEqual(messageStore.getCoverage(db, "1"), [{ startUnix: 100, endUnix: 500 }]);
    assert.deepEqual(messageStore.getCoverage(db, "2"), [{ startUnix: 301, endUnix: 500 }]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the refresh resumes each group where its first unbroken coverage (inside the look-back) ends, so a gap is read again", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-resume-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    const range = db.prepare("INSERT INTO scan_ranges (group_id, start_unix, end_unix, run_id) VALUES (?, ?, ?, 'r')");
    range.run("1", 200, 300);
    range.run("1", 100, 200);
    range.run("2", 100, 200);
    range.run("2", 250, 300);
    range.run("3", 10, 50);
    range.run("3", 100, 300);
    range.run("4", 40, 120);
    range.run("4", 150, 300);
    range.run("5", 10, 40);

    assert.deepEqual({ ...messageStore.getCoverageResume(db, 60) }, { 1: 300, 2: 200, 3: 300, 4: 120 });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a group that stopped early is covered from the oldest second it read (newest first) up", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-read-from-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1", "2", "3"],
      startUnix: 100,
      endUnix: 500,
      coveredFromUnix: null,
      groupStarts: { 1: 100, 2: 100, 3: 100 },
      incompleteGroups: ["1", "2", "3"],
      // 1 stopped inside the window; 2 read past its start (the bad page was
      // older than the window); 3 read nothing.
      groupReadFrom: { 1: 450, 2: 60 },
      messages: [],
      mediaMessages: [],
    }, "partial-run");

    assert.deepEqual(messageStore.getCoverage(db, "1"), [{ startUnix: 451, endUnix: 500 }], "the oldest second may be half read");
    assert.deepEqual(messageStore.getCoverage(db, "2"), [{ startUnix: 100, endUnix: 500 }]);
    assert.deepEqual(messageStore.getCoverage(db, "3"), []);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("advanceLocalReadMarks moves each group's cursor to its newest stored message", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-advance-read-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      groupIds: ["1"],
      groupNames: { 1: "A" },
      startUnix: 10,
      endUnix: 50,
      coveredFromUnix: 10,
      messages: [
        { groupId: "1", rowId: "1", sentAt: 20, senderName: "A", senderUin: "1", text: "old" },
        { groupId: "1", rowId: "2", sentAt: 40, senderName: "A", senderUin: "1", text: "new" },
      ],
      mediaMessages: [],
    }, "read-run");
    messageStore.setReadMark(db, "1", 20, "1");
    const result = messageStore.advanceLocalReadMarks(db, ["1", "9"]);
    assert.equal(result.advanced, 1);
    const mark = messageStore.getReadMark(db, "1");
    assert.equal(mark.sentAt, 40);
    assert.equal(mark.rowId, "2");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
