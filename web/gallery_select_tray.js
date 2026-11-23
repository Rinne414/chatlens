"use strict";

/* ---------- 画廊: 托盘 (what is selected), 大图 (one picture, big), and their keys ----------
   托盘: while selecting, a strip of the selected pictures, so it is seen what
   is about to be saved; one can be looked at big or taken out again.
   大图: the picture under the mouse (or one in the 托盘) alone on the screen,
   without leaving the wall or changing the selection.
   Keys on the wall: 空格 = 大图 of the picture under the mouse, O = its
   window with everything about it, X = select / unselect it. */

const galleryHover = { md5: null };
const galleryQuickLook = { md5: null };

const galleryIndexOf = (md5) => (app.gallery.results?.items ?? []).findIndex((item) => item.md5 === md5);

const unselectGalleryPicture = (md5) => {
  const next = new Set(app.gallery.selected);
  next.delete(md5);
  replaceGallery({ selected: next });
  refreshGallerySelection();
};

/* --- 托盘 --- */

const gallerySelectedTray = () => {
  const md5s = [...app.gallery.selected];
  if (md5s.length === 0) {
    return el("div", { class: "select-tray empty" }, el("span", { class: "kb-meta" }, "托盘是空的：点图片把它放进来。"));
  }
  return el("div", { class: "select-tray", role: "list", "aria-label": `托盘：已选的 ${md5s.length} 张` },
    md5s.map((md5) => el("div", { class: "select-tray-item", role: "listitem" },
      el("button", { class: "select-tray-thumb", type: "button", title: "看大图", onclick: () => openGalleryQuickLook(md5) },
        el("img", { src: pictureUrl(md5, "thumb"), alt: "", loading: "lazy", decoding: "async" })),
      el("button", { class: "select-tray-remove", type: "button", "aria-label": "从托盘拿出来", title: "从托盘拿出来", onclick: () => unselectGalleryPicture(md5) }, "×"))));
};

/* --- 大图 --- */

const closeGalleryQuickLook = () => {
  galleryQuickLook.md5 = null;
  document.getElementById("quick-look")?.remove();
};

const renderGalleryQuickLook = () => {
  document.getElementById("quick-look")?.remove();
  const md5 = galleryQuickLook.md5;
  if (md5 === null) {
    return;
  }
  const items = app.gallery.results?.items ?? [];
  const index = galleryIndexOf(md5);
  const selected = app.gallery.selected.has(md5);
  const key = (label) => el("kbd", { class: "tray-key" }, label);
  document.body.append(el("div", {
    id: "quick-look", class: "quick-look", role: "dialog", "aria-label": "大图",
    onclick: (event) => {
      if (event.target.closest("button") === null) {
        closeGalleryQuickLook();
      }
    },
  },
  // The small one shows at once; the big one draws over it when it has arrived.
  el("img", { class: "quick-look-image", src: pictureUrl(md5, "preview"), alt: "", style: `background-image:url("${pictureUrl(md5, "thumb")}")` }),
  el("div", { class: "quick-look-bar" },
    index >= 0 ? el("span", {}, `${briefNumber(index + 1)} / ${briefNumber(items.length)}`) : null,
    selected ? el("span", { class: "quick-look-picked" }, "在托盘里") : null,
    el("span", { class: "quick-look-keys" },
      key("←"), key("→"), " 换一张 · ", key("X"), selected ? " 拿出托盘 · " : " 放进托盘 · ", key("O"), " 详情 · ", key("空格"), " 关闭"))));
};

const openGalleryQuickLook = (md5) => {
  galleryQuickLook.md5 = md5;
  renderGalleryQuickLook();
};

const stepGalleryQuickLook = (step) => {
  const items = app.gallery.results?.items ?? [];
  const index = galleryIndexOf(galleryQuickLook.md5);
  const next = items[index + step];
  if (index >= 0 && next !== undefined) {
    openGalleryQuickLook(next.md5);
  }
};

// The same as ticking the picture's box: the first one starts the selection.
const toggleGalleryPick = (md5) => {
  const tile = [...document.querySelectorAll("#view-media .wall-tile")].find((node) => node.dataset.md5 === md5) ?? null;
  toggleGallerySelected(md5, app.gallery.selecting ? tile : null);
};

/* --- the mouse and the keys --- */

document.addEventListener("mouseover", (event) => {
  if (app.view !== "media") {
    return;
  }
  const tile = event.target.closest?.("#view-media .wall-tile");
  if (tile?.dataset.md5) {
    galleryHover.md5 = tile.dataset.md5;
  } else if (event.target.closest?.("#view-media .wall") === null || event.target.closest?.("#view-media .wall") === undefined) {
    // Off the wall: nothing is under the mouse any more.
    galleryHover.md5 = event.target.closest?.("#gallery-selection, #quick-look") ? galleryHover.md5 : null;
  }
});

VIEW_LEAVE_HOOKS.push(() => {
  galleryHover.md5 = null;
  closeGalleryQuickLook();
});

const galleryKeyBlocked = (event) => event.ctrlKey || event.metaKey || event.altKey || event.isComposing || paletteState.open
  || isTypingTarget(event.target) || document.querySelector(".cc-dialog-layer") !== null || pictureUi.viewer !== null;

document.addEventListener("keydown", (event) => {
  if (app.view !== "media" || galleryKeyBlocked(event)) {
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const looking = galleryQuickLook.md5;
  if (looking !== null) {
    const actions = {
      " ": closeGalleryQuickLook,
      Escape: closeGalleryQuickLook,
      ArrowLeft: () => stepGalleryQuickLook(-1),
      ArrowRight: () => stepGalleryQuickLook(1),
      x: () => {
        toggleGalleryPick(looking);
        renderGalleryQuickLook();
      },
      o: () => {
        const index = galleryIndexOf(looking);
        closeGalleryQuickLook();
        if (index >= 0) {
          openGalleryDetail(index);
        }
      },
    };
    if (actions[key] !== undefined) {
      // Nothing behind the big picture gets this key.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat || key.startsWith("Arrow")) {
        actions[key]();
      }
    }
    return;
  }
  // On the wall itself: only with a picture under the mouse and nothing opened over the wall.
  const md5 = galleryHover.md5;
  if (md5 === null || event.repeat || app.gallery.detail !== null || document.querySelector(".view-layer") !== null) {
    return;
  }
  if (key === " ") {
    event.preventDefault();
    openGalleryQuickLook(md5);
  } else if (key === "o") {
    const index = galleryIndexOf(md5);
    if (index >= 0) {
      event.preventDefault();
      openGalleryDetail(index);
    }
  } else if (key === "x") {
    event.preventDefault();
    toggleGalleryPick(md5);
  }
}, true);
