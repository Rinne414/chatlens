"use strict";

/* ---------- 画廊: the whole picture beside the one the mouse rests on ----------
   A tile is small and may be cropped. When the mouse stays on one for a
   moment, the whole picture is shown large beside it, without a click; it
   goes away as soon as the mouse leaves, the page scrolls, or anything is
   pressed. Not on touch screens (there is no resting mouse). */

// Long enough that moving across the wall shows nothing.
const GALLERY_HOVER_DELAY_MS = 350;
// The share of the screen the picture may take, and the gap to its tile.
const GALLERY_HOVER_MAX_WIDTH = 0.4;
const GALLERY_HOVER_MAX_HEIGHT = 0.82;
// A small picture is not blown up past this many times its own pixels.
const GALLERY_HOVER_MAX_ENLARGE = 1.5;
// A tile that already shows the whole picture nearly this large needs no preview.
const GALLERY_HOVER_WORTH = 1.3;
const GALLERY_HOVER_CROP_TOLERANCE = 0.06;
const GALLERY_HOVER_GAP = 14;
const GALLERY_HOVER_EDGE = 10;

const galleryHoverPreview = { md5: null, timer: null };

const hideGalleryHoverPreview = () => {
  clearTimeout(galleryHoverPreview.timer);
  galleryHoverPreview.timer = null;
  galleryHoverPreview.md5 = null;
  document.getElementById("gallery-hover-preview")?.remove();
};

const galleryHoverAllowed = () => app.view === "media" && window.matchMedia("(hover: hover)").matches
  && galleryQuickLook.md5 === null && app.gallery.detail === null && !pictureTrays.dragging
  && document.querySelector(".view-layer, .cc-dialog-layer, #gallery-compare") === null;

// Where the picture goes: as large as allowed, on the side of the tile with
// more room, level with the tile but inside the screen. Screen pixels.
const galleryHoverBox = (tile, ratio, realWidth) => {
  const at = tile.getBoundingClientRect();
  const roomRight = window.innerWidth - at.right - GALLERY_HOVER_GAP - GALLERY_HOVER_EDGE;
  const roomLeft = at.left - GALLERY_HOVER_GAP - GALLERY_HOVER_EDGE;
  const right = roomRight >= roomLeft;
  const maxHeight = window.innerHeight * GALLERY_HOVER_MAX_HEIGHT;
  const maxWidth = Math.min(window.innerWidth * GALLERY_HOVER_MAX_WIDTH, right ? roomRight : roomLeft);
  const width = Math.min(maxWidth, maxHeight / ratio, realWidth > 0 ? realWidth * GALLERY_HOVER_MAX_ENLARGE : Infinity);
  const height = width * ratio;
  const cropped = Math.abs((at.height / Math.max(1, at.width)) / ratio - 1) > GALLERY_HOVER_CROP_TOLERANCE;
  if (!cropped && width < at.width * GALLERY_HOVER_WORTH) {
    return null;
  }
  const top = Math.min(Math.max(at.top + at.height / 2 - height / 2, GALLERY_HOVER_EDGE), window.innerHeight - height - GALLERY_HOVER_EDGE);
  return { left: right ? at.right + GALLERY_HOVER_GAP : at.left - GALLERY_HOVER_GAP - width, top, width, height };
};

const showGalleryHoverPreview = (md5) => {
  const tile = [...document.querySelectorAll("#view-media .wall-tile")].find((node) => node.dataset.md5 === md5) ?? null;
  const item = (app.gallery.results?.items ?? []).find((candidate) => candidate.md5 === md5) ?? null;
  if (tile === null || item === null || !galleryHoverAllowed() || !tile.matches(":hover")) {
    return;
  }
  document.getElementById("gallery-hover-preview")?.remove();
  const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : tile.offsetHeight / Math.max(1, tile.offsetWidth);
  const box = galleryHoverBox(tile, ratio, item.width);
  if (box === null) {
    return;
  }
  // The page may be shown larger or smaller (界面大小): its own pixels are the screen's divided by that.
  const zoom = wallZoom();
  const px = (value) => `${value / zoom}px`;
  document.body.append(el("div", {
    id: "gallery-hover-preview", class: "gallery-hover-preview", "aria-hidden": "true",
    style: `left:${px(box.left)};top:${px(box.top)};width:${px(box.width)};height:${px(box.height)}`,
  },
  // The small one shows at once; the bigger one draws over it when it has arrived.
  el("img", { src: pictureUrl(md5, item.sticker ? "original" : "preview"), alt: "", style: `background-image:url("${pictureUrl(md5, "thumb")}")` })));
};

document.addEventListener("mouseover", (event) => {
  if (app.view !== "media") {
    return;
  }
  const md5 = event.target.closest?.("#view-media .wall-tile")?.dataset.md5 ?? null;
  if (md5 === galleryHoverPreview.md5) {
    return;
  }
  hideGalleryHoverPreview();
  if (md5 !== null && galleryHoverAllowed()) {
    galleryHoverPreview.md5 = md5;
    galleryHoverPreview.timer = setTimeout(() => showGalleryHoverPreview(md5), GALLERY_HOVER_DELAY_MS);
  }
});

// Anything done with the picture or the page takes the preview away.
for (const type of ["scroll", "keydown", "mousedown", "dragstart", "wheel", "blur"]) {
  window.addEventListener(type, hideGalleryHoverPreview, { capture: true, passive: true });
}
document.addEventListener("mouseleave", hideGalleryHoverPreview);
VIEW_LEAVE_HOOKS.push(hideGalleryHoverPreview);
