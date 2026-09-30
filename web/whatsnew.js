"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.21";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "回复不再漏掉", detail: "以前「回复」某条消息发出的消息（约占聊天的两到三成）都没收进来：聊天、AI 总结和「和你有关」里都少了它们。现在都会收进来；升级后第一次后台刷新会把以前的回复补回来（约 1–2 分钟，只做一次，不另花 AI 费用）。", view: "brief", selector: ".brief-for-you" },
  { title: "「现在在聊」好读了", detail: "群页的「现在在聊」先给两句重点，「展开全文」看完整的；下面「按时间」一行一段，点一段跳到那里的消息。", view: "group", selector: ".gp-brief" },
  { title: "关系网", detail: "群页里谁回复 / @ 了谁，画成头像联络图：头像越大说话越多，线越粗来往越多，外圈同色是常互相回复的小圈子。点一个人看 TA 最常和谁来往，双击打开个人页。", view: "group", selector: ".gp-rel" },
  { title: "个人页和好感度趋势", detail: "一个人在这个群说了多少、什么时候说、最常和谁来往，以及和几个人互相回复 / @ 的次数怎么变化。在关系网里双击一个人打开。", view: "group", selector: ".gp-rel" },
  { title: "TA 在所有群", detail: "个人页上点「看 TA 在所有群」：TA 在你所在的哪些群说话、各群用的名字、跨群最常来往的人和跨群关系网。只统计这台电脑上有记录的群。", view: null, selector: null },
  { title: "QQ 收藏图", detail: "左栏「QQ 收藏图」：收藏里的图按天排开，对照你电脑上的图片文件夹标出哪些还没存，挑一段一次存好。", view: "qqcollect", selector: ".qqc-head" },
  { title: "后退 / 前进", detail: "顶上的「← 返回」、浏览器或鼠标侧键的后退，都会回到上一个画面和原来的位置：群页回到群列表，聊天回到群列表或打开它的页面，看大图时是关掉大图。", view: null, selector: null },
  { title: "「不看此人」已移除", detail: "容易误点，点了又找不到地方撤回。以前设为不看的人，他们的 @ 会重新出现在「和你有关」；快捷键 m 也一起取消。", view: null, selector: null },
  { title: "AI 会看到什么", detail: "开启 AI 时，要整理的消息会发给你在设置里选的 AI 服务商；不开 AI，聊天内容就不会离开这台电脑。关系网、个人页和所有群页只在本机统计，不用 AI。", view: null, selector: null },
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
