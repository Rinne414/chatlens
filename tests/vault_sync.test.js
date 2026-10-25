"use strict";

// 笔记库 (Obsidian): the whole sync on a small store and a temp vault
// (src/vault_sync.js) -- what it writes, and that the user's own edits,
// deletions and decisions survive the next sync.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const messageStore = require("../src/message_store");
const { ensureBriefingSchema } = require("../src/briefing_store");
const { hktToUnix } = require("../src/review_store");
const { ensureTopicSchema } = require("../src/things_topics");
const { syncNotes, restoreDeleted } = require("../src/vault_sync");

const NOW = hktToUnix("2026-10-25 12:00");

const addChunk = (db, { groupId, at, partial, messages = 10 }) => {
  db.prepare(`
    INSERT INTO summary_chunks (group_id, start_sent_at, end_sent_at, first_row_id, last_row_id, message_count, status, partial_json, created_at, summarized_at)
    VALUES (?, ?, ?, '1', '2', ?, 'done', ?, ?, ?)
  `).run(groupId, hktToUnix(at), hktToUnix(at) + 600, messages, JSON.stringify(partial), NOW, NOW);
};

const thingItem = (name, extra = {}) => ({ kind: "model", name, detail: `${name} 的说明`, speaker: "甲", link: null, ...extra });

// What the AI pass would have stored: topics and where each name key goes.
const placeTopics = (db, topics, places) => {
  ensureTopicSchema(db);
  for (const [key, topic] of Object.entries(topics)) {
    db.prepare("INSERT OR REPLACE INTO kb_topics (topic_key, name, category, what, model, made_at) VALUES (?, ?, ?, ?, 'fake', 1)")
      .run(key, topic.name, topic.category, topic.what ?? "");
  }
  for (const [key, [topicKey, role, what = ""]] of Object.entries(places)) {
    db.prepare("INSERT OR REPLACE INTO kb_topic_members (thing_key, topic_key, role, what, model, checked_at) VALUES (?, ?, ?, ?, 'fake', 1)")
      .run(key, topicKey, role, what);
  }
};

const KREA = { krea: { name: "Krea", category: "image", what: "Krea 的图像模型" } };
const KREA_PLACES = { krea2: ["krea", "main"], k2: ["krea", "version", "Krea2 的简称版"], krea2动漫lora: ["krea", "derived", "动漫画风 LoRA"] };

const setup = (t, { topics = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlens-notes-"));
  const vault = path.join(dir, "vault");
  const storeDir = path.join(dir, "store");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(storeDir);
  const db = ensureBriefingSchema(messageStore.openStore(path.join(storeDir, "messages.db")));
  // The store first: Windows cannot delete an open database.
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('100001', '甲群'), ('100002', '乙群'), ('100003', '丙群')").run();
  const message = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media) VALUES (?, ?, ?, '甲', '消息', 0)");
  message.run("100001", "1", hktToUnix("2026-10-24 10:00"));
  message.run("100002", "2", hktToUnix("2026-10-24 11:00"));
  addChunk(db, { groupId: "100001", at: "2026-10-24 10:00", partial: {
    newThings: [
      thingItem("Krea2", { link: "https://github.com/krea/krea2" }),
      thingItem("k2"),
      thingItem("Krea2 动漫 LoRA", { kind: "resource", link: "https://civitai.com/models/11" }),
      thingItem("一次性的梗", { kind: "other", link: "https://example.com/meme" }),
    ],
    qa: [{ question: "Krea2 显存要多少？", answer: "大约 24G", resolved: true, hkt: "2026-10-24 10:01" }],
    timeline: [{ start: "2026-10-24 10:00", end: "2026-10-24 10:10", title: "聊模型", summary: "大家在试 Krea2" }],
  } });
  addChunk(db, { groupId: "100002", at: "2026-10-24 11:00", partial: {
    newThings: [thingItem("krea2"), thingItem("k2")],
    timeline: [{ start: "2026-10-24 11:00", end: "2026-10-24 11:05", title: "也聊模型", summary: "#话题 $5 <b>" }],
  } });
  // A third stretch: a topic gets a note once it comes up 3+ times over 2+ groups.
  addChunk(db, { groupId: "100002", at: "2026-10-24 11:30", partial: { newThings: [thingItem("krea2")] } });
  if (topics) {
    placeTopics(db, KREA, { ...KREA_PLACES, 一次性的梗: ["", "other"] });
  }
  const config = { notes: { enabled: true, vaultPath: vault, folder: "ChatLens", language: "zh-Hans" } };
  const sync = (overrides = {}, extra = {}) => syncNotes({ db, config: { ...extra, notes: { ...config.notes, ...overrides } }, storeDir, nowUnix: NOW, serverUrl: "http://127.0.0.1:8321/" });
  return { db, vault, storeDir, config, sync, root: path.join(vault, "ChatLens") };
};

const read = (root, relPath) => fs.readFileSync(path.join(root, relPath), "utf8");

test("the first sync writes a note per topic, day and group, an overview and a table view", (t) => {
  const { sync, root } = setup(t);

  const result = sync();

  assert.equal(result.topics, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "主题")), ["Krea.md"]);
  assert.ok(fs.existsSync(path.join(root, "日报", "2026-10-24.md")));
  assert.ok(fs.existsSync(path.join(root, "群", "甲群.md")));
  assert.ok(fs.existsSync(path.join(root, "ChatLens 总览.md")));
  assert.ok(fs.existsSync(path.join(root, "主题.base")));
  const krea = read(root, "主题/Krea.md");
  assert.match(krea, /type: 主题/u);
  assert.match(krea, /category: 图像模型/u);
  assert.match(krea, /summary: Krea 的图像模型/u);
  assert.match(krea, /aliases:\n {2}- Krea2/u);
  assert.match(krea, /items: 2/u);
  assert.match(krea, /mentions: 6/u);
  assert.match(krea, /group_count: 2/u);
  // The things under the topic, each with what it is and its link.
  assert.match(krea, /## 版本（1）\n- \*\*k2\*\* — Krea2 的简称版 · 2 个群 · 2 次/u);
  assert.match(krea, /## LoRA 和微调（1）\n- \*\*Krea2 动漫 LoRA\*\* — 动漫画风 LoRA · 1 个群 · 1 次 · 2026-10-24 · \[civitai\.com\/models\/11\]/u);
  assert.match(krea, /\[github\.com\/krea\/krea2\]\(https:\/\/github\.com\/krea\/krea2\)/u);
  assert.match(krea, /显存要多少/u);
  // The console's URL ends in "/": the link must not become 8321//?chat=.
  assert.match(krea, /\(http:\/\/127\.0\.0\.1:8321\/\?chat=100001&at=\d+\)/u);
  const day = read(root, "日报/2026-10-24.md");
  assert.match(day, /\[\[ChatLens\/主题\/Krea\|Krea\]\] · 图像模型 · 2 个群 · \*\*第一次出现\*\*/u);
  // A thing in no topic is listed in the day, not given a note of its own.
  assert.match(day, /## 零散提到（1）\n- \*\*一次性的梗\*\* · 其他/u);
  assert.match(day, /\\#话题 \\\$5 \\<b\\>/u);
  assert.match(read(root, "群/甲群.md"), /\[\[ChatLens\/主题\/Krea\|Krea\]\] · 图像模型 · 在这个群 3 次/u);
  assert.match(read(root, "ChatLens 总览.md"), /1 个主题/u);
});

test("a second sync with nothing new writes nothing", (t) => {
  const { sync } = setup(t);
  sync();

  const second = sync();

  assert.equal(second.written, 0);
  assert.ok(second.same > 0);
});

test("until the AI has placed the things once, the notes are not rearranged", (t) => {
  const { sync, root } = setup(t, { topics: false });
  const aiConfig = { llm: { baseUrl: "https://example.invalid/v1", model: "m", apiKeyEnv: "CHATLENS_TEST_NOTES_KEY" } };
  process.env.CHATLENS_TEST_NOTES_KEY = "x";
  t.after(() => delete process.env.CHATLENS_TEST_NOTES_KEY);

  const waiting = sync({}, aiConfig);

  assert.equal(waiting.skipped, "topics-pending");
  assert.equal(waiting.placed, 0);
  assert.equal(fs.existsSync(root), false);
  // Without AI for the notes there is nothing to wait for.
  assert.equal(sync({ consensus: false }, aiConfig).skipped, undefined);
});

test("what the user writes under 我的笔记 and their own properties survive a sync", (t) => {
  const { sync, root } = setup(t);
  sync();
  const file = path.join(root, "主题", "Krea.md");
  const edited = fs.readFileSync(file, "utf8").replace("---\n>", "rating: 5\n---\n>").replace(/## 我的笔记\n$/u, "## 我的笔记\n跑过，很好用。\n");
  fs.writeFileSync(file, edited);

  sync();

  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /rating: 5/u);
  assert.ok(after.endsWith("## 我的笔记\n跑过，很好用。\n"));
});

test("a renamed note is still found and updated in place", (t) => {
  const { sync, root, db } = setup(t);
  sync();
  fs.renameSync(path.join(root, "主题", "Krea.md"), path.join(root, "主题", "我的 Krea.md"));
  addChunk(db, { groupId: "100001", at: "2026-10-24 12:00", partial: { newThings: [thingItem("Krea2")] } });

  sync();

  assert.equal(fs.existsSync(path.join(root, "主题", "Krea.md")), false);
  assert.match(read(root, "主题/我的 Krea.md"), /mentions: 7/u);
});

test("a note the user deleted is not brought back until they ask", (t) => {
  const { sync, root, config, storeDir } = setup(t);
  sync();
  fs.rmSync(path.join(root, "主题", "Krea.md"));

  const second = sync();
  assert.equal(fs.existsSync(path.join(root, "主题", "Krea.md")), false);
  assert.equal(second.deleted, 1);

  restoreDeleted({ config, storeDir });
  sync();
  assert.ok(fs.existsSync(path.join(root, "主题", "Krea.md")));
});

test("a name the user adds to a topic's aliases is put under that topic, whatever the AI said", (t) => {
  const { sync, root, db } = setup(t);
  ["12:00", "13:00"].forEach((time) => addChunk(db, { groupId: "100001", at: `2026-10-24 ${time}`, partial: { newThings: [thingItem("KreaX")] } }));
  placeTopics(db, {}, { kreax: ["", "other"] });
  sync();
  assert.doesNotMatch(read(root, "主题/Krea.md"), /KreaX/u);
  const file = path.join(root, "主题", "Krea.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aliases:\n  - Krea2\n", "aliases:\n  - Krea2\n  - KreaX\n"));

  sync();
  sync();

  const after = read(root, "主题/Krea.md");
  assert.match(after, /mentions: 8/u);
  assert.match(after, /aliases:\n {2}- Krea2\n {2}- KreaX\n/u);
});

test("ignore: true freezes a note, and a note without the 我的笔记 heading is the user's", (t) => {
  const { sync, root, db } = setup(t);
  sync();
  const krea = path.join(root, "主题", "Krea.md");
  const day = path.join(root, "日报", "2026-10-24.md");
  fs.writeFileSync(krea, fs.readFileSync(krea, "utf8").replace("---\n>", "ignore: true\n---\n>"));
  fs.writeFileSync(day, "完全是我自己的笔记\n");
  const frozen = fs.readFileSync(krea, "utf8");
  addChunk(db, { groupId: "100001", at: "2026-10-24 13:00", partial: { newThings: [thingItem("Krea2"), thingItem("k2")] } });

  const result = sync();

  assert.equal(fs.readFileSync(krea, "utf8"), frozen);
  assert.equal(fs.readFileSync(day, "utf8"), "完全是我自己的笔记\n");
  assert.equal(result.ignored, 1);
});

test("a Traditional vault gets converted prose and folder names, group names as they are", (t) => {
  const { sync, vault } = setup(t);

  sync({ language: "zh-Hant", folder: "群聊" });

  const root = path.join(vault, "群聊");
  assert.ok(fs.existsSync(path.join(root, "日報", "2026-10-24.md")));
  const krea = fs.readFileSync(path.join(root, "主題", "Krea.md"), "utf8");
  assert.match(krea, /顯存要多少/u);
  assert.match(krea, /category: 圖像模型/u);
  assert.match(krea, /\[\[群聊\/群\/甲群\|甲群\]\]/u);
});

test("nothing is written outside the folder, and a missing vault is a plain error", (t) => {
  const { sync, vault } = setup(t);

  assert.throws(() => sync({ folder: "../escape" }), /一层文件夹/u);
  assert.throws(() => sync({ vaultPath: path.join(vault, "missing") }), /找不到笔记库文件夹/u);
  assert.deepEqual(sync({ enabled: false }), { skipped: "off" });
});

test("a file of the user's own where a new note would go is never overwritten", (t) => {
  const { sync, root } = setup(t);
  fs.mkdirSync(path.join(root, "主题"), { recursive: true });
  fs.writeFileSync(path.join(root, "主题", "Krea.md"), "我自己的 Krea 笔记\n");
  fs.mkdirSync(path.join(root, "日报"), { recursive: true });
  fs.writeFileSync(path.join(root, "日报", "2026-10-24.md"), "我的日记\n");

  sync();

  assert.equal(read(root, "主题/Krea.md"), "我自己的 Krea 笔记\n");
  assert.match(read(root, "主题/Krea (2).md"), /chatlens: "topic:krea"/u);
  assert.equal(read(root, "日报/2026-10-24.md"), "我的日记\n");
  assert.ok(fs.existsSync(path.join(root, "日报", "2026-10-24 (2).md")));
});

test("notes from before topics go to the vault's .trash, unless the user wrote in them", (t) => {
  const { sync, root, vault, storeDir } = setup(t);
  const files = require("../src/vault_files");
  const old = (name, extra = "") => `---\nchatlens: "thing:${name.toLowerCase()}"\ntype: 事物\nkind: 模型\naliases:\n  - ${name}x\n---\n> [!info] 旧的\n\n## 我的笔记\n${extra}`;
  fs.mkdirSync(path.join(root, "事物"), { recursive: true });
  fs.writeFileSync(path.join(root, "事物", "Krea2.md"), old("Krea2"));
  fs.writeFileSync(path.join(root, "事物", "k2.md"), old("k2", "我对 k2 的笔记\n"));
  // As Obsidian rewrites it once a column is resized: no marker, another hash, still the old folder.
  fs.writeFileSync(path.join(root, "事物.base"), "filters:\n  and:\n    - file.inFolder(\"ChatLens/事物\")\nviews: []\n");
  files.saveManifest(storeDir, {
    ...files.emptyManifest(root),
    things: { "thing:krea2": { name: "Krea2", keys: ["krea2"], aliases: ["Krea2x"] }, "thing:k2": { name: "k2", keys: ["k2"], aliases: ["k2x"] } },
    written: { "thing:krea2": "事物/Krea2.md", "thing:k2": "事物/k2.md" },
    baseHash: "old",
  });

  const result = sync();

  assert.equal(result.retired, 2);
  assert.ok(fs.existsSync(path.join(vault, ".trash", "ChatLens", "事物", "Krea2.md")));
  assert.ok(fs.existsSync(path.join(vault, ".trash", "ChatLens", "事物.base")));
  assert.equal(fs.existsSync(path.join(root, "事物.base")), false);
  const kept = read(root, "事物/k2.md");
  assert.match(kept, /type: 已合并/u);
  assert.match(kept, /\[\[ChatLens\/主题\/Krea\|Krea\]\]/u);
  assert.ok(kept.endsWith("## 我的笔记\n我对 k2 的笔记\n"));
  // Its old aliases would still catch [[k2x]] links meant for the topic.
  assert.doesNotMatch(kept, /aliases:|kind:/u);
  // A day note keeps no count from before topics.
  const day = path.join(root, "日报", "2026-10-24.md");
  fs.writeFileSync(day, fs.readFileSync(day, "utf8").replace("---\n#", "thing_count: 3\n---\n#"));
  assert.match(fs.readFileSync(day, "utf8"), /thing_count: 3/u);
  sync();
  assert.doesNotMatch(fs.readFileSync(day, "utf8"), /thing_count/u);
  // Once the user has emptied the folder, it is tidied away with the last note.
  fs.writeFileSync(path.join(root, "事物", "k2.md"), kept.replace("我对 k2 的笔记\n", ""));
  sync();
  assert.equal(fs.existsSync(path.join(root, "事物")), false);
});

test("a heavy thing not placed yet stands alone, and its note goes once it is placed", (t) => {
  const { sync, root, db, vault } = setup(t);
  sync();
  ["100001", "100002", "100003"].forEach((groupId) => addChunk(db, { groupId, at: "2026-10-24 15:00", partial: { newThings: [thingItem("Krea 3")] } }));

  const before = sync();
  assert.equal(before.unplaced, 1);
  assert.ok(fs.existsSync(path.join(root, "主题", "Krea 3.md")));

  placeTopics(db, {}, { krea3: ["krea", "version"] });
  sync();

  assert.equal(fs.existsSync(path.join(root, "主题", "Krea 3.md")), false);
  assert.ok(fs.existsSync(path.join(vault, ".trash", "ChatLens", "主题", "Krea 3.md")));
  assert.match(read(root, "主题/Krea.md"), /## 版本（2）/u);
});

test("a deleted note the user puts back is updated again", (t) => {
  const { sync, root, db, storeDir } = setup(t);
  sync();
  const file = path.join(root, "主题", "Krea.md");
  const outside = path.join(storeDir, "Krea.md");
  fs.renameSync(file, outside);
  assert.equal(sync().deleted, 1);
  fs.renameSync(outside, file);
  addChunk(db, { groupId: "100001", at: "2026-10-24 14:00", partial: { newThings: [thingItem("Krea2")] } });

  const restored = sync();

  assert.equal(restored.deleted, 0);
  assert.match(read(root, "主题/Krea.md"), /mentions: 7/u);
});

test("a sync stopped half way does not turn ChatLens's own alias writes into the user's decision", (t) => {
  const { sync, root, storeDir } = setup(t);
  sync();
  const files = require("../src/vault_files");
  const manifestFile = files.manifestPath(storeDir, root);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  // As if the notes were written with new aliases and the final manifest never saved.
  const id = "topic:krea";
  const file = path.join(root, "主题", "Krea.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aliases:\n  - Krea2\n", "aliases:\n  - 新写法\n"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, pending: { [id]: ["新写法"] } }));

  sync();

  const after = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.deepEqual(after.topicPins, {});
  assert.deepEqual(after.pending, {});
});

test("a note with a byte-order mark is still found", (t) => {
  const { sync, root } = setup(t);
  sync();
  const file = path.join(root, "主题", "Krea.md");
  fs.writeFileSync(file, `﻿${fs.readFileSync(file, "utf8")}`);

  const second = sync();

  assert.equal(second.deleted, 0);
  assert.match(fs.readFileSync(file, "utf8"), /^---\nchatlens: "topic:krea"/u);
});

test("the writer composes from the note as it is on disk at that moment, not from the scan", (t) => {
  const { sync, root } = setup(t);
  sync();
  const { createWriter } = require("../src/vault_sync");
  const counts = { written: 0, same: 0, kept: 0, failed: 0 };
  const write = createWriter({ root, heading: "## 我的笔记", counts, errors: [] });
  const file = path.join(root, "主题", "Krea.md");
  // Typed after the sync read the folder.
  fs.appendFileSync(file, "刚刚打的字\n");

  write("topic:krea", "主题/Krea.md", { managed: [["chatlens", "topic:krea"]], body: "新正文" });

  assert.ok(fs.readFileSync(file, "utf8").endsWith("## 我的笔记\n刚刚打的字\n"));
  assert.equal(counts.written, 1);
  // A file that now carries another id (the user replaced it) is left alone.
  assert.equal(write("topic:other", "主题/Krea.md", { managed: [], body: "" }), "kept");
});

test("the table view is rewritten while it is ChatLens's, even after the record is lost, and kept once the user changed it", (t) => {
  const { sync, root, storeDir } = setup(t);
  sync();
  const files = require("../src/vault_files");
  const base = path.join(root, "主题.base");
  assert.match(fs.readFileSync(base, "utf8"), /type == "主题"/u);
  fs.writeFileSync(base, fs.readFileSync(base, "utf8").replace("最近热度", "旧名字"));
  fs.rmSync(files.manifestPath(storeDir, root));
  fs.rmSync(`${files.manifestPath(storeDir, root)}.bak`, { force: true });

  sync();
  assert.match(fs.readFileSync(base, "utf8"), /最近热度/u);

  fs.writeFileSync(base, "views:\n  - type: table\n    name: 我的视图\n");
  sync();
  assert.equal(fs.readFileSync(base, "utf8"), "views:\n  - type: table\n    name: 我的视图\n");
});

/* ---------- from the review of the topics rework ---------- */

const aiConfigFor = (t) => {
  process.env.CHATLENS_TEST_NOTES_KEY = "x";
  t.after(() => delete process.env.CHATLENS_TEST_NOTES_KEY);
  return { llm: { baseUrl: "https://example.invalid/v1", model: "m", apiKeyEnv: "CHATLENS_TEST_NOTES_KEY" } };
};

const markFailed = (db, keys, checkedAt = 1) => {
  ensureTopicSchema(db);
  keys.forEach((key) => db.prepare("INSERT OR REPLACE INTO kb_topic_members (thing_key, topic_key, role, what, model, checked_at) VALUES (?, '', 'other', '', 'failed', ?)")
    .run(key, checkedAt));
};

test("a note whose write failed is written next time, not taken for one the user deleted", (t) => {
  const { sync, root } = setup(t);
  // Something holds the temp file's place (a sync client, an antivirus ...).
  fs.mkdirSync(path.join(root, "主题", "Krea.md.chatlens-tmp"), { recursive: true });

  const first = sync();
  assert.equal(first.failed, 1);
  fs.rmSync(path.join(root, "主题", "Krea.md.chatlens-tmp"), { recursive: true });

  const second = sync();

  assert.equal(second.deleted, 0);
  assert.ok(fs.existsSync(path.join(root, "主题", "Krea.md")));
});

test("the first time, a heavy thing not asked about yet holds the notes back; one the AI could not answer does not", (t) => {
  const { sync, db, root } = setup(t);
  const aiConfig = aiConfigFor(t);
  ["100001", "100002", "100003"].forEach((groupId) => addChunk(db, { groupId, at: "2026-10-24 15:00", partial: { newThings: [thingItem("Krea 3")] } }));

  assert.equal(sync({}, aiConfig).skipped, "topics-pending");
  assert.equal(fs.existsSync(root), false);

  markFailed(db, ["krea3"]);
  const written = sync({}, aiConfig);

  assert.equal(written.skipped, undefined);
  assert.ok(fs.existsSync(path.join(root, "主题", "Krea 3.md")));
});

test("a name ChatLens wrote that the user takes out of the aliases leaves the topic", (t) => {
  const { sync, root, db } = setup(t);
  // Without Krea2 the topic still comes up 3 times over 2 groups (a note of its own).
  addChunk(db, { groupId: "100001", at: "2026-10-24 12:00", partial: { newThings: [thingItem("k2")] } });
  sync();
  const file = path.join(root, "主题", "Krea.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aliases:\n  - Krea2\n", ""));

  sync();

  const after = read(root, "主题/Krea.md");
  assert.match(after, /mentions: 4/u);
  assert.doesNotMatch(after, /aliases:/u);
  assert.match(after, /从 aliases 删掉一个名字，它就离开这个主题/u);
});

test("a single thing's note keeps its file when another spelling becomes the most used", (t) => {
  const { sync, root, db } = setup(t);
  const link = "https://github.com/someone/alpha";
  ["100001", "100002", "100003"].forEach((groupId) => addChunk(db, { groupId, at: "2026-10-24 15:00", partial: { newThings: [thingItem("Alpha", { link })] } }));
  placeTopics(db, {}, { alpha: ["", "other"], alphax: ["", "other"] });
  sync();
  assert.ok(fs.existsSync(path.join(root, "主题", "Alpha.md")));
  ["16:00", "17:00", "18:00", "19:00"].forEach((time) => addChunk(db, { groupId: "100001", at: `2026-10-24 ${time}`, partial: { newThings: [thingItem("AlphaX", { link })] } }));

  sync();

  assert.ok(fs.existsSync(path.join(root, "主题", "Alpha.md")));
  assert.equal(fs.existsSync(path.join(root, "主题", "AlphaX.md")), false);
  assert.match(read(root, "主题/Alpha.md"), /mentions: 7/u);
});

test("an old note moved back from .trash is left alone", (t) => {
  const { sync, root, vault, storeDir } = setup(t);
  const files = require("../src/vault_files");
  fs.mkdirSync(path.join(root, "事物"), { recursive: true });
  const old = "---\nchatlens: \"thing:krea2\"\ntype: 事物\n---\n> 旧的\n\n## 我的笔记\n";
  fs.writeFileSync(path.join(root, "事物", "Krea2.md"), old);
  files.saveManifest(storeDir, { ...files.emptyManifest(root), written: { "thing:krea2": "事物/Krea2.md" } });
  sync();
  const trashed = path.join(vault, ".trash", "ChatLens", "事物", "Krea2.md");
  assert.ok(fs.existsSync(trashed));
  fs.mkdirSync(path.join(root, "事物"), { recursive: true });
  fs.renameSync(trashed, path.join(root, "事物", "Krea2.md"));

  const again = sync();

  assert.equal(again.retired, 0);
  assert.equal(read(root, "事物/Krea2.md"), old);
});

test("a name the user added to an old thing note's aliases is carried over to its topic", (t) => {
  const { sync, root, db, storeDir } = setup(t);
  const files = require("../src/vault_files");
  ["12:00", "13:00"].forEach((time) => addChunk(db, { groupId: "100001", at: `2026-10-24 ${time}`, partial: { newThings: [thingItem("KreaX")] } }));
  placeTopics(db, {}, { kreax: ["", "other"] });
  fs.mkdirSync(path.join(root, "事物"), { recursive: true });
  fs.writeFileSync(path.join(root, "事物", "k2.md"), "---\nchatlens: \"thing:k2\"\ntype: 事物\naliases:\n  - k2x\n  - KreaX\n---\n> 旧的\n\n## 我的笔记\n");
  files.saveManifest(storeDir, {
    ...files.emptyManifest(root),
    things: { "thing:k2": { name: "k2", keys: ["k2"], aliases: ["k2x"] } },
    written: { "thing:k2": "事物/k2.md" },
  });

  sync();

  assert.match(read(root, "主题/Krea.md"), /mentions: 8/u);
  assert.match(read(root, "事物/k2.md"), /type: 已合并/u);
});

test("so many notes retiring at once that the store must have changed moves none of them", () => {
  const { tooManyRetiring } = require("../src/vault_retire");
  const notes = new Map(Array.from({ length: 30 }, (_, index) => [`day:2026-09-${String(index + 1).padStart(2, "0")}`, {}]));
  const retiring = (count) => [...notes].slice(0, count);

  assert.equal(tooManyRetiring(notes, retiring(5)), false);
  assert.equal(tooManyRetiring(notes, retiring(16)), true);
});

test("the AI lock of a live process holds past the sync lock's half hour", (t) => {
  const files = require("../src/vault_files");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlens-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The parent of this test process is alive; its lock is 40 minutes old.
  fs.writeFileSync(path.join(dir, "notes-ai.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() - 40 * 60 * 1000 }));

  assert.equal(files.takeLock(dir, "notes-ai", { staleMs: 2 * 3600 * 1000 }), null);
  const release = files.takeLock(dir, "notes-ai");
  assert.equal(typeof release, "function");
  release();
});

test("the AI part places things first; 立即同步 asks nothing else, and one AI pass runs at a time", async (t) => {
  const { db, storeDir, config } = setup(t, { topics: false });
  const { runNotesAi } = require("../src/vault_ai");
  const purposes = [];
  const itemsOf = (prompt) => prompt.user.split("\n").filter((line) => /^\d+ \| /u.test(line))
    .map((line) => ({ i: Number(line.split(" | ")[0]), topic: "Krea", role: "main", what: "" }));
  const callLlm = async (_client, build, meta) => {
    purposes.push(meta.purpose);
    const raw = meta.purpose === "notes-topics" ? { items: itemsOf(build()), topics: [{ name: "Krea", category: "image", what: "图像模型" }] }
      : meta.purpose === "notes-aliases" ? { same: [] } : { what: "图像模型", points: [], unsure: [] };
    meta.validate?.(raw);
    return raw;
  };
  const run = (manual) => runNotesAi(db, { config, storeDir, client: {}, callLlm, model: () => "fake", gate: () => null, nowUnix: NOW, manual });

  const manual = await run(true);

  assert.deepEqual([...new Set(purposes)], ["notes-topics"]);
  assert.equal(manual.topics.calls, 1);
  assert.equal(manual.aliases.skipped, "later");
  // A later background run has nothing to place and goes on to merge names.
  await run(false);
  assert.ok(purposes.includes("notes-aliases"));
  fs.writeFileSync(path.join(storeDir, "notes-ai.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal((await run(false)).skipped, "busy");
});

test("a topic said twice in two groups stays in the day notes; one said three times over two groups gets a note", (t) => {
  const { isNotable } = require("../src/things_topics");
  assert.equal(isNotable({ groups: [{}, {}], chunkCount: 2 }), false);
  assert.equal(isNotable({ groups: [{}, {}], chunkCount: 3 }), true);
  assert.equal(isNotable({ groups: [{}], chunkCount: 4 }), false);
  assert.equal(isNotable({ groups: [{}], chunkCount: 5 }), true);

  const { sync, root, db } = setup(t);
  ["100001", "100002"].forEach((groupId) => addChunk(db, { groupId, at: "2026-10-24 15:00", partial: { newThings: [thingItem("Beta")] } }));
  placeTopics(db, { beta: { name: "Beta", category: "app", what: "某个工具" } }, { beta: ["beta", "main"] });
  sync();
  assert.equal(fs.existsSync(path.join(root, "主题", "Beta.md")), false);
  assert.match(read(root, "日报/2026-10-24.md"), /Beta/u);
});

test("a thing that is a topic of its own says what the AI said it is, not who mentioned it", (t) => {
  const { sync, root, db } = setup(t);
  ["100001", "100002", "100003"].forEach((groupId) => addChunk(db, { groupId, at: "2026-10-24 16:00", partial: { newThings: [thingItem("DS", { detail: "某人凌晨提到 DS 能一次写一千行" })] } }));
  placeTopics(db, {}, { ds: ["", "other", "可写代码的模型服务"] });

  sync();

  const note = read(root, "主题/DS.md");
  assert.match(note, /summary: 可写代码的模型服务/u);
  assert.match(note, /> 可写代码的模型服务/u);
});
