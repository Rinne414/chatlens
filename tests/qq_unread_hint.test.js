"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const { extractUnreadRows, hintForWatchlist } = require("../src/qq_unread_hint");

const openTemp = (build) => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "unread-")), "recent.db");
  const db = new Database(filePath);
  build(db);
  return db;
};

test("reads unread counts from a named unread_count column", () => {
  const db = openTemp((handle) => {
    handle.prepare(`
      CREATE TABLE recent_contact_table (
        peer_uin TEXT,
        chat_type INTEGER,
        unread_count INTEGER
      )
    `).run();
    handle.prepare("INSERT INTO recent_contact_table VALUES (?, ?, ?)").run("900001", 2, 17);
    handle.prepare("INSERT INTO recent_contact_table VALUES (?, ?, ?)").run("111", 1, 3);
  });

  const rows = extractUnreadRows(db);
  db.close();

  const group = rows.find((row) => row.peerId === "900001");
  assert.equal(group.unreadCount, 17);
  assert.equal(group.chatType, "group");
});

test("ignores tables that have no unread-like column", () => {
  const db = openTemp((handle) => {
    handle.prepare("CREATE TABLE group_msg_table (id INTEGER, body BLOB)").run();
    handle.prepare("INSERT INTO group_msg_table VALUES (1, x'00')").run();
  });

  assert.deepEqual(extractUnreadRows(db), []);
  db.close();
});

test("reads QQ NT recent_contact_v3 numbered columns", () => {
  const db = openTemp((handle) => {
    handle.prepare(`
      CREATE TABLE recent_contact_v3_table (
        "40010" INTEGER,
        "40021" TEXT,
        "40005" INTEGER
      )
    `).run();
    handle.prepare(`INSERT INTO recent_contact_v3_table ("40010", "40021", "40005") VALUES (?, ?, ?)`).run(2, "900001", 12);
    handle.prepare(`INSERT INTO recent_contact_v3_table ("40010", "40021", "40005") VALUES (?, ?, ?)`).run(2, "999", 0);
  });

  const rows = extractUnreadRows(db);
  db.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].peerId, "900001");
  assert.equal(rows[0].unreadCount, 12);
  assert.equal(rows[0].chatType, "group");
});

test("hintForWatchlist only reports watchlist groups and never claims to be a cursor", () => {
  const hint = hintForWatchlist(
    [
      { peerId: "1", unreadCount: 4, chatType: "group" },
      { peerId: "9", unreadCount: 99, chatType: "group" },
    ],
    [{ groupId: "1", name: "测试群甲" }],
  );

  assert.equal(hint.available, true);
  assert.equal(hint.totalUnread, 4);
  assert.equal(hint.groups.length, 1);
  assert.equal(hint.groups[0].name, "测试群甲");
  assert.match(hint.disclaimer, /红点/u);
});
