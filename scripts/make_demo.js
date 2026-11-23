"use strict";

// Makes a demo copy of ChatLens filled with made-up chats (scripts/demo_data.js),
// for screenshots, videos and trying the program without setting anything up:
//
//   node scripts/make_demo.js <folder>
//
// <folder> gets the program, a store of invented groups and messages with
// their summaries, a config that never reads a real chat database and never
// calls an AI, and start-demo.cmd / start-demo.sh. Nothing of the real
// install (its store, its keys, its settings) is read or changed. Making it
// again into the same folder replaces the demo; any other folder that is
// not empty is refused.

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("../src/message_store");
const briefingStore = require("../src/briefing_store");
const briefThings = require("../src/brief_things");
const commitments = require("../src/commitments");
const { ME, PEOPLE, GROUPS, THINGS, PROMISES, CHATTER } = require("./demo_data");

const ROOT = path.resolve(__dirname, "..");
const MARKER = "CHATLENS-DEMO";
const COPIED = ["src", "web", "package.json", "LICENSE"];
const WINDOW_HOURS = 72;
const LINE_SECONDS = 50;

// The same demo every time: chatter is picked by position, not at random.
const pick = (list, seed) => list[seed % list.length];

// db: an open message store. now: unix seconds. Returns what was written.
const fillDemoStore = (db, now) => {
  briefingStore.ensureBriefingSchema(db);
  const windowStart = now - WINDOW_HOURS * 3600;
  const messages = [];
  const rowOf = new Map();
  let row = 0;
  const say = (groupId, who, text, sentAt, { reply = null, at = [] } = {}) => {
    row += 1;
    const person = PEOPLE[who];
    messages.push({
      groupId, rowId: String(row), msgSeq: String(row), sentAt, senderUin: person.uin, senderName: person.name, text,
      isSelf: person.uin === ME.uin, atUins: at.map((name) => PEOPLE[name].uin), atAll: false,
      replyTo: reply === null ? null : { seq: String(reply.row), uin: reply.uin },
    });
    return { row, uin: person.uin };
  };
  const others = Object.keys(PEOPLE).filter((name) => name !== "me");
  const threads = [];
  GROUPS.forEach((group, groupIndex) => {
    group.threads.forEach((thread, threadIndex) => {
      const start = now - thread.hoursAgo * 3600;
      const said = [];
      thread.lines.forEach(([who, text, options = {}], lineIndex) => {
        const entry = say(group.id, who, text, start + lineIndex * LINE_SECONDS, {
          reply: options.reply === undefined ? null : said[options.reply],
          at: options.at ?? [],
        });
        said.push(entry);
        rowOf.set(`${groupIndex}|${threadIndex}|${lineIndex}`, entry.row);
      });
      // A little small talk after each conversation, as a real group has.
      const end = start + thread.lines.length * LINE_SECONDS;
      for (let extra = 0; extra < 6; extra += 1) {
        say(group.id, pick(others, groupIndex * 7 + threadIndex * 3 + extra), pick(CHATTER, groupIndex + threadIndex * 5 + extra * 2), end + (extra + 1) * 90);
      }
      threads.push({ group, groupIndex, threadIndex, thread, start, end: end + 7 * 90, first: said[0].row, last: row, count: thread.lines.length + 6 });
    });
  });
  messageStore.ingestExport(db, {
    groupIds: GROUPS.map((group) => group.id),
    groupNames: Object.fromEntries(GROUPS.map((group) => [group.id, group.name])),
    startUnix: windowStart, endUnix: now, coveredFromUnix: windowStart, messages, mediaMessages: [],
  }, "demo");

  // The summaries an AI would have written for each conversation and each group.
  const chunkIds = new Map();
  for (const item of threads) {
    const chunkId = briefingStore.insertChunk(db, {
      groupId: item.group.id, startSentAt: item.start, endSentAt: item.end, firstRowId: String(item.first), lastRowId: String(item.last),
      messageCount: item.count, createdAt: now,
    });
    briefingStore.saveChunkResult(db, chunkId, { partial: item.thread.partial });
    chunkIds.set(item.group.id, [...(chunkIds.get(item.group.id) ?? []), chunkId]);
  }
  briefingStore.setState(db, "briefing_since", windowStart);
  for (const group of GROUPS) {
    briefingStore.saveGroupBrief(db, group.id, {
      windowStart,
      chunkKey: chunkIds.get(group.id).join(","),
      summary: { summary: group.summary, topics: group.threads.flatMap((thread) => thread.partial.topics), coverage: null },
      updatedAt: now,
    });
  }

  // 值得知道的事, the way the page reads it back.
  const watchlist = GROUPS.map((group) => ({ groupId: group.id, name: group.name }));
  const topics = briefThings.windowTopics(db, watchlist, windowStart);
  const indexOfTopic = ([groupIndex, threadIndex, topicIndex]) => {
    const title = GROUPS[groupIndex].threads[threadIndex].partial.topics[topicIndex].title;
    return topics.findIndex((topic) => topic.groupId === GROUPS[groupIndex].id && topic.title === title);
  };
  const things = THINGS.map((thing) => ({ ...thing, topics: thing.topics.map(indexOfTopic).filter((index) => index >= 0) }));
  briefThings.saveBriefThings(db, { windowStart, things: briefThings.thingsToKeys(things, topics), model: "demo", topicCount: topics.length, nowUnix: now });

  // 答应过的事.
  commitments.ensureCommitmentSchema(db);
  const promise = db.prepare("INSERT OR REPLACE INTO commitments (group_id, row_id, kind, what, who, quote, sent_at, created_at, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')");
  for (const [groupIndex, threadIndex, lineIndex, kind, what, who] of PROMISES) {
    const group = GROUPS[groupIndex];
    const thread = group.threads[threadIndex];
    promise.run(group.id, String(rowOf.get(`${groupIndex}|${threadIndex}|${lineIndex}`)), kind, what, who, thread.lines[lineIndex][1],
      now - thread.hoursAgo * 3600 + lineIndex * LINE_SECONDS, now);
  }
  return { groups: GROUPS.length, messages: messages.length, chunks: threads.length, things: things.length, watchlist };
};

const demoConfig = (folder, watchlist) => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "defaults.example.json"), "utf8"));
  return {
    ...example,
    // The pages say "示范数据" where they would talk about setup and refreshing.
    demo: true,
    // Folders that hold nothing: the demo never reads a real chat database.
    ntDbDir: path.join(folder, "demo-data", "no-chat-db"),
    ntDataDir: path.join(folder, "demo-data", "no-chat-files"),
    watchlist,
    defaultGroupIds: watchlist.map((group) => group.groupId),
    background: { enabled: false, autoSummarize: false, notifyMentions: false, notifyDaily: false },
    pictures: { ...(example.pictures ?? {}), enabled: false },
    notes: { enabled: false, autoSync: false },
    desktop: { version: 3, asked: true },
  };
};

// Windows: the batch file is read by cmd, which wants CRLF and no Unicode surprises.
const START_CMD = [
  "@echo off",
  "rem ChatLens demo: made-up chats, its own settings and keys, nothing shared with a real install.",
  "set \"DEMO=%~dp0\"",
  "set \"APPDATA=%DEMO%demo-data\\appdata\"",
  "set \"CHATLENS_SECRET_DIR=%DEMO%demo-data\\secrets\"",
  "set \"CHATLENS_SECRET_BACKEND=file\"",
  "node \"%DEMO%src\\server\\control_center.js\"",
  "",
].join("\r\n");

const START_SH = [
  "#!/bin/sh",
  "# ChatLens demo: made-up chats, its own settings and keys, nothing shared with a real install.",
  "DEMO=\"$(cd \"$(dirname \"$0\")\" && pwd)\"",
  "export XDG_CONFIG_HOME=\"$DEMO/demo-data/config\"",
  "export CHATLENS_SECRET_DIR=\"$DEMO/demo-data/secrets\"",
  "export CHATLENS_SECRET_BACKEND=file",
  "exec node \"$DEMO/src/server/control_center.js\"",
  "",
].join("\n");

const makeDemo = (target, { now = Math.floor(Date.now() / 1000) } = {}) => {
  const folder = path.resolve(target);
  if (folder === ROOT || ROOT.startsWith(`${folder}${path.sep}`) || folder.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("The demo cannot be made inside the program's own folder (or around it). Choose a folder elsewhere.");
  }
  if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0 && !fs.existsSync(path.join(folder, MARKER))) {
    throw new Error(`${folder} is not empty and is not a demo made earlier. Choose an empty folder.`);
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, MARKER), "A ChatLens demo copy with made-up chats. Safe to delete.\n", "utf8");
  for (const name of COPIED) {
    fs.rmSync(path.join(folder, name), { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, name), path.join(folder, name), { recursive: true });
  }
  // The libraries are shared with the program this was made from, not copied (hundreds of MB).
  const modules = path.join(folder, "node_modules");
  if (!fs.existsSync(modules)) {
    fs.symlinkSync(path.join(ROOT, "node_modules"), modules, "junction");
  }
  for (const name of ["store", "demo-data"]) {
    fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  }
  for (const name of ["store", "config", path.join("demo-data", "no-chat-db"), path.join("demo-data", "no-chat-files"), path.join("demo-data", "appdata"), path.join("demo-data", "secrets")]) {
    fs.mkdirSync(path.join(folder, name), { recursive: true });
  }
  const db = messageStore.openStore(path.join(folder, "store", "messages.db"));
  let written = null;
  try {
    written = fillDemoStore(db, now);
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(folder, "config", "defaults.json"), `${JSON.stringify(demoConfig(folder, written.watchlist), null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(folder, "start-demo.cmd"), START_CMD, "utf8");
  fs.writeFileSync(path.join(folder, "start-demo.sh"), START_SH, { encoding: "utf8", mode: 0o755 });
  return { folder, ...written };
};

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/make_demo.js <folder>");
    process.exit(1);
  }
  try {
    const made = makeDemo(target);
    console.log(`Demo made in ${made.folder}: ${made.groups} groups, ${made.messages} messages, ${made.things} things on the briefing.`);
    console.log(process.platform === "win32" ? "Start it with start-demo.cmd in that folder." : "Start it with ./start-demo.sh in that folder.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { makeDemo, fillDemoStore };
