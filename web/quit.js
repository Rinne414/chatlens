"use strict";

/* ---------- 关闭控制台 ----------
   The console runs without a window (started at login or from the Start
   menu), so this page is the only place to stop it: the rail's 「关闭」, the
   button in 设置 → 后台与通知, and Ctrl+K. */

const quitReopenHint = (desktop) => {
  if (desktop?.appShortcut && desktop.desktopShortcut === true) {
    return "要再打开：桌面或开始菜单里的「QQ 群消息简报」，或按 Ctrl+Alt+U。";
  }
  if (desktop?.desktopShortcut === true) {
    return "要再打开：双击桌面上的「QQ 群消息简报」。";
  }
  if (!desktop?.appShortcut) {
    return "要再打开：运行安装文件夹里的启动脚本（Windows 是 Start-QQ-Console.cmd）。";
  }
  return desktop.platform === "win32"
    ? "要再打开：开始菜单里的「QQ 群消息简报」，或按 Ctrl+Alt+U。"
    : "要再打开：应用菜单里的「QQ 群消息简报」。";
};

// What closing means, for the confirmation. status: GET /api/background.
const quitQuestion = (status) => [
  "关闭控制台？",
  "",
  "后台不再自动收消息、做 AI 总结，直到你再打开它。",
  status?.running ? "正在进行的这一轮刷新会中断，下次打开后接着做。" : null,
  status?.desktop?.autostart ? "「开机后在后台运行」开着：下次登录它会自己启动（可在设置里关掉）。" : null,
  quitReopenHint(status?.desktop),
].filter((line) => line !== null).join("\n");

const showQuitScreen = (desktop) => {
  document.body.append(el("div", { class: "quit-screen", role: "alertdialog", "aria-label": "控制台已关闭" },
    el("div", { class: "quit-card" },
      el("h2", {}, "控制台已关闭"),
      el("p", {}, "后台刷新和 AI 总结都停了，这个页面可以关掉。"),
      el("p", {}, quitReopenHint(desktop)))));
};

const quitConsole = async () => {
  let status = null;
  try {
    status = await api("/api/background");
  } catch {
    // Still offer to close; the question just says less.
  }
  if (!window.confirm(quitQuestion(status))) {
    return;
  }
  try {
    await api("/api/shutdown", { method: "POST", body: "{}" });
  } catch (error) {
    alert(`关闭失败：${error.message}`);
    return;
  }
  showQuitScreen(status?.desktop ?? null);
};

document.getElementById("quit-console")?.addEventListener("click", quitConsole);
