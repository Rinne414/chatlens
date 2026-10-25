"use strict";

// 笔记库: one note rewritten without touching what the user wrote
// (src/vault_note_io.js).

const assert = require("node:assert/strict");
const test = require("node:test");

const { splitNote, readList, readFlag, composeNote, inlineText, safeFileName, userSectionOf } = require("../src/vault_note_io");

const heading = "## 我的笔记";

test("a rewrite replaces ChatLens's keys and body, keeps the user's keys and their section", () => {
  const existing = [
    "---",
    "chatlens: \"thing:a\"",
    "mentions: 3",
    "rating: 5",
    "tags:",
    "  - 我的标签",
    "---",
    "旧的正文",
    "",
    "## 我的笔记",
    "我自己写的。",
    "",
  ].join("\n");

  const text = composeNote({ managed: [["chatlens", "thing:a"], ["mentions", 9]], body: "新的正文", heading, existingText: existing });

  assert.match(text, /mentions: 9/u);
  assert.doesNotMatch(text, /mentions: 3/u);
  assert.match(text, /rating: 5\ntags:\n {2}- 我的标签/u);
  assert.match(text, /新的正文/u);
  assert.doesNotMatch(text, /旧的正文/u);
  assert.ok(text.endsWith("## 我的笔记\n我自己写的。\n"));
});

test("a new note gets an empty 我的笔记 section; a Traditional heading is recognised too", () => {
  const text = composeNote({ managed: [["type", "事物"]], body: "正文", heading, existingText: null });
  assert.ok(text.endsWith("## 我的笔记\n"));
  assert.equal(userSectionOf("x\n## 我的筆記\n寫的\n"), "## 我的筆記\n寫的\n");
  assert.equal(userSectionOf("x\n### 我的笔记 不是\n"), null);
});

test("lists are read in the forms Obsidian and people write", () => {
  const { blocks } = splitNote("---\naliases:\n  - Krea 2\n  - \"k:2\"\nother: [a, 'b c', \"d\"]\none: solo\nignore: true\n---\n");

  assert.deepEqual(readList(blocks, "aliases"), ["Krea 2", "k:2"]);
  assert.deepEqual(readList(blocks, "other"), ["a", "b c", "d"]);
  assert.deepEqual(readList(blocks, "one"), ["solo"]);
  assert.equal(readList(blocks, "missing"), null);
  assert.equal(readFlag(blocks, "ignore"), true);
});

test("written values that YAML would misread are quoted", () => {
  const text = composeNote({ managed: [["a", "true"], ["b", "[[ChatLens/群/x|x]]"], ["c", "12"], ["d", "Krea2"], ["e", ["x: y"]]], body: "", heading });

  assert.match(text, /a: "true"/u);
  assert.match(text, /b: "\[\[ChatLens\/群\/x\|x\]\]"/u);
  assert.match(text, /c: "12"/u);
  assert.match(text, /d: Krea2/u);
  assert.match(text, /e:\n {2}- "x: y"/u);
});

test("chat text cannot become tags, links, math, comments or html", () => {
  assert.equal(inlineText("#tag [[x]] $5 %%c%% <b>\nnext"), "\\#tag \\[\\[x\\]\\] \\$5 \\%\\%c\\%\\% \\<b\\> next");
});

test("file names lose what Windows or Obsidian refuse and stay short", () => {
  assert.equal(safeFileName("[gpt跑图] a/b: c?"), "gpt跑图- a-b- c");
  assert.equal(safeFileName("   "), "未命名");
  assert.equal([...safeFileName("长".repeat(200))].length, 80);
});
