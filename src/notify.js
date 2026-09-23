"use strict";

// Desktop notifications without extra dependencies.
// Windows: a WinRT toast through PowerShell; clicking it opens the console URL.
// Linux: notify-send (libnotify), when installed.
// Text reaches the helper through environment variables, never the command
// line, and is XML-escaped inside PowerShell.

const { spawn } = require("node:child_process");
const platform = require("./platform");

// PowerShell's own AppUserModelID: always registered on Windows 10/11, so the
// toast shows without installing a shortcut with a custom AUMID.
const WINDOWS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$title = [System.Security.SecurityElement]::Escape($env:CHATLENS_TOAST_TITLE)",
  "$body = [System.Security.SecurityElement]::Escape($env:CHATLENS_TOAST_BODY)",
  "$url = [System.Security.SecurityElement]::Escape($env:CHATLENS_TOAST_URL)",
  "$xml = \"<toast activationType='protocol' launch='$url'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>\"",
  "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$doc.LoadXml($xml)",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:CHATLENS_TOAST_APPID).Show($toast)",
].join("\n");

const MAX_TITLE = 60;
const MAX_BODY = 200;

const clip = (value, limit) => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

const runQuiet = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore", env: { ...process.env, ...env } });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

const canNotify = () => platform.isWindows || platform.commandExists("notify-send");

// Resolves true when the OS accepted the notification. Never throws.
const notify = async ({ title, body, url }) => {
  const safeTitle = clip(title, MAX_TITLE);
  const safeBody = clip(body, MAX_BODY);
  if (platform.isWindows) {
    const encoded = Buffer.from(WINDOWS_TOAST_SCRIPT, "utf16le").toString("base64");
    return runQuiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      CHATLENS_TOAST_TITLE: safeTitle,
      CHATLENS_TOAST_BODY: safeBody,
      CHATLENS_TOAST_URL: String(url ?? ""),
      CHATLENS_TOAST_APPID: WINDOWS_APP_ID,
    });
  }
  if (platform.commandExists("notify-send")) {
    return runQuiet("notify-send", ["--app-name=QQ 群简报", safeTitle, safeBody], {});
  }
  return false;
};

module.exports = { notify, canNotify, clip };
