"use strict";

/* ---------- 键盘快捷键: one list, on every page ----------
   ? shows the keys that work everywhere and the ones of the page that is
   open. The keys themselves are handled where they belong (palette.js,
   brief_keys.js, gallery_detail.js, messages_keys below). */

const KEY_HELP_EVERYWHERE = [
  ["Ctrl+K 或 /", "搜索，跳到任何页面、群"],
  ["Esc", "关掉最上面的一层"],
  ["Alt+←", "返回上一步"],
  ["?", "显示 / 隐藏这张说明"],
];

// view -> { title, keys, note }. A page without keys of its own is not listed.
const KEY_HELP_PAGES = {
  brief: {
    title: "简报",
    keys: [
      ["j / k", "下一张 / 上一张卡片"],
      ["o 或 Enter", "打开（聊天、群）"],
      ["s", "收藏 / 取消收藏"],
    ],
    note: "「标为看完」没有快捷键，要点按钮。",
  },
  messages: {
    title: "消息（打开一个群之后）",
    keys: [
      ["n / p", "下一条 / 上一条 @你或回复你的消息"],
      ["b", "回到刚才的位置（点了引用或 @你 跳走之后）"],
      ["Esc", "取消「只看某人」"],
    ],
    note: null,
  },
  media: {
    title: "画廊",
    keys: [
      ["← → ↑ ↓", "在墙上移动一个框（Home / End：第一张 / 最后一张）；下面的键对框住的那张也有效"],
      ["Enter", "打开框住的那张"],
      ["空格", "鼠标下那张的大图；再按一次关掉"],
      ["O 或 I", "鼠标下那张的详情（多选时也能看）"],
      ["X", "把这张放进 / 拿出托盘"],
      ["← / →", "上一张 / 下一张（大图或详情里）"],
      ["S 或 1", "存到第一个存图文件夹"],
      ["2 – 9", "存到第 2 – 9 个存图文件夹"],
      ["Shift + 存图的键", "大图里：存完看下一张"],
      ["滚轮 / 点图", "大图里：放大、缩小；放大后按住拖动"],
      ["Ctrl+A", "把已加载的图全放进托盘"],
      ["Ctrl 或 Shift + 点图", "开始多选；多选时 Shift + 点是连选"],
      ["Shift + 方向键", "把经过的图放进托盘"],
      ["C", "托盘里有 2 到 4 张时并排看"],
      ["Ctrl+Z", "撤销刚才存的图"],
      ["Esc", "关掉图片，或退出多选"],
    ],
    note: "存图的键存的是打开的那张；没打开图时是托盘里的全部。",
  },
};

const keyHelp = { node: null };

const closeKeyHelp = () => {
  keyHelp.node?.remove();
  keyHelp.node = null;
};

const keyHelpList = (keys) => el("dl", {}, keys.map(([key, what]) => [el("dt", {}, key), el("dd", {}, what)]));

const toggleKeyHelp = () => {
  if (keyHelp.node !== null) {
    closeKeyHelp();
    return;
  }
  const page = KEY_HELP_PAGES[app.view] ?? null;
  keyHelp.node = el("aside", { class: "brief-keys-help", "aria-label": "键盘快捷键" },
    el("div", { class: "brief-keys-help-head" },
      el("strong", {}, "键盘快捷键"),
      el("button", { class: "btn small ghost", type: "button", onclick: closeKeyHelp }, "关闭")),
    page === null ? null : [
      el("p", { class: "key-help-title" }, page.title),
      keyHelpList(page.keys),
      page.note === null ? null : el("p", { class: "brief-meta" }, page.note),
    ],
    el("p", { class: "key-help-title" }, "所有页面"),
    keyHelpList(KEY_HELP_EVERYWHERE));
  document.body.append(keyHelp.node);
};

// The list belongs to the page it was opened on.
VIEW_LEAVE_HOOKS.push(closeKeyHelp);

const keyHelpIgnores = (event) => paletteState.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
  || isTypingTarget(event.target) || document.querySelector(".cc-dialog-layer") !== null;

document.addEventListener("keydown", (event) => {
  if (event.repeat || keyHelpIgnores(event)) {
    return;
  }
  // Some keyboards report Shift+/ as "/" with Shift rather than "?".
  if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
    event.preventDefault();
    toggleKeyHelp();
  }
});

// Esc closes only the list while it is open: it is the top layer, so this
// runs before the pages' own Esc (an open picture, 多选, 只看某人).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || keyHelp.node === null || document.querySelector(".cc-dialog-layer") !== null) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  closeKeyHelp();
}, true);

/* ---------- 消息: keys inside an open chat ---------- */

const chatKeyActions = {
  n: () => stepChatMention(1),
  p: () => stepChatMention(-1),
  b: () => (chatReading.back === null ? false : goBackInChat()),
  escape: () => (chatReading.speaker === null ? false : setChatSpeaker(null)),
};

document.addEventListener("keydown", (event) => {
  if (app.view !== "messages" || app.msg.mode !== "chat" || event.repeat || event.defaultPrevented || keyHelpIgnores(event)
    || document.querySelector(".view-layer") !== null || pictureUi.viewer !== null) {
    return;
  }
  const action = chatKeyActions[event.key.toLowerCase()];
  if (action !== undefined && action() !== false) {
    event.preventDefault();
  }
});
