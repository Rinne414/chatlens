"use strict";

/* ---------- 首页 keyboard ----------
   j / k move between cards (和你有关, 关注的词, new things, Q&A, topics,
   groups), o or Enter opens, s stars; ? lists the keys (key_help.js). No key marks
   anything read: read marks only move forward, so that stays a deliberate
   click. */

const BRIEF_KEY_ITEMS = ["brief-mention", "brief-watch-hit", "brief-thing", "brief-qa", "brief-topic", "brief-group"]
  .map((name) => `.brief-page li.${name}`).join(", ");
const briefKeys = { index: -1 };

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

// Enter only when no button or link has the focus (it opens that one itself).
const briefKeyActions = {
  j: () => briefKeyMove(1),
  k: () => briefKeyMove(-1),
  o: () => briefKeyPress(".brief-row-button"),
  enter: () => document.activeElement === document.body && briefKeyPress(".brief-row-button"),
  s: () => briefKeyPress(".bm-star"),
};

document.addEventListener("keydown", (event) => {
  if (app.view !== "brief" || paletteState.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || isTypingTarget(event.target)) {
    return;
  }
  const action = briefKeyActions[event.key.toLowerCase()];
  if (action !== undefined && action() !== false) {
    event.preventDefault();
  }
});
