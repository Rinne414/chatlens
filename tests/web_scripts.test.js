"use strict";

// Guards the failure mode that produced a blank knowledge page: the web/ files
// are CLASSIC scripts sharing one global scope, so two files declaring the same
// top-level `const` is a SyntaxError that kills the whole page. `node -c` cannot
// catch it (each file is valid alone) and no other test loads them together.
//
// This evaluates every page script in the real order inside one shared context,
// which is exactly how the browser loads them.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");

// The scripts the page actually loads, in the order it loads them.
const pageScripts = () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  return [...html.matchAll(/<script src="\/([^"]+)"><\/script>/gu)].map((match) => match[1]);
};

const makeNode = (tag) => ({
  tagName: String(tag).toUpperCase(),
  children: [],
  dataset: {},
  style: { setProperty() {}, removeProperty() {} },
  attributes: {},
  isConnected: true,
  classList: {
    _set: new Set(),
    add(...names) { for (const name of names) { this._set.add(name); } },
    remove(...names) { for (const name of names) { this._set.delete(name); } },
    toggle(name, on) { if (on) { this._set.add(name); } else { this._set.delete(name); } },
    contains(name) { return this._set.has(name); },
  },
  setAttribute(key, value) { this.attributes[key] = value; },
  addEventListener() {},
  removeEventListener() {},
  append(...kids) { this.children.push(...kids); },
  replaceChildren(...kids) { this.children = kids; },
  getBoundingClientRect() { return { top: 0, left: 0, width: 1200, height: 800 }; },
  get clientWidth() { return 1200; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  set textContent(value) { this._text = value; },
  get textContent() { return this._text ?? ""; },
  set className(value) { this._class = value; },
  get className() { return this._class ?? ""; },
  set innerHTML(value) { this._html = value; },
  get innerHTML() { return this._html ?? ""; },
  focus() {},
  scrollIntoView() {},
  remove() {},
  closest() { return null; },
  insertBefore() {},
});

const makeSandbox = () => {
  const nodes = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      createElement: makeNode,
      createDocumentFragment: () => makeNode("fragment"),
      querySelector: (selector) => {
        if (!nodes.has(selector)) { nodes.set(selector, makeNode("div")); }
        return nodes.get(selector);
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      documentElement: makeNode("html"),
      body: makeNode("body"),
      head: makeNode("head"),
      activeElement: null,
      visibilityState: "visible",
    },
    localStorage: {
      _data: new Map(),
      getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
      setItem(key, value) { this._data.set(key, String(value)); },
      removeItem(key) { this._data.delete(key); },
    },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "test" },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    queueMicrotask(fn) { fn(); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    alert() {},
    confirm: () => false,
    prompt: () => null,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    URLSearchParams,
    URL,
    Intl,
    Date,
    // el() checks `child instanceof Node`; without it, boot's async work throws
    // after the test ends and surfaces as an unhandled rejection.
    Node: class Node {},
    // Boot fetches state on DOMContentLoaded. Rejecting immediately keeps the
    // scripts from starting real work we do not want to assert on here.
    Promise,
    _nodes: nodes,
  };
  sandbox.window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    location: { href: "http://127.0.0.1:8321/", search: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    open() {},
    devicePixelRatio: 1,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
};

test("every page script loads together without a global collision", () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  // app.js declares TOKEN itself from a meta tag, so the harness must NOT
  // pre-declare it or it would report a collision of its own making.

  const failures = [];
  for (const script of pageScripts()) {
    const file = path.join(WEB, script);
    assert.ok(fs.existsSync(file), `index.html references a missing script: ${script}`);
    try {
      vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: script });
    } catch (error) {
      // A ReferenceError deep in a render path is expected in a fake DOM; a
      // SyntaxError or a duplicate declaration is a genuine page-breaking bug.
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }

  assert.deepEqual(failures, [], `scripts cannot coexist in one global scope:\n${failures.join("\n")}`);
});

test("index.html references only scripts that exist", () => {
  for (const script of pageScripts()) {
    assert.ok(fs.existsSync(path.join(WEB, script)), `missing: ${script}`);
  }
});

test("the knowledge grid math module is reachable under its own global name", () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WEB, "knowledge_grid_math.js"), "utf8"), context, {
    filename: "knowledge_grid_math.js",
  });

  assert.equal(typeof sandbox.window.KnowledgeGridMath, "object");
  assert.equal(typeof sandbox.window.KnowledgeGridMath.windowFor, "function");
});

test("reader back returns to the view that opened the report", () => {
  const reader = fs.readFileSync(path.join(WEB, "reader.js"), "utf8");
  const appSource = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  assert.match(reader, /ai\.status === "failed" \? "AI 摘要失败"/u);
  assert.match(reader, /ai\.status === "indeterminate" \? "无法判断是否使用 AI"/u);
  assert.match(reader, /LLM 调用失败，已改用本地分组/u);
  assert.match(reader, /旧报告没有留下 LLM 成败记录，不能判断是未使用还是失败/u);
  assert.match(reader, /group\.llmError \? "LLM 失败" : group\.llmUnused \? "本地" : "无法判断"/u);
  assert.match(reader, /group\.llmError \? "LLM 失败" : group\.llmUnused \? "本地分组" : "无法判断 LLM"/u);
  assert.doesNotMatch(reader, /llmSummary !== null \? "LLM 主题" : "本地分组"/u);
  assert.match(reader, /data-testid": "reader-back"/u);
  assert.match(reader, /const returnFromReader/u);
  assert.match(reader, /app\.readerOrigin\?\.view === "history" \? "history" : "run"/u);
  assert.doesNotMatch(
    reader,
    /onclick:\s*\(\)\s*=>\s*\{\s*showView\("history"\);\s*renderHistoryView\(\);\s*\}/u,
  );
  assert.match(appSource, /openReader\(card\.runId,\s*\{\s*view:\s*"run"\s*\}/u);
  assert.match(appSource, /openReader\(runId,\s*\{\s*view:\s*"run"\s*\}/u);
  assert.match(appSource, /openReader\(run\.runId,\s*\{\s*view:\s*"history"\s*\}/u);
  assert.match(appSource, /readerOrigin:\s*\{\s*view:\s*"run"\s*\}/u);
});

test("reader group titles distinguish LLM failed, unused, and indeterminate", () => {
  const sandbox = makeSandbox();
  sandbox.document.querySelector('meta[name="cc-token"]').content = "test-token";
  const context = vm.createContext(sandbox);
  const failures = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);

  assert.equal(
    vm.runInContext('groupLlmTitleLabel({ llmSummary: { summary: "ok" } })', context),
    "LLM 主题",
  );
  assert.equal(
    vm.runInContext("groupLlmTitleLabel({ llmSummary: null, llmError: { failed: true } })", context),
    "LLM 失败",
  );
  assert.equal(
    vm.runInContext("groupLlmTitleLabel({ llmSummary: null, llmUnused: true })", context),
    "本地分组",
  );
  assert.equal(
    vm.runInContext("groupLlmTitleLabel({ llmSummary: null })", context),
    "无法判断 LLM",
  );
});

test("reader origin survives a round-trip through the fake page scripts", () => {
  const sandbox = makeSandbox();
  sandbox.document.querySelector('meta[name="cc-token"]').content = "test-token";
  const context = vm.createContext(sandbox);
  const failures = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);

  assert.equal(vm.runInContext("readerReturnView()", context), "run");
  vm.runInContext('rememberReaderOrigin({ view: "history" })', context);
  assert.equal(vm.runInContext("readerReturnView()", context), "history");
  assert.equal(vm.runInContext("readerBackLabel()", context), "← 返回历史");
  vm.runInContext("returnFromReader()", context);
  assert.equal(vm.runInContext("app.view", context), "history");

  vm.runInContext('rememberReaderOrigin({ view: "run" })', context);
  assert.equal(vm.runInContext("readerBackLabel()", context), "← 返回运行");
  vm.runInContext("returnFromReader()", context);
  assert.equal(vm.runInContext("app.view", context), "run");

  // Returning from the message drill-down must not clobber the opening view.
  vm.runInContext('rememberReaderOrigin({ view: "history" })', context);
  vm.runInContext("rememberReaderOrigin(undefined)", context);
  assert.equal(vm.runInContext("readerReturnView()", context), "history");
});

test("run view has a QQ paste cursor panel", () => {
  const source = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  assert.match(source, /label: "从 QQ 粘贴", type: "paste"/u);
  assert.match(source, /data-testid": "paste-start"/u);
  assert.match(source, /data-testid": "paste-end"/u);
  assert.match(source, /data-testid": "paste-match-btn"/u);
  assert.match(source, /\/api\/paste-cursor/u);
  assert.match(source, /请先把粘贴的消息对上本地记录/u);
});

test("catchup card keeps honest empty, error, and remainder copy", () => {
  const source = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  assert.match(source, /data-testid": "run-catchup-error"/u);
  assert.match(source, /data-testid": "run-catchup-empty"/u);
  assert.match(source, /无法加载上次总结/u);
  assert.match(source, /这次总结没有可展示的内容。范围内可能没有消息。/u);
  assert.match(source, /LLM 失败，已改用本地分组/u);
  assert.match(source, /本地分组（无法判断是否使用过 LLM）/u);
  assert.match(source, /group\.source === "failed" \|\| group\.llmFailed === true/u);
  assert.match(source, /group\.llmUnused === true \|\| card\.llmMode === "unused"/u);
  assert.match(source, /run\.llmStatus === "failed" \? "LLM 失败"/u);
  assert.match(source, /run\.llmStatus === "not-used" \? "仅本地分组" : "无法判断 LLM"/u);
  assert.match(source, /coverage\?\.status === "indeterminate"/u);
  assert.match(source, /coverage\?\.status === "failed"/u);
  assert.match(source, /还有 \$\{group\.moreOpenActions\} 件未办，见完整报告/u);
  assert.match(source, /还有 \$\{group\.moreRisks\} 个风险，见完整报告/u);
  assert.match(source, /还有 \$\{card\.hiddenGroupCount\} 个群见完整报告/u);
  assert.match(source, /data-testid": "run-catchup-empty-groups"/u);
  assert.match(source, /其余 \$\{count\} 个群这段没有消息/u);
  assert.match(source, /其余 \$\{count\} 个群没有看到消息，但扫描并不完整/u);
  assert.match(source, /其余 \$\{count\} 个群没有展示内容，无法判断是否漏了消息/u);
  assert.match(source, /catchupWindow\(card\)/u);
  assert.match(source, /扫描 \$\{requested\} · 消息 \$\{messages\}/u);
  assert.match(source, /扫描 \$\{requested\} · 无消息范围/u);
  assert.match(source, /data-testid": "run-catchup-scan"/u);
  assert.match(source, /扫描只覆盖了 \$\{pct\}%/u);
  assert.match(source, /不能当作已经补上看过的全部消息/u);
  assert.match(source, /这次没有有效扫描，不能当作已经补上看过的消息/u);
  assert.match(source, /旧报告没有扫描覆盖记录，不能据此断言没有漏消息/u);
  assert.match(source, /scanNote\?\.status === "complete" \? "扫描完整"/u);
  assert.match(source, /aiNote\?\.status === "complete" \? "AI 输入完整"/u);
  assert.match(source, /data-testid": "run-catchup-ai"/u);
  assert.match(source, /AI 摘要\$\{seen\}，不能当作已经看过这个范围的全部消息/u);
  assert.match(source, /旧报告没有保存 AI 输入覆盖，不能判断遗漏了多少文本/u);
});

test("catchup AI note warns on partial coverage and stays quiet when complete or unused", () => {
  const sandbox = makeSandbox();
  sandbox.document.querySelector('meta[name="cc-token"]').content = "test-token";
  const context = vm.createContext(sandbox);
  const failures = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);

  const noteJson = (expr) => vm.runInContext(`JSON.stringify(${expr})`, context);
  assert.equal(
    noteJson('catchupAiNote({ status: "partial", includedMessages: 60, totalMessages: 80 })'),
    JSON.stringify({
      status: "partial",
      text: "AI 摘要只处理了 60/80 条文本，不能当作已经看过这个范围的全部消息。",
    }),
  );
  assert.equal(
    noteJson('catchupAiNote({ status: "partial" })'),
    JSON.stringify({
      status: "partial",
      text: "AI 摘要没有覆盖全部文本，不能当作已经看过这个范围的全部消息。",
    }),
  );
  assert.equal(
    noteJson('catchupAiNote({ status: "unknown" })'),
    JSON.stringify({
      status: "unknown",
      text: "旧报告没有保存 AI 输入覆盖，不能判断遗漏了多少文本。",
    }),
  );
  assert.equal(
    noteJson('catchupAiNote({ status: "complete", includedMessages: 12, totalMessages: 12 })'),
    JSON.stringify({ status: "complete", text: "" }),
  );
  assert.equal(
    noteJson('catchupAiNote({ status: "not-used" })'),
    JSON.stringify({ status: "not-used", text: "" }),
  );
  assert.equal(vm.runInContext("catchupAiNote(null)", context), null);
});

test("catchup window keeps requested scan range separate from the message span", () => {
  const sandbox = makeSandbox();
  sandbox.document.querySelector('meta[name="cc-token"]').content = "test-token";
  const context = vm.createContext(sandbox);
  const failures = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);

  const requested = vm.runInContext(
    '`${unixToHkt(1755648000).slice(0, 16)} — ${unixToHkt(1755734400).slice(0, 16)}`',
    context,
  );
  assert.equal(
    vm.runInContext(
      'catchupWindow({ firstHkt: "2026-08-20 10:06:58", lastHkt: "2026-08-21 10:05:20", scan: { requestedStartUnix: 1755648000, requestedEndUnix: 1755734400 } })',
      context,
    ),
    `扫描 ${requested} · 消息 2026-08-20 10:06 — 2026-08-21 10:05`,
  );
  assert.equal(
    vm.runInContext(
      'catchupWindow({ firstHkt: "", lastHkt: "", scan: { requestedStartUnix: 1755648000, requestedEndUnix: 1755734400 } })',
      context,
    ),
    `扫描 ${requested} · 无消息范围`,
  );
  assert.equal(
    vm.runInContext(
      'catchupWindow({ firstHkt: null, lastHkt: null, scan: { status: "complete", requestedStartUnix: null, requestedEndUnix: null } })',
      context,
    ),
    "",
  );
  assert.equal(
    vm.runInContext(
      'catchupWindow({ firstHkt: "2026-08-20 10:06:58", lastHkt: "2026-08-21 10:05:20" })',
      context,
    ),
    "消息 2026-08-20 10:06 — 2026-08-21 10:05",
  );
  assert.equal(
    vm.runInContext(
      'catchupWindow({ firstHkt: "N/A", lastHkt: "N/A", scan: { requestedStartUnix: "nope" } })',
      context,
    ),
    "",
  );
});

test("catchup empty-groups note is definite only when the scan is complete", () => {
  const sandbox = makeSandbox();
  sandbox.document.querySelector('meta[name="cc-token"]').content = "test-token";
  const context = vm.createContext(sandbox);
  const failures = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);

  assert.equal(
    vm.runInContext('catchupEmptyGroupsNote({ emptyGroupCount: 17, scan: { status: "complete" } })', context),
    "其余 17 个群这段没有消息。",
  );
  assert.equal(
    vm.runInContext('catchupEmptyGroupsNote({ emptyGroupCount: 2, scan: { status: "partial" } })', context),
    "其余 2 个群没有看到消息，但扫描并不完整。",
  );
  assert.equal(
    vm.runInContext('catchupEmptyGroupsNote({ emptyGroupCount: 2, scan: { status: "unknown" } })', context),
    "其余 2 个群没有展示内容，无法判断是否漏了消息。",
  );
  assert.equal(
    vm.runInContext('catchupEmptyGroupsNote({ emptyGroupCount: 2, scan: { status: "none" } })', context),
    "其余 2 个群没有有效扫描。",
  );
  assert.equal(
    vm.runInContext("catchupEmptyGroupsNote({ emptyGroupCount: 3 })", context),
    "其余 3 个群没有可展示的内容。",
  );
  assert.equal(vm.runInContext("catchupEmptyGroupsNote({ emptyGroupCount: 0 })", context), "");
});

test("knowledge overlay does not re-clamp the prompt the card promised in full", () => {
  // Cards say 点图看完整 after a 320-char slice. If the overlay also slices,
  // clicking a thumb still shows the same truncated prompt.
  const source = fs.readFileSync(path.join(WEB, "knowledge.js"), "utf8");
  assert.match(source, /promptBlock\(item\.prompt,\s*"咒语",\s*\{\s*clamp:\s*false\s*\}\)/u);
  assert.match(source, /promptBlock\(item\.negativePrompt,\s*"负面咒语",\s*\{\s*clamp:\s*false\s*\}\)/u);
  assert.match(
    source,
    /const shouldClamp = clamp && \(truncated \|\| text\.length > PROMPT_CLAMP_CHARS\)/u,
  );
});

test("no two page scripts declare the same top-level const", () => {
  // Catches the collision class directly, with a readable message naming both
  // files, rather than only failing at evaluation time.
  const declarations = new Map();
  const duplicates = [];
  for (const script of pageScripts()) {
    const source = fs.readFileSync(path.join(WEB, script), "utf8");
    for (const match of source.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gmu)) {
      const name = match[1];
      const owner = declarations.get(name);
      if (owner !== undefined && owner !== script) {
        duplicates.push(`${name}: declared in both ${owner} and ${script}`);
      } else {
        declarations.set(name, script);
      }
    }
  }

  assert.deepEqual(duplicates, [], `top-level identifiers collide across classic scripts:\n${duplicates.join("\n")}`);
});
