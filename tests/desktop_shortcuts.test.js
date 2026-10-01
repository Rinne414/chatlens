"use strict";

// Shortcuts: a Start-menu entry by default (unless the user removed it in
// 设置), an optional desktop one, and a one-time rewrite of shortcuts made by
// older versions, which showed node.exe's icon instead of the app's.
// Only the pure decisions are tested: nothing here touches a real Start menu.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const fs = require("node:fs");
const os = require("node:os");

const {
  bootShortcutPlan,
  windowsShortcutEnv,
  withRenamedShortcuts,
  removeObsoleteLaunchers,
  desktopEntry,
  SHORTCUT_VERSION,
} = require("../src/server/desktop_ops");

const status = (fields) => ({ appShortcut: false, desktopShortcut: false, autostart: false, ...fields });
const current = { startMenu: true, version: SHORTCUT_VERSION };

test("a first start creates the Start-menu entry and nothing else", () => {
  assert.deepEqual(bootShortcutPlan({ status: status({}), prefs: { startMenu: true, version: 1 } }), ["startMenu"]);
});

test("a Start-menu entry the user removed in 设置 is not put back", () => {
  assert.deepEqual(bootShortcutPlan({ status: status({}), prefs: { ...current, startMenu: false } }), []);
});

test("a Start-menu entry deleted by hand comes back, as before", () => {
  assert.deepEqual(bootShortcutPlan({ status: status({}), prefs: current }), ["startMenu"]);
});

test("up-to-date shortcuts are left alone", () => {
  const all = status({ appShortcut: true, desktopShortcut: true, autostart: true });

  assert.deepEqual(bootShortcutPlan({ status: all, prefs: current }), []);
});

test("shortcuts from an older version are rewritten once, and only those that exist", () => {
  const some = status({ appShortcut: true, desktopShortcut: false, autostart: true });

  assert.deepEqual(bootShortcutPlan({ status: some, prefs: { startMenu: true, version: 1 } }), ["startMenu", "autostart"]);
});

test("a desktop shortcut is never created at start, only refreshed", () => {
  const onDesktop = status({ appShortcut: true, desktopShortcut: true });

  assert.deepEqual(bootShortcutPlan({ status: onDesktop, prefs: { startMenu: true, version: 1 } }), ["startMenu", "desktop"]);
  assert.deepEqual(bootShortcutPlan({ status: status({ appShortcut: true }), prefs: current }), []);
});

test("Windows shortcuts carry the app icon and start the launcher", () => {
  const env = windowsShortcutEnv("C:\\Users\\a\\Desktop\\x.lnk", { background: false, hotkey: "" });

  assert.equal(env.CL_ICON, `${path.join(path.dirname(require.resolve("../package.json")), "web", "icons", "app.ico")},0`);
  assert.match(env.CL_ARGS, /launcher\.js"$/u);
  assert.equal(env.CL_HOTKEY, "");
});

test("the background (login) shortcut asks the launcher to stay hidden", () => {
  const env = windowsShortcutEnv("C:\\x.lnk", { background: true, hotkey: "" });

  assert.match(env.CL_ARGS, /launcher\.js" --background$/u);
});

test("shortcuts under the old name are made again under the new one", () => {
  const renamed = withRenamedShortcuts(status({ appShortcut: false, desktopShortcut: false, autostart: false }), { desktop: true, autostart: true });

  assert.equal(renamed.desktopShortcut, true);
  assert.equal(renamed.autostart, true);
  // The Start-menu entry is made whenever it is missing (unless removed in 设置).
  assert.deepEqual(bootShortcutPlan({ status: renamed, prefs: { startMenu: true, version: SHORTCUT_VERSION - 1 } }), ["startMenu", "desktop", "autostart"]);
});

test("a shortcut that never existed under the old name is not created", () => {
  const renamed = withRenamedShortcuts(status({}), { desktop: false, autostart: false });

  assert.deepEqual(bootShortcutPlan({ status: renamed, prefs: { startMenu: true, version: SHORTCUT_VERSION - 1 } }), ["startMenu"]);
});

test("shortcuts and the Linux menu entry carry the app's name, not the chat client's", () => {
  const env = windowsShortcutEnv("C:\\x.lnk", { background: false, hotkey: "" });

  assert.match(env.CL_DESC, /^ChatLens/u);
  // Only the texts: the install path is whatever folder the user chose.
  const texts = desktopEntry({ background: false }).split("\n").filter((line) => /^(Name|Comment)=/u.test(line));
  assert.doesNotMatch([env.CL_DESC, ...texts].join("\n"), /QQ/u);
  assert.match(desktopEntry({ background: false }), /^Name=ChatLens$/mu);
});

test("the renamed start script replaces the old one, which is removed only once the new one exists", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launchers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Start-QQ-Console.cmd"), "@echo off\n");

  assert.deepEqual(removeObsoleteLaunchers(root), []);
  assert.ok(fs.existsSync(path.join(root, "Start-QQ-Console.cmd")));

  fs.writeFileSync(path.join(root, "Start-ChatLens.cmd"), "@echo off\n");
  assert.deepEqual(removeObsoleteLaunchers(root), ["Start-QQ-Console.cmd"]);
  assert.ok(!fs.existsSync(path.join(root, "Start-QQ-Console.cmd")));
  assert.ok(fs.existsSync(path.join(root, "Start-ChatLens.cmd")));
});
