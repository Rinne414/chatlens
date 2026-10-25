"use strict";

/* ---------- 值得知道的事: the bubble map ----------
   Shared by 简报 (brief_things.js) and 群 → 重要的事 (group_things.js). Each
   thing is a bubble: its area follows its weight, its colour its kind (also
   said in words in the legend, the tooltip and the list). Biggest first, so
   the same things always land in the same places. Hovering a bubble lights
   the list row with the same data-thing id, and the other way round. */

const BUBBLE_WIDTH = 1000;
const BUBBLE_HEIGHT = 380;
const BUBBLE_FILL_SHARE = 0.5;
const BUBBLE_GAP = 6;
const BUBBLE_LABEL_MIN_RADIUS = 46;
const BUBBLE_ANGLES = 48;
// Narrow screens (a phone, a small window) get a squarer map instead of a
// wide strip of tiny bubbles.
const BUBBLE_NARROW_PX = 760;
const BUBBLE_NARROW_ASPECT = 0.95;

const THING_KINDS = {
  new: { label: "新东西", hint: "新模型、新工具、新版本、新作品、新闻" },
  qa: { label: "问答", hint: "有人提问或求助" },
  resource: { label: "资源", hint: "链接、参数、教程、文件" },
  group: { label: "群务", hint: "公告、规则、争执" },
  chat: { label: "闲聊", hint: "没有新信息的对话" },
};

const thingMapState = { hover: "" };

// Each next bubble at the free spot nearest the middle, the middle stretched
// by aspect (width / height) so the map fills a box of that shape.
const packBubbles = (things, aspect = BUBBLE_WIDTH / BUBBLE_HEIGHT) => {
  const totalWeight = things.reduce((total, thing) => total + Math.max(thing.weight, 0.5), 0);
  const scale = Math.sqrt((BUBBLE_WIDTH * BUBBLE_HEIGHT * BUBBLE_FILL_SHARE) / (Math.PI * totalWeight));
  const placed = [];
  const fits = (x, y, r) => placed.every((other) => Math.hypot(other.x - x, other.y - y) >= other.r + r + BUBBLE_GAP);
  const farness = (x, y) => Math.hypot(x / aspect, y);
  for (const thing of things) {
    const r = Math.max(10, Math.sqrt(Math.max(thing.weight, 0.5)) * scale);
    let best = placed.length === 0 ? { x: 0, y: 0 } : null;
    for (const other of placed) {
      for (let step = 0; step < BUBBLE_ANGLES; step += 1) {
        const angle = (step / BUBBLE_ANGLES) * Math.PI * 2;
        const x = other.x + Math.cos(angle) * (other.r + r + BUBBLE_GAP);
        const y = other.y + Math.sin(angle) * (other.r + r + BUBBLE_GAP);
        if (fits(x, y, r) && (best === null || farness(x, y) < farness(best.x, best.y))) {
          best = { x, y };
        }
      }
    }
    placed.push({ thing, r, ...best });
  }
  return placed;
};

const bubbleBox = (placed) => {
  const left = Math.min(...placed.map((bubble) => bubble.x - bubble.r)) - BUBBLE_GAP;
  const top = Math.min(...placed.map((bubble) => bubble.y - bubble.r)) - BUBBLE_GAP;
  const right = Math.max(...placed.map((bubble) => bubble.x + bubble.r)) + BUBBLE_GAP;
  const bottom = Math.max(...placed.map((bubble) => bubble.y + bubble.r)) + BUBBLE_GAP;
  return `${left} ${top} ${right - left} ${bottom - top}`;
};

const THING_SVG_NS = "http://www.w3.org/2000/svg";
const thingSvg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(THING_SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return node;
};

const highlightThing = (id, on) => {
  thingMapState.hover = on ? id : "";
  for (const node of document.querySelectorAll(`[data-thing="${CSS.escape(id)}"]`)) {
    node.classList.toggle("hover", on);
  }
};

// Hover wiring for a list row of the same thing.
const thingHoverProps = (id) => ({
  "data-thing": id,
  onmouseenter: () => highlightThing(id, true),
  onmouseleave: () => highlightThing(id, false),
});

const thingStatus = (thing) => {
  if (thing.status === "resolved") {
    return el("span", { class: "thing-status resolved" }, "✓ 有答案");
  }
  return thing.status === "open" ? el("span", { class: "thing-status open" }, "? 没结论") : null;
};

// options: idOf(thing), factsOf(thing) for the label and tooltip, onOpen(thing).
const bubbleNode = (bubble, { idOf, factsOf, onOpen }) => {
  const { thing, r, x, y } = bubble;
  const id = idOf(thing);
  const kind = THING_KINDS[thing.kind] ?? THING_KINDS.chat;
  const label = r >= BUBBLE_LABEL_MIN_RADIUS
    ? thingSvg("foreignObject", { x: x - r * 0.78, y: y - r * 0.6, width: r * 1.56, height: r * 1.2 },
      el("div", { class: "thing-bubble-label", style: `font-size:${Math.min(22, Math.max(13, r / 5))}px` },
        el("strong", {}, thing.title),
        el("span", {}, factsOf(thing))))
    : null;
  const group = thingSvg("g", {
    class: `thing-bubble thing-${thing.kind} ${thingMapState.hover === id ? "hover" : ""}`,
    tabindex: "0",
    role: "button",
    "aria-label": `${kind.label}：${thing.title}，${factsOf(thing)}`,
    "data-thing": id,
  },
  thingSvg("title", {}, `${kind.label} · ${thing.title}${thing.takeaway ? `\n${thing.takeaway}` : ""}\n${factsOf(thing)}`),
  thingSvg("circle", { cx: x, cy: y, r }),
  label);
  group.addEventListener("click", () => onOpen(thing));
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(thing);
    }
  });
  group.addEventListener("mouseenter", () => highlightThing(id, true));
  group.addEventListener("mouseleave", () => highlightThing(id, false));
  return group;
};

// options as bubbleNode, plus caption (the svg's label) and weightNote (what
// makes a bubble big, under the legend).
const thingMap = (things, options) => {
  const placed = packBubbles(things, window.innerWidth < BUBBLE_NARROW_PX ? BUBBLE_NARROW_ASPECT : BUBBLE_WIDTH / BUBBLE_HEIGHT);
  return el("div", { class: "thing-map" },
    thingSvg("svg", { viewBox: bubbleBox(placed), preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": options.caption },
      placed.map((bubble) => bubbleNode(bubble, options))),
    el("div", { class: "thing-legend" },
      Object.entries(THING_KINDS).map(([kind, info]) => el("span", { class: `thing-legend-item thing-${kind}`, title: info.hint },
        el("i", { "aria-hidden": "true" }), info.label)),
      el("span", { class: "kb-meta" }, options.weightNote)));
};
