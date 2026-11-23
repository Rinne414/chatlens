"use strict";

/* ---------- 热点 → 画师 (src/artist_trends.js) ----------
   Which artists' names are in the prompts of the pictures posted in the
   chosen time, against the same length of time before it. A row opens the
   咒语库 on that artist. */

const ARTIST_PAGE = 50;
const ARTIST_SORTS = [["rising", "升得最快"], ["most", "用得最多"]];

// Its own loading and error: the cards and this list are fetched apart.
const artistTrendsState = { data: null, query: null, sort: "rising", shown: ARTIST_PAGE, loading: false, error: null };

const loadArtistTrends = async ({ fresh = false } = {}) => {
  const query = trendsQuery();
  Object.assign(artistTrendsState, { loading: true, error: null });
  renderTrendsView();
  let patch = null;
  try {
    patch = { data: await api(`/api/trends/artists?${query}${fresh ? "&fresh=1" : ""}`), query, shown: ARTIST_PAGE, error: null };
  } catch (error) {
    patch = { error: error.message };
  }
  // An answer for a range the page has since left is dropped: the newer request draws.
  if (query !== trendsQuery()) {
    return;
  }
  Object.assign(artistTrendsState, patch, { loading: false });
  renderTrendsView();
};

// Every picture in the library whose prompt names the artist (the library's
// own date filter goes by the file's date, not by when it was posted).
const openArtistInLibrary = (artist) => {
  showView("knowledge");
  replaceKnowledgeTab({ surface: "images", libraryScope: "all", groupId: "", query: `tag:${window.KbTokens.quoteValue(artist.tag)}` });
  ensureKnowledgeLoaded();
  loadKnowledgeResults();
};

const artistChange = (artist) => {
  if (artist.before === 0) {
    return el("span", { class: "ta-change up", title: "前一段同样长的时间里没有出现过" }, "新出现");
  }
  const delta = artist.now - artist.before;
  if (delta === 0) {
    return el("span", { class: "ta-change down" }, "持平");
  }
  return el("span", { class: delta > 0 ? "ta-change up" : "ta-change down", title: `前一段 ${artist.before} 张 → 这一段 ${artist.now} 张` },
    `${delta > 0 ? "↑ +" : "↓ −"}${Math.abs(delta)}`);
};

const artistRow = (artist, index, max) => el("li", {},
  el("button", { class: "ta-row", type: "button", title: "在咒语库看所有写了这位画师的图（不限这段时间）", onclick: () => openArtistInLibrary(artist) },
    el("span", { class: "ta-rank" }, String(index + 1)),
    el("span", { class: "ta-name" }, artist.name),
    el("span", { class: "ta-bar", "aria-hidden": "true" },
      el("span", { class: "before", style: `width:${(Math.max(artist.now, artist.before) / max) * 100}%` }),
      el("span", { style: `width:${(artist.now / max) * 100}%` })),
    el("span", { class: "ta-count" }, `${briefNumber(artist.now)} 张 · ${artist.people} 人 · ${artist.groups} 个群`),
    artistChange(artist)));

const artistTrendsPage = () => {
  const { loading, error } = artistTrendsState;
  const fresh = artistTrendsState.query === trendsQuery() ? artistTrendsState.data : null;
  const sorted = fresh === null ? [] : artistTrendsState.sort === "most"
    ? [...fresh.artists].sort((left, right) => right.now - left.now || left.name.localeCompare(right.name))
    : fresh.artists;
  const max = Math.max(1, ...sorted.map((artist) => Math.max(artist.now, artist.before)));
  const body = () => {
    if (fresh === null) {
      return error === null ? el("p", { class: "kb-meta" }, "正在整理…") : null;
    }
    if (!fresh.library) {
      return el("div", { class: "wall-empty" }, "咒语库还是空的：群里发过带咒语的 AI 图之后，这里才有内容。");
    }
    if (sorted.length === 0) {
      return el("div", { class: "wall-empty" }, "这段时间发的图里，咒语没有写画师。可以把时间放宽。");
    }
    return [
      el("div", { class: "ta-sort" },
        el("div", { class: "wall-modes", role: "group", "aria-label": "排序" }, ARTIST_SORTS.map(([sort, label]) => el("button", {
          class: artistTrendsState.sort === sort ? "wall-mode active" : "wall-mode",
          type: "button",
          "aria-pressed": String(artistTrendsState.sort === sort),
          onclick: () => {
            Object.assign(artistTrendsState, { sort, shown: ARTIST_PAGE });
            renderTrendsView();
          },
        }, label))),
        el("span", { class: "kb-meta" },
          `${briefNumber(sorted.length)} 位画师，出现在 ${briefNumber(fresh.pictures)} 张图的咒语里 · 和 ${briefWhen(fresh.before.fromUnix)} 起同样长的前一段比`)),
      el("ol", { class: "ta-list" }, sorted.slice(0, artistTrendsState.shown).map((artist, index) => artistRow(artist, index, max))),
      sorted.length > artistTrendsState.shown
        ? el("button", {
          class: "btn tr-more",
          type: "button",
          onclick: () => {
            artistTrendsState.shown += ARTIST_PAGE;
            renderTrendsView();
          },
        }, `再显示 ${Math.min(ARTIST_PAGE, sorted.length - artistTrendsState.shown)} 位（共 ${briefNumber(sorted.length)} 位）`)
        : null,
    ];
  };
  return el("section", { class: `panel tr-page ${loading ? "is-loading" : ""}` },
    el("p", { class: "tr-intro", title: "写成 artist:名字、by 名字、@名字 的都算，带权重的写法也算；咒语库里见过带 artist: 写法的名字，不带前缀也算" },
      "群里发的 AI 图，咒语里写了哪些画师：谁用得多了，谁是新出现的。"),
    trendsToolbar(app.trends.data),
    error === null ? null : el("div", { class: "notice risk" }, `读取画师趋势失败：${error}`),
    body());
};
