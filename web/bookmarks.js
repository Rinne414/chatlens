"use strict";

/* ---------- 收藏 ----------
   Things saved from the briefing (☆ on new things, Q&A and topics) with
   where they came from. The page lists every one of them (pages of 200 with
   "再显示更多"), filtered by when they were saved and by text. */

const BOOKMARK_KIND_LABELS = { thing: "新东西", qa: "问答", topic: "话题", message: "消息" };
const BOOKMARK_RANGES = [["all", "全部"], ["7", "7 天"], ["30", "30 天"], ["custom", "选日期…"]];

const bookmarkState = {
  keys: new Map(),
  keysLoaded: false,
  list: null,
  error: null,
  loading: false,
  query: "",
  range: "all",
  fromDay: "",
  toDay: "",
  busy: false,
};

// Must match src/bookmark_store.js itemKeyOf after its normalizing.
const bookmarkKeyOf = (item) => [
  item.kind,
  /^\d+$/u.test(String(item.groupId ?? "")) ? String(item.groupId) : "",
  String(item.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 200).toLowerCase(),
].join("|");

const setBookmarkKeys = (saved) => {
  bookmarkState.keys = new Map((saved ?? []).map((entry) => [entry.itemKey, entry.id]));
  bookmarkState.keysLoaded = true;
};

const loadBookmarkKeys = async () => {
  try {
    setBookmarkKeys((await api("/api/bookmarks/keys")).saved);
  } catch {
    // Stars stay empty; saving still works and reloads them.
  }
};

// A star for any savable item; `redraw` re-renders the page it sits on.
const bookmarkStar = (item, redraw) => {
  const id = bookmarkState.keys.get(bookmarkKeyOf(item));
  const saved = id !== undefined;
  return el("button", {
    class: `bm-star${saved ? " on" : ""}`,
    type: "button",
    title: saved ? "取消收藏" : "收藏：以后在左边「收藏」里找",
    "aria-label": saved ? "取消收藏" : "收藏",
    "aria-pressed": String(saved),
    disabled: bookmarkState.busy,
    onclick: async (event) => {
      event.stopPropagation();
      bookmarkState.busy = true;
      try {
        const result = saved
          ? await api("/api/bookmarks/remove", { method: "POST", body: JSON.stringify({ id }) })
          : await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ item }) });
        setBookmarkKeys(result.saved);
        bookmarkState.list = null;
      } catch (error) {
        alert(error.message);
      }
      bookmarkState.busy = false;
      redraw();
    },
  }, saved ? "★" : "☆");
};

/* ---------- the page ---------- */

const bookmarkRangeUnix = () => {
  const now = Math.floor(Date.now() / 1000);
  if (bookmarkState.range === "7" || bookmarkState.range === "30") {
    return { fromUnix: now - Number(bookmarkState.range) * 86400, toUnix: null };
  }
  if (bookmarkState.range === "custom") {
    const from = hktToUnix(`${bookmarkState.fromDay} 00:00`);
    const to = hktToUnix(`${bookmarkState.toDay} 00:00`);
    return { fromUnix: from, toUnix: to === null ? null : to + 86400 };
  }
  return { fromUnix: null, toUnix: null };
};

const loadBookmarks = async ({ more = false } = {}) => {
  bookmarkState.loading = true;
  renderBookmarksView();
  try {
    const { fromUnix, toUnix } = bookmarkRangeUnix();
    const params = new URLSearchParams({ q: bookmarkState.query, offset: String(more ? bookmarkState.list?.items.length ?? 0 : 0) });
    if (fromUnix !== null) {
      params.set("fromUnix", String(fromUnix));
    }
    if (toUnix !== null) {
      params.set("toUnix", String(toUnix));
    }
    const page = await api(`/api/bookmarks?${params}`);
    bookmarkState.list = more && bookmarkState.list !== null
      ? { total: page.total, items: [...bookmarkState.list.items, ...page.items] }
      : page;
    bookmarkState.error = null;
  } catch (error) {
    bookmarkState.error = error.message;
  }
  bookmarkState.loading = false;
  renderBookmarksView();
};

const openBookmarksView = async () => {
  showView("bookmarks");
  renderBookmarksView();
  await Promise.all([loadBookmarks(), bookmarkState.keysLoaded ? null : loadBookmarkKeys()]);
};

VIEW_RELOADERS.bookmarks = () => loadBookmarks();

const bookmarkOrigin = { view: "bookmarks", label: "收藏" };

const bookmarkCard = (item) =>
  el("li", { class: "bm-card" },
    el("div", { class: "bm-head" },
      el("span", { class: `bm-kind ${item.kind}` }, BOOKMARK_KIND_LABELS[item.kind] ?? "收藏"),
      safeHref(item.link)
        ? el("a", { class: "bm-title", href: safeHref(item.link), target: "_blank", rel: "noopener noreferrer", title: item.link }, item.title, " ↗")
        : el("strong", { class: "bm-title" }, item.title),
      // Removing one here reloads the list (the star clears the cached page).
      bookmarkStar(item, () => loadBookmarks())),
    item.body ? el("p", { class: "bm-body" }, item.body) : null,
    el("div", { class: "bm-meta" },
      el("span", { class: "brief-meta" }, [
        item.groupName,
        item.speaker,
        item.sentAt ? `原消息 ${briefWhen(item.sentAt)}` : "",
        `收藏于 ${unixToHkt(item.createdAt).slice(0, 16)}`,
      ].filter(Boolean).join(" · ")),
      item.groupId && item.sentAt
        ? el("button", {
            class: "linklike",
            onclick: () => openMessagesView({
              groupId: item.groupId,
              groupName: item.groupName,
              fromUnix: item.sentAt - 1800,
              scrollToTime: item.sentAt,
              origin: bookmarkOrigin,
            }),
          }, "看原消息")
        : null));

const bookmarkToolbar = () => {
  const search = el("input", {
    type: "search",
    class: "review-search-input bm-search",
    placeholder: "在收藏里找：标题、内容、群、人",
    value: bookmarkState.query,
    oninput: (event) => { bookmarkState.query = event.target.value; },
  });
  return el("div", { class: "bm-toolbar" },
    el("form", {
      class: "bm-search-form",
      role: "search",
      onsubmit: (event) => {
        event.preventDefault();
        loadBookmarks();
      },
    }, search, el("button", { class: "btn", type: "submit" }, "找")),
    el("div", { class: "wall-modes", role: "group", "aria-label": "收藏时间" }, BOOKMARK_RANGES.map(([key, label]) => el("button", {
      class: `wall-mode ${bookmarkState.range === key ? "active" : ""}`,
      type: "button",
      onclick: () => {
        bookmarkState.range = key;
        if (key === "custom" && bookmarkState.fromDay === "") {
          const today = unixToHkt(Math.floor(Date.now() / 1000)).slice(0, 10);
          bookmarkState.fromDay = unixToHkt(Math.floor(Date.now() / 1000) - 30 * 86400).slice(0, 10);
          bookmarkState.toDay = today;
        }
        loadBookmarks();
      },
    }, label))),
    bookmarkState.range === "custom"
      ? el("span", { class: "bm-dates" },
        el("input", { type: "date", value: bookmarkState.fromDay, onchange: (event) => { bookmarkState.fromDay = event.target.value; loadBookmarks(); } }),
        " 至 ",
        el("input", { type: "date", value: bookmarkState.toDay, onchange: (event) => { bookmarkState.toDay = event.target.value; loadBookmarks(); } }))
      : null);
};

const renderBookmarksView = () => {
  const root = $("#view-bookmarks");
  if (root === null || app.view !== "bookmarks") {
    return;
  }
  const list = bookmarkState.list;
  setChildren(root, el("div", { class: "card bm-page" },
    el("h2", {}, "收藏"),
    el("p", { class: "card-sub" }, "在简报的新东西、问答、话题上点 ☆ 就会存到这里，带着是哪个群、谁说的、什么时候，点「看原消息」回到聊天。"),
    bookmarkToolbar(),
    bookmarkState.error ? el("div", { class: "notice risk" }, bookmarkState.error) : null,
    list === null
      ? el("p", { class: "brief-empty-line" }, bookmarkState.loading ? "正在读取…" : "")
      : list.total === 0
        ? el("p", { class: "brief-empty-line" }, bookmarkState.query || bookmarkState.range !== "all" ? "没有符合条件的收藏。" : "还没有收藏。在简报里看到值得留着的，点它旁边的 ☆。")
        : [
            el("p", { class: "brief-meta" }, `共 ${briefNumber(list.total)} 条`),
            el("ul", { class: "bm-list" }, list.items.map(bookmarkCard)),
            list.items.length < list.total
              ? el("button", { class: "btn small ghost", disabled: bookmarkState.loading, onclick: () => loadBookmarks({ more: true }) },
                `再显示更多（还有 ${briefNumber(list.total - list.items.length)} 条）`)
              : null,
          ]));
};
