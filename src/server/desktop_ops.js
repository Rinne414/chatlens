"use strict";

// Desktop integration: an app shortcut that opens the briefing, optional
// start-at-login in the background, and cleanup of the scheduled task older
// versions created. Windows uses Start-menu/Startup .lnk files (made through
// WScript.Shell); Linux uses freedesktop .desktop files.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const platform = require("../platform");

const APP_NAME = "QQ 群消息简报";
const LEGACY_TASK_NAME = "QQSummaryToolkit-Digest";
const LEGACY_SHORTCUT = "QQ摘要-未查看.lnk";
const launcherScript = path.join(state.toolRoot, "src", "launcher.js");

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

const windowsDirs = () => {
  const programs = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
  return { programs, startup: path.join(programs, "Startup") };
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
  "$lnk.Description = $env:CL_DESC",
  "$lnk.Save()",
].join("\n");

const quoteArg = (value) => `"${value}"`;

const createWindowsShortcut = async (lnkPath, { background, hotkey }) => {
  const result = await runPowershell(CREATE_SHORTCUT_SCRIPT, {
    CL_LNK: lnkPath,
    CL_TARGET: process.execPath,
    CL_ARGS: [quoteArg(launcherScript), ...(background ? ["--background"] : [])].join(" "),
    CL_CWD: state.toolRoot,
    CL_HOTKEY: hotkey ?? "",
    CL_DESC: background ? `${APP_NAME}（开机后台运行）` : `${APP_NAME}：不开 QQ 也能看完群消息`,
  });
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

const shortcutPaths = () => {
  if (platform.isWindows) {
    const dirs = windowsDirs();
    return {
      app: path.join(dirs.programs, `${APP_NAME}.lnk`),
      autostart: path.join(dirs.startup, `${APP_NAME}.lnk`),
      legacy: path.join(dirs.programs, LEGACY_SHORTCUT),
    };
  }
  const dirs = linuxDirs();
  return {
    app: path.join(dirs.applications, "chatlens.desktop"),
    autostart: path.join(dirs.autostart, "chatlens.desktop"),
    legacy: null,
  };
};

const getDesktopStatus = () => {
  const paths = shortcutPaths();
  return {
    platform: process.platform,
    appShortcut: fs.existsSync(paths.app),
    autostart: fs.existsSync(paths.autostart),
    appShortcutPath: paths.app,
  };
};

const writeDesktopFile = (filePath, background) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, desktopEntry({ background }), { encoding: "utf8", mode: 0o755 });
};

// Idempotent: (re)creates the app shortcut so it always points at this
// install (and its node binary), and drops the old "未查看" shortcut.
const ensureAppShortcut = async () => {
  const paths = shortcutPaths();
  if (platform.isWindows) {
    await createWindowsShortcut(paths.app, { background: false, hotkey: "Ctrl+Alt+U" });
    fs.rmSync(paths.legacy, { force: true });
  } else {
    writeDesktopFile(paths.app, false);
  }
  return getDesktopStatus();
};

const setAutostart = async (enabled) => {
  const paths = shortcutPaths();
  if (!enabled) {
    fs.rmSync(paths.autostart, { force: true });
    return getDesktopStatus();
  }
  if (platform.isWindows) {
    await createWindowsShortcut(paths.autostart, { background: true });
  } else {
    writeDesktopFile(paths.autostart, true);
  }
  return getDesktopStatus();
};

module.exports = { getDesktopStatus, ensureAppShortcut, setAutostart, removeLegacyScheduledTask, desktopEntry };
