"use strict";

/* ---------- Ctrl+K: one box for everything ----------
   Pages, groups (opens the chat), followed words, a few commands, and "search
   this" hand-offs to 回顾 / 问群聊 / 收藏. Ctrl+K (⌘K on a Mac) or "/"
   outside a text box opens it; ↑ ↓ choose, Enter runs, Esc closes. */

// Extra words a page is found by, beside its name.
const PALETTE_PAGE_WORDS = {
  brief: "首页 今天 早报", review: "往日 日历 以前 搜索", bookmarks: "星标 收藏夹", ask: "提问 问答 ai",
  trends: "热门 热点图", group: "群页 群统计", messages: "聊天 消息 未读", media: "图片 画廊 相册",
  knowledge: "咒语 prompt lora 模型 tag 参数", backup: "备份 导出 保存", storage: "硬盘 空间 占用", settings: "设置 密钥 key 路径",
};

const paletteState = { open: false, query: "", index: 0, root: null, list: null, entries: [] };

const isTypingTarget = (node) =>
  node instanceof HTMLElement && (node.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName));

// Every word of the query must appear (case-insensitive) in the label or keywords.
const paletteMatches = (entry, query) => {
  const haystack = `${entry.label} ${entry.keywords ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/u).filter(Boolean).every((word) => haystack.includes(word));
};

// sources: { pages: [[view, title]], groups: [{ groupId, name }], words: [{ word, total }] }
// -> entries { kind, label, hint, keywords, action } in the order shown.
const paletteEntries = (sources, rawQuery) => {
  const query = String(rawQuery ?? "").trim();
  const listed = [
    ...sources.pages.map(([view, title]) => ({ kind: "page", label: title, hint: "页面", keywords: `${view} ${PALETTE_PAGE_WORDS[view] ?? ""}`, action: { type: "page", view } })),
    { kind: "command", label: "关闭控制台", hint: "命令", keywords: "退出 关掉 停止 quit exit", action: { type: "quit" } },
    { kind: "command", label: "切换夜间 / 日间模式", hint: "命令", keywords: "主题 暗色 深色 theme dark", action: { type: "theme" } },
    ...sources.groups.map((group) => ({ kind: "group", label: group.name, hint: "Enter 打开聊天 · Shift+Enter 群页", keywords: `群 ${group.groupId}`, action: { type: "chat", groupId: group.groupId, groupName: group.name } })),
    ...sources.words.map((item) => ({ kind: "word", label: `关注的词：${item.word}`, hint: `这几天 ${item.total} 条`, keywords: item.word, action: { type: "word", word: item.word } })),
  ].filter((entry) => query === "" || paletteMatches(entry, query));
  if (query === "") {
    return listed;
  }
  return [
    ...listed,
    { kind: "search", label: `在回顾里搜「${query}」`, hint: "哪天聊过", action: { type: "review", query } },
    { kind: "search", label: `问群聊：${query}`, hint: "AI 根据聊天记录回答", action: { type: "ask", query } },
    { kind: "search", label: `在收藏里找「${query}」`, hint: "收藏", action: { type: "bookmarks", query } },
  ];
};

const paletteSources = () => ({
  // The rail's pages, in its order, by name (the buttons also carry an icon).
  pages: [...document.querySelectorAll("#nav button[data-view]")].map((button) => [button.dataset.view, VIEW_TITLES[button.dataset.view] ?? button.textContent.trim()]),
  groups: (railState.data?.groups ?? app.state?.watchlist ?? []).map((group) => ({ groupId: group.groupId, name: group.name || group.groupId })),
  words: (briefState.data?.watch ?? []).map((item) => ({ word: item.word, total: item.total })),
});

const runPaletteAction = (action) => {
  switch (action.type) {
    case "page":
      openView(action.view);
      break;
    case "chat":
      openMessagesView({ groupId: action.groupId, groupName: action.groupName, fromLastRead: true });
      break;
    case "group":
      openGroupView(action.groupId);
      break;
    case "word":
      openReviewView({ query: action.word, range: briefWindowRange() });
      break;
    case "review":
      openReviewView({ query: action.query });
      break;
    case "ask":
      askState.draft = action.query;
      openAskView();
      break;
    case "bookmarks":
      bookmarkState.query = action.query;
      openBookmarksView();
      break;
    case "theme":
      document.getElementById("theme-toggle")?.click();
      break;
    case "quit":
      quitConsole();
      break;
    default:
      break;
  }
};

const closePalette = () => {
  paletteState.open = false;
  paletteState.root?.remove();
  paletteState.root = null;
};

const renderPaletteList = () => {
  const entries = paletteEntries(paletteSources(), paletteState.query);
  paletteState.index = Math.max(0, Math.min(paletteState.index, entries.length - 1));
  paletteState.entries = entries;
  setChildren(paletteState.list, entries.length === 0
    ? el("li", { class: "palette-empty" }, "没有找到。")
    : entries.map((entry, index) => el("li", {
        class: `palette-item ${entry.kind}${index === paletteState.index ? " active" : ""}`,
        role: "option",
        "aria-selected": String(index === paletteState.index),
        onmousemove: () => {
          if (paletteState.index !== index) {
            paletteState.index = index;
            renderPaletteList();
          }
        },
        onclick: () => {
          closePalette();
          runPaletteAction(entry.action);
        },
      }, el("span", { class: "palette-label" }, entry.label), el("span", { class: "palette-hint" }, entry.hint))));
  paletteState.list.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
};

const paletteKeydown = (event) => {
  if (event.isComposing) {
    return;
  }
  const count = paletteState.entries.length;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    paletteState.index = count === 0 ? 0 : (paletteState.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    renderPaletteList();
  } else if (event.key === "Enter" && count > 0) {
    event.preventDefault();
    const { action } = paletteState.entries[paletteState.index];
    closePalette();
    runPaletteAction(event.shiftKey && action.type === "chat" ? { type: "group", groupId: action.groupId } : action);
  }
};

const openPalette = () => {
  if (paletteState.open) {
    return;
  }
  const input = el("input", {
    type: "search",
    class: "palette-input",
    placeholder: "搜页面、群、关注的词，或输入任意内容去回顾 / 问群聊里找…",
    "aria-label": "搜索",
    oninput: (event) => {
      paletteState.query = event.target.value;
      paletteState.index = 0;
      renderPaletteList();
    },
    onkeydown: paletteKeydown,
  });
  paletteState.list = el("ul", { class: "palette-list", role: "listbox" });
  paletteState.root = el("div", {
    class: "palette-backdrop",
    onclick: (event) => {
      if (event.target === paletteState.root) {
        closePalette();
      }
    },
  }, el("div", { class: "palette", role: "dialog", "aria-label": "搜索与跳转" },
    input,
    paletteState.list,
    el("p", { class: "palette-foot" }, "↑ ↓ 选择 · Enter 打开 · Esc 关闭 · 在任意页面按 Ctrl+K 或 / 打开")));
  Object.assign(paletteState, { open: true, query: "", index: 0 });
  document.body.append(paletteState.root);
  renderPaletteList();
  input.focus();
};

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (paletteState.open) {
      closePalette();
    } else {
      openPalette();
    }
    return;
  }
  if (event.key === "/" && !event.shiftKey && !paletteState.open && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target)) {
    event.preventDefault();
    openPalette();
  }
});
