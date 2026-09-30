"use strict";

/* ---------- 群 → 关系网 (联络图) ----------
   Who replies to and @'s whom in the dates the 群 page shows, drawn as a
   contact map: each person is their QQ avatar (bigger = says more) ringed in
   the colour of their circle (people who mostly talk among themselves), each
   pair a curved line (thicker = more back and forth). Hover shows a card,
   click picks a person, double-click opens their page (group_person.js);
   people can be dragged, the map panned and zoomed. The math lives in
   web/relation_graph.js. The drawing is built once per group, range and
   people count and kept across the page's re-renders, so picking someone
   only changes classes (no redraw, no jump). Circles and pairs are also
   listed in text under the map, so nothing depends on colour alone. */

const REL_SHOW_CHOICES = [15, 30, 60];
const REL_DEFAULT_SHOW = 30;
const REL_BOX = { width: 1000, height: 620, pad: 60 };
const REL_COLORED_CIRCLES = 3;
const REL_LABEL_ALL_UP_TO = 60;
const REL_LABEL_CHARS = 8;
const REL_PAIRS_PREVIEW = 6;
const REL_CARD_PARTNERS = 5;
const REL_CHIP_AVATARS = 5;
const REL_SVG_NS = "http://www.w3.org/2000/svg";
const REL_EDGE_MIN_OPACITY = 0.1;
const REL_CURVE = 0.12;
const REL_ZOOM_MIN = 0.5;
const REL_ZOOM_MAX = 4;
const REL_ZOOM_STEP = 1.3;
const REL_CLICK_SLOP = 4;
// Two clicks on one person this close together open their page. Detected
// here: the first click re-renders the page around the (kept) drawing, which
// makes the browser drop its own dblclick.
const REL_DOUBLE_CLICK_MS = 350;
const REL_ENTER_STAGGER_MS = 18;
const REL_ENTER_MAX_DELAY_MS = 600;
// people.css rel-pop lasts .55 s. The kept stage is re-attached on every
// redraw, and a browser replays CSS animations on re-attach: once they have
// played, the stage is marked rel-entered and they are off.
const REL_ENTER_DONE_MS = REL_ENTER_MAX_DELAY_MS + 550;

// The drawing for one group, range and people count (see the header).
let relationCache = null;

const relationShow = () => app.groupPage.relShow ?? REL_DEFAULT_SHOW;
const relationFocus = () => app.groupPage.relFocus ?? null;

const svgEl = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(REL_SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) {
      node.append(child instanceof Node ? child : String(child));
    }
  }
  return node;
};

const circleClass = (index) => (index < REL_COLORED_CIRCLES ? `c${index}` : "c-other");
const shortName = (name) => (Array.from(name).length > REL_LABEL_CHARS ? `${Array.from(name).slice(0, REL_LABEL_CHARS - 1).join("")}…` : name);
const personLabel = (person) => (person.isSelf ? `${person.name}（我）` : person.name);
const personAvatar = (person, size) => avatarEl(person.name, person.uin, size, userAvatarUrl(person.uin));

const sentText = (direction) => [
  direction.replies > 0 ? `回复 ${direction.replies} 次` : "",
  direction.ats > 0 ? `@ ${direction.ats} 次` : "",
].filter(Boolean).join("、") || "没有";

// Everyone a person talks with, most back and forth first (directions apart).
const partnersOf = (uin, links) => links
  .filter((link) => link.a === uin || link.b === uin)
  .map((link) => {
    const mine = link.a === uin;
    return { uin: mine ? link.b : link.a, out: mine ? link.aToB : link.bToA, back: mine ? link.bToA : link.aToB, total: link.total };
  });

/* ---------- the picture (computed once per key) ---------- */

// options: { openPerson(uin), openLabel } - what 「打开…」 and a double
// click do (the 群 page opens the group's person page; a person's 所有群
// page opens the other person's 所有群 page).
const relationPicture = (data, options) => {
  const relations = data.relations;
  const show = relationShow();
  // New replies change the totals even when no new pair appears.
  const interactions = relations.links.reduce((sum, link) => sum + link.total, 0);
  const key = `${data.groupId}|${data.range.fromUnix}|${data.range.toUnix}|${show}|${relations.links.length}|${interactions}|${settings.icons}|${settings.theme}`;
  if (relationCache?.key === key) {
    return relationCache;
  }
  const graph = window.RelationGraph;
  const people = graph.pickPeople(relations.people, show);
  const links = graph.linksAmong(people, relations.links);
  const circles = graph.findCircles(people, links);
  const maxMessages = Math.max(1, ...people.map((person) => person.messages));
  const radii = new Map(people.map((person) => [person.uin, person.messages === 0 ? 11 : 13 + 13 * Math.sqrt(person.messages / maxMessages)]));
  const positions = graph.layoutGraph(people, links, circles, REL_BOX, radii);
  relationCache = { key, groupId: data.groupId, people, links, circles, radii, positions, allLinks: relations.links, allPeople: relations.people, options };
  relationCache.view = buildStage(relationCache);
  return relationCache;
};

/* ---------- drawing ---------- */

const curvePath = (a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cx = (a.x + b.x) / 2 - dy * REL_CURVE;
  const cy = (a.y + b.y) / 2 + dx * REL_CURVE;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

const edgeElement = (picture, link, maxTotal) => {
  const strength = Math.log1p(link.total) / Math.log1p(maxTotal);
  const inner = picture.circles.get(link.a) === picture.circles.get(link.b);
  return svgEl("path", {
    class: `rel-edge ${inner ? circleClass(picture.circles.get(link.a)) : "cross"}`,
    d: curvePath(picture.positions.get(link.a), picture.positions.get(link.b)),
    "stroke-width": (1 + 5 * strength).toFixed(2),
    // Faint weak lines, so the strong ones stand out of a busy group's web.
    "stroke-opacity": (REL_EDGE_MIN_OPACITY + (1 - REL_EDGE_MIN_OPACITY) * strength * strength).toFixed(2),
  });
};

const nodeElement = (picture, person, index) => {
  const r = picture.radii.get(person.uin);
  const { x, y } = picture.positions.get(person.uin);
  const url = settings.icons ? userAvatarUrl(person.uin) : null;
  const labelled = picture.people.length <= REL_LABEL_ALL_UP_TO || index < REL_LABEL_ALL_UP_TO;
  return svgEl("g", {
    class: ["rel-node", circleClass(picture.circles.get(person.uin)), person.isSelf ? "self" : "", person.isFocus ? "focus" : ""].join(" "),
    "data-uin": person.uin,
    transform: `translate(${x} ${y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${personLabel(person)}，发言 ${person.messages} 条，回复或 @ 别人 ${person.sent} 次，被回复或 @ ${person.received} 次`,
  },
  svgEl("g", { class: "rel-node-body", style: `animation-delay:${Math.min(index * REL_ENTER_STAGGER_MS, REL_ENTER_MAX_DELAY_MS)}ms` },
    svgEl("circle", { class: "rel-hit", r: r + 8 }),
    svgEl("circle", { class: "rel-ring", r: r + 3 }),
    svgEl("circle", { class: "rel-face", r, style: `fill:hsl(${hashHue(person.uin)} 55% ${settings.theme === "dark" ? "38%" : "46%"})` }),
    svgEl("text", { class: "rel-initial", "font-size": (r * 0.9).toFixed(1), dy: "0.35em" }, firstGrapheme(person.name) || "?"),
    url === null ? null : svgEl("image", {
      class: "rel-avatar",
      href: url,
      x: -r, y: -r, width: 2 * r, height: 2 * r,
      "clip-path": "url(#rel-avatar-clip)",
      preserveAspectRatio: "xMidYMid slice",
      onerror: (event) => event.target.remove(),
    }),
    person.isSelf ? svgEl("text", { class: "rel-self-tag", y: -r - 9 }, "我") : null,
    labelled ? svgEl("text", { class: "rel-label", y: r + 17 }, shortName(person.name)) : null));
};

const buildStage = (picture) => {
  const maxTotal = Math.max(1, ...picture.links.map((link) => link.total));
  // Weakest first, so the strong lines are drawn on top.
  const edges = [...picture.links].reverse().map((link) => ({ link, path: edgeElement(picture, link, maxTotal) }));
  const nodes = new Map(picture.people.map((person, index) => [person.uin, nodeElement(picture, person, index)]));
  const neighbours = new Map(picture.people.map((person) => [person.uin, new Set()]));
  for (const link of picture.links) {
    neighbours.get(link.a).add(link.b);
    neighbours.get(link.b).add(link.a);
  }
  const viewport = svgEl("g", { class: "rel-viewport" },
    svgEl("g", { class: "rel-edges" }, edges.map((edge) => edge.path)),
    svgEl("g", { class: "rel-nodes" }, [...nodes.values()]));
  const svg = svgEl("svg", {
    class: "rel-svg",
    viewBox: `0 0 ${REL_BOX.width} ${REL_BOX.height}`,
    role: "img",
    "aria-label": `关系网：${picture.people.length} 人，${picture.links.length} 对有来往`,
  },
  svgEl("defs", {}, svgEl("clipPath", { id: "rel-avatar-clip", clipPathUnits: "objectBoundingBox" }, svgEl("circle", { cx: 0.5, cy: 0.5, r: 0.5 }))),
  viewport);
  const view = {
    picture, svg, viewport, edges, nodes, neighbours,
    tip: el("div", { class: "rel-tip", hidden: true, role: "status" }),
    card: el("div", { class: "rel-card", hidden: true }),
    transform: { k: 1, x: 0, y: 0 },
    hover: null,
    pointer: null,
    lastClick: null,
  };
  view.stage = el("div", { class: "rel-stage" }, svg, view.tip, view.card, zoomControls(view));
  wireStage(view);
  setTimeout(() => view.stage.classList.add("rel-entered"), REL_ENTER_DONE_MS);
  return view;
};

/* ---------- highlight, hover card, picked card ---------- */

// Who is lit: the hovered person, else the picked person, else a picked circle.
const litSet = (view) => {
  const focus = relationFocus();
  const person = view.hover ?? (focus?.kind === "person" && view.nodes.has(focus.uin) ? focus.uin : null);
  if (person !== null) {
    return { person, set: new Set([person, ...view.neighbours.get(person)]) };
  }
  if (focus?.kind === "circle") {
    return { person: null, set: new Set(view.picture.people.filter((item) => view.picture.circles.get(item.uin) === focus.index).map((item) => item.uin)) };
  }
  return null;
};

const applyHighlight = (view) => {
  const lit = litSet(view);
  const focus = relationFocus();
  view.svg.classList.toggle("has-focus", lit !== null);
  for (const [uin, node] of view.nodes) {
    node.classList.toggle("lit", lit !== null && lit.set.has(uin));
    node.classList.toggle("picked", focus?.kind === "person" && focus.uin === uin);
  }
  for (const { link, path } of view.edges) {
    const on = lit !== null && (lit.person !== null ? link.a === lit.person || link.b === lit.person : lit.set.has(link.a) && lit.set.has(link.b));
    path.classList.toggle("lit", on);
  }
};

const personByUin = (view, uin) => view.picture.allPeople.find((person) => person.uin === uin);

// Places a card next to a node, inside the stage.
const placeNear = (view, box, uin) => {
  const node = view.nodes.get(uin).getBoundingClientRect();
  const stage = view.stage.getBoundingClientRect();
  const left = Math.min(stage.width - box.offsetWidth - 8, Math.max(8, node.right - stage.left + 10));
  const top = Math.min(stage.height - box.offsetHeight - 8, Math.max(8, node.top - stage.top - 6));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
};

const showTip = (view, uin) => {
  const person = personByUin(view, uin);
  const focus = relationFocus();
  const pair = focus?.kind === "person" && focus.uin !== uin
    ? partnersOf(focus.uin, view.picture.allLinks).find((partner) => partner.uin === uin)
    : undefined;
  const picked = pair === undefined ? null : personByUin(view, focus.uin);
  setChildren(view.tip,
    el("div", { class: "rel-tip-head" }, personAvatar(person, "sm"), el("strong", {}, personLabel(person))),
    el("p", {}, `发言 ${briefNumber(person.messages)} 条 · 来往 ${briefNumber(person.sent + person.received)} 次`),
    pair === undefined ? null : el("p", {}, `${picked.name} → TA：${sentText(pair.out)}`, el("br"), `TA → ${picked.name}：${sentText(pair.back)}`),
    el("p", { class: "kb-meta" }, "点一下看详情，双击打开个人页"));
  view.tip.hidden = false;
  placeNear(view, view.tip, uin);
};

const renderPickedCard = (view) => {
  const focus = relationFocus();
  const person = focus?.kind === "person" ? personByUin(view, focus.uin) : undefined;
  if (person === undefined) {
    view.card.hidden = true;
    return;
  }
  const names = new Map(view.picture.allPeople.map((item) => [item.uin, item]));
  const partners = partnersOf(person.uin, view.picture.allLinks).slice(0, REL_CARD_PARTNERS);
  setChildren(view.card,
    el("div", { class: "rel-card-head" },
      personAvatar(person),
      el("div", {}, el("strong", {}, personLabel(person)),
        el("p", { class: "kb-meta" }, `发言 ${briefNumber(person.messages)} 条 · 找别人 ${briefNumber(person.sent)} 次 · 被找 ${briefNumber(person.received)} 次`)),
      el("button", { class: "rel-card-close", type: "button", "aria-label": "取消选中", title: "取消选中", onclick: () => pickRelation(null) }, "×")),
    el("span", { class: "gp-label" }, "最常来往（→ TA 找对方　← 对方找 TA）"),
    el("ol", { class: "rel-card-partners" }, partners.map((partner) => {
      const other = names.get(partner.uin) ?? { uin: partner.uin, name: partner.uin };
      return el("li", {}, el("button", {
        type: "button",
        title: `${person.name} → ${other.name}：${sentText(partner.out)}\n${other.name} → ${person.name}：${sentText(partner.back)}`,
        onclick: () => pickRelation({ kind: "person", uin: partner.uin }),
      }, personAvatar(other, "sm"), el("span", { class: "rel-pair-names" }, personLabel(other)),
      el("span", { class: "rel-pair-count" }, `→${partner.out.replies + partner.out.ats} ←${partner.back.replies + partner.back.ats}`)));
    })),
    el("button", { class: "btn primary small", type: "button", onclick: () => view.picture.options.openPerson(person.uin) }, view.picture.options.openLabel));
  view.card.hidden = false;
};

// Picks a person or a circle (null: nothing). The drawing stays; the page's
// lists under it re-render for their active states.
const pickRelation = (focus) => {
  replaceGroupPage({ relFocus: focus });
  renderGroupView();
};

/* ---------- pan, zoom, drag ---------- */

const applyTransform = (view) => {
  const { k, x, y } = view.transform;
  view.viewport.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(3)})`);
};

// Client pixels -> viewBox units.
const svgScale = (view) => view.svg.getScreenCTM()?.a || 1;

const zoomBy = (view, factor, centre = { x: REL_BOX.width / 2, y: REL_BOX.height / 2 }) => {
  const { k, x, y } = view.transform;
  const next = Math.min(REL_ZOOM_MAX, Math.max(REL_ZOOM_MIN, k * factor));
  view.transform = { k: next, x: centre.x - ((centre.x - x) * next) / k, y: centre.y - ((centre.y - y) * next) / k };
  applyTransform(view);
};

const zoomControls = (view) => el("div", { class: "rel-zoom", role: "group", "aria-label": "缩放" },
  el("button", { type: "button", title: "放大", onclick: () => zoomBy(view, REL_ZOOM_STEP) }, "+"),
  el("button", { type: "button", title: "缩小", onclick: () => zoomBy(view, 1 / REL_ZOOM_STEP) }, "−"),
  el("button", { type: "button", title: "回到原来的大小和位置", onclick: () => {
    view.transform = { k: 1, x: 0, y: 0 };
    applyTransform(view);
  } }, "重置"));

const moveNode = (view, uin, point) => {
  const position = { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
  view.picture.positions.set(uin, position);
  view.nodes.get(uin).setAttribute("transform", `translate(${position.x} ${position.y})`);
  for (const { link, path } of view.edges) {
    if (link.a === uin || link.b === uin) {
      path.setAttribute("d", curvePath(view.picture.positions.get(link.a), view.picture.positions.get(link.b)));
    }
  }
};

const nodeUinOf = (target) => target?.closest?.(".rel-node")?.getAttribute("data-uin") ?? null;

const onPointerDown = (view, event) => {
  if (event.button !== 0) {
    return;
  }
  const uin = nodeUinOf(event.target);
  view.svg.setPointerCapture?.(event.pointerId);
  view.pointer = {
    id: event.pointerId, uin, moved: false,
    startX: event.clientX, startY: event.clientY,
    transform: { ...view.transform },
    position: uin === null ? null : { ...view.picture.positions.get(uin) },
  };
};

const onPointerMove = (view, event) => {
  const pointer = view.pointer;
  if (pointer === null || pointer.id !== event.pointerId) {
    return;
  }
  const dx = event.clientX - pointer.startX;
  const dy = event.clientY - pointer.startY;
  if (!pointer.moved && Math.hypot(dx, dy) < REL_CLICK_SLOP) {
    return;
  }
  pointer.moved = true;
  view.tip.hidden = true;
  const scale = svgScale(view);
  if (pointer.uin === null) {
    view.transform = { ...pointer.transform, x: pointer.transform.x + dx / scale, y: pointer.transform.y + dy / scale };
    applyTransform(view);
    return;
  }
  const k = view.transform.k;
  moveNode(view, pointer.uin, { x: pointer.position.x + dx / scale / k, y: pointer.position.y + dy / scale / k });
};

const onPointerUp = (view, event) => {
  const pointer = view.pointer;
  if (pointer === null || pointer.id !== event.pointerId) {
    return;
  }
  view.pointer = null;
  view.svg.releasePointerCapture?.(event.pointerId);
  if (pointer.moved) {
    return;
  }
  const focus = relationFocus();
  if (pointer.uin === null) {
    if (focus !== null) {
      pickRelation(null);
    }
    return;
  }
  const now = Date.now();
  if (view.lastClick?.uin === pointer.uin && now - view.lastClick.at < REL_DOUBLE_CLICK_MS) {
    view.lastClick = null;
    view.picture.options.openPerson(pointer.uin);
    return;
  }
  view.lastClick = { uin: pointer.uin, at: now };
  pickRelation({ kind: "person", uin: pointer.uin });
};

const wireStage = (view) => {
  const { svg } = view;
  svg.addEventListener("pointerdown", (event) => onPointerDown(view, event));
  svg.addEventListener("pointermove", (event) => onPointerMove(view, event));
  svg.addEventListener("pointerup", (event) => onPointerUp(view, event));
  svg.addEventListener("pointercancel", () => {
    view.pointer = null;
  });
  // Ctrl + wheel (and a touchpad pinch) zooms; a plain wheel keeps scrolling the page.
  svg.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    zoomBy(view, Math.exp(-event.deltaY * 0.002), point);
  }, { passive: false });
  svg.addEventListener("pointerover", (event) => {
    const uin = nodeUinOf(event.target);
    if (uin !== null && view.pointer === null && uin !== view.hover) {
      view.hover = uin;
      applyHighlight(view);
      showTip(view, uin);
    }
  });
  svg.addEventListener("pointerout", (event) => {
    const uin = nodeUinOf(event.target);
    if (uin !== null && nodeUinOf(event.relatedTarget) !== uin) {
      view.hover = null;
      view.tip.hidden = true;
      applyHighlight(view);
    }
  });
  svg.addEventListener("keydown", (event) => {
    const uin = nodeUinOf(event.target);
    if (uin !== null && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const focus = relationFocus();
      pickRelation(focus?.kind === "person" && focus.uin === uin ? null : { kind: "person", uin });
      // The redraw re-attached the stage, which drops the focus.
      queueMicrotask(() => view.nodes.get(uin)?.focus());
    }
  });
};

/* ---------- the lists under the map ---------- */

const circleChips = (picture) => {
  const members = new Map();
  for (const person of picture.people) {
    const index = picture.circles.get(person.uin);
    members.set(index, [...(members.get(index) ?? []), person]);
  }
  const circles = [...members].sort(([left], [right]) => left - right).filter(([, people]) => people.length > 1);
  if (circles.length === 0) {
    return null;
  }
  const focus = relationFocus();
  const active = circles.find(([index]) => focus?.kind === "circle" && focus.index === index);
  return el("div", { class: "rel-circles" },
    el("span", { class: "gp-label" }, "小圈子（常互相回复的人；点一个只看这圈）"),
    el("div", { class: "rel-chips" }, circles.map(([index, people]) => el("button", {
      class: `rel-chip ${circleClass(index)}${active?.[0] === index ? " active" : ""}`,
      type: "button",
      "aria-pressed": String(active?.[0] === index),
      title: people.map(personLabel).join("、"),
      onclick: () => pickRelation(active?.[0] === index ? null : { kind: "circle", index }),
    },
    el("span", { class: "rel-chip-faces" }, people.slice(0, REL_CHIP_AVATARS).map((person) => personAvatar(person, "sm"))),
    el("span", {}, el("strong", {}, `圈子 ${index + 1}`), ` · ${people.length} 人`)))),
    active === undefined ? null : el("p", { class: "rel-members" }, el("strong", {}, `圈子 ${active[0] + 1}：`), active[1].map(personLabel).join("、")),
    circles.length > REL_COLORED_CIRCLES ? el("p", { class: "kb-meta" }, `圈子 ${REL_COLORED_CIRCLES + 1} 起在图里是灰色。`) : null);
};

const topPairs = (picture) => {
  const names = new Map(picture.allPeople.map((person) => [person.uin, person]));
  const nameOf = (uin) => names.get(uin) ?? { uin, name: uin };
  return el("div", { class: "rel-pairs" },
    el("span", { class: "gp-label" }, "来往最多的两个人"),
    expandable("relPairs", picture.allLinks, REL_PAIRS_PREVIEW, (shown) => el("ol", { class: "rel-pair-list" }, shown.map((link) => el("li", {},
      el("button", {
        type: "button",
        title: `${nameOf(link.a).name} → ${nameOf(link.b).name}：${sentText(link.aToB)}\n${nameOf(link.b).name} → ${nameOf(link.a).name}：${sentText(link.bToA)}`,
        onclick: () => pickRelation({ kind: "person", uin: link.a }),
      },
      el("span", { class: "rel-pair-faces" }, personAvatar(nameOf(link.a), "sm"), personAvatar(nameOf(link.b), "sm")),
      el("span", { class: "rel-pair-names" }, `${personLabel(nameOf(link.a))} ⇄ ${personLabel(nameOf(link.b))}`),
      el("span", { class: "rel-pair-count" }, `${briefNumber(link.total)} 次`))))), "对"));
};

const relationShowControl = (related) => el("div", { class: "wall-modes", role: "group", "aria-label": "图里画几个人" },
  [...REL_SHOW_CHOICES.filter((count) => count < related), related].map((count) => el("button", {
    class: relationShow() === count || (relationShow() >= related && count === related) ? "wall-mode active" : "wall-mode",
    type: "button",
    onclick: () => {
      replaceGroupPage({ relShow: count, relFocus: null });
      renderGroupView();
    },
  }, count === related ? `全部 ${related} 人` : `前 ${count} 人`)));

const RELATION_DEFAULTS = {
  title: "关系网",
  subtitle: "谁回复 / @ 谁（所选时间）",
  openLabel: "打开 TA 的个人页 →",
};

const groupRelations = (data, overrides = {}) => {
  const relations = data.relations;
  if (relations === undefined) {
    return null;
  }
  const options = { ...RELATION_DEFAULTS, openPerson: (uin) => openPersonView(uin), ...overrides };
  const related = relations.people.filter((person) => person.sent + person.received > 0).length;
  const head = el("div", { class: "gp-section-head" },
    el("h3", {}, options.title, el("span", { class: "kb-meta" }, `　${options.subtitle}`)),
    related > REL_SHOW_CHOICES[0] ? relationShowControl(related) : null);
  if (relations.links.length === 0) {
    return el("section", { class: "card gp-section gp-rel" }, head, el("p", { class: "kb-meta" }, "这段时间没有人回复或 @ 别人。换一个更长的时间看看。"));
  }
  const picture = relationPicture(data, options);
  const interactions = relations.links.reduce((sum, link) => sum + link.total, 0);
  // After the page has attached the (kept) stage again.
  queueMicrotask(() => {
    applyHighlight(picture.view);
    renderPickedCard(picture.view);
  });
  return el("section", { class: "card gp-section gp-rel" },
    head,
    el("p", { class: "kb-meta" },
      `${briefNumber(related)} 人互相回复或 @ 过，共 ${briefNumber(interactions)} 次。头像越大说话越多，线越粗来往越多，外圈同色是一个小圈子。`,
      "点一个人看 TA 和谁最常来往，双击打开个人页；人可以拖动，空白处拖动平移，Ctrl + 滚轮缩放。"),
    picture.view.stage,
    el("div", { class: "rel-under" }, circleChips(picture), topPairs(picture)));
};
