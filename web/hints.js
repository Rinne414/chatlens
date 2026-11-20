"use strict";

/* ---------- hints: what a mouse sees on hover, for a finger and a keyboard too ----------
   Many controls explain themselves only in their title (a hover tooltip).
   A touch screen never hovers and a keyboard user never sees it. The same text
   now shows in a bubble when a control is reached with Tab, and when it is
   pressed and held on a touch screen (the held press does not also click). */

const HINT_HOLD_MS = 450;
const HINT_MOVE_PX = 10;
const HINT_MARGIN_PX = 8;

const hintState = { bubble: null, holdTimer: null, start: null, swallowClick: false };

const hintTextOf = (target) => {
  const holder = target instanceof Element ? target.closest("[title]") : null;
  const text = holder?.getAttribute("title")?.trim() ?? "";
  return text === "" ? null : { holder, text };
};

const hideHint = () => {
  hintState.bubble?.remove();
  hintState.bubble = null;
};

const showHint = ({ holder, text }) => {
  hideHint();
  const bubble = document.createElement("div");
  bubble.className = "cc-hint";
  bubble.setAttribute("role", "tooltip");
  bubble.textContent = text;
  document.body.append(bubble);
  const box = holder.getBoundingClientRect();
  const size = bubble.getBoundingClientRect();
  const left = Math.min(Math.max(HINT_MARGIN_PX, box.left + box.width / 2 - size.width / 2), window.innerWidth - size.width - HINT_MARGIN_PX);
  const below = box.bottom + HINT_MARGIN_PX;
  const top = below + size.height <= window.innerHeight - HINT_MARGIN_PX ? below : Math.max(HINT_MARGIN_PX, box.top - size.height - HINT_MARGIN_PX);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
  hintState.bubble = bubble;
};

const cancelHold = () => {
  clearTimeout(hintState.holdTimer);
  hintState.holdTimer = null;
  hintState.start = null;
};

// Keyboard: the hint of whatever Tab lands on.
document.addEventListener("focusin", (event) => {
  const hint = event.target instanceof Element && event.target.matches(":focus-visible") ? hintTextOf(event.target) : null;
  if (hint === null) {
    hideHint();
  } else {
    showHint(hint);
  }
});
document.addEventListener("focusout", hideHint);

// Touch: press and hold.
document.addEventListener("pointerdown", (event) => {
  hideHint();
  hintState.swallowClick = false;
  if (event.pointerType !== "touch") {
    return;
  }
  const hint = hintTextOf(event.target);
  if (hint === null) {
    return;
  }
  hintState.start = { x: event.clientX, y: event.clientY };
  hintState.holdTimer = setTimeout(() => {
    hintState.holdTimer = null;
    hintState.swallowClick = true;
    showHint(hint);
  }, HINT_HOLD_MS);
}, true);
document.addEventListener("pointermove", (event) => {
  const start = hintState.start;
  if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > HINT_MOVE_PX) {
    cancelHold();
  }
}, true);
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, cancelHold, true);
}
// The press that showed a hint was a question, not a command.
document.addEventListener("click", (event) => {
  if (hintState.swallowClick) {
    hintState.swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
document.addEventListener("contextmenu", (event) => {
  if (hintState.bubble !== null) {
    event.preventDefault();
  }
}, true);
for (const type of ["scroll", "resize"]) {
  window.addEventListener(type, hideHint, true);
}
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideHint();
  }
});
