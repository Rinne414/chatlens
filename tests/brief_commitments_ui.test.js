"use strict";

// 简报's 答应过的事 block: absent until something was found, so a briefing
// without promises looks the way it always did.

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
  return (expression) => vm.runInContext(expression, context);
};

const ITEM = { groupId: "1", groupName: "画图群", rowId: "9", kind: "promise", what: "帮 Alice 看工作流", who: "Alice", quote: "好，晚点看", sentAt: 1790000000, status: "open", statusAt: 0 };

const sectionWith = (run, data, extra = "") => run(`briefCommitments.data = ${JSON.stringify(data)}; ${extra} briefCommitmentsSection()`);

test("the block is absent before the list arrives and while there is nothing in it", () => {
  const run = loadPage();
  assert.equal(run("briefCommitmentsSection()"), null);
  assert.equal(sectionWith(run, { open: [], done: [], lookedUntil: null, notRunning: null }), null);
});

test("it appears with open items, with only finished ones, and right after one was taken off", () => {
  const run = loadPage();
  assert.notEqual(sectionWith(run, { open: [ITEM], done: [] }), null);
  assert.notEqual(sectionWith(run, { open: [], done: [{ ...ITEM, status: "done", statusAt: 1790000100 }] }), null);
  assert.notEqual(sectionWith(run, { open: [], done: [] }, `briefCommitments.justDropped = ${JSON.stringify(ITEM)};`), null);
});

test("my promises and requests to me are one side, what others promised me the other", () => {
  const run = loadPage();
  const sides = JSON.parse(JSON.stringify(run(`COMMITMENT_SIDES.map(([key, title, belongs]) => [key, title, ["promise", "asked", "owed"].filter((kind) => belongs({ kind }))])`)));
  assert.deepEqual(sides, [["mine", "我要做的", ["promise", "asked"]], ["theirs", "别人答应我的", ["owed"]]]);
});
