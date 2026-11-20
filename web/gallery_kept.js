"use strict";

/* ---------- 画廊:「留存的原图」 ----------
   The pictures whose original this tool holds, as their own place in 画廊:
   one switch away from the group pictures, over all time (a kept original is
   exactly what is still worth finding after 31 days). It is the same wall
   with the kept filter on, so search, groups and multi-select all work. */

const GALLERY_SCOPES = [
  ["all", "全部群图", "后台记下的所有群图片"],
  ["kept", "留存的原图", "原图已经存在本程序里的图，腾讯删掉之后也能看"],
  ["removed", "取消留存的", "你从「留存的原图」里拿出去的图；文件还在，可以放回"],
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
  // 取消留存的 only shows while there are some, or while it is open.
  GALLERY_SCOPES.filter(([scope]) => scope !== "removed" || galleryScope() === "removed" || (keptUi.summary?.removed.count ?? 0) > 0)
    .map(([scope, label, title]) => el("button", {
      class: galleryScope() === scope ? "wall-mode active" : "wall-mode",
      type: "button",
      title,
      "aria-pressed": String(galleryScope() === scope),
      onclick: () => {
        if (galleryScope() !== scope) {
          applyGalleryFilter(galleryScopePatch(scope));
        }
      },
    }, label)));

const galleryKeptEmptyText = () => [
  "这个范围里还没有留存的原图。",
  el("br"),
  el("span", { class: "kb-meta" }, linked("点开一张图按「留存原图」，或「多选」后一起留存；在「设置 → 群图片」还可以让某些群每张都留。备份页可以一次留存所有快过期的 AI 原图。")),
];

// From another page (the chat's picture viewer): straight to the library.
const openGalleryKept = () => {
  replaceGallery({
    ...galleryKeptPatch(true),
    removed: false, why: "",
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
