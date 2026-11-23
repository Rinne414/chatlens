"use strict";

/* ---------- 画廊 大图: closer, and moved about ----------
   The wheel makes the picture bigger or smaller around the mouse, a click on
   it goes between whole and close-up, and a close-up is dragged about. A click
   beside the picture closes the 大图. Another picture starts whole again. */

const LOOK_ZOOM_MAX = 8;
const LOOK_ZOOM_WHEEL = 0.0016;
const LOOK_WHEEL_LINE = 33;
// A close-up may be pushed this far past the edge of the screen, no further.
const LOOK_ZOOM_SLACK = 60;
// Moving less than this between press and release is a click, not a drag.
const LOOK_DRAG_START = 4;

const galleryLookZoom = { scale: 1, x: 0, y: 0, drag: null, dragged: false };
// Pictures whose original has arrived (shown instead of the preview from then
// on) and the ones it was asked for: a close-up of the preview alone is blurry.
const galleryLookOriginals = { ready: new Set(), asked: new Set() };

// Asked for once per picture, the first time it is looked at closer. The
// original goes through the same store as 「看原图」; when it cannot be had
// the preview simply stays.
const wantGalleryLookOriginal = () => {
  const md5 = galleryQuickLook.md5;
  const item = (app.gallery.results?.items ?? []).find((candidate) => candidate.md5 === md5) ?? null;
  if (md5 === null || galleryLookOriginals.asked.has(md5) || (item !== null && item.gone && !item.kept)) {
    return;
  }
  galleryLookOriginals.asked.add(md5);
  const original = new Image();
  original.onload = () => {
    galleryLookOriginals.ready.add(md5);
    const image = galleryLookImage();
    if (galleryQuickLook.md5 === md5 && image !== null) {
      image.src = original.src;
    }
  };
  original.src = pictureUrl(md5, "original");
};

const galleryLookImage = () => document.querySelector("#quick-look .quick-look-image");

const applyGalleryLookZoom = (image = galleryLookImage()) => {
  if (image === null) {
    return;
  }
  const { scale, x, y } = galleryLookZoom;
  image.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
  image.classList.toggle("zoomed", scale > 1);
  image.classList.toggle("dragging", galleryLookZoom.drag !== null);
};

const resetGalleryLookZoom = () => {
  Object.assign(galleryLookZoom, { scale: 1, x: 0, y: 0, drag: null, dragged: false });
  applyGalleryLookZoom();
};

// The interface can be shown larger or smaller (界面大小): the mouse reports
// screen pixels, the picture is moved in the page's own.
const galleryLookScreenRatio = (image) => {
  const shown = image.getBoundingClientRect().width;
  const own = image.offsetWidth * galleryLookZoom.scale;
  return shown > 0 && own > 0 ? shown / own : 1;
};

// How far the picture may be moved at this size: its edge stays near the screen's.
const clampGalleryLookPan = (image, scale, x, y) => {
  const frame = image.closest(".quick-look");
  const limit = (size, room) => Math.max(0, (size * scale - room) / 2 + LOOK_ZOOM_SLACK);
  const maxX = limit(image.offsetWidth, frame?.offsetWidth ?? window.innerWidth);
  const maxY = limit(image.offsetHeight, frame?.offsetHeight ?? window.innerHeight);
  return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
};

// The point under the mouse stays under the mouse while the size changes.
const zoomGalleryLookAt = (clientX, clientY, wanted) => {
  const image = galleryLookImage();
  if (image === null) {
    return;
  }
  const scale = Math.min(LOOK_ZOOM_MAX, Math.max(1, wanted));
  if (scale === 1) {
    resetGalleryLookZoom();
    return;
  }
  const box = image.getBoundingClientRect();
  const screen = galleryLookScreenRatio(image);
  // The mouse, measured from where the picture's middle sits when it has not been moved.
  const pointX = (clientX - box.left - box.width / 2) / screen + galleryLookZoom.x;
  const pointY = (clientY - box.top - box.height / 2) / screen + galleryLookZoom.y;
  const ratio = scale / galleryLookZoom.scale;
  const moved = clampGalleryLookPan(image, scale, pointX - (pointX - galleryLookZoom.x) * ratio, pointY - (pointY - galleryLookZoom.y) * ratio);
  Object.assign(galleryLookZoom, { scale, ...moved });
  applyGalleryLookZoom(image);
  wantGalleryLookOriginal();
};

// A click on the picture: close up at that point (its real pixels when it is
// shown smaller than it is, else twice the size), or whole again.
const toggleGalleryLookZoom = (event) => {
  if (galleryLookZoom.scale > 1) {
    resetGalleryLookZoom();
    return;
  }
  const image = galleryLookImage();
  const shown = image?.getBoundingClientRect().width ?? 0;
  const real = shown > 0 ? image.naturalWidth / shown : 1;
  zoomGalleryLookAt(event.clientX, event.clientY, real > 1.15 ? real : 2);
};

const clickGalleryQuickLook = (event) => {
  if (event.target.closest("button") !== null) {
    return;
  }
  if (event.target.closest(".quick-look-image") === null) {
    dismissGalleryQuickLook();
    return;
  }
  // The release that ends a drag is not a click on the picture.
  if (galleryLookZoom.dragged) {
    galleryLookZoom.dragged = false;
    return;
  }
  toggleGalleryLookZoom(event);
};

const startGalleryLookDrag = (event) => {
  if (event.button !== 0) {
    return;
  }
  galleryLookZoom.dragged = false;
  if (galleryLookZoom.scale === 1) {
    return;
  }
  event.preventDefault();
  galleryLookZoom.drag = {
    pointerId: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: galleryLookZoom.x, y: galleryLookZoom.y,
    screen: galleryLookScreenRatio(event.currentTarget),
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  applyGalleryLookZoom(event.currentTarget);
};

const moveGalleryLookDrag = (event) => {
  const drag = galleryLookZoom.drag;
  if (drag === null || drag.pointerId !== event.pointerId) {
    return;
  }
  const byX = event.clientX - drag.fromX;
  const byY = event.clientY - drag.fromY;
  if (!galleryLookZoom.dragged && Math.hypot(byX, byY) < LOOK_DRAG_START) {
    return;
  }
  galleryLookZoom.dragged = true;
  Object.assign(galleryLookZoom, clampGalleryLookPan(event.currentTarget, galleryLookZoom.scale, drag.x + byX / drag.screen, drag.y + byY / drag.screen));
  applyGalleryLookZoom(event.currentTarget);
};

const endGalleryLookDrag = (event) => {
  if (galleryLookZoom.drag?.pointerId !== event.pointerId) {
    return;
  }
  galleryLookZoom.drag = null;
  applyGalleryLookZoom(event.currentTarget);
};

// The small one shows at once; the big one draws over it when it has arrived.
const galleryQuickLookImage = (md5) => {
  const image = el("img", {
    class: "quick-look-image",
    src: pictureUrl(md5, galleryLookOriginals.ready.has(md5) ? "original" : "preview"),
    alt: "",
    draggable: "false",
    style: `background-image:url("${pictureUrl(md5, "thumb")}")`,
    onpointerdown: startGalleryLookDrag,
    onpointermove: moveGalleryLookDrag,
    onpointerup: endGalleryLookDrag,
    onpointercancel: endGalleryLookDrag,
  });
  // The 大图 is drawn again when a line under it changes: the picture stays as it was.
  applyGalleryLookZoom(image);
  return image;
};

// The wheel belongs to the 大图 while it is open: the wall behind stays where it is.
document.addEventListener("wheel", (event) => {
  if (galleryQuickLook.md5 === null || event.target.closest?.("#quick-look") === null || event.target.closest?.("#quick-look") === undefined) {
    return;
  }
  event.preventDefault();
  if (event.deltaY === 0) {
    return;
  }
  // Some mice report lines instead of pixels.
  const pixels = event.deltaMode === 1 ? event.deltaY * LOOK_WHEEL_LINE : event.deltaY;
  zoomGalleryLookAt(event.clientX, event.clientY, galleryLookZoom.scale * Math.exp(-pixels * LOOK_ZOOM_WHEEL));
}, { passive: false });
