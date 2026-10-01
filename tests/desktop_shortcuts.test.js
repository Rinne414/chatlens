"use strict";

// Shortcuts: a Start-menu entry by default (unless the user removed it in
// 设置), an optional desktop one, and a one-time rewrite of shortcuts made by
// older versions, which showed node.exe's icon instead of the app's.
// Decisions and boot cleanup are tested without touching a real Start menu.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const fs = require("node:fs");
const os = require("node:os");
const vm = require("node:vm");

const {
  bootShortcutPlan,
  windowsShortcutEnv,
  withRenamedShortcuts,
  removeObsoleteLaunchers,
  desktopEntry,
  SHORTCUT_VERSION,
} = require("../src/server/desktop_ops");

// Exercise Windows boot cleanup on every platform without invoking PowerShell
// or deleting real shortcuts. Unexpected removals model the native failure seen
// for an absent legacy shortcut with the bundled Node v25.2.1 on Windows.
const bootCleanupFixture = (legacyIndexes) => {
  const appData = path.resolve("shortcut-fixture", "AppData");
  const desktop = path.resolve("shortcut-fixture", "Desktop");
  const programs = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
  const dirs = [programs, desktop, path.join(programs, "Startup")];
  const legacyPaths = [
    ...dirs.map((dir) => path.join(dir, "QQ 群消息简报.lnk")),
    path.join(programs, "QQ摘要-未查看.lnk"),
  ];
  const existing = new Set([
    ...dirs.map((dir) => path.join(dir, "ChatLens.lnk")),
    ...legacyIndexes.map((index) => legacyPaths[index]),
  ]);
  const removed = [];
  const module = { exports: {} };
  const dependencies = {
    "node:fs": {
      existsSync: (file) => existing.has(file),
      rmSync: (file, options) => {
        assert.ok(existing.has(file), `must not remove a missing shortcut: ${file}`);
        assert.equal(options.force, true);
        existing.delete(file);
        removed.push(file);
      },
    },
    "node:os": os,
    "node:path": path,
    "node:child_process": {
      spawnSync: () => ({ stdout: desktop }),
      spawn: () => assert.fail("up-to-date shortcuts must not be rewritten"),
    },
    "./toolkit_state": {
      toolRoot: path.resolve("shortcut-fixture", "chatlens"),
      loadRawConfig: () => ({ desktop: { version: SHORTCUT_VERSION } }),
      writeConfig: () => assert.fail("up-to-date preferences must not be rewritten"),
    },
    "../platform": { isWindows: true },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/server/desktop_ops"), "utf8"), {
    module,
    process: { platform: "win32", env: { APPDATA: appData } },
    require: (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected dependency: ${id}`);
      return dependencies[id];
    },
  });
  return { sync: module.exports.syncShortcutsAtBoot, removed, legacyPaths, existing, dirs };
};

for (const [name, indexes] of [
  ["all legacy shortcuts are missing", []],
  ["only some legacy shortcuts exist", [1, 3]],
  ["renamed shortcuts exist but the legacy launcher is missing", [0, 1, 2]],
  ["all legacy shortcuts exist", [0, 1, 2, 3]],
]) {
  test(`boot cleanup succeeds when ${name}`, async () => {
    const fixture = bootCleanupFixture(indexes);
    await fixture.sync();
    assert.deepEqual(fixture.removed, indexes.map((index) => fixture.legacyPaths[index]));
    assert.ok(fixture.legacyPaths.every((file) => !fixture.existing.has(file)));
    assert.ok(fixture.dirs.every((dir) => fixture.existing.has(path.join(dir, "ChatLens.lnk"))));
  });
}

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
