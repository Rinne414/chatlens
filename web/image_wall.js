"use strict";

/* ---------- picture wall: windowed grid / waterfall / card layouts ----------
   Shared by 咒语库, 画廊 and the group page. The arithmetic lives in
   wall_layout.js; this file only positions DOM nodes. Only the tiles near the
   viewport exist in the DOM, so a wall of thousands of pictures stays cheap.

   Usage: put imageWall({...}) into the page like any other node. It mounts
   itself once it is in the document and tears itself down when it leaves, or
   when a newer wall with the same key replaces it. */

const WALL_BUFFER_SCREENS = 1.2;
const WALL_NEAR_END_PX = 1400;
const WALL_MODE_LABELS = { grid: "网格", masonry: "瀑布流", cards: "详细" };

// Remembered per key: a re-render briefly empties the page, and a wall that
// started at height 0 would let the browser clamp the scroll position to the top.
const wallHeights = new Map();
const activeWalls = new Map();

const wallZoom = () => {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

const mountWall = (container, options) => {
  if (!container.isConnected) {
    return;
  }
  activeWalls.get(options.key)?.destroy();
  const { layoutWall, visibleIndexes } = window.WallLayout;
  // A wall inside its own scroll box (options.scrollerSelector) windows
  // against that box instead of the page.
  const scroller = options.scrollerSelector ? container.closest(options.scrollerSelector) : null;
  const nodes = new Map();
  let entries = options.entries;
  let layout = null;
  let frame = null;

  const place = (node, box) => {
    node.style.transform = `translate(${box.x}px, ${box.y}px)`;
    node.style.width = `${box.w}px`;
    node.style.height = `${box.h}px`;
  };

  const relayout = () => {
    layout = layoutWall({
      entries,
      containerWidth: container.clientWidth,
      targetSize: options.targetSize,
      gap: options.gap ?? 8,
      mode: options.mode,
      cardHeight: options.cardHeight,
    });
    container.style.height = `${layout.height}px`;
    wallHeights.set(options.key, layout.height);
    for (const [index, node] of nodes) {
      place(node, layout.boxes[index]);
    }
  };

  const paint = () => {
    frame = null;
    if (!container.isConnected) {
      handle.destroy();
      return;
    }
    // A hidden view keeps its nodes attached; nothing to paint there.
    if (container.offsetParent === null) {
      return;
    }
    // getBoundingClientRect and innerHeight are in zoomed (visual) pixels; the
    // layout is in the page's own CSS pixels.
    const zoom = wallZoom();
    const box = scroller?.getBoundingClientRect() ?? null;
    const viewport = (box === null ? window.innerHeight : box.height) / zoom;
    const top = ((box === null ? 0 : box.top) - container.getBoundingClientRect().top) / zoom;
    const buffer = viewport * WALL_BUFFER_SCREENS;
    const wanted = visibleIndexes(layout.boxes, top - buffer, top + viewport + buffer);
    const keep = new Set(wanted);
    for (const [index, node] of nodes) {
      if (!keep.has(index)) {
        node.remove();
        nodes.delete(index);
      }
    }
    for (const index of wanted) {
      if (nodes.has(index)) {
        continue;
      }
      const node = options.renderEntry(entries[index], index);
      node.classList.add("wall-item");
      place(node, layout.boxes[index]);
      container.append(node);
      nodes.set(index, node);
    }
    if (typeof options.onNearEnd === "function" && layout.height - (top + viewport) < WALL_NEAR_END_PX) {
      options.onNearEnd();
    }
  };

  const schedule = () => {
    if (frame === null) {
      frame = requestAnimationFrame(paint);
    }
  };

  const resizeObserver = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(() => {
      relayout();
      schedule();
    });

  const handle = {
    // Appending a page keeps every placed tile where it is (see wall_layout.js),
    // so existing nodes survive and nothing flickers.
    setEntries: (next) => {
      entries = next;
      relayout();
      schedule();
    },
    // Rebuilds the visible tiles, e.g. after badges arrive.
    repaint: () => {
      for (const node of nodes.values()) {
        node.remove();
      }
      nodes.clear();
      schedule();
    },
    destroy: () => {
      window.removeEventListener("scroll", schedule);
      scroller?.removeEventListener("scroll", schedule);
      resizeObserver?.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (activeWalls.get(options.key) === handle) {
        activeWalls.delete(options.key);
      }
    },
  };

  activeWalls.set(options.key, handle);
  relayout();
  paint();
  window.addEventListener("scroll", schedule, { passive: true });
  scroller?.addEventListener("scroll", schedule, { passive: true });
  resizeObserver?.observe(container);
};

// options: { key, entries, mode, targetSize, gap, cardHeight, renderEntry, onNearEnd, scrollerSelector }
// entries: [{ kind: "tile", ratio, ... } | { kind: "header", height, ... }]
const imageWall = (options) => {
  const container = el("div", {
    class: `wall wall-${options.mode}`,
    style: `height:${wallHeights.get(options.key) ?? 0}px`,
    "data-testid": `wall-${options.key}`,
  });
  queueMicrotask(() => mountWall(container, options));
  return container;
};

// Leaving a view hides it without removing it, so its wall would otherwise
// keep reacting to every scroll. Each view re-renders (and re-mounts its wall)
// when opened again.
const destroyAllWalls = () => {
  for (const wall of [...activeWalls.values()]) {
    wall.destroy();
  }
};
VIEW_LEAVE_HOOKS.push(destroyAllWalls);

// Updates a mounted wall in place. Returns false when there is none, so the
// caller falls back to a full render.
const wallSetEntries = (key, entries) => {
  const wall = activeWalls.get(key);
  if (wall === undefined) {
    return false;
  }
  wall.setEntries(entries);
  return true;
};

const wallRepaint = (key) => {
  activeWalls.get(key)?.repaint();
};

/* ---------- building blocks for tiles ---------- */

// The image is the button that opens the detail; badges sit on top and the
// caption shows on hover (always on touch screens, see wall.css).
const wallTile = ({ src, alt = "", onOpen, badges = [], corner = null, caption = null, onError = null, extraClass = "" }) => {
  const image = el("img", { src, alt, loading: "lazy", decoding: "async", draggable: "false" });
  // Not once: a handler may swap in a fallback src, which can fail too.
  if (onError !== null) {
    image.addEventListener("error", () => onError(image));
  }
  return el("div", { class: `wall-tile ${extraClass}` },
    el("button", { class: "wall-open", type: "button", title: caption?.title ?? alt, onclick: onOpen }, image),
    badges.length === 0
      ? null
      : el("div", { class: "wall-badges" },
        badges.map((badge) => el("span", { class: `wall-badge ${badge.tone ?? ""}`, title: badge.title ?? "" }, badge.text))),
    corner,
    caption === null
      ? null
      : el("div", { class: "wall-caption" },
        el("strong", {}, caption.title),
        caption.sub ? el("span", {}, caption.sub) : null));
};

const wallHeader = (title, sub = "", action = null) =>
  el("div", { class: "wall-header" }, el("strong", {}, title), sub ? el("span", {}, sub) : null, action);

/* ---------- view mode + tile size controls ---------- */

const wallReadPref = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const wallWritePref = (key, value) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private windows may refuse storage; the choice still applies now.
  }
};

let wallSizeTimer = null;

// modes: subset of WALL_MODE_LABELS keys. onSize is debounced: every size step
// re-lays the whole wall out.
const wallControls = ({ mode, modes, size, min, max, onMode, onSize }) =>
  el("div", { class: "wall-controls" },
    el("div", { class: "wall-modes", role: "group", "aria-label": "显示方式" },
      modes.map((value) => el("button", {
        class: value === mode ? "wall-mode active" : "wall-mode",
        type: "button",
        "aria-pressed": String(value === mode),
        onclick: () => onMode(value),
      }, WALL_MODE_LABELS[value]))),
    mode === "cards"
      ? null
      : el("label", { class: "wall-size", title: "图片大小" },
        el("span", {}, "大小"),
        el("input", {
          type: "range",
          min: String(min),
          max: String(max),
          step: "10",
          value: String(size),
          "aria-label": "图片大小",
          oninput: (event) => {
            const value = Number(event.target.value);
            clearTimeout(wallSizeTimer);
            wallSizeTimer = setTimeout(() => onSize(value), 120);
          },
        })));
