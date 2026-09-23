"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const messageStore = require("../src/message_store");
const { parseTimeToken } = require("../src/qq_paste");
const { resolvePasteCursor } = require("../src/paste_cursor");
const { formatHkt } = require("../src/unviewed_range");

const START_UNIX = parseTimeToken("2026/8/24 13:45:01");
const MID_UNIX = parseTimeToken("2026/8/24 13:46:10");
const END_UNIX = parseTimeToken("2026/8/24 14:00:00");

const withStore = (fill) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-paste-cursor-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    fill(db);
    return { db, tempDir };
  } catch (error) {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
};

const insert = (db, row) => {
  db.prepare(`
    INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
    VALUES (?, ?, ?, ?, ?, ?, ?, '')
  `).run(row.groupId, row.rowId, row.sentAt, row.speaker, row.text, row.isMedia ?? 0, row.mediaKinds ?? "");
};

test("resolves a desktop paste to an inclusive start and empty end (now)", () => {
  const { db, tempDir } = withStore((store) => {
    store.prepare("INSERT INTO group_names (group_id, name) VALUES (?, ?)").run("1001", "绘星海");
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "1001", rowId: "2", sentAt: MID_UNIX, speaker: "小红", text: "开" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      endPaste: "",
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, true);
    assert.equal(result.startUnix, START_UNIX);
    assert.equal(result.endUnix, null);
    assert.equal(result.startHkt, formatHkt(START_UNIX));
    assert.equal(result.endHkt, "");
    assert.deepEqual(result.groupIds, ["1001"]);
    assert.equal(result.groups[0].name, "绘星海");
    assert.match(result.label, /绘星海/u);
    assert.match(result.label, /现在/u);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("uses the first pasted message as the start when several lines are copied", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "1001", rowId: "2", sentAt: MID_UNIX, speaker: "小红", text: "开" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: [
        "小明 2026/8/24 13:45:01",
        "今晚还开吗",
        "",
        "小红 2026/8/24 13:46:10",
        "开",
      ].join("\n"),
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, true);
    assert.equal(result.startUnix, START_UNIX);
    assert.equal(result.startMessage.speaker, "小明");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("end paste is inclusive: EndTime is that message's second plus one", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "1001", rowId: "2", sentAt: END_UNIX, speaker: "小红", text: "先这样" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      endPaste: "小红 2026/8/24 14:00:00\n先这样\n",
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, true);
    assert.equal(result.endUnix, END_UNIX + 1);
    assert.equal(result.endHkt, formatHkt(END_UNIX + 1));
    assert.equal(result.endMessage.text, "先这样");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("media placeholder without a time is an honest miss", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "m1", sentAt: START_UNIX, speaker: "小红", text: "photo.jpg", isMedia: 1, mediaKinds: "image" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小红：[图片]",
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-time-for-media");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("not-found explains that the local store may not have that window", () => {
  const { db, tempDir } = withStore(() => {});
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-found");
    assert.match(result.error, /本地/u);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ambiguous matches across groups return candidates instead of guessing", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "2002", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      preferredGroupIds: [],
      formatHkt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ambiguous");
    assert.equal(result.candidates.length, 2);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("preferred groupIds break an otherwise ambiguous pair", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "2002", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      preferredGroupIds: ["2002"],
      formatHkt,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.groupIds, ["2002"]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("end earlier than start is refused", () => {
  const { db, tempDir } = withStore((store) => {
    insert(store, { groupId: "1001", rowId: "1", sentAt: START_UNIX, speaker: "小明", text: "今晚还开吗" });
    insert(store, { groupId: "1001", rowId: "2", sentAt: MID_UNIX, speaker: "小红", text: "开" });
  });
  try {
    const result = resolvePasteCursor({
      db,
      startPaste: "小红 2026/8/24 13:46:10\n开\n",
      endPaste: "小明 2026/8/24 13:45:01\n今晚还开吗\n",
      preferredGroupIds: ["1001"],
      formatHkt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "end-before-start");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("empty paste is refused before touching the store", () => {
  const { db, tempDir } = withStore(() => {});
  try {
    const result = resolvePasteCursor({ db, startPaste: "   ", formatHkt });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
