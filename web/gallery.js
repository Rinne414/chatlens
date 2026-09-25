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
const GALLERY_DAY_CHOICES = [[1, "今天"], [3, "3 天"], [7, "7 天"], [31, "31 天"], [0, "全部"]];
const GALLERY_KINDS = [["images", "图片"], ["stickers", "表情包"], ["all", "全部"]];
const GALLERY_SORTS = [["recent", "最新发的"], ["spread", "传得最广"]];
const GIF_PICTURE_FORMAT = 2000;
const GALLERY_ORIGIN = { view: "media", label: "画廊" };
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

app.gallery = {
  days: 7,
  range: null,
  kind: "images",
  ai: false,
  sort: "recent",
  groupId: "",
  sender: "",
  senderLabel: "",
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
};

const replaceGallery = (patch) => {
  app.gallery = { ...app.gallery, ...patch };
};

const galleryWallMode = () => {
  const stored = wallReadPref(GALLERY_MODE_KEY, "masonry");
  return GALLERY_MODES.includes(stored) ? stored : "masonry";
};

const galleryWallSize = () => {
  const size = Number(wallReadPref(GALLERY_SIZE_KEY, GALLERY_SIZE_DEFAULT));
  return Number.isFinite(size) ? Math.min(GALLERY_SIZE_MAX, Math.max(GALLERY_SIZE_MIN, size)) : GALLERY_SIZE_DEFAULT;
};

/* ---------- loading ---------- */

const galleryFilterParams = () => {
  const tab = app.gallery;
  const params = new URLSearchParams({ kind: tab.kind, ai: tab.ai ? "1" : "0", groupId: tab.groupId, sender: tab.sender });
  if (tab.range !== null) {
    params.set("fromUnix", String(tab.range.fromUnix));
    params.set("toUnix", String(tab.range.toUnix));
  } else {
    params.set("days", String(tab.days));
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
const openMediaView = (forceRefresh) => {
  showView("media");
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
    item.ai && !item.kept && days !== null && days <= GALLERY_EXPIRY_WARN_DAYS
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

// One tile changes in place (no re-draw, so no flicker); bulk changes
// re-draw the visible tiles through refreshGallerySelection.
const toggleGallerySelected = (md5, tile) => {
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
    el("strong", {}, `已选 ${briefNumber(count)} 张`),
    el("button", { class: "btn small", type: "button", disabled: loaded.length === 0, onclick: () => selectGalleryItems(loaded) },
      `全选已加载的 ${briefNumber(loaded.length)} 张`),
    count === 0 ? null : el("button", { class: "btn small", type: "button", onclick: () => {
      replaceGallery({ selected: new Set() });
      refreshGallerySelection();
    } }, "清除"),
    el("button", {
      class: "btn small primary",
      type: "button",
      disabled: count === 0 || pictureExport.running,
      title: "把原图复制到 reports 下的新文件夹；带咒语的 AI 图附同名 .txt",
      onclick: () => runPictureExport([...app.gallery.selected], "gallery"),
    }, `导出原图到文件夹（${briefNumber(count)}）`),
    el("span", { class: "kb-meta" }, "腾讯只保留 31 天，更早的图取不到原图。"),
    pictureExportStatus("gallery"),
  ];
};

const gallerySelectBox = (item) => el("label", {
  class: app.gallery.selected.has(item.md5) ? "wall-pick picked" : "wall-pick",
  title: "选中",
  onclick: (event) => event.stopPropagation(),
}, el("input", {
  type: "checkbox",
  checked: app.gallery.selected.has(item.md5),
  "aria-label": "选中这张图",
  onchange: (event) => toggleGallerySelected(item.md5, event.target.closest(".wall-tile")),
}));

const galleryTile = (item, index) => wallTile({
  src: pictureUrl(item.md5, "thumb"),
  alt: item.sticker ? "表情" : "图片",
  onOpen: (event) => (app.gallery.selecting
    ? toggleGallerySelected(item.md5, event.currentTarget.closest(".wall-tile"))
    : openGalleryDetail(index)),
  badges: galleryBadges(item),
  corner: app.gallery.selecting ? el("div", { class: "wall-corner" }, gallerySelectBox(item)) : null,
  caption: galleryCaption(item),
  extraClass: [item.sticker ? "sticker" : "", app.gallery.selected.has(item.md5) ? "selected" : ""].join(" "),
  onError: (image) => image.closest(".wall-tile")?.classList.add("broken"),
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
  return range === null ? "" : `${unixToHkt(range.fromUnix).slice(5, 16)} – ${unixToHkt(range.toUnix).slice(5, 16)}`;
};

const galleryToolbar = () => el("div", { class: "gallery-toolbar" },
  el("div", { class: "wall-modes", role: "group", "aria-label": "时间范围" },
    GALLERY_DAY_CHOICES.map(([days, label]) => el("button", {
      class: app.gallery.range === null && app.gallery.days === days ? "wall-mode active" : "wall-mode",
      type: "button",
      "aria-pressed": String(app.gallery.range === null && app.gallery.days === days),
      onclick: () => applyGalleryFilter({ days, range: null }),
    }, label))),
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

const galleryConditions = () => {
  const tab = app.gallery;
  const chips = [
    tab.range === null ? null : { text: `时间：${galleryRangeLabel()}`, remove: () => applyGalleryFilter({ range: null }) },
    tab.groupId === "" ? null : { text: `群：${pictureGroupName(tab.groupId)}`, remove: () => applyGalleryFilter({ groupId: "" }) },
    tab.sender === "" ? null : { text: `发图人：${tab.senderLabel || tab.sender}`, remove: () => applyGalleryFilter({ sender: "", senderLabel: "" }) },
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
    ]),
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
  setChildren(root, el("section", { class: "panel kb-page gallery-page" },
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
            class: tab.selecting ? "btn small active" : "btn small",
            type: "button",
            "aria-pressed": String(tab.selecting),
            title: "选几张图，一起导出原图",
            onclick: () => {
              replaceGallery({ selecting: !tab.selecting });
              renderMediaView();
            },
          }, tab.selecting ? "完成选择" : "多选"),
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
        tab.selecting ? el("div", { id: "gallery-selection", class: "gallery-selection" }, gallerySelectionNodes()) : null,
        galleryWall(),
        el("div", { id: "gallery-foot", class: "wall-foot" }, galleryFootText())))));
};
