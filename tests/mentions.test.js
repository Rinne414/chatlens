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

test("a mention right after I spoke in that group is marked: I was there and likely saw it", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, exportOf([
      msg(1, 1100, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "机器人画一张" }),
      msg(2, 1160, { senderName: "Bot", text: "@小狐狸 画好了", atUins: ["999"] }),
      msg(3, 1100 + 11 * 60, { senderName: "Bot", text: "@小狐狸 还要吗", atUins: ["999"] }),
      msg(4, 5000, { text: "@小狐狸 在吗", atUins: ["999"] }),
    ]), "run-1");
    const identity = messageStore.getSelfIdentity(db);
    const mentions = messageStore.getMentions(db, { fromUnix: 1000, toUnix: 9000, identity });
    assert.deepEqual(mentions.map((item) => [item.rowId, item.youWereThere]), [["4", false], ["3", false], ["2", true]]);
  } finally {
    db.close();
  }
});

test("inbox summary: a never-opened group counts only what came after the floor; the preview is the last text", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, {
      ...exportOf([
        msg(1, 1100, { text: "很早的消息" }),
        msg(2, 3000, { text: "看完之后的第一句" }),
        msg(3, 3100, { text: "最后一句文字" }),
      ]),
      mediaMessages: [{ groupId: "1001", rowId: "4", msgSeq: "504", sentAt: 3200, senderUin: "222", senderName: "Alice", mediaRefs: [{ kind: "image", hash: "a".repeat(32) }] }],
    }, "run-1");
    const [all] = messageStore.getGroupSummaries(db);
    assert.equal(all.unreadCount, 4);
    const [floored] = messageStore.getGroupSummaries(db, { unreadFloor: 2000 });
    assert.equal(floored.unreadCount, 3);
    assert.equal(floored.lastMessage.isMedia, 1);
    assert.deepEqual({ speaker: floored.lastText.speaker, text: floored.lastText.text }, { speaker: "Alice", text: "最后一句文字" });
    // A read mark wins over the floor.
    messageStore.setReadMark(db, "1001", 3000, "2");
    assert.equal(messageStore.getGroupSummaries(db, { unreadFloor: 2000 })[0].unreadCount, 2);
  } finally {
    db.close();
  }
});

test("a reply some minutes after my question is news unless I spoke again after it", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, exportOf([
      msg(1, 1000, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "有人知道怎么装吗？" }),
      msg(2, 1360, { senderName: "Bob", text: "看教程", replyTo: { uin: "999", seq: "501", sentAt: 1000 } }),
      msg(3, 3000, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "再问一个" }),
      msg(4, 3300, { senderName: "Carol", text: "@小狐狸 这个", atUins: ["999"] }),
      msg(5, 3480, { senderUin: "999", senderName: "小狐狸", isSelf: true, text: "谢谢" }),
    ]), "run-1");
    const identity = messageStore.getSelfIdentity(db);
    const mentions = messageStore.getMentions(db, { fromUnix: 900, toUnix: 9000, identity });
    // Row 2: 6 minutes after my question, I said nothing after it -> not seen yet.
    // Row 4: I answered 3 minutes later -> I saw it.
    assert.deepEqual(mentions.map((item) => [item.rowId, item.youWereThere]), [["4", true], ["2", false]]);
  } finally {
    db.close();
  }
});

test("a page of messages says what each reply quotes, and one person's messages can be asked for alone", () => {
  const db = openTemp();
  try {
    messageStore.ingestExport(db, exportOf([
      msg(1, 1100, { text: "谁有这个 LoRA", senderUin: "33333", senderName: "Bob" }),
      msg(2, 1200, { text: "我有，晚点发", replyTo: { uin: "33333", seq: "501", sentAt: 1100 } }),
      msg(3, 1300, { text: "回一条没存到的", replyTo: { uin: "444", seq: "9999", sentAt: 900 } }),
      msg(4, 1400, { text: "x".repeat(300), senderUin: "33333", senderName: "Bob" }),
      msg(5, 1500, { text: "太长了", replyTo: { uin: "33333", seq: "504", sentAt: 1400 } }),
    ]), "run-1");
    const page = messageStore.queryMessages(db, { groupId: "1001", limit: 50 }).messages;
    const quoted = messageStore.repliedMessages(db, "1001", page);
    assert.deepEqual([...quoted.keys()], ["2", "5"]);
    assert.deepEqual({ ...quoted.get("2") }, { rowId: "1", sentAt: 1100, speaker: "Bob", text: "谁有这个 LoRA", isMedia: 0 });
    assert.equal([...quoted.get("5").text].length, 121);
    // A page that starts after the quoted message still finds it.
    const later = messageStore.queryMessages(db, { groupId: "1001", fromUnix: 1150, limit: 50 }).messages;
    assert.equal(messageStore.repliedMessages(db, "1001", later).get("2").rowId, "1");
    assert.equal(messageStore.repliedMessages(db, "1001", page.filter((message) => !message.replyToSeq)).size, 0);

    const bob = messageStore.queryMessages(db, { groupId: "1001", limit: 50, speakerUin: "33333" }).messages;
    assert.deepEqual(bob.map((message) => message.rowId), ["1", "4"]);
    // Not a QQ number: ignored rather than matched against anything.
    assert.equal(messageStore.queryMessages(db, { groupId: "1001", limit: 50, speakerUin: "1 OR 1=1" }).messages.length, 5);
  } finally {
    db.close();
  }
});
