"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");
const messageStore = require("../src/message_store");
const knowledgeStore = require("../src/knowledge_store");
const gallery = require("../src/gallery_store");

const md5 = (seed) => seed.repeat(32).slice(0, 32);
const A = md5("a");
const B = md5("b");
const S = md5("c");
const NOW = 1_790_000_000;

// Two groups; picture A posted first in group 1 by Alice, then reposted in
// group 2 by Bob; picture B only in group 1; S is a sticker.
const seed = (db) => {
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('1', '一群'), ('2', '二群')").run();
  const message = db.prepare(`INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text, is_media)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const picture = db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker)
    VALUES (?, ?, 0, ?, ?, ?, 1000, 1001, ?, ?, ?)`);
  message.run("1", "m1", NOW - 3000, "Alice", "10001", "", 1);
  picture.run("1", "m1", A, 800, 1200, NOW - 3000, NOW + 86400 * 20, 0);
  message.run("1", "t1", NOW - 2990, "Carol", "10003", "好看", 0);
  message.run("2", "m2", NOW - 1000, "Bob", "10002", "", 1);
  picture.run("2", "m2", A, 800, 1200, NOW - 1000, NOW + 86400 * 25, 0);
  message.run("1", "m3", NOW - 500, "Bob", "10002", "", 1);
  picture.run("1", "m3", B, 1024, 1024, NOW - 500, NOW + 86400 * 30, 0);
  message.run("1", "m4", NOW - 100, "Alice", "10001", "", 1);
  picture.run("1", "m4", S, 200, 200, NOW - 100, NOW + 86400 * 30, 1);
  db.prepare("INSERT INTO picture_files (md5, thumb, probe, kept) VALUES (?, 'a.png', 'ai', 0), (?, 'b.png', '', 1)").run(A, B);
};

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-"));
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    seed(db);
    work(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const range = { fromUnix: NOW - 86400, toUnix: NOW + 60 };

test("one tile per picture, newest posting first, with its spread", () => {
  withStore((db) => {
    const page = gallery.listPictures(db, range);
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((item) => item.md5), [B, A]);
    const first = page.items[1];
    assert.equal(first.groups, 2);
    assert.equal(first.posts, 2);
    assert.equal(first.origin.speaker, "Alice");
    assert.equal(first.shown.speaker, "Bob");
    assert.equal(first.ai, true);
    assert.equal(first.hasThumb, true);
  });
});

test("stickers are their own kind", () => {
  withStore((db) => {
    assert.deepEqual(gallery.listPictures(db, { ...range, kind: "stickers" }).items.map((item) => item.md5), [S]);
    assert.equal(gallery.listPictures(db, { ...range, kind: "all" }).total, 3);
  });
});

test("filters by group and by sender, and the tile shows the matching posting", () => {
  withStore((db) => {
    const inGroup1 = gallery.listPictures(db, { ...range, groupId: "1" });
    assert.equal(inGroup1.items.find((item) => item.md5 === A).shown.speaker, "Alice");
    const byBob = gallery.listPictures(db, { ...range, sender: "10002" });
    assert.deepEqual(byBob.items.map((item) => item.md5), [B, A]);
  });
});

test("spread sort puts the most travelled picture first", () => {
  withStore((db) => {
    assert.equal(gallery.listPictures(db, { ...range, sort: "spread" }).items[0].md5, A);
  });
});

test("the AI filter uses the picture probe", () => {
  withStore((db) => {
    assert.deepEqual(gallery.listPictures(db, { ...range, ai: true }).items.map((item) => item.md5), [A]);
  });
});

test("an attached knowledge library marks its AI pictures too", () => {
  withStore((db, dir) => {
    const kbPath = path.join(dir, "knowledge.db");
    const kb = knowledgeStore.openKnowledgeStore(kbPath);
    kb.prepare(`INSERT INTO images (hash, generator, prompt, checkpoint, parsed_at) VALUES (?, 'comfyui', '1girl', 'anima', 1)`).run(B);
    kb.close();
    const reader = new Database(path.join(dir, "messages.db"), { readonly: true });
    reader.prepare("ATTACH DATABASE ? AS kb").run(kbPath);
    const page = gallery.listPictures(reader, { ...range, ai: true });
    reader.close();
    const itemB = page.items.find((item) => item.md5 === B);
    assert.equal(itemB.generator, "comfyui");
    assert.equal(itemB.inLibrary, true);
  });
});

test("facets count each dimension without its own selection", () => {
  withStore((db) => {
    const facets = gallery.galleryFacets(db, { ...range, groupId: "2" });
    assert.deepEqual(facets.kinds, { images: 1, stickers: 0 });
    assert.deepEqual(facets.groups.map((row) => [row.value, row.count]), [["1", 2], ["2", 1]]);
    assert.equal(facets.spread, 1);
  });
});

test("detail lists every posting oldest first; context surrounds the posting", () => {
  withStore((db) => {
    const detail = gallery.pictureDetail(db, A);
    assert.deepEqual(detail.occurrences.map((item) => item.groupName), ["一群", "二群"]);
    const context = gallery.messageContext(db, { groupId: "1", rowId: "m1", sentAt: NOW - 3000 });
    assert.deepEqual(context.messages.map((message) => message.rowId), ["m1", "t1", "m3", "m4"]);
    assert.equal(gallery.pictureDetail(db, md5("d")), null);
  });
});

test("rejects an invalid range, kind or md5", () => {
  withStore((db) => {
    assert.throws(() => gallery.listPictures(db, { fromUnix: 10, toUnix: 5 }), /时间范围/u);
    assert.throws(() => gallery.listPictures(db, { ...range, kind: "videos" }), /未知的类型/u);
    assert.throws(() => gallery.pictureDetail(db, "../etc"), /图片编号/u);
  });
});

test("search matches the text sent with a picture, who posted it, a file name, and the prompt library", () => {
  withStore((db, dir) => {
    db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text, is_media) VALUES ('1', '3', ?, 'Bob', '10002', '新出的 Anima 立绘', 0)").run(NOW - 500);
    db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker, file_name)
      VALUES ('1', 'm5', 2000, ?, 2752, 2144, 9616710, 1001, ?, ?, 0, 'Moss_00008_.png')`).run(md5("e"), NOW - 50, NOW + 86400);
    const kbPath = path.join(dir, "knowledge.db");
    const kb = knowledgeStore.openKnowledgeStore(kbPath);
    kb.prepare(`INSERT INTO images (hash, generator, prompt, checkpoint, parsed_at) VALUES (?, 'comfyui', 'silver hair, maid', 'anima', 1)`).run(A);
    kb.prepare("INSERT INTO prompt_requests (group_id, ask_row_id, image_hash) VALUES ('1', 't9', ?)").run(A);
    kb.close();
    const reader = new Database(path.join(dir, "messages.db"), { readonly: true });
    reader.prepare("ATTACH DATABASE ? AS kb").run(kbPath);
    const found = (options) => gallery.listPictures(reader, { ...range, ...options }).items.map((item) => item.md5);
    try {
      assert.deepEqual(found({ q: "anima 立绘" }), [B]);
      assert.deepEqual(found({ q: "MAID" }), [A]);
      assert.deepEqual(found({ q: "alice" }), [A]);
      assert.deepEqual(found({ q: "moss" }), [md5("e")]);
      assert.deepEqual(found({ q: "100%" }), []);
      assert.deepEqual(found({ prompt: true }), [A]);
      assert.deepEqual(found({ asked: true }), [A]);
      assert.deepEqual(found({ file: true }), [md5("e")]);
      assert.equal(gallery.listPictures(reader, { ...range, file: true }).items[0].fileName, "Moss_00008_.png");
      // A switch adds to the others: with 有咒语 on, file counts files that have a prompt.
      assert.deepEqual(gallery.galleryFacets(reader, { ...range, prompt: true }).extras, { prompt: 1, asked: 1, file: 0 });
      assert.deepEqual(gallery.galleryFacets(reader, range).extras, { prompt: 1, asked: 1, file: 1 });
    } finally {
      reader.close();
    }
  });
});

test("shape and size buckets filter and count without their own selection", () => {
  withStore((db) => {
    db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker)
      VALUES ('1', 'm6', 0, ?, 1080, 2400, 900000, 1000, ?, ?, 0)`).run(md5("f"), NOW - 40, NOW + 86400);
    const found = (options) => gallery.listPictures(db, { ...range, ...options }).items.map((item) => item.md5);
    assert.deepEqual(found({ shape: "tall" }), [A]);
    assert.deepEqual(found({ shape: "square" }), [B]);
    assert.deepEqual(found({ shape: "long" }), [md5("f")]);
    assert.deepEqual(found({ size: "large" }), [md5("f"), B, A]);
    assert.deepEqual(found({ size: "small" }), []);
    assert.deepEqual(found({ kind: "stickers", size: "small" }), [S]);
    const facets = gallery.galleryFacets(db, { ...range, shape: "long" });
    assert.deepEqual(facets.shapes, { wide: 0, square: 1, tall: 1, long: 1 });
    assert.deepEqual(facets.sizes, { large: 1, medium: 0, small: 0 });
    assert.throws(() => gallery.listPictures(db, { ...range, shape: "round" }), /未知的形状/u);
  });
});
