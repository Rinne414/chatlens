"use strict";

// 简报's first load and 回顾's report lists, in the fake page of web_sandbox.js:
// what is on screen while there is nothing else to show.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

// el() only appends real Nodes as elements; let the fake page's nodes count, so nesting can be inspected.
const asNode = (value) => typeof value === "object" && value !== null && "tagName" in value;

const findByClass = (node, name) => {
  if (!asNode(node)) {
    return null;
  }
  if (node.className.split(" ").includes(name)) {
    return node;
  }
  return node.children.map((child) => findByClass(child, name)).find((found) => found !== null) ?? null;
};

const textOf = (node) => (asNode(node) ? [node.textContent, ...node.children.map(textOf)].join("") : String(node ?? ""));

const loadPage = () => {
  const sandbox = makeSandbox();
  sandbox.Node = class Node {
    static [Symbol.hasInstance](value) { return asNode(value); }
  };
  const context = vm.createContext(sandbox);
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // Boot paths may throw in the fake DOM; the render helpers under test do not.
    }
  }
  const root = sandbox.document.querySelector("#view-brief");
  // The fake DOM has no selector engine: answer the one lookup renderBriefPending makes.
  root.querySelector = (selector) => findByClass(root, selector.slice(1));
  return { run: (expression) => vm.runInContext(expression, context), root };
};

test("while the first load is pending the page says so at once, with no count yet", () => {
  const { run, root } = loadPage();
  run("briefState.data = null; briefState.error = null; renderBriefView()");
  const line = findByClass(root, "brief-loading");
  assert.notEqual(line, null);
  assert.match(textOf(line), /正在读取简报…/u);
  assert.doesNotMatch(textOf(line), /已经/u);
});

test("a redraw while still pending keeps the same line, so its count is not restarted", () => {
  const { run, root } = loadPage();
  run("briefState.data = null; briefState.error = null; renderBriefView()");
  const first = findByClass(root, "brief-loading");
  run("renderBriefView()");
  assert.equal(findByClass(root, "brief-loading"), first);
});

test("a failed first load shows the error, not the loading line", () => {
  const { run, root } = loadPage();
  run("briefState.data = null; briefState.error = null; renderBriefView()");
  run("briefState.error = '连不上'; renderBriefView()");
  assert.equal(findByClass(root, "brief-loading"), null);
  assert.match(textOf(root), /读取简报失败：连不上/u);
});

test("a report that exists says so once; one that does not stays quiet and is explained by the header", () => {
  const { run } = loadPage();
  const madeRow = run("digestReportRow('week', '2026-11-16', { period: '2026-11-16', headline: '画图群在聊新模型' }, null, () => {})");
  const missingRow = run("digestReportRow('week', '2026-11-09', undefined, null, () => {})");
  assert.match(textOf(madeRow), /已生成/u);
  assert.match(textOf(madeRow), /画图群在聊新模型/u);
  assert.doesNotMatch(textOf(missingRow), /未生成|点开/u);
  assert.match(textOf(run("digestReportList('week', () => {}, null)")), /周报点开一份就生成/u);
});

test("the report lists move into the main column only while nothing else is there", () => {
  const { run } = loadPage();
  const empty = (setup) => run(`reviewState.data = null; reviewState.report = null; reviewState.results = null; reviewState.resultsOpen = false; ${setup}; reviewMainIsEmpty()`);
  assert.equal(empty(""), true);
  assert.equal(empty("reviewState.data = { day: '2026-11-23' }"), false);
  assert.equal(empty("reviewState.report = { kind: 'week', period: '2026-11-16' }"), false);
  assert.equal(empty("reviewState.results = { hits: [] }; reviewState.resultsOpen = true"), false);
});

test("回顾 with no day yet: both lists in the main column, no side column, one loading line", () => {
  const { run } = loadPage();
  run("reviewState.data = null; reviewState.report = null; reviewState.results = null; reviewState.resultsOpen = false; reviewState.calendar = null; reviewState.error = null; digestState.lists = { week: [], month: [] }; renderReviewView()");
  const page = run("$('#view-review')");
  const idle = findByClass(page, "review-idle");
  assert.notEqual(idle, null);
  assert.equal(findByClass(page, "review-side"), null);
  assert.match(textOf(findByClass(idle, "review-idle-lists")), /周报.*月报/su);
  assert.match(textOf(idle), /正在读取这一天…/u);
  const first = findByClass(idle, "brief-loading");
  run("renderReviewView()");
  assert.equal(findByClass(run("$('#view-review')"), "brief-loading"), first);
});
