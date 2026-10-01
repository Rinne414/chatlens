"use strict";

// Desktop integration: app shortcuts that open the briefing (Start menu by
// default, desktop on request), optional start-at-login in the background,
// and cleanup of the scheduled task older versions created. Windows uses .lnk
// files (made through WScript.Shell); Linux uses freedesktop .desktop files.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const state = require("./toolkit_state");
const platform = require("../platform");

const APP_NAME = "QQ 群消息简报";
const LEGACY_TASK_NAME = "QQSummaryToolkit-Digest";
const LEGACY_SHORTCUT = "QQ摘要-未查看.lnk";
const START_MENU_HOTKEY = "Ctrl+Alt+U";
const DESKTOP_DIR_TIMEOUT_MS = 10000;
// 2: shortcuts carry the app icon (version 1 showed node.exe's).
const SHORTCUT_VERSION = 2;
const launcherScript = path.join(state.toolRoot, "src", "launcher.js");
const appIcon = path.join(state.toolRoot, "web", "icons", "app.ico");

const runPowershell = (script, env = {}) =>
  new Promise((resolve) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/* ---------- Windows ---------- */

// The Desktop can be redirected (OneDrive, another drive), so Windows is
// asked once instead of assuming %USERPROFILE%\Desktop.
let desktopDirCache = null;
const windowsDesktopDir = () => {
  if (desktopDirCache === null) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')",
    ], { windowsHide: true, encoding: "utf8", timeout: DESKTOP_DIR_TIMEOUT_MS });
    const dir = String(result.stdout ?? "").trim();
    desktopDirCache = dir !== "" && path.isAbsolute(dir) ? dir : path.join(os.homedir(), "Desktop");
  }
  return desktopDirCache;
};

const windowsDirs = () => {
  const programs = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
  return { programs, startup: path.join(programs, "Startup"), desktop: windowsDesktopDir() };
};

// Target is node.exe itself with the launcher as argument; WindowStyle 7
// (minimized) keeps the brief console of the launcher out of sight.
const CREATE_SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:CL_LNK) | Out-Null",
  "$shell = New-Object -ComObject WScript.Shell",
  "$lnk = $shell.CreateShortcut($env:CL_LNK)",
  "$lnk.TargetPath = $env:CL_TARGET",
  "$lnk.Arguments = $env:CL_ARGS",
  "$lnk.WorkingDirectory = $env:CL_CWD",
  "$lnk.WindowStyle = 7",
  "if ($env:CL_HOTKEY) { $lnk.Hotkey = $env:CL_HOTKEY }",
  "if ($env:CL_ICON) { $lnk.IconLocation = $env:CL_ICON }",
  "$lnk.Description = $env:CL_DESC",
  "$lnk.Save()",
].join("\n");

const quoteArg = (value) => `"${value}"`;

// The target is node.exe, whose own icon says nothing about the app.
const windowsShortcutEnv = (lnkPath, { background, hotkey }) => ({
  CL_LNK: lnkPath,
  CL_TARGET: process.execPath,
  CL_ARGS: [quoteArg(launcherScript), ...(background ? ["--background"] : [])].join(" "),
  CL_CWD: state.toolRoot,
  CL_HOTKEY: hotkey ?? "",
  CL_ICON: `${appIcon},0`,
  CL_DESC: background ? `${APP_NAME}（开机后台运行）` : `${APP_NAME}：不开 QQ 也能看完群消息`,
});

const createWindowsShortcut = async (lnkPath, options) => {
  const result = await runPowershell(CREATE_SHORTCUT_SCRIPT, windowsShortcutEnv(lnkPath, options));
  if (result.code !== 0) {
    throw new Error(`创建快捷方式失败：${result.stderr.trim().split(/\r?\n/u).at(-1) ?? result.code}`);
  }
};

const removeLegacyScheduledTask = async () => {
  if (!platform.isWindows) {
    return false;
  }
  // The old daily task ran scripts that no longer exist; the background
  // refresh replaces it.
  const result = await runPowershell([
    `$task = Get-ScheduledTask -TaskName '${LEGACY_TASK_NAME}' -ErrorAction SilentlyContinue`,
    `if ($null -ne $task) { Unregister-ScheduledTask -TaskName '${LEGACY_TASK_NAME}' -Confirm:$false; 'removed' }`,
  ].join("\n"));
  return result.stdout.includes("removed");
};

/* ---------- Linux ---------- */

const linuxDirs = () => {
  const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  const configHome = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return { applications: path.join(dataHome, "applications"), autostart: path.join(configHome, "autostart") };
};

// Exec values are quoted per the Desktop Entry spec (paths may contain spaces).
const desktopQuote = (value) => `"${String(value).replace(/(["`$\\])/gu, "\\$1")}"`;

const desktopEntry = ({ background }) => [
  "[Desktop Entry]",
  "Type=Application",
  `Name=${APP_NAME}`,
  "Comment=不开 QQ 也能看完群消息（本地只读）",
  `Exec=${desktopQuote(process.execPath)} ${desktopQuote(launcherScript)}${background ? " --background" : ""}`,
  `Path=${state.toolRoot}`,
  `Icon=${path.join(state.toolRoot, "web", "icons", "icon-192.png")}`,
  "Terminal=false",
  "Categories=Network;Chat;",
  ...(background ? ["X-GNOME-Autostart-enabled=true", "NoDisplay=true"] : []),
  "",
].join("\n");

/* ---------- public API ---------- */

// Linux desktops often show no desktop icons at all (GNOME), so only the app
// menu entry is offered there: `desktop` is null.
const shortcutPaths = () => {
  if (platform.isWindows) {
    const dirs = windowsDirs();
    return {
      startMenu: path.join(dirs.programs, `${APP_NAME}.lnk`),
      desktop: path.join(dirs.desktop, `${APP_NAME}.lnk`),
      autostart: path.join(dirs.startup, `${APP_NAME}.lnk`),
      legacy: path.join(dirs.programs, LEGACY_SHORTCUT),
    };
  }
  const dirs = linuxDirs();
  return {
    startMenu: path.join(dirs.applications, "chatlens.desktop"),
    desktop: null,
    autostart: path.join(dirs.autostart, "chatlens.desktop"),
    legacy: null,
  };
};

// Kept in the config, not the browser: the console's port (and so the page's
// storage) can change between starts. startMenu false = removed in 设置.
const loadPrefs = () => ({ startMenu: true, asked: false, version: 1, ...(state.loadRawConfig().desktop ?? {}) });

const savePrefs = (patch) => {
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, desktop: { ...(raw.desktop ?? {}), ...patch } });
};

const getDesktopStatus = () => {
  const paths = shortcutPaths();
  return {
    platform: process.platform,
    appShortcut: fs.existsSync(paths.startMenu),
    desktopShortcut: paths.desktop === null ? null : fs.existsSync(paths.desktop),
    autostart: fs.existsSync(paths.autostart),
    appShortcutPath: paths.startMenu,
    desktopShortcutPath: paths.desktop,
    shortcutAsked: loadPrefs().asked === true,
  };
};

const writeDesktopFile = (filePath, background) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, desktopEntry({ background }), { encoding: "utf8", mode: 0o755 });
};

// Only the Start-menu entry gets the hotkey: two shortcuts with the same
// hotkey make Windows ignore it.
const writeShortcut = async (kind) => {
  const paths = shortcutPaths();
  const background = kind === "autostart";
  if (platform.isWindows) {
    await createWindowsShortcut(paths[kind], { background, hotkey: kind === "startMenu" ? START_MENU_HOTKEY : "" });
  } else {
    writeDesktopFile(paths[kind], background);
  }
};

// Which shortcuts to (re)write when the console starts: the Start-menu entry
// unless the user removed it in 设置, and, once after an update, every
// shortcut that exists so it gets the current icon. A desktop shortcut is
// only ever made on request.
const bootShortcutPlan = ({ status, prefs }) => {
  const outdated = prefs.version !== SHORTCUT_VERSION;
  return [
    prefs.startMenu !== false && (!status.appShortcut || outdated) ? "startMenu" : null,
    status.desktopShortcut === true && outdated ? "desktop" : null,
    status.autostart && outdated ? "autostart" : null,
  ].filter((kind) => kind !== null);
};

const syncShortcutsAtBoot = async () => {
  const prefs = loadPrefs();
  for (const kind of bootShortcutPlan({ status: getDesktopStatus(), prefs })) {
    await writeShortcut(kind);
  }
  const { legacy } = shortcutPaths();
  if (legacy !== null) {
    fs.rmSync(legacy, { force: true });
  }
  if (prefs.version !== SHORTCUT_VERSION) {
    savePrefs({ version: SHORTCUT_VERSION });
  }
};

const SHORTCUT_KINDS = new Set(["startMenu", "desktop"]);

const setShortcut = async (kind, enabled) => {
  if (!SHORTCUT_KINDS.has(kind)) {
    throw new Error("未知的快捷方式位置。");
  }
  const target = shortcutPaths()[kind];
  if (target === null) {
    throw new Error("这个系统不提供桌面快捷方式，请用应用菜单里的入口。");
  }
  if (enabled) {
    await writeShortcut(kind);
  } else {
    fs.rmSync(target, { force: true });
  }
  if (kind === "startMenu") {
    savePrefs({ startMenu: enabled });
  }
  return getDesktopStatus();
};

// The home page asks once whether to add a desktop shortcut.
const markShortcutAsked = () => {
  savePrefs({ asked: true });
  return getDesktopStatus();
};

const setAutostart = async (enabled) => {
  if (enabled) {
    await writeShortcut("autostart");
  } else {
    fs.rmSync(shortcutPaths().autostart, { force: true });
  }
  return getDesktopStatus();
};

module.exports = {
  getDesktopStatus,
  syncShortcutsAtBoot,
  setShortcut,
  markShortcutAsked,
  setAutostart,
  removeLegacyScheduledTask,
  desktopEntry,
  bootShortcutPlan,
  windowsShortcutEnv,
  SHORTCUT_VERSION,
};
