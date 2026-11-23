"use strict";

/* ---------- 画廊: the arrow keys on the wall, and seeing a Shift range before the click ----------
   ← → ↑ ↓ move a frame from picture to picture (Home / End: the first / last
   one loaded); 空格, O, X and Enter then act on the framed picture as they do
   on the one under the mouse. With Shift the pictures passed over go into the
   托盘. Moving the mouse takes the frame away again.
   While Shift is held during a selection, the pictures a click would add are
   tinted before the click. */

const GALLERY_CURSOR_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
// How many frames a far jump may take to bring the framed picture into the page.
const GALLERY_REVEAL_TRIES = 8;
// Room kept above a picture jumped to, for the bar that stays at the top.
const GALLERY_REVEAL_TOP = 160;

// md5: the framed picture. range: [from, to] item indexes a Shift click would add.
const galleryCursor = { md5: null, range: null };

// What 空格 / O / X act on: the framed picture, else the one under the mouse.
const galleryCurrentMd5 = () => galleryCursor.md5 ?? galleryHover.md5;

const galleryTileOf = (md5) =>
  [...document.querySelectorAll("#view-media .wall-tile")].find((node) => node.dataset.md5 === md5) ?? null;

const paintGalleryCursor = () => {
  for (const node of document.querySelectorAll("#view-media .wall-tile.cursor")) {
    node.classList.remove("cursor");
  }
  if (galleryCursor.md5 !== null) {
    galleryTileOf(galleryCursor.md5)?.classList.add("cursor");
  }
};

const inGalleryRange = (index) => galleryCursor.range !== null && index >= galleryCursor.range[0] && index <= galleryCursor.range[1];

const paintGalleryRange = () => {
  for (const node of document.querySelectorAll("#view-media .wall-tile")) {
    node.classList.toggle("range-preview", inGalleryRange(Number(node.dataset.index)));
  }
};

const setGalleryRange = (range) => {
  const same = (galleryCursor.range === null && range === null)
    || (galleryCursor.range !== null && range !== null && galleryCursor.range[0] === range[0] && galleryCursor.range[1] === range[1]);
  if (!same) {
    galleryCursor.range = range;
    paintGalleryRange();
  }
};

// Called for every tile the wall draws (gallery.js).
const markGalleryTile = (tile, item, index) => {
  tile.dataset.index = String(index);
  tile.classList.toggle("cursor", item.md5 === galleryCursor.md5);
  tile.classList.toggle("range-preview", inGalleryRange(index));
};

const clearGalleryCursor = () => {
  if (galleryCursor.md5 !== null) {
    galleryCursor.md5 = null;
    paintGalleryCursor();
  }
};

/* --- where the frame goes --- */

// The picture straight above or below: the nearest one whose width covers the
// framed picture's middle, else simply the nearest.
const galleryCursorVertical = (md5, down) => {
  const entries = galleryEntries();
  const boxes = wallBoxes(GALLERY_WALL_KEY);
  const own = entries.findIndex((entry) => entry.kind === "tile" && entry.item.md5 === md5);
  if (boxes === null || own < 0 || boxes[own] === undefined) {
    return null;
  }
  const from = boxes[own];
  const middle = from.x + from.w / 2;
  let best = null;
  for (const [index, entry] of entries.entries()) {
    const box = boxes[index];
    if (entry.kind !== "tile" || box === undefined || index === own) {
      continue;
    }
    const gap = down ? box.y - (from.y + from.h) : from.y - (box.y + box.h);
    if (gap < -1) {
      continue;
    }
    const covers = box.x <= middle && middle <= box.x + box.w;
    const aside = Math.abs(box.x + box.w / 2 - middle);
    const score = [covers ? 0 : 1, gap, aside];
    if (best === null || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
      best = { md5: entry.item.md5, score };
    }
  }
  return best?.md5 ?? null;
};

const galleryCursorTarget = (md5, key) => {
  const items = app.gallery.results?.items ?? [];
  if (key === "Home") {
    return items[0]?.md5 ?? null;
  }
  if (key === "End") {
    return items.at(-1)?.md5 ?? null;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    return galleryCursorVertical(md5, key === "ArrowDown");
  }
  const index = items.findIndex((item) => item.md5 === md5);
  return index < 0 ? null : items[index + (key === "ArrowRight" ? 1 : -1)]?.md5 ?? null;
};

// With nothing framed and nothing under the mouse: the first picture on screen.
const galleryCursorStart = () => {
  const entries = galleryEntries();
  const top = wallTopIndex(GALLERY_WALL_KEY) ?? 0;
  return entries.slice(top).find((entry) => entry.kind === "tile")?.item.md5 ?? null;
};

/* --- bringing the framed picture into view --- */

// Near pictures are in the page already; a far one (Home, End) is not drawn
// until the page is near it, so the page is moved towards it first.
const revealGalleryCursor = (tries = GALLERY_REVEAL_TRIES) => {
  const md5 = galleryCursor.md5;
  if (md5 === null) {
    return;
  }
  const node = galleryTileOf(md5);
  if (node !== null) {
    node.scrollIntoView({ block: "nearest" });
    paintGalleryCursor();
    return;
  }
  const wall = document.querySelector("#view-media .wall");
  const boxes = wallBoxes(GALLERY_WALL_KEY);
  const entry = galleryEntries().findIndex((candidate) => candidate.kind === "tile" && candidate.item.md5 === md5);
  if (tries <= 0 || wall === null || boxes === null || entry < 0 || boxes[entry] === undefined) {
    return;
  }
  window.scrollBy(0, wall.getBoundingClientRect().top + boxes[entry].y * wallZoom() - GALLERY_REVEAL_TOP);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (galleryCursor.md5 === md5) {
      revealGalleryCursor(tries - 1);
    }
  }));
};

const setGalleryCursor = (md5) => {
  galleryCursor.md5 = md5;
  paintGalleryCursor();
  revealGalleryCursor();
};

/* --- Shift + arrows: what is passed over goes into the 托盘 --- */

const extendGallerySelection = (fromMd5, toMd5) => {
  const items = app.gallery.results?.items ?? [];
  const from = items.findIndex((item) => item.md5 === fromMd5);
  const to = items.findIndex((item) => item.md5 === toMd5);
  if (from < 0 || to < 0) {
    return;
  }
  const anchor = app.gallery.selecting && app.gallery.lastPicked !== null ? app.gallery.lastPicked : from;
  const picked = items.slice(Math.min(anchor, to), Math.max(anchor, to) + 1);
  if (!app.gallery.selecting) {
    replaceGallery({ selecting: true, lastPicked: anchor, selected: new Set([...app.gallery.selected, ...picked.map((item) => item.md5)]) });
    renderMediaView();
    return;
  }
  replaceGallery({ lastPicked: anchor });
  selectGalleryItems(picked);
};

const moveGalleryCursor = async (key, extend) => {
  const from = galleryCurrentMd5() ?? (key === "Home" || key === "End" ? galleryCursorStart() : null);
  if (from === null) {
    const start = galleryCursorStart();
    if (start !== null) {
      setGalleryCursor(start);
    }
    return;
  }
  let target = galleryCursorTarget(from, key);
  // At the last loaded picture: the next page, then on.
  if (target === null && (key === "ArrowRight" || key === "ArrowDown") && await loadGalleryNextPage() && galleryCurrentMd5() === from) {
    target = galleryCursorTarget(from, key);
  }
  if (target === null) {
    // Nothing further that way: the frame at least shows where the keys are.
    setGalleryCursor(from);
    return;
  }
  if (extend) {
    extendGallerySelection(from, target);
  }
  setGalleryCursor(target);
};

/* --- keys and mouse --- */

const galleryWallKeysFree = (event) => app.view === "media" && !event.ctrlKey && !galleryKeyBlocked(event)
  && galleryQuickLook.md5 === null && app.gallery.detail === null && document.querySelector(".view-layer") === null
  && document.getElementById("gallery-compare") === null
  // A slider or a radio in focus keeps its own arrow keys.
  && !(document.activeElement?.tagName === "INPUT" && ["range", "radio"].includes(document.activeElement.type));

document.addEventListener("keydown", (event) => {
  if (!galleryWallKeysFree(event) || (app.gallery.results?.items.length ?? 0) === 0) {
    return;
  }
  if (GALLERY_CURSOR_KEYS.has(event.key)) {
    event.preventDefault();
    moveGalleryCursor(event.key, event.shiftKey);
    return;
  }
  if (event.key === "Enter" && galleryCursor.md5 !== null && !event.repeat) {
    const index = galleryIndexOf(galleryCursor.md5);
    if (index >= 0) {
      event.preventDefault();
      openGalleryDetail(index);
    }
    return;
  }
  // Shift pressed with the mouse resting on a picture: the range shows at once.
  if (event.key === "Shift") {
    previewGalleryRange(galleryHover.md5 === null ? -1 : galleryIndexOf(galleryHover.md5), true);
  }
}, true);

// index: the picture a Shift click would end on (-1 = none).
const previewGalleryRange = (index, shift) => {
  const anchor = app.gallery.lastPicked;
  const on = shift && app.gallery.selecting && anchor !== null && index >= 0;
  setGalleryRange(on ? [Math.min(anchor, index), Math.max(anchor, index)] : null);
};

document.addEventListener("mousemove", (event) => {
  if (app.view !== "media") {
    return;
  }
  // The mouse really moved (a wall scrolling under a resting mouse does not count).
  if (event.movementX !== 0 || event.movementY !== 0) {
    clearGalleryCursor();
  }
  const tile = event.target.closest?.("#view-media .wall-tile");
  previewGalleryRange(tile?.dataset.index === undefined ? -1 : Number(tile.dataset.index), event.shiftKey);
});

document.addEventListener("keyup", (event) => {
  if (event.key === "Shift") {
    setGalleryRange(null);
  }
});
window.addEventListener("blur", () => setGalleryRange(null));

VIEW_LEAVE_HOOKS.push(() => {
  galleryCursor.md5 = null;
  galleryCursor.range = null;
});
