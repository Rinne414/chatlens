"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const bookmarks = require("../src/bookmark_store");

const openTemp = () => bookmarks.ensureBookmarkSchema(
  messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bookmarks-")), "messages.db")),
);

test("a saved item keeps where it came from; saving it again does not duplicate it", () => {
  const db = openTemp();
  try {
    const item = { kind: "thing", title: "  Wulver  ", body: "福瑞向 K2 微调", link: "https://example.com/w", groupId: "1001", groupName: "示例群", speaker: "小红", sentAt: 1_790_000_000 };
    const id = bookmarks.addBookmark(db, item, 100);
    assert.equal(bookmarks.addBookmark(db, { ...item, body: "更新过的说明" }, 200), id);
    const { total, items } = bookmarks.listBookmarks(db);
    assert.equal(total, 1);
    assert.deepEqual({ ...items[0] }, {
      id, itemKey: "thing|1001|wulver", kind: "thing", title: "Wulver", body: "更新过的说明", link: "https://example.com/w",
      groupId: "1001", groupName: "示例群", speaker: "小红", sentAt: 1_790_000_000, createdAt: 100,
    });
    assert.equal(bookmarks.removeBookmark(db, id), 1);
    assert.equal(bookmarks.listBookmarks(db).total, 0);
  } finally {
    db.close();
  }
});

test("links must be http(s), kinds are checked, and a title is required", () => {
  assert.equal(bookmarks.normalizeBookmark({ kind: "qa", title: "怎么装", link: "javascript:alert(1)" }).link, "");
  assert.throws(() => bookmarks.normalizeBookmark({ kind: "x", title: "t" }), /类型/u);
  assert.throws(() => bookmarks.normalizeBookmark({ kind: "qa", title: "   " }), /标题/u);
});

test("the list filters by when things were saved and by text, newest first, in pages", () => {
  const db = openTemp();
  try {
    bookmarks.addBookmark(db, { kind: "qa", title: "LoRA 不显示", body: "关掉 SFW" }, 100);
    bookmarks.addBookmark(db, { kind: "thing", title: "Anima", body: "新底模" }, 200);
    bookmarks.addBookmark(db, { kind: "topic", title: "炼丹翻车", body: "100% 的 loss" }, 300);
    assert.deepEqual(bookmarks.listBookmarks(db).items.map((item) => item.title), ["炼丹翻车", "Anima", "LoRA 不显示"]);
    assert.deepEqual(bookmarks.listBookmarks(db, { fromUnix: 150, toUnix: 250 }).items.map((item) => item.title), ["Anima"]);
    assert.deepEqual(bookmarks.listBookmarks(db, { query: "sfw" }).items.map((item) => item.title), ["LoRA 不显示"]);
    // LIKE wildcards in the query are literal.
    assert.deepEqual(bookmarks.listBookmarks(db, { query: "100%" }).items.map((item) => item.title), ["炼丹翻车"]);
    const page = bookmarks.listBookmarks(db, { limit: 2, offset: 2 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map((item) => item.title), ["LoRA 不显示"]);
  } finally {
    db.close();
  }
});
