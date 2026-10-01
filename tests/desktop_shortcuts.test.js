"use strict";

// Shortcuts: a Start-menu entry by default (unless the user removed it in
// 设置), an optional desktop one, and a one-time rewrite of shortcuts made by
// older versions, which showed node.exe's icon instead of the app's.
// Only the pure decisions are tested: nothing here touches a real Start menu.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { bootShortcutPlan, windowsShortcutEnv, SHORTCUT_VERSION } = require("../src/server/desktop_ops");

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
