"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { buildBriefing } = require("../src/briefing_view");
const { readBriefThings } = require("../src/brief_things");
const { listCommitments } = require("../src/commitments");
const review = require("../src/review_store");
const { makeDemo, fillDemoStore } = require("../scripts/make_demo");
const { ME, GROUPS } = require("../scripts/demo_data");

const NOW = 1_800_000_000;

test("the demo store shows a full briefing: groups with summaries, things, mentions, promises, questions", () => {
  const db = messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "demo-store-")), "messages.db"));
  try {
    const written = fillDemoStore(db, NOW);
    assert.equal(written.groups, GROUPS.length);
    const briefing = buildBriefing({ db, knowledgeDbPath: path.join(os.tmpdir(), "no-such-knowledge.db"), watchlist: written.watchlist, nowUnix: NOW, extraSelfUins: [], isImageAvailable: () => false });
    assert.equal(briefing.groups.length, GROUPS.length);
    assert.ok(briefing.groups.every((group) => typeof group.summary === "string" && group.summary.length > 0 && group.topics.length > 0));
    assert.deepEqual(briefing.identity.names, [ME.name]);
    assert.ok(briefing.mentions.filter((item) => item.kind === "at" || item.kind === "reply").length >= 3, "people turn to the reader");
    const things = readBriefThings(db, { watchlist: written.watchlist, windowStart: briefing.windowStart, nowUnix: NOW });
    assert.equal(things.things.length, 5);
    assert.equal(things.things[0].title, "Aurora XL 2.0 发布");
    assert.equal(things.things[0].groups.length, 3, "the same matter in three groups is one thing");
    const promised = listCommitments(db, { nowUnix: NOW });
    assert.equal(promised.open.length, 2);
    assert.ok(review.search(db, { query: "", library: "qa" }).summaries.total >= 8);
  } finally {
    db.close();
  }
});

test("a demo folder is self-contained, can be made again, and other folders are left alone", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "demo-folder-"));
  const folder = path.join(base, "demo");
  const made = makeDemo(folder, { now: NOW });
  assert.ok(made.messages > 80);
  for (const name of ["CHATLENS-DEMO", "start-demo.cmd", "start-demo.sh", "src/server/control_center.js", "web/index.html", "store/messages.db", "config/defaults.json", "node_modules"]) {
    assert.ok(fs.existsSync(path.join(folder, name)), name);
  }
  const config = JSON.parse(fs.readFileSync(path.join(folder, "config", "defaults.json"), "utf8"));
  assert.equal(config.background.enabled, false);
  assert.ok(config.ntDbDir.startsWith(folder));
  assert.doesNotThrow(() => makeDemo(folder, { now: NOW }), "the same folder again replaces the demo");
  const other = path.join(base, "mine");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "notes.txt"), "keep me");
  assert.throws(() => makeDemo(other, { now: NOW }), /not empty/u);
  assert.equal(fs.readFileSync(path.join(other, "notes.txt"), "utf8"), "keep me");
  assert.throws(() => makeDemo(path.join(__dirname, "..", "demo-inside"), { now: NOW }), /own folder/u);
  // the shared libraries are a link: removing the demo must not follow it
  fs.rmdirSync(path.join(folder, "node_modules"));
});
