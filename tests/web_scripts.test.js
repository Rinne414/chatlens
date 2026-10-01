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

const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

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
      // The error comes from the context's realm, so `instanceof SyntaxError`
      // is always false here: compare the name.
      if (error?.name === "SyntaxError" || /already been declared/u.test(error.message)) {
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

test("the pure helper modules are reachable under their own global names", () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  for (const file of ["wall_layout.js", "kb_tokens.js", "relation_graph.js", "qq_collection_days.js", "brief_text.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, file), "utf8"), context, { filename: file });
  }

  assert.equal(typeof sandbox.window.WallLayout.layoutWall, "function");
  assert.equal(typeof sandbox.window.KbTokens.tokenLabel, "function");
  assert.equal(typeof sandbox.window.RelationGraph.layoutGraph, "function");
  assert.equal(typeof sandbox.window.QqcDays.qqcUnsavedRuns, "function");
  assert.equal(typeof sandbox.window.BriefText.summaryParts, "function");
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

// The chat used to keep every page it ever loaded and rebuild the whole list
// on each one: 70 s of scrolling an image-heavy group reached 3,320 messages,
// ~100k DOM nodes and +700 MB in the browser (measured 2026-09-25).
const loadPageContext = () => {
  const context = vm.createContext(makeSandbox());
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // Render paths fail in the fake DOM; the declarations are what we need.
    }
  }
  return context;
};

test("the chat keeps a bounded window of loaded messages", () => {
  const context = loadPageContext();
  const windowedItems = vm.runInContext("windowedItems", context);
  const max = vm.runInContext("CHAT_WINDOW", context);
  const page = vm.runInContext("MSG_PAGE_SIZE", context);
  assert.ok(max >= 2 * page, "the window holds at least two pages");
  const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ rowId: String(from + i) }));

  const small = rows(0, 10);
  const kept = windowedItems(small, max, "start");
  assert.equal(kept.items, small);
  assert.equal(kept.dropped.length, 0);

  const appended = windowedItems(rows(0, max + page), max, "start");
  assert.equal(appended.items.length, max);
  assert.equal(appended.items[0].rowId, String(page));
  assert.deepEqual(Array.from(appended.dropped, (row) => row.rowId), rows(0, page).map((row) => row.rowId));

  const prepended = windowedItems(rows(0, max + page), max, "end");
  assert.equal(prepended.items.length, max);
  assert.equal(prepended.items.at(-1).rowId, String(max - 1));
  assert.equal(prepended.dropped[0].rowId, String(max));
});

test("chat paging inserts pages instead of rebuilding the list", () => {
  const source = fs.readFileSync(path.join(WEB, "messages.js"), "utf8");
  const paging = fs.readFileSync(path.join(WEB, "chat_paging.js"), "utf8");
  const observers = paging.slice(paging.indexOf("const setupChatObservers"));
  assert.match(observers, /applyChatPage\(listNode, page, "top"\)/u);
  assert.match(observers, /applyChatPage\(listNode, page, "bottom"\)/u);
  assert.doesNotMatch(observers, /renderMessagesView\(\)/u);
  const apply = paging.slice(paging.indexOf("const applyChatPage"), paging.indexOf("const setupChatObservers"));
  assert.match(apply, /prependChatPage\(list, page\)/u);
  assert.match(apply, /appendChatPage\(list, page\)/u);
  // Selection survives pages being added or dropped: it is kept by message, not by index.
  assert.doesNotMatch(source, /onSelectMessage\(index\)/u);
});

test("chat pictures get their thumbnail's size before they load", () => {
  // Tencent's thumbnail is the picture scaled to 300 px on its long side, never
  // enlarged (measured 2026-09-25). A box of that size keeps the list from
  // changing height as thumbnails arrive, so inserted pages keep the reader's place.
  const context = loadPageContext();
  const thumbBox = vm.runInContext("thumbBox", context);
  const plain = (box) => ({ width: box.width, height: box.height });
  assert.deepEqual(plain(thumbBox({ width: 832, height: 1216 })), { width: 205, height: 300 });
  assert.deepEqual(plain(thumbBox({ width: 1536, height: 1024 })), { width: 300, height: 200 });
  assert.deepEqual(plain(thumbBox({ width: 60, height: 42 })), { width: 60, height: 42 });
  // Stickers are shown within 140 x 140.
  assert.deepEqual(plain(thumbBox({ width: 1080, height: 662 }, 140)), { width: 140, height: 86 });
  assert.deepEqual(plain(thumbBox({ width: 100, height: 92 }, 140)), { width: 100, height: 92 });
  assert.deepEqual(plain(thumbBox({ width: 0, height: 0 })), { width: undefined, height: undefined });
});

test("an avatar's letter is a whole character even when the name starts with an emoji", () => {
  const context = loadPageContext();
  const firstGrapheme = vm.runInContext("firstGrapheme", context);
  assert.equal(firstGrapheme("🥛示例牛奶工厂🐺"), "🥛");
  assert.equal(firstGrapheme("⭕示例的小Kの群"), "⭕");
  assert.equal(firstGrapheme("  示例咖啡厅"), "示");
  assert.equal(firstGrapheme(""), "");
});

test("mentions from one person in one group fold into a thread; ones you were there for go last", () => {
  const context = loadPageContext();
  const threadsOf = vm.runInContext("briefMentionThreads", context);
  const mention = (rowId, sentAt, fields = {}) => ({ groupId: "1", groupName: "g", rowId, sentAt, speaker: "Bot", kind: "at", text: rowId, youWereThere: false, ...fields });
  const threads = threadsOf([
    mention("b1", 1000, { youWereThere: true }),
    mention("b2", 1100, { youWereThere: true }),
    mention("b3", 1200, { youWereThere: true }),
    mention("x", 1150, { speaker: "Alice" }),
    mention("all", 1300, { kind: "atAll", speaker: "Admin" }),
    mention("b4", 1200 + 31 * 60, { youWereThere: true }),
  ]);
  // Arrays from the page context have another realm's prototype: compare as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(threads.map((thread) => thread.items.map((item) => item.rowId)))), [["x"], ["b4"], ["b3", "b2", "b1"], ["all"]]);
});

test("a followed word is marked in the text, whatever its case and even with regex characters", () => {
  const context = loadPageContext();
  const markWord = vm.runInContext("briefMarkWord", context);
  const marked = (parts) => [...parts].filter((part) => typeof part !== "string").map((node) => String(node.children.join("")));
  assert.deepEqual(marked(markWord("新 Anima 和 anima 都好", "anima")), ["Anima", "anima"]);
  assert.deepEqual(marked(markWord("试了 qwen image (2.1)* 版", "Qwen Image (2.1)*")), ["qwen image (2.1)*"]);
  assert.deepEqual(marked(markWord("没有提到", "anima")), []);
});

test("a group card drops an opening clause that only states the date range", () => {
  const context = loadPageContext();
  const drop = vm.runInContext("briefDropDatePreamble", context);
  assert.equal(drop("从9月29日凌晨到30日零点，群聊主线几乎都围着炼丹转。"), "群聊主线几乎都围着炼丹转。");
  assert.equal(drop("2026-09-29 凌晨到 9 月 30 日零点，群聊主要围着 NovelAI。"), "群聊主要围着 NovelAI。");
  // No date in the clause: it is content.
  assert.equal(drop("凌晨有人发了新模型，大家都在试。"), "凌晨有人发了新模型，大家都在试。");
  assert.equal(drop("本段时间群聊从凌晨持续到深夜，话题跨度较大。"), "本段时间群聊从凌晨持续到深夜，话题跨度较大。");
  assert.equal(drop("没有逗号的一句话"), "没有逗号的一句话");
  // A date that comes with news is the news.
  assert.equal(drop("9月30日 GPT-6 发布，群里都在讨论。"), "9月30日 GPT-6 发布，群里都在讨论。");
  assert.equal(drop("2026-09-29这批群聊从凌晨03:31到23:58，中间空了很久。"), "2026-09-29这批群聊从凌晨03:31到23:58，中间空了很久。");
  assert.equal(drop("9月29日凌晨到次日00:23，群里在聊显卡。"), "群里在聊显卡。");
});

test("one model file saved under several names is one facet row", () => {
  const context = loadPageContext();
  const merge = vm.runInContext("mergeNameVariants", context);
  const rows = JSON.parse(JSON.stringify(merge([
    { value: "anima_baseV10.safetensors", count: 694 },
    { value: "anima_baseV10", count: 497 },
    { value: "anima\\anima_baseV10.safetensors", count: 143 },
    { value: "anima-base-v1.0.safetensors", count: 881 },
  ])));
  assert.deepEqual(rows.map((row) => [row.value, row.count, row.variants.length]), [["anima_baseV10", 1334, 3], ["anima-base-v1.0", 881, 1]]);
});

test("a chat page that arrives after the chat moved on is dropped, and 到最新 loads the newest page at once", () => {
  const source = fs.readFileSync(path.join(WEB, "messages.js"), "utf8");
  const body = (name) => source.slice(source.indexOf(`const ${name} = async`), source.indexOf("\n};\n", source.indexOf(`const ${name} = async`)));
  for (const name of ["loadMessages", "loadOlderMessages", "loadNewestPage"]) {
    assert.match(body(name), /isStaleLoad\(generation, groupId\)/u, `${name} must drop stale answers`);
    assert.match(body(name), /finishLoad\(generation\)/u, `${name} must only clear its own loading flag`);
  }
  assert.match(body("loadMessages"), /reset \? nextLoadGeneration\(\)/u);
  assert.doesNotMatch(body("goToLatest"), /guard < 20/u);
  assert.match(body("goToLatest"), /loadNewestPage\(\)/u);
});

test("a 回顾 search sends whole Beijing days for 7 天 and chosen dates, and nothing for 全部时间", () => {
  const context = loadPageContext();
  // 2026-09-30 12:00 Beijing.
  vm.runInContext(`Date.now = () => ${Date.UTC(2026, 8, 30, 4)}`, context);
  const params = () => Object.fromEntries(vm.runInContext("reviewSearchParams({ messageOffset: 20 })", context));
  vm.runInContext('reviewState.query = "anima"', context);

  assert.deepEqual(params(), { q: "anima", messageOffset: "20" });

  vm.runInContext('reviewState.searchRange = "7"', context);
  assert.deepEqual(params(), { q: "anima", messageOffset: "20", fromUnix: String(Date.UTC(2026, 8, 23, 16) / 1000) });

  vm.runInContext('Object.assign(reviewState, { searchRange: "custom", searchFrom: "2026-09-01", searchTo: "2026-09-03" })', context);
  assert.deepEqual(params(), {
    q: "anima",
    messageOffset: "20",
    fromUnix: String(Date.UTC(2026, 7, 31, 16) / 1000),
    toUnix: String(Date.UTC(2026, 8, 3, 16) / 1000),
  });
});

test("问群聊 says how many messages there were when a keyword's search was cut off", () => {
  const context = loadPageContext();
  const found = vm.runInContext("askFoundText", context);
  assert.equal(found({ matchedMessages: 12, hitsUsed: 5, capped: false }), "找到 12 条相关消息，读了其中 5 处的上下文");
  // An answer saved before the fields existed reads as before.
  assert.equal(found({ matchedMessages: 12, hitsUsed: 5 }), "找到 12 条相关消息，读了其中 5 处的上下文");
  assert.equal(
    found({ matchedMessages: 400, totalMatches: 2345, capped: true, searchedFrom: Date.UTC(2026, 8, 20, 4) / 1000, hitsUsed: 40 }),
    "相关消息共 2,345 条，搜了最新的 400 条（2026-09-20 以后），读了其中 40 处的上下文",
  );
});

test("a backup whose scan stopped early never says it is safe to clean up", () => {
  const context = loadPageContext();
  // Nested elements stay nodes (the fake DOM has no real Node class).
  vm.runInContext("globalThis.Node = { [Symbol.hasInstance]: (value) => typeof value === \"object\" && value !== null }", context);
  const backupVerdict = vm.runInContext("backupVerdict", context);
  const textOf = (node) => (typeof node === "string" ? node : `${node?._text ?? ""}${(node?.children ?? []).map(textOf).join("")}`);
  const verdict = (report) => ({ textContent: textOf(backupVerdict(report)) });
  const report = {
    mode: "save",
    totals: { total: 10, thumbOnly: 0, compressed: 0, missing: 0 },
    groups: [{ groupId: "1001", groupName: "画图群" }],
    emptyGroups: [{ groupId: "2002", groupName: "" }],
  };
  assert.match(verdict(report).textContent, /可以放心清理/u);
  const stopped = verdict({ ...report, incompleteScan: { reason: "scan-limit", groupIds: ["1001", "2002"] } }).textContent;
  assert.match(stopped, /2 个群的消息没扫完，先别清理/u);
  assert.match(stopped, /画图群、2002/u);
  assert.doesNotMatch(stopped, /放心清理/u);
});

test("a backup table row never says 可清理 or 没有文件 for a group whose scan stopped early", () => {
  const context = loadPageContext();
  vm.runInContext("globalThis.Node = { [Symbol.hasInstance]: (value) => typeof value === \"object\" && value !== null }", context);
  const table = vm.runInContext("backupGroupTable", context);
  const textOf = (node) => (typeof node === "string" ? node : `${node?._text ?? ""}${(node?.children ?? []).map(textOf).join("")}`);
  const report = {
    groups: [{ groupId: "1001", groupName: "画图群", byKind: {}, ai: 0, asked: 0, logDays: 1, verdict: "safe" }],
    emptyGroups: [{ groupId: "2002", groupName: "闲聊群", logDays: 0 }],
  };
  assert.match(textOf(table(report)), /可清理.*没有文件/u);
  const stopped = textOf(table({ ...report, incompleteScan: { reason: "scan-limit", groupIds: ["1001", "2002"] } }));
  assert.doesNotMatch(stopped, /可清理|没有文件/u);
  assert.equal(stopped.match(/没扫完/gu).length, 2);
});

test("这次更新的新东西: every link opens a real page, and 知道了 hides the card", () => {
  const context = loadPageContext();
  const items = JSON.parse(JSON.stringify(vm.runInContext("WHATS_NEW", context)));
  const views = Object.keys(JSON.parse(JSON.stringify(vm.runInContext("VIEW_TITLES", context))));
  for (const item of items.filter((entry) => entry.view !== null)) {
    assert.ok(views.includes(item.view), `unknown page ${item.view}`);
    assert.ok(item.selector.length > 0, item.title);
  }
  assert.notEqual(vm.runInContext("whatsNewCard()", context), null);
  try {
    vm.runInContext("dismissWhatsNew()", context);
  } catch {
    // Its redraw may fail in the fake DOM; the card state is set before it.
  }
  assert.equal(vm.runInContext("whatsNewCard()", context), null);
});

test("closing the console says what stops, whether it comes back at login, and how to reopen it", () => {
  const context = loadPageContext();
  const question = vm.runInContext("quitQuestion", context);
  const windows = question({ running: true, desktop: { platform: "win32", appShortcut: true, autostart: true } });
  assert.match(windows, /这一轮刷新会中断/u);
  assert.match(windows, /下次登录它会自己启动/u);
  assert.match(windows, /开始菜单里的「ChatLens」，或按 Ctrl\+Alt\+U/u);
  const quiet = question({ running: false, desktop: { platform: "linux", appShortcut: true, autostart: false } });
  assert.doesNotMatch(quiet, /中断|自己启动/u);
  assert.match(quiet, /应用菜单/u);
  // Status unknown (the request failed): still a clear question.
  assert.match(question(null), /^关闭控制台？/u);
  assert.match(question(null), /启动脚本/u);
});

test("Ctrl+K: pages, groups and words match every word typed, and any text can go to 回顾 / 问群聊 / 收藏", () => {
  const context = loadPageContext();
  const entries = vm.runInContext("paletteEntries", context);
  const sources = {
    pages: [["brief", "简报"], ["knowledge", "咒语库"], ["settings", "设置"]],
    groups: [{ groupId: "1001", name: "示例咖啡厅" }, { groupId: "1002", name: "示例画室MKII" }],
    words: [{ word: "anima", total: 47 }],
  };
  const labels = (query) => JSON.parse(JSON.stringify(entries(sources, query))).map((entry) => entry.label);

  // Nothing typed: every page, command, group and word; no search hand-offs.
  const all = labels("");
  assert.equal(all.length, 3 + 2 + 2 + 1);
  assert.ok(!all.some((label) => label.startsWith("在回顾里搜")));

  // A page by an alias, a group by part of its name, a word; hand-offs last.
  assert.deepEqual(labels("lora").slice(0, 1), ["咒语库"]);
  assert.deepEqual(labels("示例咖啡").slice(0, 1), ["示例咖啡厅"]);
  assert.deepEqual(labels("ANIMA"), ["关注的词：anima", "在回顾里搜「ANIMA」", "问群聊：ANIMA", "在收藏里找「ANIMA」"]);
  // Every word must match.
  assert.deepEqual(labels("示例 mkii").slice(0, 1), ["示例画室MKII"]);
  assert.deepEqual(labels("关闭").slice(0, 1), ["关闭控制台"]);
  assert.equal(labels("完全不存在的词").length, 3);
});
