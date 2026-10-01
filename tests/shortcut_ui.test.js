"use strict";

// The ways back into the app without the install folder: 设置 offers a
// desktop and a Start-menu shortcut, the home page asks once about the
// desktop, and closing the console names whichever shortcut exists.

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

const WINDOWS = { platform: "win32", appShortcut: true, desktopShortcut: false, autostart: false, shortcutAsked: false };
const LINUX = { platform: "linux", appShortcut: true, desktopShortcut: null, autostart: false, shortcutAsked: false };

test("设置 offers a desktop and a Start-menu shortcut on Windows, showing which exist", () => {
  const run = loadPage();

  const options = JSON.parse(JSON.stringify(run(`shortcutOptions(${JSON.stringify(WINDOWS)})`)));

  assert.deepEqual(options.map((option) => [option.kind, option.label, option.on]), [
    ["desktop", "桌面", false],
    ["startMenu", "开始菜单", true],
  ]);
});

test("Linux gets only the app-menu entry", () => {
  const run = loadPage();

  const options = JSON.parse(JSON.stringify(run(`shortcutOptions(${JSON.stringify(LINUX)})`)));

  assert.deepEqual(options.map((option) => [option.kind, option.label]), [["startMenu", "应用菜单"]]);
});

test("the home page asks about a desktop shortcut until it has been answered", () => {
  const run = loadPage();
  const promptFor = (desktop) => run(`shortcutState.desktop = ${JSON.stringify(desktop)}; shortcutPromptCard()`);

  assert.notEqual(promptFor(WINDOWS), null);
  assert.equal(promptFor({ ...WINDOWS, shortcutAsked: true }), null);
  assert.equal(promptFor({ ...WINDOWS, desktopShortcut: true }), null);
  assert.equal(promptFor(LINUX), null);
});

test("closing the console names the desktop shortcut when there is one", () => {
  const run = loadPage();
  const hint = (desktop) => run(`quitReopenHint(${JSON.stringify(desktop)})`);

  assert.match(hint({ ...WINDOWS, desktopShortcut: true }), /桌面.*开始菜单.*Ctrl\+Alt\+U/u);
  assert.match(hint({ ...WINDOWS, appShortcut: false, desktopShortcut: true }), /桌面上的「QQ 群消息简报」/u);
  assert.match(hint({ ...WINDOWS, appShortcut: false }), /Start-QQ-Console\.cmd/u);
});
