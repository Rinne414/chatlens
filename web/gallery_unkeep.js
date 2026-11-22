"use strict";

/* ---------- 画廊「留存的原图」: why, how much, and taking pictures out ----------
   The library explains itself: how many originals it holds, how much disk,
   where, and which rules bring them in; each picture says what kept it.
   「取消留存」 moves the original to a removed folder (nothing is deleted, it can
   be put back); only 「彻底删除」 deletes, and it asks first. */

const KEPT_WHY_TEXT = {
  manual: "你手动留存的",
  group: "它所在的群设了「每张都留存原图」",
  group_guess: "它所在的群设过「每张都留存原图」（推断）",
  ai: "开着「自动留存 AI 原图」时留的",
  local: "这台电脑的 QQ 已经存有这张原图（通常是你点开过），咒语库复制了一份",
  early: "较早留存的，当时没有记下原因（你手动留的，或当时设了「每张都留存原图」的群）",
};
const KEPT_WHY_FACETS = [
  ["manual", "你手动留的", KEPT_WHY_TEXT.manual],
  ["group", "群设了每张都留", "所在的群在「设置 → 群图片」里勾了「每张都留存原图」"],
  ["ai", "自动留存的 AI 图", "备份页的「以后自动留存所有 AI 原图」开着时留的"],
  ["local", "电脑上已有原图，复制来的", KEPT_WHY_TEXT.local],
  ["early", "较早留存，没记原因", KEPT_WHY_TEXT.early],
];
const UNKEEP_BATCH = 200;

const keptUi = { summary: null, loading: false, reload: false, busy: false, confirmEmpty: false, notice: "", undo: [], folder: { available: true, unconfirmed: 0 } };

const keptWhyText = (item) => (item.kept ? KEPT_WHY_TEXT[item.keptWhy] ?? "" : "");

const inKeptPlaces = () => app.gallery.kept || app.gallery.removed;

const renderKeptHead = () => {
  const node = document.getElementById("gallery-kept-head");
  if (node !== null) {
    setChildren(node, galleryKeptHeadNodes());
  }
};

const loadKeptSummary = async () => {
  if (keptUi.loading) {
    // Something changed while the numbers were being read: read them again after.
    keptUi.reload = true;
    return;
  }
  keptUi.loading = true;
  try {
    // First let the records catch up with the folder: files deleted or put
    // back there by hand since the last look.
    await followKeptFolder();
    keptUi.summary = await api("/api/gallery/kept-summary");
  } catch {
    keptUi.summary = null;
  } finally {
    keptUi.loading = false;
    renderKeptHead();
    // 取消留存的 appears beside the other two once there is something in it.
    document.querySelector(".gallery-scope")?.replaceWith(galleryScopeTabs());
    if (keptUi.reload) {
      keptUi.reload = false;
      loadKeptSummary();
    }
  }
};

const followKeptFolder = async ({ confirmed = false } = {}) => {
  let found;
  try {
    found = await api("/api/pictures/reconcile", { method: "POST", body: JSON.stringify({ confirmed }) });
  } catch {
    return;
  }
  keptUi.folder = { available: found.available, unconfirmed: found.unconfirmed ?? 0 };
  const parts = [
    found.dropped > 0 ? `留存文件夹里有 ${briefNumber(found.dropped)} 张原图被直接删掉了，已经把它们从留存里去掉，以后不会自动留回来（把文件放回原处，它们就又算留存）。` : "",
    found.adopted > 0 ? `留存文件夹里多了 ${briefNumber(found.adopted)} 张原图（放回来的），已经重新算作留存。` : "",
  ].join("");
  if (parts !== "") {
    keptUi.notice = parts;
    keptUi.undo = [];
    replaceGallery({ facets: null, facetsKey: "" });
  }
};

// The folder is away, or lost most of its files at once: say so, change nothing.
const keptFolderLine = () => {
  if (keptUi.folder.available === false) {
    return el("p", { class: "notice warn" }, "现在读不到留存文件夹（它所在的磁盘可能没接上）。留存的记录都没有动，文件夹回来后就恢复正常。");
  }
  if (keptUi.folder.unconfirmed === 0) {
    return null;
  }
  return el("p", { class: "notice warn gallery-kept-removed" },
    `留存文件夹里少了 ${briefNumber(keptUi.folder.unconfirmed)} 张原图的文件，超过一半。如果是你自己删的，点下面的按钮确认，它们就从留存里去掉；如果不是（比如文件夹没复制全），先把文件放回去，记录都还在。`,
    el("button", {
      class: "btn small",
      type: "button",
      disabled: keptUi.busy,
      onclick: async () => {
        keptUi.busy = true;
        renderKeptHead();
        await followKeptFolder({ confirmed: true });
        keptUi.busy = false;
        afterKeptChange();
      },
    }, "是我删的，从留存里去掉"));
};

const openPictureKeepSettings = async () => {
  await openSettingsView();
  document.getElementById("picture-keep-groups")?.scrollIntoView({ behavior: "smooth", block: "center" });
};

const openAutoKeepAi = async () => {
  await openBackupView();
  document.getElementById("backup-rescue")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

const keptLinkButton = (label, onclick) => el("button", { class: "linklike", type: "button", onclick }, label);

const keptRulesLine = (rules) => el("p", { class: "kb-meta gallery-kept-rules" },
  "原图是这样进来的：",
  el("span", {}, "① 你按「留存原图」；"),
  el("span", {}, `② 勾了「每张都留存原图」的群（现在 ${rules.keepAllGroups} 个），这些群发的每张图都留，表情除外 `),
  keptLinkButton("去改", openPictureKeepSettings),
  el("span", {}, `；③「自动留存 AI 原图」（现在${rules.keepAi ? "开着" : "关着"}） `),
  keptLinkButton("去看", openAutoKeepAi),
  el("span", {}, "；④ 这台电脑的 QQ 已经存有原图的（通常是你点开过的图），咒语库会复制一份。可在「筛选 → 为什么留存」里按来源筛选。"));

// Originals the prompt library took in before the gallery recorded pictures:
// no group and no time to list them by, so they are handled together.
const keptOutsideLine = (outside) => (outside.count === 0 ? null : el("p", { class: "kb-meta gallery-kept-removed" },
  linked(`另外 ${briefNumber(outside.count)} 张是咒语库更早收进来的原图，没有群和时间，只能在咒语库里看。`),
  el("button", {
    class: "btn small",
    type: "button",
    disabled: keptUi.busy,
    title: "把这些原图也从留存里拿出去。先放到一边，没有删，可以「全部放回留存」；要腾出空间再按「彻底删除」",
    onclick: runOutsideUnkeep,
  }, keptUi.busy ? "正在处理…" : `把这 ${briefNumber(outside.count)} 张取消留存`)));

const keptRemovedLine = (removed) => {
  if (removed.count === 0 && !app.gallery.removed) {
    return null;
  }
  const size = formatByteSize(removed.bytes);
  return el("p", { class: "kb-meta gallery-kept-removed" },
    removed.count === 0
      ? "现在没有取消留存的图。"
      : `取消留存的 ${briefNumber(removed.count)} 张（约 ${size}）还没删，仍占空间${removed.unlisted > 0 ? `；其中 ${briefNumber(removed.unlisted)} 张不在画廊里，同样可以放回或删除` : ""}：`,
    removed.count === 0 || app.gallery.removed ? null : el("button", { class: "btn small", type: "button", onclick: () => applyGalleryFilter(galleryScopePatch("removed")) }, "看看这些图"),
    removed.count === 0 ? null : el("button", { class: "btn small", type: "button", disabled: keptUi.busy, onclick: () => runRemovedAction("restore", { all: true }) }, "全部放回留存"),
    removed.count === 0 ? null : keptUi.confirmEmpty
      ? el("span", { class: "gallery-kept-confirm" },
        `彻底删除这 ${briefNumber(removed.count)} 张原图？删了拿不回来（腾讯那边过期的图也下载不到了）。`,
        el("button", { class: "btn small danger", type: "button", disabled: keptUi.busy, onclick: () => runRemovedAction("empty-removed", { all: true, expected: removed.count }) }, "确定删除"),
        el("button", { class: "btn small", type: "button", onclick: () => { keptUi.confirmEmpty = false; renderKeptHead(); } }, "不删"))
      : el("button", { class: "btn small", type: "button", disabled: keptUi.busy, onclick: () => { keptUi.confirmEmpty = true; renderKeptHead(); } }, `彻底删除，腾出约 ${size}`));
};

const keptNoticeLine = () => (keptUi.notice === "" ? null : el("p", { class: "kb-meta gallery-kept-notice", "aria-live": "polite" },
  keptUi.notice,
  keptUi.undo.length === 0 ? null : el("button", { class: "btn small", type: "button", disabled: keptUi.busy, onclick: () => runRemovedAction("restore", { md5s: keptUi.undo }) }, "撤销，放回去")));

const galleryKeptHeadNodes = () => {
  if (!inKeptPlaces()) {
    // 取消留存 pressed from 全部群图: what happened and the way back still show.
    return [keptNoticeLine()];
  }
  const summary = keptUi.summary;
  if (summary === null) {
    return [el("p", { class: "kb-meta" }, keptUi.loading ? waiting("正在统计留存的原图…", "留存得多时要几秒") : "暂时读不到留存的统计。")];
  }
  return [
    el("p", { class: "kb-meta gallery-kept-hint" },
      el("strong", {}, summary.outside.count > 0
        ? `留存文件夹里一共有 ${briefNumber(summary.kept.count + summary.outside.count)} 张原图，其中 ${briefNumber(summary.kept.count)} 张在画廊里（图片和表情都算），约 ${formatByteSize(summary.kept.bytes)}。`
        : `本程序里一共留存了 ${briefNumber(summary.kept.count)} 张原图（图片和表情都算），约 ${formatByteSize(summary.kept.bytes)}。`),
      el("button", {
        class: "btn small desktop-action",
        type: "button",
        title: "文件名是图片的编号（md5），不好认；找图还是在这一页方便",
        onclick: () => api("/api/storage/open", { method: "POST", body: JSON.stringify({ category: "knowledge-media" }) })
          .catch(() => notify("还没有留存过原图，所以还没有这个文件夹。", { isError: true })),
      }, "打开留存文件夹")),
    keptFolderLine(),
    keptRemovedLine(summary.removed),
    keptNoticeLine(),
    app.gallery.removed
      ? el("p", { class: "kb-meta" }, "下面是你取消留存的图。原图文件还在，点开一张按「放回留存」，或「多选」后一起放回。")
      // Unfolded where there is room; on a phone the pictures come first.
      : el("details", { class: "gallery-kept-about", open: window.innerWidth > KB_MOBILE_WIDTH },
        el("summary", {}, "这些原图存在哪、怎么进来的、怎么去掉"),
        el("p", { class: "kb-meta" }, linked(`存在 ${summary.folder}，占用在「存储」页看。文件名是图片编号（md5）。也可以直接在文件夹里删：ChatLens 会把它们从留存里去掉；从回收站放回原处就恢复。`)),
        el("p", { class: "kb-meta" }, "腾讯删掉之后这些图也能看。要把图放进你自己的文件夹，点开图按「另存为」，或「多选」后「另存到文件夹」。不想留的，点开图按「取消留存」，或「多选」后一起取消。"),
        keptRulesLine(summary.rules),
        keptOutsideLine(summary.outside)),
  ];
};

const galleryKeptHead = () => {
  if (inKeptPlaces() && keptUi.summary === null && !keptUi.loading) {
    loadKeptSummary();
  }
  return el("div", { id: "gallery-kept-head", class: "gallery-kept-head" }, galleryKeptHeadNodes());
};

/* ---------- actions ---------- */

const postPictureBatches = async (route, md5s) => {
  const total = { tally: {}, bytes: 0 };
  for (let start = 0; start < md5s.length; start += UNKEEP_BATCH) {
    const result = await api(`/api/pictures/${route}`, { method: "POST", body: JSON.stringify({ md5s: md5s.slice(start, start + UNKEEP_BATCH) }) });
    total.bytes += result.bytes ?? 0;
    for (const [status, count] of Object.entries(result.tally ?? {})) {
      total.tally[status] = (total.tally[status] ?? 0) + count;
    }
  }
  return total;
};

const afterKeptChange = () => {
  keptUi.confirmEmpty = false;
  replaceGallery({ selected: new Set(), lastPicked: null, facets: null, facetsKey: "", detail: null });
  loadKeptSummary();
  loadGallery();
};

// 取消留存: the originals move to the removed folder; nothing is deleted.
const runPictureUnkeep = async (md5s) => {
  if (keptUi.busy || md5s.length === 0) {
    return;
  }
  keptUi.busy = true;
  try {
    const done = await postPictureBatches("unkeep", md5s);
    const removed = done.tally.removed ?? 0;
    keptUi.undo = removed > 0 ? [...md5s] : [];
    const missing = done.tally.missing ?? 0;
    const failed = done.tally.failed ?? 0;
    const notKept = done.tally["not-kept"] ?? 0;
    keptUi.notice = [
      removed > 0 ? `已取消留存 ${briefNumber(removed)} 张（约 ${formatByteSize(done.bytes)}）。文件还在，要腾出空间请到「留存的原图」按「彻底删除」。` : "",
      missing > 0 ? `${briefNumber(missing)} 张的原图文件本来就不在了，已经从留存里去掉。` : "",
      notKept > 0 ? `${briefNumber(notKept)} 张本来就没有留存，没有动。` : "",
      failed > 0 ? `${briefNumber(failed)} 张没有取消成（文件可能正被别的程序占用），它们还在留存里，可以再试一次。` : "",
    ].join("");
  } catch (error) {
    keptUi.notice = `没有取消成：${error.message}`;
    keptUi.undo = [];
  } finally {
    keptUi.busy = false;
    afterKeptChange();
  }
};

// Every kept original the gallery cannot list, in one go (the server works
// through them in chunks; with thousands it takes a while).
const runOutsideUnkeep = async () => {
  if (keptUi.busy) {
    return;
  }
  keptUi.busy = true;
  renderKeptHead();
  try {
    const done = await api("/api/pictures/unkeep", { method: "POST", body: JSON.stringify({ outsideGallery: true }) });
    const failed = done.tally.failed ?? 0;
    keptUi.undo = [];
    keptUi.notice = `已取消留存 ${briefNumber(done.tally.removed ?? 0)} 张不在画廊里的原图（约 ${formatByteSize(done.bytes)}）。文件还在，可以「全部放回留存」；要腾出空间请按「彻底删除」。`
      + (failed > 0 ? `另有 ${briefNumber(failed)} 张没有取消成（文件可能正被别的程序占用），可以再试一次。` : "");
  } catch (error) {
    keptUi.notice = `没有取消成：${error.message}`;
  } finally {
    keptUi.busy = false;
    afterKeptChange();
  }
};

// restore (md5s or everything removed) and empty-removed (everything removed).
const runRemovedAction = async (route, body) => {
  if (keptUi.busy) {
    return;
  }
  keptUi.busy = true;
  renderKeptHead();
  try {
    const done = body.all === true
      ? await api(`/api/pictures/${route}`, { method: "POST", body: JSON.stringify(body) })
      : await postPictureBatches(route, body.md5s);
    keptUi.undo = [];
    const failed = done.tally.failed ?? 0;
    keptUi.notice = (route === "restore"
      ? `放回了 ${briefNumber(done.tally.restored ?? 0)} 张，又在「留存的原图」里了。`
      : `彻底删除了 ${briefNumber(done.tally.emptied ?? 0)} 张原图，腾出约 ${formatByteSize(done.bytes)}。这些图以后不会再被自动留存；想留可以手动按「留存原图」。`)
      + (failed > 0 ? `另有 ${briefNumber(failed)} 张没有成功（文件可能正被别的程序占用），可以再试一次。` : "");
  } catch (error) {
    keptUi.notice = `没有成功：${error.message}`;
  } finally {
    keptUi.busy = false;
    afterKeptChange();
  }
};

/* ---------- pieces other gallery files place ---------- */

// 全部群图 / 留存的原图 / 取消留存的 (only while there are some).
const galleryScopePatch = (scope) => {
  const tab = app.gallery;
  // A new place: a half-confirmed delete and the last message do not follow,
  // and neither does a selection made among other pictures.
  Object.assign(keptUi, { confirmEmpty: false, notice: "", undo: [] });
  const fresh = { selected: new Set(), lastPicked: null };
  if (scope === "removed") {
    return {
      ...fresh,
      ...(tab.kept ? {} : galleryKeptPatch(true)),
      kept: false, removed: true, why: "", kind: "all", days: 0, range: null, until: null,
    };
  }
  if (scope === "kept") {
    return { ...fresh, ...galleryKeptPatch(true), kept: true, removed: false, days: 0, range: null, until: null, kind: tab.removed ? "images" : tab.kind };
  }
  return { ...fresh, ...galleryKeptPatch(false), removed: false, why: "", kind: tab.removed ? "images" : tab.kind };
};

const galleryScope = () => (app.gallery.removed ? "removed" : app.gallery.kept ? "kept" : "all");

const galleryWhyFacetRows = () => {
  const whys = app.gallery.facets?.whys ?? null;
  if (whys === null || !app.gallery.kept) {
    return null;
  }
  return KEPT_WHY_FACETS.map(([why, label, title]) => facetRow({
    label,
    title,
    count: whys[why] ?? 0,
    active: app.gallery.why === why,
    onClick: () => applyGalleryFilter({ why: app.gallery.why === why ? "" : why }),
  }));
};

const gallerySelectionKeptButtons = (count) => [
  app.gallery.kept
    ? el("button", {
      class: "btn small",
      type: "button",
      disabled: count === 0 || keptUi.busy,
      title: "把这些图的原图从本程序里拿出去。先放到一边，没有删，可以放回；要腾出空间再按「彻底删除」",
      onclick: () => runPictureUnkeep([...app.gallery.selected]),
    }, `取消留存（${briefNumber(count)}）`)
    : null,
  app.gallery.removed
    ? el("button", {
      class: "btn small primary",
      type: "button",
      disabled: count === 0 || keptUi.busy,
      onclick: () => runRemovedAction("restore", { md5s: [...app.gallery.selected] }),
    }, `放回留存（${briefNumber(count)}）`)
    : null,
];

// In the big view of one picture: the mark plus the way out, or the way back.
const galleryDetailKeptNodes = (item, patch) => {
  if (item.removed && !item.kept) {
    return [
      el("span", { class: "tag", title: "你取消了留存；原图文件还在，没有删" }, "已取消留存"),
      el("button", {
        class: "btn small",
        type: "button",
        onclick: async () => {
          await runRemovedAction("restore", { md5s: [item.md5] });
          patch({ notice: keptUi.notice });
        },
      }, "放回留存"),
    ];
  }
  return [
    el("span", { class: "tag", title: `原图已经存在本程序里，在画廊「留存的原图」里能找到。${keptWhyText(item)}` }, "已留存"),
    el("button", {
      class: "btn small",
      type: "button",
      title: "把原图从本程序里拿出去。先放到一边，没有删，可以放回；要腾出空间到「留存的原图」里按「彻底删除」",
      onclick: () => runPictureUnkeep([item.md5]),
    }, "取消留存"),
  ];
};
