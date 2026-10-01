"use strict";

/* ---------- 快捷方式 ----------
   Ways to open the app without finding the install folder: the Start menu
   entry (made on first start) and, on request, a desktop shortcut. 设置 has a
   card to add or remove either; the home page asks once about the desktop.
   Shortcuts run the launcher, which starts the console if it is not running.
   Status comes from GET /api/background (its `desktop` field). */

const shortcutState = { desktop: null, loading: false, busy: false, result: null };

// desktopShortcut is null where no desktop shortcut is offered (Linux).
const shortcutOptions = (desktop) => {
  const windows = desktop.platform === "win32";
  return [
    typeof desktop.desktopShortcut === "boolean"
      ? { kind: "desktop", label: "桌面", hint: "双击桌面上的「ChatLens」打开", on: desktop.desktopShortcut }
      : null,
    {
      kind: "startMenu",
      label: windows ? "开始菜单" : "应用菜单",
      hint: windows ? "也可以随时按 Ctrl+Alt+U 打开" : "在应用菜单里找「ChatLens」",
      on: desktop.appShortcut === true,
    },
  ].filter((option) => option !== null);
};

const SHORTCUT_DONE_TEXT = {
  desktop: ["已在桌面放好「ChatLens」。", "已从桌面移除。"],
  startMenu: ["已加入开始菜单 / 应用菜单。", "已移除；之后启动也不会再自动加回来。"],
};

const saveShortcut = async (kind, enabled) => {
  const desktop = await api("/api/desktop/shortcut", { method: "POST", body: JSON.stringify({ kind, enabled }) });
  // Deciding about the desktop in 设置 answers the home page's question too.
  shortcutState.desktop = kind === "desktop"
    ? await api("/api/desktop/shortcut-asked", { method: "POST", body: "{}" })
    : desktop;
  return SHORTCUT_DONE_TEXT[kind][enabled ? 0 : 1];
};

/* --- 设置 card --- */

const setShortcutFromSettings = async (kind, enabled) => {
  try {
    settingsState.shortcutNotice = { text: await saveShortcut(kind, enabled), isError: false };
  } catch (error) {
    settingsState.shortcutNotice = { text: error.message, isError: true };
  }
  await refreshBackgroundStatus();
};

const renderShortcutCard = () => {
  const desktop = settingsState.background?.desktop ?? null;
  const msg = el("span", { style: "font-size:13px" });
  if (settingsState.shortcutNotice) {
    settingsFeedback(msg, settingsState.shortcutNotice.text, settingsState.shortcutNotice.isError);
  }
  const loadingText = settingsState.backgroundError ? `读取失败：${settingsState.backgroundError}` : "正在读取…";
  return el("div", { class: "card", id: "settings-shortcuts" },
    el("h2", {}, "快捷方式"),
    el("p", { class: "card-sub" }, "不用再去安装文件夹里找启动脚本：点快捷方式就打开简报，控制台没开时会先把它启动。"),
    desktop === null
      ? el("p", { class: "card-sub" }, loadingText)
      : el("div", { class: "bg-grid" }, shortcutOptions(desktop).map((option) =>
        backgroundToggle(option.label, option.hint, option.on, (value) => setShortcutFromSettings(option.kind, value)))),
    msg);
};

/* --- home page: asked once --- */

const ensureShortcutStatus = () => {
  if (shortcutState.loading) {
    return;
  }
  shortcutState.loading = true;
  api("/api/background")
    .then((status) => {
      shortcutState.desktop = status.desktop ?? {};
      renderBriefView();
    })
    .catch(() => {
      // No status, no question; 设置 still has the card.
      shortcutState.desktop = {};
    });
};

const answerShortcutPrompt = async (wanted) => {
  shortcutState.busy = true;
  renderBriefView();
  try {
    if (wanted) {
      shortcutState.result = { text: await saveShortcut("desktop", true), isError: false };
    } else {
      shortcutState.desktop = await api("/api/desktop/shortcut-asked", { method: "POST", body: "{}" });
    }
  } catch (error) {
    shortcutState.result = { text: error.message, isError: true };
  }
  shortcutState.busy = false;
  renderBriefView();
};

const shortcutResultCard = (result) =>
  el("section", { class: result.isError ? "shortcut-prompt error" : "shortcut-prompt" },
    el("span", {}, result.text),
    el("button", {
      class: "btn small ghost",
      type: "button",
      onclick: () => {
        shortcutState.result = null;
        renderBriefView();
      },
    }, "知道了"));

const shortcutPromptCard = () => {
  if (shortcutState.result !== null) {
    return shortcutResultCard(shortcutState.result);
  }
  const desktop = shortcutState.desktop;
  if (desktop === null) {
    ensureShortcutStatus();
    return null;
  }
  if (desktop.shortcutAsked === true || desktop.desktopShortcut !== false) {
    return null;
  }
  return el("section", { class: "shortcut-prompt", "aria-label": "桌面快捷方式" },
    el("div", { class: "shortcut-prompt-text" },
      el("strong", {}, "要在桌面放一个快捷方式吗？"),
      el("span", {}, desktop.appShortcut
        ? "开始菜单里已经有「ChatLens」（也可以按 Ctrl+Alt+U）。桌面上再放一个，双击就能打开。以后可在「设置 → 快捷方式」里改。"
        : "双击就能打开，不用再去安装文件夹里找。以后可在「设置 → 快捷方式」里改。")),
    el("div", { class: "shortcut-prompt-actions" },
      el("button", { class: "btn small primary", type: "button", disabled: shortcutState.busy, onclick: () => answerShortcutPrompt(true) }, "放到桌面"),
      el("button", { class: "btn small ghost", type: "button", disabled: shortcutState.busy, onclick: () => answerShortcutPrompt(false) }, "不用了")));
};
