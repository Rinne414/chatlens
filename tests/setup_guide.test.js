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

  assert.match(text, /上次没收成：数据库副本正被另一个任务使用/u);
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

test("raw refresh errors are said in plain words, unknown ones are kept as they are", () => {
  const run = loadPage();
  const plain = (raw) => run(`plainSetupError(${JSON.stringify(raw)})`);

  assert.match(plain("导出消息失败（退出码 1）：SqliteError: database disk image is malformed"), /不完整.*自动重试/u);
  assert.match(plain("SqliteError: file is not a database"), /密钥对不上/u);
  assert.match(plain("找不到源数据库: C:/x/nt_msg.db（请在设置页检查 QQ 数据库路径）"), /找不到 QQ 的数据库文件/u);
  assert.equal(plain("网络断了"), "网络断了");
});

test("steps still waiting show what they do, how long, the disk they use and the fallback", () => {
  const run = loadPage();
  setScene(run, { status: { ...NO_PATH, ntMsgDbBytes: 15 * 1024 ** 3 } });

  const text = run("textOfNode(setupGuideCard())");

  assert.match(text, /找不到？手动指定/u);
  assert.match(text, /QQ 的内存里读出密钥/u);
  assert.match(text, /到设置页手动填密钥/u);
  assert.match(text, /大约 1-2 分钟.*和 QQ 的数据库一样大（现在约 15/u);
  assert.match(text, /联网时会发生什么/u);
  assert.match(text, /GitHub/u);
});

// setupGuide.status too: the boot's leftover async renders read it.
const briefScene = (run, { background = {}, llmConfigured = true, newestMessageAt = null }) => {
  run(`setupGuide.status = ${JSON.stringify(READY)}`);
  run(`briefState.data = ${JSON.stringify({ status: { background, llmConfigured, newestMessageAt }, totals: { textMessages: 0, unsummarized: 0 } })}`);
};

test("the 简报 status line says how fresh the data is, and offers the switch when refresh is off", () => {
  const run = loadPage();
  const line = () => run("textOfNode(briefStatusLine(briefState.data))");
  const newest = Math.floor(Date.now() / 1000) - 3600;

  briefScene(run, { background: { settings: { enabled: false } }, newestMessageAt: newest });
  assert.match(line(), /后台刷新关着.*消息到 .*打开后台刷新.*现在收一次/u);

  briefScene(run, { background: { settings: { enabled: true }, lastFinishedAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 600000).toISOString() }, newestMessageAt: newest });
  assert.match(line(), /刷新过 · 消息到 .* · 下次刷新 /u);

  // Unfinished setup is not shown as a failed refresh, though the refresh records it as its error.
  briefScene(run, { background: { settings: { enabled: true }, readinessProblem: "还没有保存 QQ 数据库密钥", lastError: "还没有保存 QQ 数据库密钥" } });
  assert.match(line(), /还没设置好/u);
  assert.doesNotMatch(line(), /出错/u);
});

test("nothing promises an automatic summary while refresh, setup, AI or 自动 AI 总结 is missing", () => {
  const run = loadPage();
  const on = (scene) => {
    briefScene(run, scene);
    return run("briefAutoSummaryOn(briefState.data)");
  };

  assert.equal(on({ background: { settings: { enabled: true, autoSummarize: true } } }), true);
  assert.equal(on({ background: { settings: { enabled: false } } }), false);
  assert.equal(on({ background: { settings: { enabled: true, autoSummarize: false } } }), false);
  assert.equal(on({ background: { settings: { enabled: true }, readinessProblem: "关注群列表为空" } }), false);
  assert.equal(on({ background: { settings: { enabled: true } }, llmConfigured: false }), false);
});
