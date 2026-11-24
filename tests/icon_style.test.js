"use strict";

// 设置 → 界面 → 图标: emoji (the default) or the drawn line icons.

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
      // Boot paths may throw in the fake DOM; the helpers under test do not.
    }
  }
  return (expression) => vm.runInContext(expression, context);
};

test("emoji is the default, and labels keep their emoji", () => {
  const run = loadPage();
  assert.equal(run("settings.iconStyle"), "emoji");
  assert.equal(run("emojiLabel('🧠', '总结所选')"), "🧠 总结所选");
  assert.equal(run("mediaLabelText('image', '看这个')"), "📷 [图片] 看这个");
  assert.equal(run("iconAndWord('brief', '📰', '简报')[0]"), "📰 简报");
});

test("with line icons chosen, labels are their words and the rail gets a drawn icon beside the word", () => {
  const run = loadPage();
  run("settings.iconStyle = 'line'");
  assert.equal(run("emojiLabel('🧠', '总结所选')"), "总结所选");
  assert.equal(run("emojiMark('✅', '✓')"), "✓");
  assert.equal(run("mediaLabelText('image', '')"), "[图片]");
  assert.equal(run("iconAndWord('brief', '📰', '简报').length"), 2);
});

test("every page on the rail has a drawn icon, so the line set leaves no entry bare", () => {
  const run = loadPage();
  assert.equal(run("Object.keys(NAV_ICONS).filter((name) => ICON_PATHS[name] === undefined).join(',')"), "");
});

test("an unknown stored value falls back to emoji", () => {
  const run = loadPage();
  assert.equal(run("ICON_STYLES.includes('svg')"), false);
  run("changeIconStyle('svg')");
  assert.equal(run("settings.iconStyle"), "emoji");
});
