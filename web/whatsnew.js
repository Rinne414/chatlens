"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.33";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "简报从上次看到的地方开始", detail: "看过简报一小时后，下一份只有那之后的新内容，不用再按「看完了」。日期旁边可以「回到上一份」，也可以改回按「看完了」才换。", view: "brief", selector: ".brief-window-mode" },
  { title: "答应过的事", detail: "你在群里答应别人的、别人请你做的、别人答应你的，简报最上面列出来，做完了打个勾。", view: "brief", selector: ".brief-commitments" },
  { title: "画廊：一下就存到自己的文件夹", detail: "拖动图片，下面会出现你的存图文件夹，放进去，或看图时按 S / 1–9，原图就存到那个文件夹。存过的图有记号，也可以只看还没存过的。", view: "media", selector: ".tray-dock" },
  { title: "找同一张图、用图找图", detail: "点开一张图能看到它还在哪些群、什么时候发过；画廊工具栏的「以图搜图」可以拿一张图去找库里相同或相近的。", view: "media", selector: ".gallery-toolbar" },
  { title: "聊天里看得到回复的是哪句", detail: "回复的消息上面有被回复的原话，点了跳过去再回来；点名字只看这个人；右上「@你」可以一条一条跳。", view: "messages", selector: "#view-messages" },
  { title: "个人页和角色卡", detail: "聊天里点名字再点「TA 的个人页」：你和 TA 的来往、TA 常说的话、回答过的问题；还可以让 AI 写一张角色卡。简报最下面有「我的页面」。", view: "brief", selector: ".brief-page" },
  { title: "热点里看画师", detail: "热点页多了「画师」：这段时间群里的图，咒语写了哪些画师，谁变多了。", view: "trends", selector: "#view-trends .gallery-toolbar" },
  { title: "问答库和资源库", detail: "回顾页搜索框旁边：群里问过的问题（可以只看没人回答的）、提到的新东西和链接，不用输入就能翻。搜不到时可以让 AI 换几种说法再搜。", view: "review", selector: ".review-search" },
  { title: "告诉简报什么不重要", detail: "点开「值得知道的事」里的一件，可以标「不重要」或「讲错了」，它会从简报拿掉；也可以写一句话，让 AI 帮你盯一件事。", view: "brief", selector: ".thing-section" },
  { title: "刷新能看进度、能停下", detail: "后台刷新时简报写着正在做哪一步、已经多久，旁边可以「停下这一轮」。任何页面按 ? 看这一页能用的键。主题多了「跟随系统」。", view: null, selector: "" },
  { title: "咒语库：换写法、交给 ComfyUI", detail: "咒语可以复制成 NAI 或 WebUI 的强调写法；ComfyUI 做的图可以把工作流直接交给这台电脑上的 ComfyUI 排队。", view: "knowledge", selector: "#view-knowledge" },
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
    toggleKeyHelp();
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
  // One line until opened: the news about the program never outweighs the
  // news from the groups.
  const open = whatsNewState.open === true;
  return el("section", { class: open ? "whats-new" : "whats-new folded", "aria-label": "ChatLens 这次更新了什么" },
    el("div", { class: "whats-new-head" },
      el("strong", {}, `ChatLens 这次更新了什么（${WHATS_NEW.length} 项）`),
      el("span", { class: "whats-new-actions" },
        el("button", {
          class: "btn small ghost",
          type: "button",
          "aria-expanded": String(open),
          onclick: () => {
            whatsNewState.open = !open;
            renderBriefView();
          },
        }, open ? "收起" : "看看有什么"),
        el("button", { class: "btn small ghost", type: "button", onclick: dismissWhatsNew }, "知道了"))),
    !open ? null : el("ul", { class: "whats-new-list" }, WHATS_NEW.map((item) => el("li", {},
      !whatsNewActionable(item)
        ? el("div", { class: "whats-new-item" }, el("b", {}, item.title), el("span", {}, item.detail))
        : el("button", { class: "whats-new-item", type: "button", onclick: () => whatsNewGo(item), title: "去看看" },
          el("b", {}, item.title, " →"), el("span", {}, item.detail))))));
};
