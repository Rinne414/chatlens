"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.31";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "「留存的原图」会说明自己了", detail: "开头写着一共留存多少张、占多少空间、存在哪个文件夹，以及原图是怎么进来的。点开一张图能看到它为什么被留存；左边「为什么留存」可以按原因筛选。", view: "media", selector: ".gallery-scope" },
  { title: "不想留的原图可以取消留存", detail: "在「留存的原图」里点开图按「取消留存」，或「多选」后一起取消。文件先放到一边，可以放回；按「彻底删除」才真的删掉、腾出空间，删掉的图不会再被自动留存。", view: "media", selector: ".gallery-scope" },
  { title: "看得到消息新不新", detail: "左栏和简报顶部会写消息到几点、下次几点刷新。后台刷新关着时会直接说，并给一个打开的按钮。", view: null, selector: "#rail-status" },
  { title: "存储、设置、备份页改成了大白话", detail: "存储页打开就会算好本程序占了多少，删除的按钮单独放并先问一句；设置页的 AI 用量写明花在哪了；备份页的几个数字对得上了。", view: "storage", selector: "#view-storage" },
  { title: "画廊左边的统计快了", detail: "时间范围选「全部」时，左边的数字以前要等十秒左右，现在几秒；图片没有变化时再打开是马上。", view: "media", selector: "#gallery-facets-body" },
  { title: "可以关掉自动检查更新", detail: "设置 →「版本与更新」多了「自动检查更新」的开关，默认开着；关掉后只有你点「检查更新」才查。", view: "settings", selector: "#update-card" },
  { title: "「打开文件夹」的按钮修好了", detail: "在 Windows 上，「打开留存文件夹」「打开备份文件夹」、存储页的「打开」这类按钮以前按了没有反应：文件夹其实开了，但窗口是隐藏的。现在会正常出现。", view: null, selector: "" },
  { title: "画廊里有了「留存的原图」", detail: "搜索框左边可以在「全部群图」和「留存的原图」之间切换。留存的原图是原图已经存在本工具里的图，腾讯删掉之后也能看；这里列出全部时间的，照样可以搜索、按群和发图人筛选。以前工具从电脑里复制进来的那些原图也算在内。", view: "media", selector: ".gallery-scope" },
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
