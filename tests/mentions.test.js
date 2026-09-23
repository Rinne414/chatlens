"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");

const exportOf = (messages) => ({
  groupIds: ["1001"],
  groupNames: { 1001: "画图群" },
  startUnix: 1000,
  endUnix: 9000,
  coveredFromUnix: 1000,
  messages,
  mediaMessages: [],
});

const msg = (rowId, sentAt, fields) => ({
  groupId: "1001",
  rowId: String(rowId),
  msgSeq: String(rowId + 500),
  sentAt,
  senderUin: "222",
  senderName: "Alice",
  text: "hello",
  isSelf: false,
  atUins: [],
  atAll: false,
  replyTo: null,
  ...fields,
});

const openTemp = () => messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qq-mentions-")), "messages.db"));

test("finds @me, replies to my messages, @all and name mentions, never my own lines", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, exportOf([
      msg(1, 1100, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "我今晚发 LoRA" }),
      msg(2, 1200, { text: "@小狐狸 求链接", atUins: ["999"] }),
      msg(3, 1300, { text: "已下载，好用", replyTo: { uin: "999", seq: "501", sentAt: 1100 } }),
      msg(4, 1400, { text: "@全体成员 今晚维护", atAll: true }),
      msg(5, 1500, { text: "小狐狸 的图真不错" }),
      msg(6, 1600, { text: "无关闲聊" }),
      msg(7, 1700, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "小狐狸 自己说话" }),
    ]), "run-1");

    const identity = messageStore.getSelfIdentity(db);
    assert.deepEqual(identity, { uins: ["999"], names: ["小狐狸"] });

    const mentions = messageStore.getMentions(db, { fromUnix: 1000, toUnix: 9000, identity });
    assert.deepEqual(mentions.map((item) => [item.rowId, item.kind]), [["5", "name"], ["4", "atAll"], ["3", "reply"], ["2", "at"]]);
    assert.equal(mentions.find((item) => item.kind === "reply").quotedMine, "我今晚发 LoRA");
    assert.equal(mentions[0].groupName, "画图群");
  } finally {
    db.close();
  }
});

test("re-ingest fills mention columns for rows stored by an older version", () => {
  const db = openTemp();
  try {
    db.prepare(`
      INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, media_kinds, speaker_uin)
      VALUES ('1001', '2', 1200, 'Alice', '@小狐狸 求链接', 0, '', '222')
    `).run();
    const result = messageStore.ingestExport(db, exportOf([msg(2, 1200, { text: "@小狐狸 求链接", atUins: ["999"] })]), "run-2");
    assert.equal(result.inserted, 0);
    const row = db.prepare("SELECT at_uins AS atUins, meta_version AS metaVersion FROM messages WHERE row_id = '2'").get();
    assert.deepEqual(row, { atUins: "999", metaVersion: 1 });

    // A later ingest of the same row with different data must not overwrite it.
    messageStore.ingestExport(db, exportOf([msg(2, 1200, { text: "@小狐狸 求链接", atUins: [] })]), "run-3");
    assert.equal(db.prepare("SELECT at_uins AS atUins FROM messages WHERE row_id = '2'").get().atUins, "999");
  } finally {
    db.close();
  }
});

test("no identity means no mentions", () => {
  const db = openTemp();
  try {
    assert.deepEqual(messageStore.getMentions(db, { fromUnix: 0, toUnix: 10, identity: { uins: [], names: [] } }), []);
  } finally {
    db.close();
  }
});
