"use strict";

/* ---------- 这次更新的新东西 ----------
   A card at the top of the home page after an update: what is new and a link
   that goes to it and outlines it for a moment. Many past asks were about
   things that already existed but could not be found. Curated by hand for
   each release (update WHATS_NEW_RELEASE with the list); "知道了" hides it
   until the next one (per browser: localStorage). */

// v0.0.20 used "2026-09-30" and came out the same day: a date would not do.
const WHATS_NEW_RELEASE = "v0.0.22";
const WHATS_NEW_KEY = "cc-whats-new-seen";
const WHATS_NEW_FLASH_MS = 2400;
const WHATS_NEW_GIVE_UP_MS = 4000;
const WHATS_NEW_FIND_STEP_MS = 150;

// view: the page to open (null: stay); selector: what to outline; run: an
// action instead ("palette", "keys"). An item with none of them is only text.
const WHATS_NEW = [
  { title: "图片参数少漏了", detail: "以前有些 AI 图明明带着参数，却被当成「未检测到生成参数」：NovelAI 藏在像素里的咒语（文字被删掉后还在）、WebP 图、写在 JPEG 注释里的，以及几种 ComfyUI 节点。现在都读得出来，连电脑上只有 QQ 预览图、没有原图的 NovelAI 图也行。升级后会在后台把以前判成没参数的图重读一遍（只做一次，几分钟）。", view: "knowledge", selector: ".kb-stats" },
  { title: "「咒语来自回复」不再乱标", detail: "没有参数的普通截图和照片以前都被标成「咒语来自回复」。现在只有群里真有人贴过咒语的图才这样标，其余显示「未检测到生成参数」。", view: "knowledge", selector: ".kb-facets" },
  { title: "桌面和开始菜单快捷方式", detail: "不用再去安装文件夹找启动脚本：「设置 → 快捷方式」可以在桌面放一个，开始菜单里也有（Ctrl+Alt+U）。快捷方式换成了本工具自己的图标。", view: "settings", selector: "#settings-shortcuts" },
  { title: "列表可以拉长", detail: "左栏「关注的群」下面有一条拖动条：往下拖显示更多（拉到底全部显示），双击恢复。关注群列表、备份选群、咒语库的长筛选列表和运行日志也一样。", view: null, selector: "#rail-groups .resize-grip" },
  { title: "出错时说清楚原因", detail: "后台任务（包括备份）失败时，以前只显示「进程退出码 1」，现在会写出真正的原因。数据库密钥不对时会直接告诉你：到「设置 → 数据库密钥」点「自动获取密钥」。", view: null, selector: null },
  { title: "手动填密钥会先验证", detail: "手动粘贴数据库密钥时，会先用你电脑上的数据库试一下，解不开就不保存。常见原因是把 AI 服务的 API key 填进了这一栏。", view: null, selector: null },
  { title: "Start-QQ-Unviewed.cmd 已移除", detail: "它一打开就自动做一次 AI 总结；现在后台本来就会整理好，用不到了。请用 Start-QQ-Console.cmd 或快捷方式打开。", view: null, selector: null },
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
