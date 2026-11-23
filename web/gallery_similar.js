"use strict";

/* ---------- 画廊: 相似的图 / 以图搜图 ----------
   Every stored picture with a thumbnail has a fingerprint (src/picture_similar.js).
   The wall can show the pictures that look like one of them (「找相似的图」 in
   the big view) or like a picture of the user's own (「以图搜图」: dropped,
   pasted or picked). For the user's own picture the page works out a 32x32
   grey sample itself and sends only that. */

const SIMILAR_SAMPLE = 32;
const SIMILAR_CANVAS_MAX = 1024;
const GALLERY_CLOSENESS = {
  same: ["同一张", "和它是同一张图，只是文件不一样（压缩过、转存过）"],
  close: ["很像", "多半是同一张图改过：裁过、加了字、换了颜色"],
  alike: ["有点像", "构图接近，可能只是碰巧"],
};
const SIMILAR_NO_FINGERPRINT = {
  pending: "这张图的指纹还没算到，后台每次刷新会算一批，过一会儿再试。",
  flat: "这张图几乎是一整片颜色，认不出特征，没法拿来找相似的。",
  unsupported: "动图和这种格式的图没有指纹，没法拿来找相似的。",
  unreadable: "这张图读不出来，没法拿来找相似的。",
  "bad-hash": "这次的图没有认出来，请再选一次。",
};

const gallerySimilarUi = { picking: false, busy: false, note: "", info: null };

/* ---------- the wall in "similar" mode ---------- */

// similar: { md5 } for a stored picture, { hash } for the user's own; label says which.
const openGallerySimilar = (similar) => {
  if (app.gallery.detail !== null) {
    dismissOverlay(closeGalleryDetail);
  }
  Object.assign(gallerySimilarUi, { picking: false, note: "", info: null });
  replaceGallery({ similar, detail: null, results: null, selecting: false, selected: new Set(), lastPicked: null });
  renderGalleryDetailLayer();
  loadGallery();
  // A step of its own: the browser's back (and Esc's way back) returns to the wall.
  openOverlayEntry({ kind: "gallery-similar", key: similar.md5 ?? similar.hash }, closeGallerySimilar);
};

const closeGallerySimilar = () => {
  if (app.gallery.similar === null) {
    return;
  }
  gallerySimilarUi.info = null;
  replaceGallery({ similar: null, results: null });
  if (app.view === "media") {
    loadGallery();
  }
};

// 「回到全部图片」: the same as back.
const leaveGallerySimilar = () => dismissOverlay(closeGallerySimilar);

const loadGallerySimilar = async () => {
  const requestId = app.gallery.requestId + 1;
  const similar = app.gallery.similar;
  replaceGallery({ requestId, loading: true, loadingMore: false, error: null });
  renderMediaView();
  try {
    const params = new URLSearchParams(similar.md5 ? { md5: similar.md5 } : { hash: similar.hash });
    const answer = await api(`/api/gallery/similar?${params}`);
    if (app.gallery.requestId !== requestId) {
      return;
    }
    gallerySimilarUi.info = { total: answer.total, coverage: answer.coverage, noFingerprint: answer.noFingerprint };
    replaceGallery({ results: { total: answer.items.length, items: answer.items }, loading: false });
  } catch (error) {
    if (app.gallery.requestId !== requestId) {
      return;
    }
    replaceGallery({ loading: false, error: error.message });
  }
  window.scrollTo({ top: 0 });
  renderMediaView();
};

const gallerySimilarBadge = (item) => {
  if (app.gallery.similar === null || item.closeness === undefined) {
    return null;
  }
  if (item.itself) {
    return { text: "就是这张", tone: "similar same", title: "你拿来找的那张" };
  }
  const [text, title] = GALLERY_CLOSENESS[item.closeness] ?? GALLERY_CLOSENESS.alike;
  return { text, tone: `similar ${item.closeness}`, title };
};

// The line above the wall: what is shown, what could not be, how to go back.
const gallerySimilarHead = () => {
  const similar = app.gallery.similar;
  if (similar === null) {
    return null;
  }
  const info = gallerySimilarUi.info;
  const left = info?.coverage?.left ?? 0;
  return el("div", { class: "gallery-similar-head" },
    similar.md5 ? el("img", { class: "gallery-similar-thumb", src: pictureUrl(similar.md5, "thumb"), alt: "" }) : null,
    el("div", { class: "gallery-similar-text" },
      el("strong", {}, similar.md5 ? "和这张图相似的" : `和「${similar.label}」相似的`),
      info === null
        ? null
        : info.noFingerprint !== null
          ? el("span", {}, SIMILAR_NO_FINGERPRINT[info.noFingerprint] ?? SIMILAR_NO_FINGERPRINT.unreadable)
          : el("span", { class: "kb-meta" },
            info.total > (app.gallery.results?.items.length ?? 0) ? `找到 ${briefNumber(info.total)} 张，显示最像的 ${briefNumber(app.gallery.results.items.length)} 张。` : "",
            `越靠前越像。在 ${briefNumber(info.coverage.hashed)} 张有指纹的图里找的`,
            left > 0 ? `，还有 ${briefNumber(left)} 张没算到（后台每次刷新算一批）` : "",
            "；动图没有指纹。")),
    el("button", { class: "btn small", type: "button", onclick: leaveGallerySimilar }, "回到全部图片"));
};

/* ---------- a picture of the user's own ---------- */

// The same 32x32 area average the server makes of a stored picture, as base64.
const smallGrayOf = async (blob) => {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, SIMILAR_CANVAS_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(SIMILAR_SAMPLE, Math.round(bitmap.width * scale));
  const height = Math.max(SIMILAR_SAMPLE, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let pixels;
  try {
    // Transparent parts read as white, as they do for stored pictures.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    pixels = context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close?.();
  }
  const sums = new Float64Array(SIMILAR_SAMPLE * SIMILAR_SAMPLE);
  const counts = new Uint32Array(SIMILAR_SAMPLE * SIMILAR_SAMPLE);
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(SIMILAR_SAMPLE - 1, Math.floor((y * SIMILAR_SAMPLE) / height));
    for (let x = 0; x < width; x += 1) {
      const cell = cellY * SIMILAR_SAMPLE + Math.min(SIMILAR_SAMPLE - 1, Math.floor((x * SIMILAR_SAMPLE) / width));
      const offset = (y * width + x) * 4;
      sums[cell] += (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1000;
      counts[cell] += 1;
    }
  }
  let binary = "";
  for (let cell = 0; cell < sums.length; cell += 1) {
    binary += String.fromCharCode(Math.round(sums[cell] / Math.max(1, counts[cell])));
  }
  return btoa(binary);
};

const searchByOwnPicture = async (blob, label) => {
  if (gallerySimilarUi.busy) {
    return;
  }
  Object.assign(gallerySimilarUi, { busy: true, note: "" });
  renderGallerySimilarPanel();
  let gray;
  try {
    gray = await smallGrayOf(blob);
  } catch {
    Object.assign(gallerySimilarUi, { busy: false, note: "这个文件不是浏览器能打开的图片。" });
    renderGallerySimilarPanel();
    return;
  }
  try {
    const answer = await api("/api/pictures/fingerprint", { method: "POST", body: JSON.stringify({ gray }) });
    gallerySimilarUi.busy = false;
    if (answer.hash) {
      openGallerySimilar({ hash: answer.hash, label });
      return;
    }
    gallerySimilarUi.note = SIMILAR_NO_FINGERPRINT[answer.state] ?? SIMILAR_NO_FINGERPRINT.unreadable;
  } catch (error) {
    gallerySimilarUi.busy = false;
    gallerySimilarUi.note = `没有找成：${error.message}`;
  }
  renderGallerySimilarPanel();
};

const firstImageOf = (list) => [...(list ?? [])].find((file) => file.type.startsWith("image/")) ?? null;

const gallerySimilarPanelNodes = () => {
  const input = el("input", {
    type: "file",
    accept: "image/*",
    class: "gallery-similar-file",
    "aria-label": "选一张图",
    onchange: (event) => {
      const file = firstImageOf(event.target.files);
      if (file !== null) {
        searchByOwnPicture(file, file.name);
      }
    },
  });
  return [
    el("div", { class: "gallery-similar-drop-text" },
      el("strong", {}, gallerySimilarUi.busy ? "正在认这张图…" : "把一张图拖到这里，或者粘贴（Ctrl+V）"),
      el("span", { class: "kb-meta" }, "找出群里谁在什么时候发过它。图不会上传，也不会存下来。")),
    el("label", { class: "btn small" }, "选一个文件", input),
    el("button", { class: "btn small", type: "button", onclick: () => { gallerySimilarUi.picking = false; gallerySimilarUi.note = ""; renderMediaView(); } }, "取消"),
    gallerySimilarUi.note === "" ? null : el("p", { class: "gallery-similar-note", role: "alert" }, gallerySimilarUi.note),
  ];
};

// Shown under the toolbar after 「以图搜图」 was pressed.
const gallerySimilarPanel = () => {
  if (!gallerySimilarUi.picking) {
    return null;
  }
  return el("div", {
    id: "gallery-similar-panel",
    class: "gallery-similar-drop",
    ondragover: (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("over");
    },
    ondragleave: (event) => event.currentTarget.classList.remove("over"),
    ondrop: (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove("over");
      // A picture from the wall itself: its fingerprint is already known.
      const fromWall = event.dataTransfer.types.includes(TRAY_DRAG_TYPE) ? draggedMd5s(event) : [];
      if (fromWall.length > 0) {
        endTrayDrag();
        openGallerySimilar({ md5: fromWall[0] });
        return;
      }
      const file = firstImageOf(event.dataTransfer.files);
      if (file !== null) {
        searchByOwnPicture(file, file.name);
      } else {
        gallerySimilarUi.note = "拖进来的不是图片文件。";
        renderGallerySimilarPanel();
      }
    },
  }, gallerySimilarPanelNodes());
};

const renderGallerySimilarPanel = () => {
  const node = document.getElementById("gallery-similar-panel");
  if (node !== null) {
    setChildren(node, gallerySimilarPanelNodes());
  }
};

const gallerySimilarButton = () => el("button", {
  class: gallerySimilarUi.picking ? "btn small active" : "btn small",
  type: "button",
  "aria-pressed": String(gallerySimilarUi.picking),
  title: "拿一张图来找：群里谁在什么时候发过它，或者发过很像的",
  onclick: () => {
    gallerySimilarUi.picking = !gallerySimilarUi.picking;
    gallerySimilarUi.note = "";
    renderMediaView();
  },
}, "以图搜图");

// A picture pasted while the panel is open.
document.addEventListener("paste", (event) => {
  if (app.view !== "media" || !gallerySimilarUi.picking) {
    return;
  }
  const file = firstImageOf(event.clipboardData?.files);
  if (file !== null) {
    event.preventDefault();
    searchByOwnPicture(file, "粘贴的图");
  }
});
