"use strict";

// The first-run guide on 简报 (web/setup_guide.js): each step opens only
// after the one before it, ticked groups stay on top of the picker, and the
// footer tells the truth about the first background refresh.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

const loadPage = () => {
  const context = vm.createContext(makeSandbox());
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // Render paths may throw in the fake DOM; the guide is rendered below.
    }
  }
  const run = (expression) => vm.runInContext(expression, context);
  // el() appends `child instanceof Node` as a node, anything else as text.
  // With real nodes the boot's leftover async work gets further and starts
  // poll timers that would keep the test process alive; nothing here needs them.
  run("setTimeout = () => 0");
  run(`Node = { [Symbol.hasInstance]: (value) => value !== null && typeof value === "object" && "tagName" in value }`);
  run(`textOfNode = (node) => node === null || node === undefined || node === false ? ""
    : typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOfNode).join(" ")
    : [node.textContent ?? "", ...(node.children ?? []).map(textOfNode)].join(" ")`);
  return run;
};

const NO_PATH = { ntDbDir: "", ntDbDirExists: false, ntqqKeySaved: false, llmKeySaved: false, llm: { model: "" }, grok: null };
const READY = { ...NO_PATH, ntDbDir: "C:\\Tencent Files\\123456\\nt_qq\\nt_db", ntDbDirExists: true, ntqqKeySaved: true };
const GROUPS = [{ groupId: "1", name: "甲群" }, { groupId: "2", name: "乙群" }, { groupId: "3", name: "丙群" }];

const stepStates = (run) => JSON.parse(run(`JSON.stringify(setupGuideCard().children
  .find((child) => child.tagName === "OL").children.map((step) => step.attributes.class ?? step.className ?? ""))`));

const setScene = (run, { status, watchlist = [], knownGroups = [], background = {} }) => {
  run(`setupGuide.status = ${JSON.stringify(status)}`);
  run(`app.state = { watchlist: ${JSON.stringify(watchlist)}, knownGroups: ${JSON.stringify(knownGroups)} }`);
  run(`briefState.data = { status: { background: ${JSON.stringify(background)} }, totals: { textMessages: 0 } }`);
};

test("a new user sees step 1 open and the steps after it waiting", () => {
  const run = loadPage();
  setScene(run, { status: NO_PATH });

  const text = run("textOfNode(setupGuideCard())");

  assert.match(text, /自动查找/u);
  assert.doesNotMatch(text, /自动获取密钥/u);
  assert.match(text, /选要看的群/u);
});

test("with the path and key saved, the group picker lists ticked groups first", () => {
  const run = loadPage();
  setScene(run, { status: READY, watchlist: [{ groupId: "3", name: "丙群" }], knownGroups: GROUPS });

  const names = JSON.parse(run(`JSON.stringify(groupRows(app.state.knownGroups, new Set(["3"])).map((row) => textOfNode(row)))`));

  assert.match(names[0], /丙群/u);
  assert.equal(names.length, 3);
});

test("a failed first refresh shows its reason and a retry, not a promise", () => {
  const run = loadPage();
  setScene(run, { status: READY, watchlist: [{ groupId: "1", name: "甲群" }], knownGroups: GROUPS, background: { running: false, lastError: "数据库副本正被占用" } });

  const text = run("textOfNode(setupFooter(true))");

  assert.match(text, /上次没收成：数据库副本正被占用/u);
  assert.match(text, /再试一次/u);
  assert.doesNotMatch(text, /自动换成简报/u);
});

test("while the first refresh runs the footer says so", () => {
  const run = loadPage();
  setScene(run, { status: READY, watchlist: [{ groupId: "1", name: "甲群" }], knownGroups: GROUPS, background: { running: true } });

  assert.match(run("textOfNode(setupFooter(true))"), /正在收第一批消息/u);
});

test("a set-up user with a quiet window (or after 看完了) keeps the briefing", () => {
  const run = loadPage();
  const scene = (totals, problem = null) =>
    run(`needsSetupGuide(${JSON.stringify({ totals, status: { background: { readinessProblem: problem } } })})`);

  assert.equal(scene({ textMessages: 0, everStored: true }), false);
  assert.equal(scene({ textMessages: 0, everStored: false }), true);
  assert.equal(scene({ textMessages: 0, everStored: true }, "关注群列表为空"), true);
  assert.equal(scene({ textMessages: 12, everStored: true }, "关注群列表为空"), false);
});
