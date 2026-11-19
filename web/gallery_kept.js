"use strict";

/* ---------- 画廊:「留存的原图」 ----------
   The pictures whose original this tool holds, as their own place in 画廊:
   one switch away from the group pictures, over all time (a kept original is
   exactly what is still worth finding after 31 days). It is the same wall
   with the kept filter on, so search, groups and multi-select all work. */

const GALLERY_SCOPES = [
  [false, "全部群图", "后台记下的所有群图片"],
  [true, "留存的原图", "原图已经存在本工具里的图，腾讯删掉之后也能看"],
];

// Turning the library on shows all time; turning it off goes back to the
// time range from before, unless the user picked another one meanwhile.
const galleryKeptPatch = (on) => {
  const tab = app.gallery;
  if (on) {
    return tab.kept ? {} : { kept: true, days: 0, range: null, until: null, timeBeforeKept: { days: tab.days, range: tab.range } };
  }
  const untouched = tab.days === 0 && tab.range === null;
  // The time cursor goes with the range it was set in (an old one inside a
  // restored 7 days would be an empty, invalid range).
  return { kept: false, timeBeforeKept: null, ...(untouched && tab.timeBeforeKept !== null ? { ...tab.timeBeforeKept, until: null } : {}) };
};

// The row under 筛选 narrows the range already on screen; only the switch
// beside the search box moves to all time. Either way off restores.
const gallerySwitchPatch = (key, on) => (key === "kept" && !on ? galleryKeptPatch(false) : { [key]: on });

const galleryScopeTabs = () => el("div", { class: "wall-modes gallery-scope", role: "group", "aria-label": "看哪些图" },
  GALLERY_SCOPES.map(([kept, label, title]) => el("button", {
    class: app.gallery.kept === kept ? "wall-mode active" : "wall-mode",
    type: "button",
    title,
    "aria-pressed": String(app.gallery.kept === kept),
    onclick: () => {
      if (app.gallery.kept !== kept) {
        applyGalleryFilter(galleryKeptPatch(kept));
      }
    },
  }, label)));

// One line, only inside the library: what it is and how it differs from 另存.
const galleryKeptHint = () => (app.gallery.kept
  ? el("p", { class: "kb-meta gallery-kept-hint" },
    "这里是原图已经存在本工具里的图，腾讯删掉之后也能看。要把图放进你自己的文件夹，点开图按「另存为」，或「多选」后「另存到文件夹」。",
    el("button", {
      class: "btn small desktop-action",
      type: "button",
      title: "留存的原图在程序文件夹的 store/media-objects 里，文件名是图片的编号（md5），不好认；找图还是在这一页方便",
      onclick: () => api("/api/storage/open", { method: "POST", body: JSON.stringify({ category: "knowledge-media" }) })
        .catch(() => alert("还没有留存过原图，所以还没有这个文件夹。")),
    }, "打开留存文件夹"))
  : null);

const galleryKeptEmptyText = () => [
  "这个范围里还没有留存的原图。",
  el("br"),
  el("span", { class: "kb-meta" }, "点开一张图按「留存原图」，或「多选」后一起留存；在「设置 → 群图片」还可以让某些群每张都留。"),
];

// From another page (the chat's picture viewer): straight to the library.
const openGalleryKept = () => {
  replaceGallery({
    ...galleryKeptPatch(true),
    groupId: "", sender: "", senderLabel: "", q: "", shape: "", size: "", ai: false, prompt: false, asked: false, file: false,
    kind: "images", detail: null,
  });
  showView("media");
  galleryNav.dismissed = false;
  loadGallerySaveTarget();
  loadGallery();
};

// Pictures kept just now get their mark without reloading the wall.
const markGalleryKept = (md5s) => {
  const kept = new Set(md5s);
  const results = app.gallery.results;
  if (kept.size === 0 || results === null) {
    return;
  }
  replaceGallery({
    results: { ...results, items: results.items.map((item) => (kept.has(item.md5) ? { ...item, kept: true } : item)) },
    facetsKey: "",
  });
  wallSetEntries(GALLERY_WALL_KEY, galleryEntries());
  wallRepaint(GALLERY_WALL_KEY);
  loadGalleryFacets();
};

const keepGallerySelection = () => runPictureKeep([...app.gallery.selected], "gallery", markGalleryKept);
