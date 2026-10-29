"use strict";

/* ---------- 画廊: every group picture, straight from the picture store ----------
   The background refresh records every picture posted in the groups (with a
   Tencent thumbnail), so this wall covers everything from the last 31 days --
   stickers included -- not just what happened to be exported by a manual run.
   One tile per picture; a picture posted in several groups says so, and its
   detail shows where it came from and how it spread. */

const GALLERY_WALL_KEY = "gallery";
const GALLERY_MODE_KEY = "cc-gallery-wall-mode";
const GALLERY_SIZE_KEY = "cc-gallery-wall-size";
const GALLERY_MODES = ["grid", "masonry"];
const GALLERY_SIZE_DEFAULT = 200;
const GALLERY_SIZE_MIN = 110;
const GALLERY_SIZE_MAX = 380;
const GALLERY_PAGE = 120;
const GALLERY_HEADER_HEIGHT = 46;
const GALLERY_EXPIRY_WARN_DAYS = 7;
const GALLERY_DAY_CHOICES = [[3, "3 天"], [7, "7 天"], [31, "31 天"], [0, "全部"]];
const GALLERY_KINDS = [["images", "图片"], ["stickers", "表情包"], ["all", "全部"]];
const GALLERY_SORTS = [["recent", "最新发的"], ["spread", "传得最广"]];
const GALLERY_SHAPES = [["wide", "横图"], ["tall", "竖图"], ["square", "方图"], ["long", "长图", "多是手机截图和长条漫画"]];
const GALLERY_SIZES = [["large", "大图", "长边 1000 以上"], ["medium", "中等", "长边 500–999"], ["small", "小图", "长边不到 500"]];
const GALLERY_SWITCHES = [
  ["prompt", "有咒语", "咒语库里能读到生成参数的图"],
  ["asked", "有人求咒语", "群里有人问过这张图的咒语"],
  ["file", "以文件发的图", "当作文件发的图片，多是没压缩的原图；显示的是 QQ 的预览"],
];
const GALLERY_SEARCH_DELAY_MS = 450;
const GIF_PICTURE_FORMAT = 2000;
const GALLERY_ORIGIN = { view: "media", label: "画廊" };
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

app.gallery = {
  days: 7,
  range: null,
  // Time cursor (gallery_nav.js): show pictures from before this moment.
  until: null,
  kind: "images",
  ai: false,
  sort: "recent",
  groupId: "",
  sender: "",
  senderLabel: "",
  // Search words, a shape / size bucket and three switches (gallery_store.js).
  q: "",
  shape: "",
  size: "",
  prompt: false,
  asked: false,
  file: false,
  results: null,
  facets: null,
  facetsKey: "",
  loading: false,
  loadingMore: false,
  error: null,
  requestId: 0,
  expandedFacets: new Set(),
  detail: null,
  selecting: false,
  selected: new Set(),
  // The tile clicked last, for shift-click ranges.
  lastPicked: null,
  saveTarget: null,
  editingSaveDir: false,
};

const replaceGallery = (patch) => {
  app.gallery = { ...app.gallery, ...patch };
};

const galleryWallMode = () => {
  const stored = wallReadPref(GALLERY_MODE_KEY, "masonry");
  return GALLERY_MODES.includes(stored) ? stored : "masonry";
};

const galleryWallSize = () => {
  const size = Number(wallReadPref(GALLERY_SIZE_KEY, phoneWallSize(GALLERY_SIZE_DEFAULT)));
  return Number.isFinite(size) ? Math.min(GALLERY_SIZE_MAX, Math.max(GALLERY_SIZE_MIN, size)) : GALLERY_SIZE_DEFAULT;
};

/* ---------- loading ---------- */

const galleryFilterParams = () => {
  const tab = app.gallery;
  const params = new URLSearchParams({ kind: tab.kind, ai: tab.ai ? "1" : "0", groupId: tab.groupId, sender: tab.sender });
  for (const key of ["q", "shape", "size"]) {
    if (tab[key] !== "") {
      params.set(key, tab[key]);
    }
  }
  for (const [key] of GALLERY_SWITCHES) {
    if (tab[key]) {
      params.set(key, "1");
    }
  }
  const bounds = galleryTimeBounds(tab);
  if (bounds.days === undefined) {
    params.set("fromUnix", String(bounds.fromUnix));
    params.set("toUnix", String(bounds.toUnix));
  } else {
    params.set("days", String(bounds.days));
  }
  return params;
};

const loadGalleryFacets = async () => {
  const key = galleryFilterParams().toString();
  if (app.gallery.facetsKey === key && app.gallery.facets !== null) {
    return;
  }
  replaceGallery({ facetsKey: key });
  try {
    const facets = await api(`/api/gallery/facets?${key}`);
    if (app.gallery.facetsKey === key) {
      replaceGallery({ facets });
    }
  } catch {
    replaceGallery({ facets: { unavailable: true } });
  }
  const node = document.getElementById("gallery-facets-body");
  if (node !== null) {
    setChildren(node, galleryFacetSections());
  }
};

const loadGallery = async ({ append = false } = {}) => {
  const requestId = app.gallery.requestId + 1;
  const offset = append ? (app.gallery.results?.items.length ?? 0) : 0;
  replaceGallery({ requestId, loading: true, loadingMore: append, error: null });
  if (append) {
    updateGalleryTexts();
  } else {
    renderMediaView();
    loadGalleryFacets();
  }
  const params = galleryFilterParams();
  params.set("sort", app.gallery.sort);
  params.set("limit", String(GALLERY_PAGE));
  params.set("offset", String(offset));
  try {
    const page = await api(`/api/gallery?${params.toString()}`);
    if (app.gallery.requestId !== requestId) {
      return;
    }
    const previous = append ? (app.gallery.results?.items ?? []) : [];
    const seen = new Set(previous.map((item) => item.md5));
    replaceGallery({
      results: { total: page.total, items: [...previous, ...page.items.filter((item) => !seen.has(item.md5))] },
      loading: false,
      loadingMore: false,
    });
    if (append && app.view === "media" && wallSetEntries(GALLERY_WALL_KEY, galleryEntries())) {
      updateGalleryTexts();
      return;
    }
  } catch (error) {
    if (app.gallery.requestId !== requestId) {
      return;
    }
    replaceGallery({ loading: false, loadingMore: false, error: error.message });
  }
  if (!append) {
    window.scrollTo({ top: 0 });
  }
  renderMediaView();
};

const applyGalleryFilter = (patch) => {
  // A filter picked inside the open picture closes it the way back would.
  if (app.gallery.detail !== null) {
    dismissOverlay(closeGalleryDetail);
  }
  replaceGallery({ ...patch, detail: null });
  renderGalleryDetailLayer();
  loadGallery();
};

const loadMoreGallery = () => {
  const tab = app.gallery;
  if (tab.loading || tab.loadingMore || tab.results === null || tab.results.items.length >= tab.results.total) {
    return;
  }
  loadGallery({ append: true });
};

// Entry points kept under the names the rest of the app already calls.
const loadGallerySaveTarget = async () => {
  try {
    replaceGallery({ saveTarget: await api("/api/pictures/save-dir") });
  } catch {
    replaceGallery({ saveTarget: null });
  }
};

const openMediaView = (forceRefresh) => {
  showView("media");
  galleryNav.dismissed = false;
  loadGallerySaveTarget();
  if (forceRefresh === true || app.gallery.results === null) {
    loadGallery();
    return;
  }
  renderMediaView();
};

// From the run timeline: one group's pictures in one time window.
const openGalleryRange = ({ groupId, fromUnix, toUnix }) => {
  replaceGallery({
    range: { fromUnix, toUnix },
    until: null,
    groupId: /^\d+$/u.test(String(groupId ?? "")) ? String(groupId) : "",
    sender: "",
    senderLabel: "",
    detail: null,
  });
  showView("media");
  loadGallery();
};

VIEW_RELOADERS.media = () => {
  replaceGallery({ facets: null, facetsKey: "" });
  loadGallery();
};
VIEW_LEAVE_HOOKS.push(() => replaceGallery({ detail: null }));

/* ---------- tiles ---------- */

const galleryDayKey = (unix) => unixToHkt(unix).slice(0, 10);

const galleryDayTitle = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  const today = galleryDayKey(Math.floor(Date.now() / 1000));
  const yesterday = galleryDayKey(Math.floor(Date.now() / 1000) - 86400);
  const label = day === today ? "今天" : day === yesterday ? "昨天" : `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return `${label} · 星期${WEEKDAYS[date.getUTCDay()]}`;
};

// Day separators only make sense when the wall is in time order.
const galleryEntries = () => {
  const items = app.gallery.results?.items ?? [];
  const entries = [];
  let day = null;
  for (const [itemIndex, item] of items.entries()) {
    const itemDay = galleryDayKey(item.lastAt);
    if (app.gallery.sort === "recent" && itemDay !== day) {
      day = itemDay;
      entries.push({ kind: "header", height: GALLERY_HEADER_HEIGHT, day });
    }
    entries.push({ kind: "tile", ratio: item.width > 0 && item.height > 0 ? item.height / item.width : 1, item, itemIndex });
  }
  return entries;
};

const galleryBadges = (item) => {
  const days = daysUntilExpiry(item.expiresAt);
  return [
    item.generator !== ""
      ? { text: generatorLabel(item.generator), tone: GENERATOR_TONES[item.generator] ?? "ai" }
      : item.ai ? { text: "AI 图", tone: "ai" } : null,
    item.groups > 1 ? { text: `${item.groups} 个群`, tone: "repost", title: `在 ${item.groups} 个群出现过 ${item.posts} 次` } : null,
    item.asks > 0 ? { text: `${item.asks} 人求`, tone: "asked" } : null,
    item.format === GIF_PICTURE_FORMAT ? { text: "GIF" } : null,
    item.fileName ? { text: "文件", tone: "file", title: `以文件发送：${item.fileName}（显示的是 QQ 的预览）` } : null,
    item.ai && !item.kept && !item.fileName && days !== null && days <= GALLERY_EXPIRY_WARN_DAYS
      ? { text: days === 0 ? "今天过期" : `${days} 天后过期`, tone: "expiring", title: "腾讯过期后原图就找不回来了" }
      : null,
    item.ai && item.kept ? { text: "已存原图", tone: "kept" } : null,
  ].filter((badge) => badge !== null);
};

const galleryCaption = (item) => {
  const shown = item.shown ?? item.origin;
  return {
    title: shown?.speaker || "不知道是谁发的",
    sub: shown === null ? "" : `${shown.groupName || shown.groupId} · ${unixToHkt(shown.sentAt).slice(11, 16)}`,
  };
};

/* ---------- multi-select + export ---------- */

const refreshGallerySelection = () => {
  wallRepaint(GALLERY_WALL_KEY);
  const node = document.getElementById("gallery-selection");
  if (node !== null) {
    setChildren(node, gallerySelectionNodes());
  }
};

// Selecting starts from any tile (its corner box, or Ctrl+click), so nobody
// has to scroll back up to a button; leaving clears the selection.
const leaveGallerySelection = () => {
  replaceGallery({ selecting: false, selected: new Set(), lastPicked: null });
  renderMediaView();
};

// One tile changes in place (no re-draw, so no flicker); bulk changes
// re-draw the visible tiles through refreshGallerySelection. The first pick
// switches the wall into selecting, which re-draws it once.
const toggleGallerySelected = (md5, tile, event = null) => {
  if (!app.gallery.selecting) {
    replaceGallery({ selecting: true, lastPicked: null });
    toggleGallerySelected(md5, null);
    renderMediaView();
    return;
  }
  const items = app.gallery.results?.items ?? [];
  const index = items.findIndex((item) => item.md5 === md5);
  if (event?.shiftKey && app.gallery.lastPicked !== null && index >= 0) {
    const [from, to] = [app.gallery.lastPicked, index].sort((left, right) => left - right);
    replaceGallery({ lastPicked: index });
    selectGalleryItems(items.slice(from, to + 1));
    return;
  }
  replaceGallery({ lastPicked: index >= 0 ? index : null });
  const next = new Set(app.gallery.selected);
  const selected = !next.has(md5);
  if (selected) {
    next.add(md5);
  } else {
    next.delete(md5);
  }
  replaceGallery({ selected: next });
  tile?.classList.toggle("selected", selected);
  tile?.querySelector(".wall-pick")?.classList.toggle("picked", selected);
  const box = tile?.querySelector(".wall-pick input");
  if (box) {
    box.checked = selected;
  }
  const bar = document.getElementById("gallery-selection");
  if (bar !== null) {
    setChildren(bar, gallerySelectionNodes());
  }
};

const selectGalleryItems = (items) => {
  replaceGallery({ selected: new Set([...app.gallery.selected, ...items.map((item) => item.md5)]) });
  refreshGallerySelection();
};

const gallerySelectionNodes = () => {
  const count = app.gallery.selected.size;
  const loaded = app.gallery.results?.items ?? [];
  return [
    el("div", { class: "gallery-selection-row" },
      el("strong", { class: "gallery-selection-count" }, `已选 ${briefNumber(count)} 张`),
      el("button", {
        class: "btn small primary",
        type: "button",
        disabled: count === 0 || pictureExport.running,
        title: "把原图复制到下面的文件夹；带咒语的 AI 图附同名 .txt",
        onclick: () => runPictureExport([...app.gallery.selected], "gallery"),
      }, `保存原图到文件夹（${briefNumber(count)}）`),
      el("button", { class: "btn small", type: "button", disabled: loaded.length === 0, onclick: () => selectGalleryItems(loaded) },
        `全选已加载的 ${briefNumber(loaded.length)} 张`),
      el("button", { class: "btn small", type: "button", disabled: count === 0, onclick: () => {
        replaceGallery({ selected: new Set(), lastPicked: null });
        refreshGallerySelection();
      } }, "清空"),
      el("span", { class: "kb-results-spacer" }),
      el("button", { class: "btn small", type: "button", title: "退出多选（Esc），已选的会清空", onclick: leaveGallerySelection }, "退出多选")),
    el("span", { class: "kb-meta" }, "点图片就是选它；按住 Shift 点另一张可以连选。腾讯只保留 31 天，更早的图取不到原图。"),
    gallerySaveTargetRow(),
    pictureExportStatus("gallery"),
  ];
};

const saveGalleryDir = async (dir) => {
  try {
    replaceGallery({ saveTarget: await api("/api/pictures/save-dir", { method: "POST", body: JSON.stringify({ dir }) }), editingSaveDir: false });
  } catch (error) {
    alert(error.message);
  }
  refreshGallerySelection();
};

// "保存到：…" with a way to pick a fixed folder (or go back to dated folders).
const gallerySaveTargetRow = () => {
  const target = app.gallery.saveTarget;
  if (target === null) {
    return null;
  }
  if (app.gallery.editingSaveDir) {
    const input = el("input", { type: "text", value: target.saveDir ?? "", placeholder: "例如 D:\\图片\\QQ好图", style: "width:320px" });
    return el("div", { class: "gallery-save-target" },
      el("span", {}, "保存到："), input,
      el("button", { class: "btn small primary", type: "button", onclick: () => saveGalleryDir(input.value) }, "保存"),
      target.saveDir === null ? null : el("button", { class: "btn small", type: "button", onclick: () => saveGalleryDir("") }, "改回每次新建文件夹"),
      el("button", { class: "btn small", type: "button", onclick: () => { replaceGallery({ editingSaveDir: false }); refreshGallerySelection(); } }, "取消"));
  }
  return el("div", { class: "gallery-save-target" },
    el("span", {}, "保存到："),
    el("code", {}, target.saveDir ?? `${target.fallbackRoot}\\picture-export-<时间>（每次新建一个文件夹）`),
    el("button", { class: "btn small", type: "button", onclick: () => { replaceGallery({ editingSaveDir: true }); refreshGallerySelection(); } },
      target.saveDir === null ? "改成固定文件夹" : "更改"));
};

const gallerySelectBox = (item) => el("label", {
  class: app.gallery.selected.has(item.md5) ? "wall-pick picked" : "wall-pick",
  title: app.gallery.selecting ? "选中" : "选中这张，开始多选（也可以按住 Ctrl 点图片）",
  onclick: (event) => event.stopPropagation(),
}, el("input", {
  type: "checkbox",
  checked: app.gallery.selected.has(item.md5),
  "aria-label": "选中这张图",
  onclick: (event) => {
    event.stopPropagation();
    if (event.shiftKey) {
      event.preventDefault();
      toggleGallerySelected(item.md5, event.target.closest(".wall-tile"), event);
    }
  },
  onchange: (event) => toggleGallerySelected(item.md5, event.target.closest(".wall-tile"), event),
}));

const galleryTile = (item, index) => wallTile({
  src: pictureUrl(item.md5, "thumb"),
  alt: item.sticker ? "表情" : "图片",
  onOpen: (event) => (app.gallery.selecting || event.ctrlKey || event.metaKey
    ? toggleGallerySelected(item.md5, event.currentTarget.closest(".wall-tile"), event)
    : openGalleryDetail(index)),
  badges: galleryBadges(item),
  // Shown on hover; always while selecting (gallery.css).
  corner: el("div", { class: "wall-corner desktop-action" }, gallerySelectBox(item)),
  caption: galleryCaption(item),
  extraClass: [item.sticker ? "sticker" : "", app.gallery.selected.has(item.md5) ? "selected" : ""].join(" "),
  onError: (image) => {
    const tile = image.closest(".wall-tile");
    tile?.classList.add("broken");
    // A picture sent as a file has nothing to show until QQ has a preview of it.
    if (item.fileName && tile && tile.querySelector(".wall-missing-note") === null) {
      tile.querySelector(".wall-open")?.append(el("span", { class: "wall-missing-note" }, `${item.fileName}：本机没有 QQ 的预览`));
    }
  },
});

const dayHeaderAction = (day) => (app.gallery.selecting
  ? el("button", {
    class: "kb-linkish gallery-day-select",
    type: "button",
    onclick: () => selectGalleryItems((app.gallery.results?.items ?? []).filter((item) => galleryDayKey(item.lastAt) === day)),
  }, "选这天")
  : null);

const renderGalleryEntry = (entry) =>
  (entry.kind === "header" ? wallHeader(galleryDayTitle(entry.day), "", dayHeaderAction(entry.day)) : galleryTile(entry.item, entry.itemIndex));

/* ---------- toolbar, conditions, facets ---------- */

const galleryRangeLabel = () => {
  const range = app.gallery.range;
  if (range === null) {
    return "";
  }
  return range.preset === "custom"
    ? `${unixToHkt(range.fromUnix).slice(5, 10)} – ${unixToHkt(range.toUnix - 1).slice(5, 10)}`
    : `${unixToHkt(range.fromUnix).slice(5, 16)} – ${unixToHkt(range.toUnix).slice(5, 16)}`;
};

/* ---------- search ---------- */

// composing: an input method (pinyin…) is mid-word; nothing searches or
// redraws the box until it ends (a redraw would cancel the word).
const gallerySearch = { timer: null, composing: false, renderPending: false };

const scheduleGallerySearch = (value) => {
  clearTimeout(gallerySearch.timer);
  gallerySearch.timer = setTimeout(() => runGallerySearch(value), GALLERY_SEARCH_DELAY_MS);
};

const runGallerySearch = (value) => {
  clearTimeout(gallerySearch.timer);
  gallerySearch.timer = null;
  const q = value.trim();
  if (q !== app.gallery.q) {
    applyGalleryFilter({ q });
  }
};

// The box is drawn again with every result; typing keeps its text, focus and
// caret (text typed after the search started is not lost).
const restoreGallerySearchFocus = (typed) => {
  const input = document.getElementById("gallery-search");
  if (input !== null && typed !== null) {
    input.value = typed.value;
    input.focus();
    input.setSelectionRange(typed.caret, typed.caret);
  }
};

const gallerySearchBox = () => el("form", {
  class: "gallery-search",
  role: "search",
  onsubmit: (event) => {
    event.preventDefault();
    runGallerySearch(event.target.querySelector("input").value);
  },
},
el("input", {
  id: "gallery-search",
  type: "search",
  value: app.gallery.q,
  placeholder: "搜图：咒语、LoRA、模型、文件名、发图人、配的话",
  "aria-label": "搜图",
  title: "几个词用空格隔开，每个词都要对上（可以分别对上不同地方）",
  oninput: (event) => {
    if (!event.isComposing && !gallerySearch.composing) {
      scheduleGallerySearch(event.target.value);
    }
  },
  oncompositionstart: () => {
    gallerySearch.composing = true;
    clearTimeout(gallerySearch.timer);
  },
  oncompositionend: (event) => {
    gallerySearch.composing = false;
    const { value } = event.target;
    if (gallerySearch.renderPending) {
      gallerySearch.renderPending = false;
      renderMediaView();
    }
    scheduleGallerySearch(value);
  },
}),
el("button", { class: "btn small", type: "submit" }, "搜索"));

const galleryToolbar = () => el("div", { class: "gallery-toolbar" },
  gallerySearchBox(),
  el("div", { class: "wall-modes", role: "group", "aria-label": "时间范围" },
    galleryCalendarButtons(),
    GALLERY_DAY_CHOICES.map(([days, label]) => el("button", {
      class: app.gallery.range === null && app.gallery.days === days ? "wall-mode active" : "wall-mode",
      type: "button",
      "aria-pressed": String(app.gallery.range === null && app.gallery.days === days),
      onclick: () => applyGalleryFilter({ days, range: null, until: null }),
    }, label)),
    galleryDatePicker()),
  galleryJumpControl(),
  el("div", { class: "wall-modes", role: "group", "aria-label": "类型" },
    GALLERY_KINDS.map(([kind, label]) => el("button", {
      class: app.gallery.kind === kind ? "wall-mode active" : "wall-mode",
      type: "button",
      "aria-pressed": String(app.gallery.kind === kind),
      onclick: () => applyGalleryFilter({ kind }),
    }, label))),
  el("label", { class: "gallery-check" },
    el("input", { type: "checkbox", checked: app.gallery.ai, onchange: (event) => applyGalleryFilter({ ai: event.target.checked }) }),
    "只看 AI 图"));

const galleryLabel = (choices, value) => choices.find(([key]) => key === value)?.[1] ?? value;

const galleryConditions = () => {
  const tab = app.gallery;
  const chips = [
    tab.range === null || tab.range.preset === "today" || tab.range.preset === "yesterday"
      ? null
      : { text: `时间：${galleryRangeLabel()}`, remove: () => applyGalleryFilter({ range: null }) },
    galleryCursorChip(),
    tab.groupId === "" ? null : { text: `群：${pictureGroupName(tab.groupId)}`, remove: () => applyGalleryFilter({ groupId: "" }) },
    tab.sender === "" ? null : { text: `发图人：${tab.senderLabel || tab.sender}`, remove: () => applyGalleryFilter({ sender: "", senderLabel: "" }) },
    tab.q === "" ? null : { text: `搜：${tab.q}`, remove: () => applyGalleryFilter({ q: "" }) },
    tab.shape === "" ? null : { text: `形状：${galleryLabel(GALLERY_SHAPES, tab.shape)}`, remove: () => applyGalleryFilter({ shape: "" }) },
    tab.size === "" ? null : { text: `大小：${galleryLabel(GALLERY_SIZES, tab.size)}`, remove: () => applyGalleryFilter({ size: "" }) },
    ...GALLERY_SWITCHES.filter(([key]) => tab[key]).map(([key, label]) => ({ text: label, remove: () => applyGalleryFilter({ [key]: false }) })),
  ].filter((chip) => chip !== null);
  if (chips.length === 0) {
    return null;
  }
  return el("div", { class: "kb-conditions" },
    el("span", { class: "kb-conditions-label" }, "条件"),
    chips.map((chip) => el("span", { class: "kb-cond include" },
      chip.text,
      el("button", { class: "kb-cond-x", type: "button", "aria-label": `去掉 ${chip.text}`, onclick: chip.remove }, "×"))));
};

const toggleGalleryFacet = (id) => {
  const expanded = new Set(app.gallery.expandedFacets);
  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }
  replaceGallery({ expandedFacets: expanded });
  const node = document.getElementById("gallery-facets-body");
  if (node !== null) {
    setChildren(node, galleryFacetSections());
  }
};

const galleryFacetSection = (id, title, rows) => facetBlock({
  id: `g-${id}`,
  title,
  rows,
  expanded: app.gallery.expandedFacets.has(id),
  onToggle: () => toggleGalleryFacet(id),
});

const galleryFacetSections = () => {
  const facets = app.gallery.facets;
  const tab = app.gallery;
  if (facets === null) {
    return [el("p", { class: "kb-meta" }, "正在统计…")];
  }
  if (facets.unavailable) {
    return [el("p", { class: "kb-meta" }, "暂时没有统计。")];
  }
  return [
    galleryFacetSection("sort", "排序", GALLERY_SORTS.map(([sort, label]) => facetRow({
      label,
      count: sort === "spread" ? facets.spread : null,
      title: sort === "spread" ? "在多个群出现过的图排在前面" : label,
      active: tab.sort === sort,
      onClick: () => applyGalleryFilter({ sort }),
    }))),
    galleryFacetSection("kind", "类型", [
      facetRow({ label: "图片", count: facets.kinds.images, active: tab.kind === "images", onClick: () => applyGalleryFilter({ kind: "images" }) }),
      facetRow({ label: "表情包", count: facets.kinds.stickers, active: tab.kind === "stickers", onClick: () => applyGalleryFilter({ kind: "stickers" }) }),
      facetRow({ label: "只看 AI 图", count: facets.ai, active: tab.ai, onClick: () => applyGalleryFilter({ ai: !tab.ai }) }),
      ...GALLERY_SWITCHES.map(([key, label, title]) => facetRow({
        label,
        title,
        count: facets.extras?.[key] ?? null,
        active: tab[key],
        onClick: () => applyGalleryFilter({ [key]: !tab[key] }),
      })),
    ]),
    galleryFacetSection("shape", "形状", GALLERY_SHAPES.map(([shape, label, title]) => facetRow({
      label,
      title: title ?? label,
      count: facets.shapes?.[shape] ?? null,
      active: tab.shape === shape,
      onClick: () => applyGalleryFilter({ shape: tab.shape === shape ? "" : shape }),
    }))),
    galleryFacetSection("size", "大小", GALLERY_SIZES.map(([size, label, title]) => facetRow({
      label,
      title,
      count: facets.sizes?.[size] ?? null,
      active: tab.size === size,
      onClick: () => applyGalleryFilter({ size: tab.size === size ? "" : size }),
    }))),
    galleryFacetSection("group", "群", facets.groups.map((row) => facetRow({
      label: row.label || row.value,
      count: row.count,
      active: tab.groupId === row.value,
      onClick: () => applyGalleryFilter({ groupId: tab.groupId === row.value ? "" : row.value }),
    }))),
    galleryFacetSection("sender", "发图人", facets.senders.map((row) => facetRow({
      label: row.label,
      count: row.count,
      active: tab.sender === row.value,
      onClick: () => applyGalleryFilter(tab.sender === row.value
        ? { sender: "", senderLabel: "" }
        : { sender: row.value, senderLabel: row.label }),
    }))),
  ];
};

/* ---------- results ---------- */

const galleryCountText = () => {
  const tab = app.gallery;
  if (tab.loading && !tab.loadingMore) {
    return "正在读取…";
  }
  return tab.results === null ? "" : `共 ${briefNumber(tab.results.total)} 张`;
};

const galleryFootText = () => {
  const results = app.gallery.results;
  if (results === null || results.items.length === 0) {
    return "";
  }
  if (app.gallery.loadingMore) {
    return "正在加载更多…";
  }
  return results.items.length < results.total
    ? `继续下滑加载（还有 ${briefNumber(results.total - results.items.length)} 张）`
    : "已经到底了";
};

const updateGalleryTexts = () => {
  const count = document.getElementById("gallery-count");
  if (count !== null) {
    count.textContent = galleryCountText();
  }
  const foot = document.getElementById("gallery-foot");
  if (foot !== null) {
    foot.textContent = galleryFootText();
  }
};

const galleryWall = () => {
  const tab = app.gallery;
  if (tab.error !== null) {
    return el("div", { class: "notice risk" }, `读取画廊失败：${tab.error}`);
  }
  if (tab.results === null) {
    return el("div", { class: "wall-empty" }, "读取中…");
  }
  if (tab.results.items.length === 0) {
    return el("div", { class: "wall-empty" },
      "这个范围里没有图片。可以把时间放宽，或去掉上面的条件。",
      el("br"),
      el("span", { class: "kb-meta" }, "画廊显示后台记录下来的所有群图片；超过 31 天的只剩已保存的缩略图和预览，腾讯那边的原图取不到了。"));
  }
  return imageWall({
    key: GALLERY_WALL_KEY,
    entries: galleryEntries(),
    mode: galleryWallMode(),
    targetSize: galleryWallSize(),
    gap: 8,
    renderEntry: renderGalleryEntry,
    onNearEnd: loadMoreGallery,
  });
};

const renderMediaView = () => {
  const root = $("#view-media");
  if (root === null) {
    return;
  }
  const tab = app.gallery;
  if (gallerySearch.composing) {
    gallerySearch.renderPending = true;
    return;
  }
  const focused = document.activeElement;
  const typed = focused?.id === "gallery-search" ? { value: focused.value, caret: focused.selectionStart } : null;
  setChildren(root, el("section", { class: tab.selecting ? "panel kb-page gallery-page selecting" : "panel kb-page gallery-page" },
    galleryToolbar(),
    galleryConditions(),
    el("div", { class: "kb-layout" },
      el("details", { class: "kb-facets", open: window.innerWidth > KB_MOBILE_WIDTH },
        el("summary", {}, "筛选"),
        el("div", { id: "gallery-facets-body", class: "kb-facets-body" }, galleryFacetSections())),
      el("div", { class: tab.loading && !tab.loadingMore ? "kb-results is-loading" : "kb-results" },
        el("div", { class: "kb-results-head" },
          el("strong", { id: "gallery-count", class: "kb-count" }, galleryCountText()),
          el("span", { class: "kb-results-spacer" }),
          el("button", {
            class: tab.selecting ? "btn small active desktop-action" : "btn small primary desktop-action",
            type: "button",
            "aria-pressed": String(tab.selecting),
            title: tab.selecting
              ? "退出多选（Esc），已选的会清空"
              : "选几张图，一起把原图保存到文件夹。也可以直接点图片右上角的方框，或按住 Ctrl 点图片",
            onclick: () => {
              if (tab.selecting) {
                leaveGallerySelection();
                return;
              }
              replaceGallery({ selecting: true, lastPicked: null });
              renderMediaView();
            },
          }, tab.selecting ? "退出多选" : "多选"),
          wallControls({
            mode: galleryWallMode(),
            modes: GALLERY_MODES,
            size: galleryWallSize(),
            min: GALLERY_SIZE_MIN,
            max: GALLERY_SIZE_MAX,
            onMode: (value) => {
              wallWritePref(GALLERY_MODE_KEY, value);
              renderMediaView();
            },
            onSize: (value) => {
              wallWritePref(GALLERY_SIZE_KEY, value);
              renderMediaView();
            },
          })),
        galleryReturnBanner(),
        galleryWall(),
        tab.selecting ? el("div", { id: "gallery-selection", class: "gallery-selection" }, gallerySelectionNodes()) : null,
        el("div", { id: "gallery-foot", class: "wall-foot" }, galleryFootText())))));
  restoreGallerySearchFocus(typed);
};
