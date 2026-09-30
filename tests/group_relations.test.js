"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { relationMap } = require("../src/group_relations");

const withStore = (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-relations-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

let nextRow = 1;
const insertAll = (db, rows) => {
  const insert = db.prepare(`
    INSERT INTO messages (group_id, row_id, sent_at, speaker, text, speaker_uin, is_self, at_uins, reply_to_uin)
    VALUES (@groupId, @rowId, @sentAt, @speaker, 'x', @uin, @isSelf, @atUins, @replyTo)
  `);
  for (const row of rows) {
    nextRow += 1;
    insert.run({ groupId: "1001", rowId: String(nextRow), sentAt: 2000, isSelf: 0, atUins: "", replyTo: "", ...row });
  }
};

test("counts who replied to and @'d whom, both directions of a pair in one link", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", replyTo: "2" },
      { speaker: "Alice", uin: "1", replyTo: "2" },
      { speaker: "Bob", uin: "2", replyTo: "1" },
      { speaker: "Bob", uin: "2", atUins: "1,3" },
      { speaker: "Carol", uin: "3", isSelf: 1 },
    ]);
    const map = relationMap(db, "1001", { fromUnix: 1000, toUnix: 3000 });

    assert.deepEqual(map.links, [
      { a: "1", b: "2", aToB: { replies: 2, ats: 0 }, bToA: { replies: 1, ats: 1 }, total: 4 },
      { a: "2", b: "3", aToB: { replies: 0, ats: 1 }, bToA: { replies: 0, ats: 0 }, total: 1 },
    ]);
    const byUin = Object.fromEntries(map.people.map((person) => [person.uin, person]));
    assert.deepEqual(byUin["1"], { uin: "1", name: "Alice", messages: 2, isSelf: false, sent: 2, received: 2 });
    assert.deepEqual(byUin["3"], { uin: "3", name: "Carol", messages: 1, isSelf: true, sent: 0, received: 1 });
  });
});

test("someone replied to but silent in the range still appears, named from older messages", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Old Dave", uin: "4", sentAt: 500 },
      { speaker: "Alice", uin: "1", replyTo: "4" },
      { speaker: "Alice", uin: "1", replyTo: "5" },
    ]);
    const map = relationMap(db, "1001", { fromUnix: 1000, toUnix: 3000 });
    const byUin = Object.fromEntries(map.people.map((person) => [person.uin, person]));
    assert.equal(byUin["4"].name, "Old Dave");
    assert.equal(byUin["4"].messages, 0);
    assert.equal(byUin["5"].name, "5");
  });
});

test("replying to yourself, other groups and other dates are not relations", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", replyTo: "1" },
      { speaker: "Alice", uin: "1", replyTo: "2", sentAt: 5000 },
      { speaker: "Alice", uin: "1", replyTo: "2", groupId: "1002" },
    ]);
    assert.deepEqual(relationMap(db, "1001", { fromUnix: 1000, toUnix: 3000 }).links, []);
  });
});

test("each person is named by the name they used last in the range", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Zed old", uin: "1", sentAt: 1500, replyTo: "2" },
      { speaker: "Amy new", uin: "1", sentAt: 2500, replyTo: "2" },
      { speaker: "Bob", uin: "2" },
    ]);
    const map = relationMap(db, "1001", { fromUnix: 1000, toUnix: 3000 });
    assert.equal(map.people.find((person) => person.uin === "1").name, "Amy new");
  });
});
