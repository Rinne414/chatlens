"use strict";

/* ---------- 画廊: 并排看 (two to four pictures of the 托盘 side by side) ----------
   For telling near-identical pictures apart before saving: the selected
   pictures next to each other, each as large as its share of the screen
   allows. One can be taken out of the 托盘 right there; with one left there
   is nothing to compare and it closes. */

const GALLERY_COMPARE_MIN = 2;
const GALLERY_COMPARE_MAX = 4;

const galleryCompare = { open: false };

const canCompareGallery = () => app.gallery.selected.size >= GALLERY_COMPARE_MIN && app.gallery.selected.size <= GALLERY_COMPARE_MAX;

const closeGalleryCompare = () => {
  galleryCompare.open = false;
  document.getElementById("gallery-compare")?.remove();
};

// 关闭, Esc, C or a click beside the pictures: back closes it the same way.
const dismissGalleryCompare = () => dismissOverlay(closeGalleryCompare);

// Who sent it and how large it is, when the wall has the picture loaded.
const galleryCompareCaption = (md5) => {
  const item = (app.gallery.results?.items ?? []).find((candidate) => candidate.md5 === md5) ?? null;
  if (item === null) {
    return "";
  }
  const shown = item.shown ?? item.origin;
  return [shown?.speaker ?? "", item.width > 0 ? `${item.width}×${item.height}` : "", item.size > 0 ? formatByteSize(item.size) : ""]
    .filter((part) => part !== "").join(" · ");
};

const takeOutOfGalleryCompare = (md5) => {
  unselectGalleryPicture(md5);
  if (app.gallery.selected.size < GALLERY_COMPARE_MIN) {
    dismissGalleryCompare();
    return;
  }
  renderGalleryCompare();
};

const renderGalleryCompare = () => {
  document.getElementById("gallery-compare")?.remove();
  if (!galleryCompare.open) {
    return;
  }
  const md5s = [...app.gallery.selected].slice(0, GALLERY_COMPARE_MAX);
  const key = (label) => el("kbd", { class: "tray-key" }, label);
  document.body.append(el("div", {
    id: "gallery-compare", class: "gallery-compare", role: "dialog", "aria-label": "并排看",
    onclick: (event) => {
      if (event.target.closest("button, img") === null) {
        dismissGalleryCompare();
      }
    },
  },
  el("div", { class: "gallery-compare-grid", style: `grid-template-columns: repeat(${md5s.length}, minmax(0, 1fr))` },
    md5s.map((md5) => el("figure", { class: "gallery-compare-item" },
      el("img", { src: pictureUrl(md5, "preview"), alt: "", draggable: "false", style: `background-image:url("${pictureUrl(md5, "thumb")}")` }),
      el("figcaption", {},
        el("span", {}, galleryCompareCaption(md5)),
        el("button", { class: "btn small", type: "button", onclick: () => takeOutOfGalleryCompare(md5) }, "拿出托盘"))))),
  el("div", { class: "quick-look-bar" },
    el("span", {}, `并排看 ${md5s.length} 张`),
    el("span", { class: "quick-look-keys" }, key("C"), " 或 ", key("Esc"), " 关闭"))));
};

const openGalleryCompare = () => {
  if (!canCompareGallery()) {
    return;
  }
  galleryCompare.open = true;
  renderGalleryCompare();
  openOverlayEntry({ kind: "gallery-compare", key: [...app.gallery.selected].join(",") }, closeGalleryCompare);
};

// The button in the 托盘's row (gallery.js).
const galleryCompareButton = () => el("button", {
  class: "btn small",
  type: "button",
  disabled: !canCompareGallery(),
  title: canCompareGallery() ? "把托盘里这几张并排放大看（C）" : `托盘里有 ${GALLERY_COMPARE_MIN} 到 ${GALLERY_COMPARE_MAX} 张时可以并排看`,
  onclick: openGalleryCompare,
}, "并排看");

VIEW_LEAVE_HOOKS.push(closeGalleryCompare);

// Loaded before the wall's own keys: while the pictures are side by side no
// key reaches the wall behind them.
document.addEventListener("keydown", (event) => {
  if (app.view !== "media") {
    return;
  }
  // The search palette, a dialog or a text box above it keep their own keys.
  const above = paletteState.open || document.querySelector(".cc-dialog-layer") !== null || galleryTypingFocus();
  if (galleryCompare.open && !above && event.ctrlKey && ["a", "A", "z", "Z"].includes(event.key)) {
    // Not for the wall behind the pictures.
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (above || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return;
  }
  const isC = event.key === "c" || event.key === "C";
  if (galleryCompare.open) {
    // The key list still opens and closes over it.
    if (event.key === "?" || (event.key === "/" && event.shiftKey) || (event.key === "Escape" && keyHelp.node !== null)) {
      return;
    }
    event.stopImmediatePropagation();
    if (event.key === "Escape" || isC) {
      event.preventDefault();
      if (!event.repeat) {
        dismissGalleryCompare();
      }
    }
    return;
  }
  if (isC && !event.repeat && canCompareGallery() && app.gallery.selecting
    && galleryQuickLook.md5 === null && app.gallery.detail === null && pictureUi.viewer === null
    && document.querySelector(".view-layer") === null) {
    event.preventDefault();
    openGalleryCompare();
  }
}, true);
