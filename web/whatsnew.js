"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.32";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "页面之间能直接走过去了", detail: "句子里提到别的页面（画廊「留存的原图」、存储页、备份页、设置里的某一栏）现在都能点过去。备份页写明了留存的原图去了哪，各处提到文件夹的地方旁边有打开的按钮。", view: "backup", selector: "#backup-rescue" },
  { title: "左栏分成了三组", detail: "聊天、图片、这台电脑。入口和顺序都没变，只是标出了哪几页是一类。", view: null, selector: "#nav" },
  { title: "设置页有了目录", detail: "设置页最上面多了一排按钮，点了就跳到那一栏。长的说明只显示开头，后面点「展开说明」。", view: "settings", selector: ".page-index" },
  { title: "提问和提示都在页面里了", detail: "确认和出错提示不再弹浏览器的小窗口：在页面里问，按 Esc 或点外面就是取消，会删东西的确认按钮是红色的。", view: null, selector: "" },
  { title: "手机上长按能看到说明", detail: "鼠标停在按钮上才出现的说明，现在在手机上长按、用键盘 Tab 到也能看到。等待超过两秒会显示已经等了多久。", view: null, selector: "" },
  { title: "「留存的原图」会说明自己了", detail: "开头写着一共留存多少张、占多少空间、存在哪个文件夹，以及原图是怎么进来的。点开一张图能看到它为什么被留存；左边「为什么留存」可以按原因筛选。", view: "media", selector: ".gallery-scope" },
  { title: "不想留的原图可以取消留存", detail: "在「留存的原图」里点开图按「取消留存」，或「多选」后一起取消。文件先放到一边，可以放回；按「彻底删除」才真的删掉、腾出空间，删掉的图不会再被自动留存。", view: "media", selector: ".gallery-scope" },
  { title: "可以关掉自动检查更新", detail: "设置 →「版本与更新」多了「自动检查更新」的开关，默认开着；关掉后只有你点「检查更新」才查。", view: "settings", selector: "#update-card" },
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
