"use strict";

// Back and forward (web/view_history.js) through the real page scripts, with a
// working history: every screen a page shows inside itself can be gone back
// to, and back from a picture closes the picture instead of leaving the page.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { WEB, pageScripts, makeNode, makeSandbox } = require("./web_sandbox");

// A browser's session history, enough for the page: back and forward fire
// popstate with the entry's state, as the browser does.
const makeHistory = (fire) => {
  const entries = [null];
  let index = 0;
  const go = (delta) => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) {
      return;
    }
    index = next;
    fire({ state: structuredClone(entries[index]) });
  };
  return {
    get state() { return structuredClone(entries[index]); },
    get length() { return entries.length; },
    replaceState(state) { entries[index] = structuredClone(state); },
    pushState(state) {
      entries.splice(index + 1);
      entries.push(structuredClone(state));
      index += 1;
    },
    back: () => go(-1),
    forward: () => go(1),
  };
};

const loadPage = () => {
  const sandbox = makeSandbox();
  const listeners = [];
  sandbox.window.addEventListener = (type, listener) => {
    if (type === "popstate") {
      listeners.push(listener);
    }
  };
  sandbox.window.scrollTo = () => {};
  // Nothing answers: what is tested happens before any data arrives, and no
  // half-drawn page keeps running after a test.
  sandbox.fetch = () => new Promise(() => {});
  sandbox.history = makeHistory((event) => listeners.forEach((listener) => listener(event)));
  // Every view container exists, as in index.html.
  sandbox.document.getElementById = (id) => (id.startsWith("view-") ? makeNode("div") : null);
  const context = vm.createContext(sandbox);
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // A render path touching more DOM than the fake has; not what is tested.
    }
  }
  const run = (code) => vm.runInContext(code, context);
  run('app.view = "brief"; showView("brief");');
  return { run, history: sandbox.history };
};

test("群: after picking a group, back returns to the list of groups, and forward to the group", () => {
  const { run, history } = loadPage();
  run("openGroupView()");
  assert.equal(run("app.groupPage.choosing"), true);
  run('openGroupView("12345")');
  assert.equal(run("app.groupPage.choosing"), false);

  history.back();
  assert.equal(run("app.view"), "group");
  assert.equal(run("app.groupPage.choosing"), true, "back shows the list of groups again");

  history.forward();
  assert.equal(run("app.groupPage.choosing"), false);
  assert.equal(run("app.groupPage.groupId"), "12345");
});

test("群: 「← 所有群」 on a group opened straight from the rail shows the list, and back returns to the group", () => {
  const { run, history } = loadPage();
  run('app.groupPage = { ...app.groupPage, groupId: "12345", choosing: false }');
  run('openView("group")');
  assert.equal(run("app.groupPage.choosing"), false, "the rail reopens the last group");

  run("backToGroupChooser()");
  assert.equal(run("app.groupPage.choosing"), true);
  history.back();
  assert.equal(run("app.groupPage.choosing"), false);
  history.back();
  assert.equal(run("app.view"), "brief");
});

test("消息: a chat left for another page comes back; back from it returns to the inbox", () => {
  const { run, history } = loadPage();
  // openChat's drawing needs more DOM than the fake has: its promise is let go.
  run("openMessagesView()");
  assert.equal(run("app.msg.mode"), "inbox");
  run('openChat({ groupId: "12345", groupName: "测试群", fromLastRead: true }).catch(() => {})');
  assert.equal(run("app.msg.mode"), "chat");

  run('openView("trends")');
  history.back();
  assert.equal(run("app.view"), "messages");
  assert.equal(run("app.msg.mode"), "chat", "back returns to the chat, not the inbox");
  assert.equal(run("app.msg.groupId"), "12345");

  history.back();
  assert.equal(run("app.msg.mode"), "inbox");
  history.forward();
  assert.equal(history.state.step.chat.groupId, "12345", "forward reopens the same chat");
});

test("a chat's 「← 简报」 goes back to the briefing when that is where it came from", () => {
  const { run, history } = loadPage();
  run('showView("messages"); openChat({ groupId: "12345", groupName: "测试群", fromUnix: 1000, origin: { view: "brief", label: "简报" } }).catch(() => {})');
  assert.equal(run("app.view"), "messages");
  const depth = history.state.depth;
  run("returnToMessageOrigin()");
  assert.equal(run("app.view"), "brief");
  assert.equal(history.state.depth, depth - 1, "it went back instead of adding another page");
});

test("画廊: back closes an open picture and stays on the wall; 关闭 does the same", () => {
  const { run, history } = loadPage();
  run('openView("media")');
  run('app.gallery = { ...app.gallery, results: { total: 2, items: [{ md5: "a".repeat(32), shown: null, origin: null }, { md5: "b".repeat(32), shown: null, origin: null }] } }');
  run("openGalleryDetail(0)");
  run("stepGalleryDetail(1)");
  assert.equal(run("app.gallery.detail.md5"), "b".repeat(32));

  history.back();
  assert.equal(run("app.view"), "media");
  assert.equal(run("app.gallery.detail"), null, "one back closes the picture, however many were stepped through");

  run("openGalleryDetail(0)");
  run("dismissGalleryDetail()");
  assert.equal(run("app.gallery.detail"), null);
  history.back();
  assert.equal(run("app.view"), "brief", "closing left no extra entry behind");
});

test("a picture opened over a detail (咒语库 → 打开图片): closing it leaves the detail open, back then closes the detail", () => {
  const { run, history } = loadPage();
  run('openView("trends"); globalThis.closed = []');
  run('openOverlayEntry({ kind: "knowledge", key: "h1" }, () => closed.push("detail"))');
  run('openOverlayEntry({ kind: "picture", key: "p1" }, () => closed.push("picture"))');
  run('openOverlayEntry({ kind: "picture", key: "p2" }, () => closed.push("picture"))');

  run('dismissOverlay(() => closed.push("picture"))');
  assert.equal(run("JSON.stringify(closed)"), JSON.stringify(["picture"]));
  assert.equal(history.state.overlay.kind, "knowledge", "the detail's entry is still there");

  history.back();
  assert.equal(run("JSON.stringify(closed)"), JSON.stringify(["picture", "detail"]), "back now closes the detail");
  assert.equal(run("app.view"), "trends");
  assert.equal(history.state.overlay ?? null, null);
  history.back();
  assert.equal(run("app.view"), "brief");
});

test("回顾: back from a weekly report returns to the day; days replace each other", () => {
  const { run, history } = loadPage();
  run('showView("review"); reviewState.calendar = { days: [] }; reviewPickDay("2026-09-20")');
  run('reviewPickDay("2026-09-21")');
  run('reviewPickReport("week", "2026-W39")');
  assert.equal(run("JSON.stringify(reviewState.report)"), '{"kind":"week","period":"2026-W39"}');

  history.back();
  assert.equal(run("reviewState.report"), null);
  assert.equal(run("reviewState.day"), "2026-09-21");
  history.back();
  assert.equal(run("app.view"), "brief", "the days were one entry");
});

test("「← 返回」 at the top shows only when there is somewhere to go back to", () => {
  const { run, history } = loadPage();
  const button = () => run('$("#view-back")');
  assert.equal(button().hidden, true);
  run('openView("trends")');
  assert.equal(button().hidden, false);
  history.back();
  assert.equal(button().hidden, true);
});
