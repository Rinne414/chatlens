"use strict";

/* ---------- drag to resize a list ----------
   A grip under a scrolling list (the rail's followed groups, the group
   pickers, long filter lists, the job log): drag it to show more or fewer
   rows, double-click for the page's default, arrow keys from the keyboard.
   The height is kept per browser under the list's own key and put back on
   every redraw by sizedList(). */

const RESIZE_MIN_PX = 80;
const RESIZE_KEY_STEP_PX = 24;
const RESIZE_PREFIX = "cc-size-";

// Which list is being dragged, so a timed redraw can wait until it ends.
const resizeState = { active: null };

// dragged: screen pixels; scale: screen pixels per CSS pixel (page zoom);
// max: the height that shows every row.
const resizedHeight = ({ startHeight, dragged, scale, max }) =>
  Math.round(Math.min(Math.max(RESIZE_MIN_PX, max), Math.max(RESIZE_MIN_PX, startHeight + dragged / scale)));

const storedResizeHeight = (key) => {
  const raw = wallReadPref(`${RESIZE_PREFIX}${key}`, "");
  const height = Number(raw);
  return raw !== "" && Number.isFinite(height) && height >= RESIZE_MIN_PX ? height : null;
};

// Inline, so it wins over each list's own max-height and flex sizing.
const applyResizeHeight = (box, height) => {
  const sized = height !== null;
  box.classList.toggle("user-sized", sized);
  for (const [property, value] of [["height", `${height}px`], ["max-height", "none"], ["flex", "none"], ["box-sizing", "border-box"]]) {
    if (sized) {
      box.style.setProperty(property, value);
    } else {
      box.style.removeProperty(property);
    }
  }
};

// Borders and a horizontal scrollbar count too, or the last row stays hidden.
const fullHeight = (box) => box.scrollHeight + (box.offsetHeight - box.clientHeight);

const saveResizeHeight = (key, height) => wallWritePref(`${RESIZE_PREFIX}${key}`, height === null ? "" : height);

const dragResize = (key) => (event) => {
  const grip = event.currentTarget;
  const box = grip.previousElementSibling;
  if (box === null || event.button !== 0) {
    return;
  }
  event.preventDefault();
  const startHeight = box.offsetHeight;
  const scale = startHeight > 0 ? box.getBoundingClientRect().height / startHeight : 1;
  const startY = event.clientY;
  const max = fullHeight(box);
  let height = startHeight;
  resizeState.active = key;
  grip.classList.add("dragging");
  grip.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    height = resizedHeight({ startHeight, dragged: moveEvent.clientY - startY, scale, max });
    applyResizeHeight(box, height);
  };
  const end = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    grip.classList.remove("dragging");
    resizeState.active = null;
    if (height !== startHeight) {
      saveResizeHeight(key, height);
    }
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
};

const keyResize = (key) => (event) => {
  const step = { ArrowDown: RESIZE_KEY_STEP_PX, ArrowUp: -RESIZE_KEY_STEP_PX }[event.key];
  const box = event.currentTarget.previousElementSibling;
  if (step === undefined || box === null) {
    return;
  }
  event.preventDefault();
  const height = resizedHeight({ startHeight: box.offsetHeight, dragged: step, scale: 1, max: fullHeight(box) });
  applyResizeHeight(box, height);
  saveResizeHeight(key, height);
};

const resetResize = (key) => (event) => {
  const box = event.currentTarget.previousElementSibling;
  if (box !== null) {
    applyResizeHeight(box, null);
  }
  saveResizeHeight(key, null);
};

const resizeGrip = (key) =>
  el("div", {
    class: "resize-grip",
    role: "separator",
    "aria-orientation": "horizontal",
    "aria-label": "调整列表高度",
    title: "拖动调整高度（拉到底显示全部），双击恢复默认",
    tabindex: "0",
    onpointerdown: dragResize(key),
    onkeydown: keyResize(key),
    ondblclick: resetResize(key),
  });

// The list followed by its grip, at the height the user last chose.
const sizedList = (key, box) => {
  applyResizeHeight(box, storedResizeHeight(key));
  return [box, resizeGrip(key)];
};
