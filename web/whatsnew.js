"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

const WHATS_NEW_RELEASE = "2026-09-30";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "Ctrl+K 搜索一切", detail: "在任何页面按 Ctrl+K（或 /）：输入页面名、群名、关注的词直接跳过去，或者把任意内容拿去回顾、问群聊、收藏里找。", view: null, selector: null, run: "palette" },
  { title: "首页键盘操作", detail: "j / k 在卡片间移动，o 打开，s 收藏，m 不看此人，? 看全部快捷键。", view: null, selector: null, run: "keys" },
  { title: "关闭控制台", detail: "控制台在后台运行、没有窗口；现在左栏最下面和设置里都有「关闭控制台」。", view: null, selector: "#quit-console" },
  { title: "关注的词", detail: "加几个词（模型、画师、你的作品名），哪个群提到就列在首页；想要的话还能弹桌面通知。", view: "brief", selector: ".brief-watch" },
  { title: "收藏", detail: "简报、各群总览、回顾里的新东西、问答、话题点 ☆ 就收下，左栏「收藏」随时翻。", view: "bookmarks", selector: "#view-bookmarks" },
  { title: "和你有关更清楚", detail: "同一个人连续 @ 你会折叠成一串；机器人可以「不看此人」；你当时就在聊的排在后面，也不再弹通知。", view: "brief", selector: ".brief-for-you" },
  { title: "每个群看到哪了", detail: "右边的群卡片写着还没看几条、看到一半还是看完了，「标为看完」一键跟上；未读数不再全是 99+。", view: "brief", selector: ".brief-side" },
  { title: "AI 出问题会直说", detail: "余额不足、密钥失效时首页写明原因，修好后点「重试」。之前余额不足漏掉的约 1.5 万条消息已重新排队总结。", view: "brief", selector: ".brief-mast" },
  { title: "回顾搜索能选时间", detail: "搜索结果上方可以选 全部 / 最近 7 天 / 30 天 / 任意日期。", view: "review", selector: ".review-search" },
  { title: "问群聊说清楚读了多少", detail: "会写明相关消息一共多少、实际读了最新的多少条，以及想问更早的事该怎么问。", view: "ask", selector: "#view-ask" },
  { title: "备份更稳妥", detail: "消息没扫完时绝不说「可以放心清理」；可以打开「以后自动保存所有 AI 原图」。", view: "backup", selector: ".backup-auto-keep" },
  { title: "后退 / 前进", detail: "浏览器或鼠标侧键的后退、前进可以在页面之间切换，并回到原来的位置。", view: null, selector: null },
  { title: "更快", detail: "打开聊天、简报、咒语库、热点、群页明显更快，重的查询不再卡住整个控制台。", view: null, selector: null },
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
