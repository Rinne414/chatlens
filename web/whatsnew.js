"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.27";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "先看「值得知道的事」", detail: "各群这段时间的话题合并成几件事：几个群都在讲的算一件，越重要泡泡越大，闲聊折起来。点开一件看每个群怎么说，一键进那个群的消息。下面的「各群总览」收成一句话，点「展开全文」看全部。", view: null, selector: ".brief-things" },
  { title: "AI 整理时也照常收新消息", detail: "后台的 AI 整理一轮有时要半小时以上，以前这段时间不收新消息、@你也不提醒；现在照常按刷新间隔收，提醒也照常。", view: null, selector: null },
  { title: "群里每段话题聊了多久、几个人", detail: "群页「在聊什么」每段写着几点到几点、多少条、几个人、谁说得最多；点开看这一段的全部消息和图片，也能让 AI 只总结这一段。", view: "group", selector: "#view-group .gp-section-tools" },
  { title: "写进 Obsidian 笔记库", detail: "设置里新增「Obsidian 笔记库」：按主题写笔记（一个模型连同它的版本、LoRA、插件和教程在一则里），每天一则日报、每个群一则。默认关着，你点「开始写笔记」才写；「我的笔记」下你写的字永远保留。", view: "settings", selector: "#notes-card" },
  { title: "跳到某个时间点准了", detail: "从群页、个人页、热点、回顾、问群聊跳进聊天，以前常停在别处；现在停在那条消息上。", view: null, selector: null },
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
