"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.29";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "画廊里有了「留存的原图」", detail: "搜索框左边可以在「全部群图」和「留存的原图」之间切换。留存的原图是原图已经存在本工具里的图，腾讯删掉之后也能看；这里列出全部时间的，照样可以搜索、按群和发图人筛选。以前工具从电脑里复制进来的那些原图也算在内。", view: "media", selector: ".gallery-scope" },
  { title: "「留存」和「另存为」分开了", detail: "点开一张图：「留存原图」是把原图存进本工具，以后在「留存的原图」里找；「另存为…」是把原图存到你选的位置。以前的「保存原图」「下载原图」「在工具里永久保存」都改成了这两个说法。", view: "media", selector: ".gallery-scope" },
  { title: "多选可以一起留存", detail: "画廊「多选」后，底部一栏有「另存到文件夹」和新的「留存原图」，可以一次留存选中的图，中途能停下。", view: "media", selector: ".gallery-page .kb-results-head" },
  { title: "哪些图留存了，一眼能看到", detail: "留存过原图的图片，缩略图上都有「已留存」（以前只有 AI 图有）；左边筛选里的「原图已留存」可以在当前时间范围里只看它们。在消息里点开已留存的图，按「已留存 · 看留存的原图」直接去画廊。", view: "media", selector: "#gallery-facets-body" },
];

const whatsNewState = { hidden: false };

const whatsNewSeen = () => {
  try {
    return localStorage.getItem(WHATS_NEW_KEY) === WHATS_NEW_RELEASE;
  } catch {
    return false;
  }
};

const dismissWhatsNew = () => {
  whatsNewState.hidden = true;
  try {
    localStorage.setItem(WHATS_NEW_KEY, WHATS_NEW_RELEASE);
  } catch {
    // Hidden for this visit anyway.
  }
  renderBriefView();
};

// Pages draw again once their data arrives, replacing the node: for a moment
// keep outlining whatever matches now, scrolling to it whenever it changes.
const whatsNewFlash = (selector) => {
  const started = Date.now();
  let shown = null;
  let firstSeen = null;
  const step = () => {
    const node = document.querySelector(selector);
    if (node !== null && node !== shown) {
      node.classList.add("whats-new-flash");
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      shown = node;
      firstSeen = firstSeen ?? Date.now();
    }
    const over = firstSeen === null
      ? Date.now() - started > WHATS_NEW_GIVE_UP_MS
      : Date.now() - firstSeen > WHATS_NEW_FLASH_MS;
    if (over) {
      shown?.classList.remove("whats-new-flash");
      return;
    }
    setTimeout(step, WHATS_NEW_FIND_STEP_MS);
  };
  step();
};

// run: "palette" opens Ctrl+K, "keys" the home keyboard help; otherwise the
// page opens (view) and the spot is outlined (selector).
const whatsNewGo = (item) => {
  if (item.run === "palette") {
    openPalette();
    return;
  }
  if (item.run === "keys") {
    toggleBriefKeyHelp();
    return;
  }
  if (item.view !== null && app.view !== item.view) {
    openView(item.view);
  }
  if (item.selector !== null) {
    whatsNewFlash(item.selector);
  }
};

const whatsNewActionable = (item) => item.view !== null || item.selector !== null || item.run !== undefined;

// null once dismissed (this release) — the home page shows it first.
const whatsNewCard = () => {
  if (whatsNewState.hidden || whatsNewSeen()) {
    return null;
  }
  return el("section", { class: "whats-new", "aria-label": "这次更新的新东西" },
    el("div", { class: "whats-new-head" },
      el("strong", {}, `这次更新的新东西（${WHATS_NEW.length} 项）`),
      el("button", { class: "btn small ghost", type: "button", onclick: dismissWhatsNew }, "知道了")),
    el("ul", { class: "whats-new-list" }, WHATS_NEW.map((item) => el("li", {},
      !whatsNewActionable(item)
        ? el("div", { class: "whats-new-item" }, el("b", {}, item.title), el("span", {}, item.detail))
        : el("button", { class: "whats-new-item", type: "button", onclick: () => whatsNewGo(item), title: "去看看" },
          el("b", {}, item.title, " →"), el("span", {}, item.detail))))));
};
