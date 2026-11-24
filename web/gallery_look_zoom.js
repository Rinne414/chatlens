"use strict";

/* ---------- 画廊: looking closer in the 大图 and in a picture's window ----------
   Both use picture_zoom.js. In the 大图 a click beside the picture closes it
   and another picture starts whole again. In a picture's window the wheel
   zooms the picture on the left; while it is whole it can still be dragged
   out to a folder, a close-up is dragged about instead. The first close-up
   of a picture brings in its original (a close-up of the preview is blurry). */

// Pictures whose original has arrived (shown instead of the preview from then
// on) and the ones it was asked for.
const galleryLookOriginals = { ready: new Set(), asked: new Set() };

// Asked for once per picture. The original goes through the same store as
// 「看原图」; when it cannot be had the preview simply stays.
const wantGalleryOriginal = (md5, arrived) => {
  const item = (app.gallery.results?.items ?? []).find((candidate) => candidate.md5 === md5) ?? app.gallery.detail?.item ?? null;
  if (md5 === null || galleryLookOriginals.asked.has(md5) || (item !== null && item.md5 === md5 && ((item.gone && !item.kept) || item.fileName))) {
    return;
  }
  galleryLookOriginals.asked.add(md5);
  const original = new Image();
  original.onload = () => {
    galleryLookOriginals.ready.add(md5);
    arrived(original.src);
  };
  original.src = pictureUrl(md5, "original");
};

/* --- 大图 --- */

const galleryLookImage = () => document.querySelector("#quick-look .quick-look-image");

const galleryLookZoomer = pictureZoomer({
  image: galleryLookImage,
  frame: (node) => node.closest(".quick-look"),
  onCloser: () => {
    const md5 = galleryQuickLook.md5;
    wantGalleryOriginal(md5, (src) => {
      const image = galleryLookImage();
      if (galleryQuickLook.md5 === md5 && image !== null) {
        image.src = src;
      }
    });
  },
});
// The 大图's zoom as it is now (scale 1 = whole).
const galleryLookZoom = galleryLookZoomer.state;
const resetGalleryLookZoom = galleryLookZoomer.reset;

const clickGalleryQuickLook = (event) => {
  if (event.target.closest("button") !== null) {
    return;
  }
  if (event.target.closest(".quick-look-image") === null) {
    dismissGalleryQuickLook();
    return;
  }
  if (!galleryLookZoomer.wasDragged()) {
    galleryLookZoomer.toggleAt(event);
  }
};

// The small one shows at once; the big one draws over it when it has arrived.
const galleryQuickLookImage = (md5) => {
  const image = el("img", {
    class: "quick-look-image",
    src: pictureUrl(md5, galleryLookOriginals.ready.has(md5) ? "original" : "preview"),
    alt: "",
    draggable: "false",
    style: `background-image:url("${pictureUrl(md5, "thumb")}")`,
    onpointerdown: galleryLookZoomer.dragStart,
    onpointermove: galleryLookZoomer.dragMove,
    onpointerup: galleryLookZoomer.dragEnd,
    onpointercancel: galleryLookZoomer.dragEnd,
  });
  // The 大图 is drawn again when a line under it changes: the picture stays as it was.
  galleryLookZoomer.apply(image);
  return image;
};

/* --- the picture in its window --- */

const galleryDetailPicture = () => document.querySelector("#gallery-detail-layer .kb-overlay-image");

// md5: the picture the zoom belongs to (another picture starts whole).
const galleryDetailLook = { md5: null };

const galleryDetailZoomer = pictureZoomer({
  image: galleryDetailPicture,
  frame: (node) => node.closest(".kb-overlay-media"),
  // Whole, it is dragged out to a folder; a close-up is dragged about.
  onChange: (node, scale) => {
    node.draggable = scale === 1;
  },
  onCloser: () => {
    const md5 = app.gallery.detail?.md5 ?? null;
    if (app.gallery.detail?.size !== "preview") {
      return;
    }
    // The window is told once the original is here, so the preview stays on screen until then.
    wantGalleryOriginal(md5, () => {
      if (app.gallery.detail?.md5 === md5) {
        galleryDetailPatch(md5, { size: "original" });
      }
    });
  },
});

// Put on the window's picture each time it is drawn (gallery_detail.js).
const zoomableGalleryDetailImage = (image, md5) => {
  if (galleryDetailLook.md5 !== md5) {
    galleryDetailLook.md5 = md5;
    Object.assign(galleryDetailZoomer.state, { scale: 1, x: 0, y: 0, drag: null, dragged: false });
  }
  image.addEventListener("pointerdown", galleryDetailZoomer.dragStart);
  image.addEventListener("pointermove", galleryDetailZoomer.dragMove);
  image.addEventListener("pointerup", galleryDetailZoomer.dragEnd);
  image.addEventListener("pointercancel", galleryDetailZoomer.dragEnd);
  image.addEventListener("click", (event) => {
    if (!galleryDetailZoomer.wasDragged()) {
      galleryDetailZoomer.toggleAt(event);
    }
  });
  galleryDetailZoomer.apply(image);
  return image;
};

/* --- the wheel --- */

// Over the 大图 anywhere, and over the picture in its window: the wheel zooms
// and the page behind stays where it is. Elsewhere it scrolls as always.
document.addEventListener("wheel", (event) => {
  if (app.view !== "media") {
    return;
  }
  if (galleryQuickLook.md5 !== null && event.target.closest?.("#quick-look")) {
    galleryLookZoomer.wheel(event);
  } else if (app.gallery.detail !== null && event.target.closest?.("#gallery-detail-layer .kb-overlay-media")) {
    galleryDetailZoomer.wheel(event);
  }
}, { passive: false });
