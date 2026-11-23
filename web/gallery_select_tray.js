"use strict";

/* ---------- 画廊: 托盘 (what is selected), 大图 (one picture, big), and their keys ----------
   托盘: while selecting, a strip of the selected pictures, so it is seen what
   is about to be saved; one can be looked at big or taken out again.
   大图: the picture under the mouse (or one in the 托盘) alone on the screen,
   without leaving the wall or changing the selection.
   Keys on the wall: 空格 = 大图 of the picture under the mouse, O or I = its
   window with everything about it, X = select / unselect it, Ctrl+A = select
   everything loaded. In the 大图 the save keys save the picture shown; with
   Shift they also go on to the next one. */

const galleryHover = { md5: null };
// among: the pictures ← → walk through when the 大图 was opened from the 托盘
// (null = the wall's own order).
const galleryQuickLook = { md5: null, among: null, notice: "" };

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
      el("button", { class: "select-tray-thumb", type: "button", title: "看大图", onclick: () => openGalleryQuickLook(md5, md5s) },
        el("img", { src: pictureUrl(md5, "thumb"), alt: "", loading: "lazy", decoding: "async" })),
      el("button", { class: "select-tray-remove", type: "button", "aria-label": "从托盘拿出来", title: "从托盘拿出来", onclick: () => unselectGalleryPicture(md5) }, "×"))));
};

/* --- 大图 --- */

const closeGalleryQuickLook = () => {
  resetGalleryLookZoom();
  Object.assign(galleryQuickLook, { md5: null, among: null, notice: "" });
  document.getElementById("quick-look")?.remove();
};

// 空格, Esc or a click: back closes it the same way.
const dismissGalleryQuickLook = () => dismissOverlay(closeGalleryQuickLook);

const galleryQuickLookList = () => galleryQuickLook.among ?? (app.gallery.results?.items ?? []).map((item) => item.md5);

const galleryQuickLookCount = (index, list) => {
  if (index < 0) {
    return null;
  }
  if (galleryQuickLook.among !== null) {
    return `托盘里第 ${briefNumber(index + 1)} / ${briefNumber(list.length)} 张`;
  }
  return `${briefNumber(index + 1)} / ${briefNumber(Math.max(app.gallery.results?.total ?? list.length, list.length))}`;
};

const renderGalleryQuickLook = () => {
  document.getElementById("quick-look")?.remove();
  const md5 = galleryQuickLook.md5;
  if (md5 === null) {
    return;
  }
  const list = galleryQuickLookList();
  const selected = app.gallery.selected.has(md5);
  const hasTrays = (pictureTrays.list ?? []).length > 0;
  const key = (label) => el("kbd", { class: "tray-key" }, label);
  document.body.append(el("div", {
    id: "quick-look", class: "quick-look", role: "dialog", "aria-label": "大图",
    onclick: clickGalleryQuickLook,
  },
  // The small one shows at once; the big one draws over it when it has arrived.
  galleryQuickLookImage(md5),
  el("div", { class: "quick-look-bar" },
    el("span", {}, galleryQuickLookCount(list.indexOf(md5), list)),
    selected ? el("span", { class: "quick-look-picked" }, "在托盘里") : null,
    galleryQuickLook.notice === "" ? null : el("span", { class: "quick-look-notice", role: "status" }, galleryQuickLook.notice),
    el("span", { class: "quick-look-keys" },
      key("←"), key("→"), " 换一张 · ", key("X"), selected ? " 拿出托盘 · " : " 放进托盘 · ",
      hasTrays ? [trayKeyHint(), " 存这张（按住 ", key("Shift"), " 存完看下一张） · "] : null,
      key("O"), " 详情 · ", key("空格"), " 关闭"))));
};

// among: the md5s to walk through instead of the wall (the 托盘's pictures).
const openGalleryQuickLook = (md5, among = null) => {
  const opening = galleryQuickLook.md5 === null;
  if (md5 !== galleryQuickLook.md5) {
    resetGalleryLookZoom();
  }
  Object.assign(galleryQuickLook, { md5, among: opening ? among : galleryQuickLook.among, notice: opening ? "" : galleryQuickLook.notice });
  renderGalleryQuickLook();
  openOverlayEntry({ kind: "gallery-look", key: md5 }, closeGalleryQuickLook);
};

// → on the last loaded picture of the wall loads the next page first.
const stepGalleryQuickLook = async (step) => {
  const looking = galleryQuickLook.md5;
  const index = galleryQuickLookList().indexOf(looking);
  if (index < 0) {
    return;
  }
  if (step > 0 && index + step >= galleryQuickLookList().length
    && !(galleryQuickLook.among === null && await loadGalleryNextPage() && galleryQuickLook.md5 === looking)) {
    return;
  }
  const next = galleryQuickLookList()[index + step];
  if (next !== undefined) {
    openGalleryQuickLook(next);
  }
};

// S or a number in the 大图: the picture shown, whatever is selected. With
// Shift the next picture comes up while this one is being saved.
const saveGalleryQuickLook = (tray, thenNext) => {
  const md5 = galleryQuickLook.md5;
  const tell = (outcome) => {
    // Said on the 大图 itself while it is open, wherever it has moved on to.
    if (galleryQuickLook.md5 === null) {
      notify(outcome.text, { isError: outcome.failed });
      return;
    }
    galleryQuickLook.notice = outcome.failed || pictureTrays.lastSave === null ? outcome.text : `${outcome.text}（Ctrl+Z 撤销）`;
    renderGalleryQuickLook();
  };
  galleryQuickLook.notice = `正在存到「${tray.name}」…`;
  // (when it is done the line says where it went and that Ctrl+Z takes it back)
  saveToTray([md5], tray.id).then((outcome) => (outcome === "" ? null : tell(outcome)));
  renderGalleryQuickLook();
  if (thenNext) {
    stepGalleryQuickLook(1);
  }
};

// From the 大图 to the picture's window: the 大图's history entry goes first,
// then the window adds its own.
const openDetailFromQuickLook = () => {
  const index = galleryIndexOf(galleryQuickLook.md5);
  dismissGalleryQuickLook();
  if (index < 0) {
    return;
  }
  if (galleryQuickLook.md5 === null) {
    openGalleryDetail(index);
    return;
  }
  window.addEventListener("popstate", () => setTimeout(() => openGalleryDetail(index), 0), { once: true });
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

// A tile's box keeps focus after a click, so only real typing places block the keys.
const galleryKeyBlocked = (event) => event.metaKey || event.altKey || event.isComposing || paletteState.open
  || galleryTypingFocus() || document.querySelector(".cc-dialog-layer") !== null || pictureUi.viewer !== null;

const galleryQuickLookAction = (event, key) => {
  const looking = galleryQuickLook.md5;
  const tray = trayForEvent(event);
  if (tray !== null) {
    return () => saveGalleryQuickLook(tray, event.shiftKey);
  }
  return {
    " ": dismissGalleryQuickLook,
    Escape: dismissGalleryQuickLook,
    ArrowLeft: () => stepGalleryQuickLook(-1),
    ArrowRight: () => stepGalleryQuickLook(1),
    x: () => {
      toggleGalleryPick(looking);
      renderGalleryQuickLook();
    },
    o: openDetailFromQuickLook,
    i: openDetailFromQuickLook,
  }[key];
};

// Ctrl+A on the wall: everything loaded so far goes into the 托盘.
const selectAllLoadedGallery = () => {
  const loaded = app.gallery.results?.items ?? [];
  if (loaded.length === 0) {
    return;
  }
  if (!app.gallery.selecting) {
    replaceGallery({ selecting: true, lastPicked: null, selected: new Set(loaded.map((item) => item.md5)) });
    renderMediaView();
    return;
  }
  selectGalleryItems(loaded);
};

document.addEventListener("keydown", (event) => {
  if (app.view !== "media" || galleryKeyBlocked(event)) {
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const nothingOpen = app.gallery.detail === null && document.querySelector(".view-layer") === null;
  if (event.ctrlKey) {
    if (key === "a" && !event.shiftKey && galleryQuickLook.md5 === null && nothingOpen) {
      event.preventDefault();
      if (!event.repeat) {
        selectAllLoadedGallery();
      }
    } else if (key === "z" && !event.shiftKey && pictureTrays.lastSave !== null) {
      // Takes back the last save into a 存图文件夹 (picture_trays.js).
      event.preventDefault();
      if (!event.repeat) {
        undoLastTraySave().then((text) => {
          if (galleryQuickLook.md5 !== null && typeof text === "string") {
            galleryQuickLook.notice = text;
            renderGalleryQuickLook();
          }
        });
      }
    }
    return;
  }
  if (galleryQuickLook.md5 !== null) {
    // The key list is the top layer while it is open: its Esc goes to it.
    const action = key === "Escape" && keyHelp.node !== null ? undefined : galleryQuickLookAction(event, key);
    if (action !== undefined) {
      // Nothing behind the big picture gets this key.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat || key.startsWith("Arrow")) {
        action();
      }
    }
    return;
  }
  // On the wall itself: the framed picture or the one under the mouse, with nothing opened over the wall.
  const md5 = galleryCurrentMd5();
  if (md5 === null || event.repeat || !nothingOpen) {
    return;
  }
  if (key === " ") {
    event.preventDefault();
    openGalleryQuickLook(md5);
  } else if (key === "o" || key === "i") {
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
