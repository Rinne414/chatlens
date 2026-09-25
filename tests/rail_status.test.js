"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const { railStatus, inboxExtras } = require("../src/rail_status");

const NOW = 1_790_000_000;
const ME = "99999";

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-"));
  const db = briefingStore.ensureBriefingSchema(messageStore.openStore(path.join(dir, "messages.db")));
  try {
    work(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// Group 1: three messages, the reader has read the first; one later message
// @-s me. Group 2: older, one message replying to me before my read mark.
const seed = (db) => {
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('1', '一群'), ('2', '二群')").run();
  const message = db.prepare(`INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text, at_uins, reply_to_uin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  message.run("1", "10", NOW - 300, "A", "1", "hi", "", "");
  message.run("1", "11", NOW - 200, "B", "2", "@me look", ME, "");
  message.run("1", "12", NOW - 100, "C", "3", "ok", "", "");
  message.run("2", "20", NOW - 5000, "D", "4", "reply", "", ME);
  messageStore.setReadMark(db, "1", NOW - 300, "10");
  messageStore.setReadMark(db, "2", NOW - 5000, "20");
  db.prepare("INSERT INTO pictures (group_id, row_id, seq, md5, sent_at, expires_at) VALUES ('1', 'm1', 0, ?, ?, ?)").run("a".repeat(32), NOW - 50, NOW + 86400);
  db.prepare("INSERT INTO picture_files (md5, probe) VALUES (?, 'ai')").run("a".repeat(32));
  db.prepare("INSERT INTO group_briefs (group_id, window_start, chunk_key, summary_json, updated_at) VALUES ('1', 0, 'k', ?, ?)")
    .run(JSON.stringify({ topics: [{ title: "模型" }, { title: "显卡" }], qa: [{ question: "?" }] }), NOW);
};

const identity = { uins: [ME], names: [] };
const watchlist = [{ groupId: "2", name: "" }, { groupId: "1", name: "关注一群" }];

test("unread counts follow read marks and mentions count only direct ones after the mark", () => {
  withStore((db) => {
    seed(db);
    const result = railStatus(db, { watchlist, identity, nowUnix: NOW });
    assert.deepEqual(result.groups.map((group) => [group.groupId, group.name, group.unread, group.mentions]),
      [["1", "关注一群", 2, 1], ["2", "二群", 0, 0]]);
    assert.equal(result.today.aiPictures, 1);
  });
});

test("the inbox extras carry the brief's topics and what is new since the mark", () => {
  withStore((db) => {
    seed(db);
    const extras = inboxExtras(db, { groupIds: ["1", "2"], identity, nowUnix: NOW });
    assert.deepEqual(extras["1"], { topics: ["模型", "显卡"], qa: 1, mentions: 1, newAi: 1 });
    assert.deepEqual(extras["2"], { topics: [], qa: 0, mentions: 0, newAi: 0 });
  });
});

test("without a known identity nobody gets a mention mark", () => {
  withStore((db) => {
    seed(db);
    const result = railStatus(db, { watchlist, identity: { uins: [], names: [] }, nowUnix: NOW });
    assert.ok(result.groups.every((group) => group.mentions === 0));
  });
});
