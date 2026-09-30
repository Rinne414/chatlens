"use strict";

/* ---------- 首页 keyboard ----------
   j / k move between cards (和你有关, 关注的词, new things, Q&A, topics,
   groups), o or Enter opens, s stars, ? lists the keys. No key marks
   anything read: read marks only move forward, so that stays a deliberate
   click. */

const BRIEF_KEY_ITEMS = ["brief-mention", "brief-watch-hit", "brief-thing", "brief-qa", "brief-topic", "brief-group"]
  .map((name) => `.brief-page li.${name}`).join(", ");
const BRIEF_KEY_HELP = [
  ["j / k", "下一张 / 上一张卡片"],
  ["o 或 Enter", "打开（聊天、群）"],
  ["s", "收藏 / 取消收藏"],
  ["Ctrl+K 或 /", "搜索，跳到任何页面、群"],
  ["?", "显示 / 隐藏这张说明"],
];

const briefKeys = { index: -1, help: null };

const briefKeyItems = () => [...document.querySelectorAll(BRIEF_KEY_ITEMS)];

const briefKeyMark = (items) => {
  items.forEach((item, index) => item.classList.toggle("kb-current", index === briefKeys.index));
};

// The page redraws when news arrives: the same position is marked again.
const briefKeysRestore = () => {
  if (briefKeys.index >= 0) {
    briefKeyMark(briefKeyItems());
  }
};

const briefKeyMove = (step) => {
  const items = briefKeyItems();
  if (items.length === 0) {
    return;
  }
  briefKeys.index = Math.max(0, Math.min(items.length - 1, briefKeys.index + step));
  briefKeyMark(items);
  items[briefKeys.index].scrollIntoView({ block: "nearest", behavior: "smooth" });
};

// Clicks the current card's control (open, star); false when it has none.
const briefKeyPress = (selector) => {
  const control = briefKeyItems()[briefKeys.index]?.querySelector(selector) ?? null;
  control?.click();
  return control !== null;
};

const closeBriefKeyHelp = () => {
  briefKeys.help?.remove();
  briefKeys.help = null;
};

const toggleBriefKeyHelp = () => {
  if (briefKeys.help !== null) {
    closeBriefKeyHelp();
    return;
  }
  briefKeys.help = el("aside", { class: "brief-keys-help", "aria-label": "键盘快捷键" },
    el("div", { class: "brief-keys-help-head" },
      el("strong", {}, "键盘快捷键"),
      el("button", { class: "btn small ghost", type: "button", onclick: closeBriefKeyHelp }, "关闭")),
    el("dl", {}, BRIEF_KEY_HELP.map(([keys, what]) => [el("dt", {}, keys), el("dd", {}, what)])),
    el("p", { class: "brief-meta" }, "「标为看完」没有快捷键：看完只能往前走，得点一下才算。"));
  document.body.append(briefKeys.help);
};

// Enter only when no button or link has the focus (it opens that one itself).
const briefKeyActions = {
  j: () => briefKeyMove(1),
  k: () => briefKeyMove(-1),
  o: () => briefKeyPress(".brief-row-button"),
  enter: () => document.activeElement === document.body && briefKeyPress(".brief-row-button"),
  s: () => briefKeyPress(".bm-star"),
  "?": toggleBriefKeyHelp,
  escape: () => {
    if (briefKeys.help === null) {
      return false;
    }
    closeBriefKeyHelp();
    return true;
  },
};

document.addEventListener("keydown", (event) => {
  if (app.view !== "brief" || paletteState.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || isTypingTarget(event.target)) {
    return;
  }
  // Some keyboards report Shift+/ as "/" with Shift rather than "?".
  const key = event.key === "/" && event.shiftKey ? "?" : event.key.toLowerCase();
  const action = briefKeyActions[key];
  if (action !== undefined && action() !== false) {
    event.preventDefault();
  }
});
