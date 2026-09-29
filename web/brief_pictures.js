"use strict";

/* ---------- 简报 → 好图 / 全部图片 ----------
   「好图」 are the AI pictures people asked about; 「全部图片」 is every group
   picture posted since the briefing window began (from the picture store,
   like 画廊), a page at a time. Both can be multi-selected and their originals
   saved to the same folder 画廊 uses. */

const BRIEF_PICTURE_PAGE = 60;
const BRIEF_PICTURE_OWNER = "brief";

const briefPictures = {
  tab: "good",
  windowKey: "",
  items: [],
  total: null,
  loading: false,
  error: null,
  selecting: false,
  selected: new Set(),
  saveTarget: null,
};

const briefPictureWindow = (data) => ({ fromUnix: data.windowStart, toUnix: data.now + 60 });

const loadBriefPictures = async (data, { append = false } = {}) => {
  const range = briefPictureWindow(data);
  const key = `${range.fromUnix}`;
  if (!append && briefPictures.windowKey === key && briefPictures.total !== null) {
    return;
  }
  briefPictures.loading = true;
  briefPictures.windowKey = key;
  renderBriefView();
  const params = new URLSearchParams({
    kind: "images", ai: "0", groupId: "", sender: "", sort: "recent",
    fromUnix: String(range.fromUnix), toUnix: String(range.toUnix),
    limit: String(BRIEF_PICTURE_PAGE), offset: String(append ? briefPictures.items.length : 0),
  });
  try {
    const page = await api(`/api/gallery?${params.toString()}`);
    const previous = append ? briefPictures.items : [];
    const seen = new Set(previous.map((item) => item.md5));
    briefPictures.items = [...previous, ...page.items.filter((item) => !seen.has(item.md5))];
    briefPictures.total = page.total;
    briefPictures.error = null;
  } catch (error) {
    briefPictures.error = error.message;
  }
  briefPictures.loading = false;
  renderBriefView();
};

const loadBriefSaveTarget = async () => {
  if (briefPictures.saveTarget !== null) {
    return;
  }
  try {
    briefPictures.saveTarget = await api("/api/pictures/save-dir");
    renderBriefView();
  } catch {
    briefPictures.saveTarget = null;
  }
};

const toggleBriefPicture = (md5) => {
  const next = new Set(briefPictures.selected);
  if (next.has(md5)) {
    next.delete(md5);
  } else {
    next.add(md5);
  }
  briefPictures.selected = next;
  renderBriefView();
};

const briefPictureTile = ({ md5, src, title, badge, onOpen }) => {
  const picked = briefPictures.selected.has(md5);
  return el("button", {
    class: `brief-image ${picked ? "picked" : ""}`,
    title,
    "aria-pressed": briefPictures.selecting ? String(picked) : null,
    onclick: () => (briefPictures.selecting ? toggleBriefPicture(md5) : onOpen()),
  },
  el("img", { src, alt: "", loading: "lazy", decoding: "async" }),
  briefPictures.selecting ? el("span", { class: `brief-image-check ${picked ? "on" : ""}` }, picked ? "✓" : "") : null,
  badge ? el("span", { class: "brief-image-badge" }, badge) : null);
};

const briefGoodGrid = (data) => {
  const shownCount = briefState.imagesShown ?? BRIEF_IMAGE_PREVIEW;
  const rest = data.images.length - shownCount;
  return [
    el("div", { class: "brief-images" }, data.images.slice(0, shownCount).map((image) => briefPictureTile({
      md5: image.hash,
      src: knowledgeThumbUrl(image.hash),
      title: `${image.groupName} · ${image.speaker}`,
      badge: image.asks > 0 ? `${image.asks} 人求 tag` : null,
      onOpen: () => briefOpenImage(image),
    }))),
    rest > 0
      ? el("button", {
          class: "btn small ghost brief-more",
          onclick: () => {
            briefState.imagesShown = shownCount + BRIEF_IMAGE_MORE;
            renderBriefView();
          },
        }, `再看 ${Math.min(rest, BRIEF_IMAGE_MORE)} 张（还有 ${briefNumber(rest)} 张）`)
      : null,
  ];
};

const briefAllGrid = (data) => {
  if (briefPictures.error !== null) {
    return [el("div", { class: "notice risk" }, `读取图片失败：${briefPictures.error}`)];
  }
  if (briefPictures.total === null) {
    return [el("p", { class: "brief-empty-line" }, "正在读取…")];
  }
  if (briefPictures.items.length === 0) {
    return [el("p", { class: "brief-empty-line" }, "这段时间群里还没有图片。")];
  }
  const rest = briefPictures.total - briefPictures.items.length;
  return [
    el("div", { class: "brief-images" }, briefPictures.items.map((item) => {
      const shown = item.shown ?? item.origin;
      return briefPictureTile({
        md5: item.md5,
        src: pictureUrl(item.md5, "thumb"),
        title: shown === null ? "" : `${shown.groupName || shown.groupId} · ${shown.speaker} · ${unixToHkt(shown.sentAt).slice(11, 16)}`,
        badge: item.ai ? "AI" : null,
        onOpen: () => (shown === null ? null : briefOpenChatAt(shown.groupId, shown.groupName, shown.sentAt, shown.rowId)),
      });
    })),
    rest > 0
      ? el("button", {
          class: "btn small ghost brief-more",
          disabled: briefPictures.loading,
          onclick: () => loadBriefPictures(data, { append: true }),
        }, briefPictures.loading ? "正在加载…" : `再看 ${Math.min(rest, BRIEF_PICTURE_PAGE)} 张（还有 ${briefNumber(rest)} 张）`)
      : null,
  ];
};

const briefPictureSelectionBar = (data) => {
  const count = briefPictures.selected.size;
  const loaded = briefPictures.tab === "good" ? data.images.map((image) => image.hash) : briefPictures.items.map((item) => item.md5);
  const target = briefPictures.saveTarget;
  return el("div", { class: "brief-picture-selection" },
    el("strong", {}, `已选 ${briefNumber(count)} 张`),
    el("button", { class: "btn small", type: "button", onclick: () => { briefPictures.selected = new Set([...briefPictures.selected, ...loaded]); renderBriefView(); } },
      `全选这里的 ${briefNumber(loaded.length)} 张`),
    count === 0 ? null : el("button", { class: "btn small", type: "button", onclick: () => { briefPictures.selected = new Set(); renderBriefView(); } }, "清除"),
    el("button", {
      class: "btn small primary",
      type: "button",
      disabled: count === 0 || pictureExport.running,
      onclick: () => runPictureExport([...briefPictures.selected], BRIEF_PICTURE_OWNER),
    }, `保存原图到文件夹（${briefNumber(count)}）`),
    target === null ? null : el("span", { class: "brief-meta" }, "保存到：", el("code", {}, target.saveDir ?? `${target.fallbackRoot} 下新建的文件夹`), "（在「画廊 → 多选保存」可以改）"),
    pictureExportStatus(BRIEF_PICTURE_OWNER));
};

// Replaces the old 好图 section: tabs, the grid, multi-select.
const briefImages = (data) => {
  if (data.images.length === 0 && briefPictures.tab === "good" && (briefPictures.total ?? 0) === 0 && data.totals.mediaMessages === 0) {
    return null;
  }
  const tab = (value, label, count) => el("button", {
    class: `chip ${briefPictures.tab === value ? "on" : ""}`,
    type: "button",
    onclick: () => {
      briefPictures.tab = value;
      if (value === "all") {
        loadBriefPictures(data);
      }
      renderBriefView();
    },
  }, count === null ? label : `${label} ${briefNumber(count)}`);
  return el("section", { class: "brief-section" },
    el("h3", { class: "brief-section-title" },
      "图片",
      el("span", { class: "brief-picture-tabs" },
        tab("good", "好图", data.images.length),
        tab("all", "全部图片", briefPictures.total)),
      el("span", { class: "brief-sub" }, briefPictures.tab === "good" ? "被求 tag、反复转发的排在前面" : "这段时间群里发的所有图，新的在前"),
      el("span", { class: "brief-picture-actions" },
        el("button", {
          class: briefPictures.selecting ? "btn small active" : "btn small primary",
          type: "button",
          onclick: () => {
            briefPictures.selecting = !briefPictures.selecting;
            loadBriefSaveTarget();
            renderBriefView();
          },
        }, briefPictures.selecting ? "完成选择" : "☑ 多选保存"),
        el("button", {
          class: "btn small",
          type: "button",
          title: "在画廊里看这段时间的全部图片",
          onclick: () => openGalleryRange({ groupId: "", ...briefPictureWindow(data) }),
        }, "在画廊中打开"))),
    briefPictures.selecting ? briefPictureSelectionBar(data) : null,
    briefPictures.tab === "good" ? briefGoodGrid(data) : briefAllGrid(data));
};
