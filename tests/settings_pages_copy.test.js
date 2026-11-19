"use strict";

// 存储, 设置 and 备份 for someone with no helper: the headline never passes a
// partial sum off as the total, AI costs are named by what they bought, and
// the expiring numbers on 备份 add up to what the rail says.

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
      // Render paths may throw in the fake DOM; the helpers under test are pure.
    }
  }
  return (expression) => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
};

const ITEMS = [
  { id: "qq-databases", label: "QQ 的聊天数据库" },
  { id: "message-store", label: "本程序的消息库" },
  { id: "knowledge-media", label: "留存的原图（咒语库的图片也在这里）" },
  { id: "picture-cache", label: "群图片缓存" },
];

const totalsFor = (run, measured, measuring = []) => run(`storageToolTotals(${JSON.stringify(ITEMS)},
  new Map(${JSON.stringify(measured)}.map(([id, bytes]) => [id, { bytes }])), new Set(${JSON.stringify(measuring)}))`);

test("存储 says 「至少」 and names the rows not counted yet, leaving QQ's folders out", () => {
  const run = loadPage();

  const totals = totalsFor(run, [["qq-databases", 900], ["message-store", 100]]);
  const headline = run(`storageToolHeadline(${JSON.stringify(totals)})`);

  assert.equal(totals.bytes, 100);
  assert.deepEqual(totals.missing.map((item) => item.label), ["留存的原图", "群图片缓存"]);
  assert.equal(headline.label, "本程序至少占用");
  assert.equal(headline.note, "还有 2 项没算：留存的原图、群图片缓存");
});

test("存储 says the total once every row of the program is counted", () => {
  const run = loadPage();

  const totals = totalsFor(run, [["message-store", 100], ["knowledge-media", 2000], ["picture-cache", 30]]);
  const headline = run(`storageToolHeadline(${JSON.stringify(totals)})`);

  assert.equal(totals.bytes, 2130);
  assert.equal(headline.label, "本程序一共占用");
});

test("存储 tells a running count apart from one nobody started", () => {
  const run = loadPage();

  const totals = totalsFor(run, [["message-store", 100]], ["knowledge-media"]);

  assert.equal(totals.busy, true);
  assert.match(run(`storageToolHeadline(${JSON.stringify(totals)}).note`), /^正在计算，还差 2 项/u);
});

test("every delete on 存储 says what goes and that it cannot be undone", () => {
  const run = loadPage();
  const question = (id) => run(`storageCleanupQuestion({ id: ${JSON.stringify(id)} }, 2048)`);

  assert.match(question("run-files"), /不能恢复/u);
  assert.match(question("reports-exports"), /不能恢复/u);
  assert.match(question("reports-exports"), /另存到文件夹/u);
  assert.match(question("temporary-files"), /消息库、补扫进度、报告和留存的原图都不受影响/u);
  assert.match(question("run-files"), /约 2/u);
});

test("AI costs are named by what the user got, and unknown kinds stay visible", () => {
  const run = loadPage();
  const label = (purpose) => run(`aiPurposeLabel(${JSON.stringify(purpose)})`);

  for (const purpose of ["map", "reduce", "notes-aliases", "notes-topics", "notes-consensus", "things", "redo"]) {
    assert.doesNotMatch(label(purpose), /^[a-z-]+$/u, purpose);
  }
  assert.equal(label("reduce"), "简报：把各段摘要合成群总览");
  assert.equal(label("notes-topics"), "笔记库：把东西归到主题");
  assert.equal(label("new-kind"), "其他用途（new-kind）");
});

test("the AI tile names exactly what is missing", () => {
  const run = loadPage();
  const detail = (status) => run(`aiReadiness(${JSON.stringify(status)}).detail`);
  const base = { grok: null, llm: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } };

  assert.equal(detail({ ...base, llmKeySaved: false }), "还没填 API Key");
  assert.equal(detail({ ...base, llmKeySaved: false, llm: { baseUrl: "", model: "" } }), "还没填 API Key 和 模型名");
  assert.equal(detail({ ...base, llmKeySaved: true }), "deepseek-chat");
});

test("备份 splits the not-kept AI originals so the parts add up to the total", () => {
  const run = loadPage();
  const items = [0, 0, 3, 6, 7, 20].map((daysLeft) => ({ daysLeft }));

  assert.deepEqual(run(`rescueExpiryBuckets(${JSON.stringify(items)})`), { day: 2, week: 2, later: 2 });
  assert.equal(run(`rescueExpiryLine(${JSON.stringify(items)})`), "共 6 张，按删除先后从左到右排：不到 1 天就删除 2 张，7 天内删除 2 张，更晚 2 张。");
  assert.equal(run("rescueBadgeText(0)"), "不到 1 天");
  assert.equal(run("rescueBadgeText(5)"), "5 天");
  assert.match(run("backupExpiringSub({ total: 5940, soon: 1173 })"), /其中 1,173 张 7 天内删除（左栏提醒的就是这些）/u);
});

test("全部留存 states the count, the size and where the files go before it starts", () => {
  const run = loadPage();

  const question = run(`rescueKeepAllQuestion(${JSON.stringify([{ size: 1048576 }, { size: 1048576 }])})`);

  assert.match(question, /^留存全部 2 张/u);
  assert.match(question, /不是下面的备份文件夹/u);
  assert.match(question, /约 2(\.0)? MB/u);
});
