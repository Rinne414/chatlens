"use strict";

// The only place that knows which OS we are on. Everything that used to call
// explorer.exe / taskkill / cmd start / %APPDATA% directly goes through here,
// so the rest of the toolkit runs unchanged on Windows and Linux.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

// Per-user config root for secrets and background state. Windows keeps the
// historical %APPDATA%\QQSummaryTools so keys saved by older versions still load.
const userConfigDir = () => {
  if (isWindows) {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "QQSummaryTools");
  }
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(base, "QQSummaryTools");
};

const commandExists = (name) => {
  if (isWindows) {
    return spawnSync("where", [name], { windowsHide: true, stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", name], { stdio: "ignore" }).status === 0;
};

const spawnDetachedQuiet = (command, args) => {
  const child = spawn(command, args, { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`${command} failed: ${error.message}`));
  child.unref();
};

// Opens a folder (or file) in the desktop file manager.
const openPath = (targetPath) => {
  const resolved = path.resolve(targetPath);
  if (isWindows) {
    spawnDetachedQuiet("explorer.exe", [resolved]);
  } else if (isMac) {
    spawnDetachedQuiet("open", [resolved]);
  } else {
    spawnDetachedQuiet("xdg-open", [resolved]);
  }
};

const openUrl = (url) => {
  if (isWindows) {
    // `start` is a cmd builtin; the empty "" is the window title argument.
    spawnDetachedQuiet("cmd.exe", ["/c", "start", "", url]);
  } else if (isMac) {
    spawnDetachedQuiet("open", [url]);
  } else {
    spawnDetachedQuiet("xdg-open", [url]);
  }
};

// Children that must be cancellable as a whole tree are spawned with
// detached:true on POSIX so they lead their own process group; killing the
// negative pid then takes every grandchild with it. Windows uses taskkill /t.
const spawnOptionsForTree = () => (isWindows ? { windowsHide: true } : { detached: true });

const killTree = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (isWindows) {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", (error) => console.error(`taskkill failed: ${error.message}`));
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
};

// Lowers the current process's scheduling priority for background work so a
// refresh never makes the desktop feel sluggish.
const lowerOwnPriority = () => {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not permitted on some systems; background work still runs.
  }
};

const isPathInside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// Absolute-path validation for user-entered directories. Rejects quote and
// shell metacharacters on every OS because paths travel through launchers.
const isSafeAbsoluteDir = (value) => {
  const text = String(value ?? "");
  if (text.length === 0 || [...text].some((ch) => ch.codePointAt(0) < 32)) {
    return false;
  }
  if (isWindows) {
    return /^[A-Za-z]:[\\/][^"<>|]*$/u.test(text);
  }
  return path.isAbsolute(text) && !/["`$\\]/u.test(text);
};

const fileExists = (filePath) => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

module.exports = {
  isWindows,
  isLinux,
  isMac,
  userConfigDir,
  commandExists,
  openPath,
  openUrl,
  spawnOptionsForTree,
  killTree,
  lowerOwnPriority,
  isPathInside,
  isSafeAbsoluteDir,
  fileExists,
};
