"use strict";

/* ---------- 画廊: picture detail ----------
   Same layout as the 咒语库 detail: the picture on the left, everything known
   about it on the right -- where it was posted first and how it spread, the
   prompt when the library has one, the poster's other pictures, and the chat
   around it. It lives outside the view, so opening it never rebuilds the wall. */

const GALLERY_OTHERS_LIMIT = 13;

const galleryDetailPatch = (md5, patch) => {
  if (app.gallery.detail?.md5 !== md5) {
    return;
  }
  replaceGallery({ detail: { ...app.gallery.detail, ...patch } });
  renderGalleryDetailLayer();
};

const loadGalleryDetailExtras = (item) => {
  const md5 = item.md5;
  const shown = item.shown ?? item.origin;
  const load = (path, key, shape = (value) => value) =>
    api(path).then((value) => galleryDetailPatch(md5, { [key]: shape(value) })).catch(() => galleryDetailPatch(md5, { [key]: false }));
  load(`/api/gallery/picture?md5=${md5}`, "data");
  if (shown !== null) {
    load(`/api/gallery/context?${new URLSearchParams({ groupId: shown.groupId, rowId: shown.rowId, sentAt: String(shown.sentAt) })}`, "context");
    const sender = shown.speakerUin || shown.speaker;
    if (sender !== "") {
      const params = new URLSearchParams({ days: "31", kind: item.sticker ? "stickers" : "images", sender, limit: String(GALLERY_OTHERS_LIMIT) });
      load(`/api/gallery?${params}`, "others", (page) => page.items.filter((other) => other.md5 !== md5).slice(0, GALLERY_OTHERS_LIMIT - 1));
    }
  }
  if (item.inLibrary) {
    load(`/api/knowledge/image?hash=${md5}`, "knowledge");
  }
};

// index is the position in the current wall (-1 for a picture opened from the
// "other pictures" strip, which has no neighbours to step to).
// The last picture opened, so back from a page it led to opens it again.
const galleryLastOpened = { item: null };

const openGalleryItem = (item, index) => {
  replaceGallery({
    detail: { md5: item.md5, item, index, size: item.sticker ? "original" : "preview", notice: "", data: null, context: null, others: null, knowledge: null },
  });
  galleryLastOpened.item = item;
  renderGalleryDetailLayer();
  loadGalleryDetailExtras(item);
  openOverlayEntry({ kind: "gallery", key: item.md5 }, closeGalleryDetail);
};

const openGalleryDetail = (index) => {
  const item = app.gallery.results?.items[index];
  if (item !== undefined) {
    openGalleryItem(item, index);
  }
};

const closeGalleryDetail = () => {
  replaceGallery({ detail: null });
  renderGalleryDetailLayer();
};

// 关闭, Esc or a click beside the picture: back closes it the same way.
const dismissGalleryDetail = () => dismissOverlay(closeGalleryDetail);

VIEW_STEP_RESTORERS.media = (step, overlay) => {
  openMediaView(false);
  if (overlay?.kind !== "gallery") {
    return;
  }
  const items = app.gallery.results?.items ?? [];
  const index = items.findIndex((item) => item.md5 === overlay.key);
  if (index >= 0) {
    openGalleryItem(items[index], index);
  } else if (galleryLastOpened.item?.md5 === overlay.key) {
    openGalleryItem(galleryLastOpened.item, -1);
  }
};

const stepGalleryDetail = (delta) => {
  const index = app.gallery.detail?.index ?? -1;
  if (index >= 0) {
    openGalleryDetail(index + delta);
  }
};

const openChatAtPosting = (posting) => openMessagesView({
  groupId: posting.groupId,
  groupName: posting.groupName || pictureGroupName(posting.groupId),
  fromUnix: posting.sentAt - 1800,
  scrollToTime: posting.sentAt,
  scrollToRowIds: [posting.rowId],
  origin: GALLERY_ORIGIN,
});

// "4 / 34,705": the place among everything the filter finds, not only among
// the pictures loaded so far.
const galleryDetailPosition = (index, loaded) => {
  const total = Math.max(app.gallery.results?.total ?? loaded, loaded);
  return `${briefNumber(index + 1)} / ${briefNumber(total)}`;
};

/* ---------- sections ---------- */

const galleryDetailMeta = (detail) => {
  const item = detail.item;
  const days = daysUntilExpiry(item.expiresAt);
  return [
    item.width > 0 ? `${item.width}×${item.height}` : "",
    item.size > 0 ? formatByteSize(item.size) : "",
    item.fileName
      ? `以文件发送：${item.fileName}，这里显示的是 QQ 的预览（最长边约 1280）`
      : item.kept ? `原图已留存在本程序里：${keptWhyText(item)}` : days === null ? "" : `腾讯还保留约 ${days} 天`,
  ].filter((part) => part !== "").join(" · ");
};

// Where this picture was already saved to (the newest copy; the rest in the title).
const galleryDetailSaved = (detail) => {
  const saves = detail.data ? detail.data.saves ?? [] : [];
  if (saves.length === 0) {
    return detail.item.savedAt > 0 ? el("p", { class: "kb-meta gallery-detail-saved" }, `已存过：${unixToHkt(detail.item.savedAt).slice(0, 16)}`) : null;
  }
  return el("p", {
    class: "kb-meta gallery-detail-saved",
    title: saves.map((save) => `${unixToHkt(save.savedAt).slice(0, 16)}  ${save.dir}\\${save.file}`).join("\n"),
  }, `已存过${saves.length > 1 ? ` ${saves.length} 次` : ""}：${unixToHkt(saves[0].savedAt).slice(0, 16)} 存到 ${saves[0].dir}`);
};

const saveGalleryDetailToTray = async (detail, tray) => {
  const md5 = detail.item.md5;
  galleryDetailPatch(md5, { notice: `正在存到「${tray.name}」…` });
  const outcome = await saveToTray([md5], tray.id);
  galleryDetailPatch(md5, { notice: outcome.text });
  if (!outcome.failed) {
    api(`/api/gallery/picture?md5=${md5}`).then((data) => galleryDetailPatch(md5, { data })).catch(() => {});
  }
};

// One button per tray; the number is the key that does the same.
const galleryDetailTrayButtons = (detail) => {
  const item = detail.item;
  if (item.gone && !item.kept) {
    return null;
  }
  return (pictureTrays.list ?? []).map((tray, index) => el("button", {
    class: index === 0 ? "btn small primary" : "btn small",
    type: "button",
    title: `把原图存到 ${tray.path}${index < TRAY_KEYS ? `（按 ${index + 1}${index === 0 ? " 或 S" : ""}）` : ""}`,
    onclick: () => saveGalleryDetailToTray(detail, tray),
  }, `存到「${tray.name}」`, index < TRAY_KEYS ? el("kbd", { class: "tray-key" }, String(index + 1)) : null));
};

const galleryDetailActions = (detail) => {
  const item = detail.item;
  const shown = item.shown ?? item.origin;
  const sender = shown === null ? "" : shown.speakerUin || shown.speaker;
  return el("div", { class: "row gallery-detail-actions" },
    detail.size === "original" || (item.gone && !item.kept) || item.fileName
      ? null
      : el("button", { class: "btn small primary", type: "button", title: item.kept ? "显示留存在本程序里的原图" : "向腾讯的图片服务器取原图来看（会联网）；只是看，不会留存", onclick: () => galleryDetailPatch(item.md5, { size: "original", notice: item.kept ? "" : "正在向腾讯取原图…" }) }, "看原图"),
    galleryDetailTrayButtons(detail),
    // A picture Tencent deleted can still be saved as when its original was kept.
    item.gone && !item.kept
      ? null
      : el("button", {
        class: "btn small",
        type: "button",
        title: SAVE_AS_TITLE,
        onclick: async () => {
          galleryDetailPatch(item.md5, { notice: "正在取原图…" });
          try {
            galleryDetailPatch(item.md5, { notice: await savePictureAs(item.md5) });
          } catch (error) {
            galleryDetailPatch(item.md5, { notice: `没有另存：${error.message}` });
          }
        },
      }, item.fileName ? "另存 QQ 的预览…" : "另存为…"),
    item.kept || item.removed
      ? galleryDetailKeptNodes(item, (patch) => galleryDetailPatch(item.md5, patch))
      : item.gone || item.fileName
        ? null
        : el("button", {
          class: "btn small",
          type: "button",
          title: KEEP_LABEL_TITLE,
          onclick: async () => {
            galleryDetailPatch(item.md5, { notice: "正在留存原图…" });
            try {
              const kept = await keepOnePicture(item.md5);
              galleryDetailPatch(item.md5, { notice: kept.text, item: { ...item, kept: kept.status === "kept" } });
              markGalleryKept(kept.status === "kept" ? [item.md5] : []);
            } catch (error) {
              galleryDetailPatch(item.md5, { notice: error.message });
            }
          },
        }, "留存原图"),
    item.ai
      ? el("button", { class: "btn small", type: "button", onclick: () => downloadPictureWorkflow(item.md5).catch((error) => notifyError(error)) }, "下载工作流")
      : null,
    shown === null ? null : el("button", { class: "btn small", type: "button", onclick: () => openChatAtPosting(shown) }, "在消息里看"),
    el("button", { class: "btn small", type: "button", title: "在画廊里列出和这张图一样或很像的图", onclick: () => openGallerySimilar({ md5: item.md5 }) }, "找相似的图"),
    item.inLibrary
      ? el("button", { class: "btn small", type: "button", onclick: () => openKnowledgeDetailByHash(item.md5).catch((error) => notifyError(error)) }, "在咒语库打开")
      : null,
    sender === "" || app.gallery.sender === sender
      ? null
      : el("button", {
        class: "btn small",
        type: "button",
        onclick: () => applyGalleryFilter({ sender, senderLabel: shown.speaker }),
      }, "只看这个人的图"));
};

// The picture's story: where it was posted, including the times it went
// round as a different file of the same picture (story, from its fingerprint).
const gallerySpread = (detail) => {
  const story = detail.data?.story ?? null;
  const together = story !== null && story.files > 1;
  const occurrences = together
    ? story.postings
    : detail.data ? detail.data.occurrences : [detail.item.origin, detail.item.shown].filter(Boolean);
  if (occurrences.length === 0) {
    return null;
  }
  const groups = new Set(occurrences.map((item) => item.groupId)).size;
  return el("section", { class: "gallery-spread" },
    el("span", { class: "kb-prompt-label", title: together ? "同一张图被压缩、转存后是不同的文件；这里把它们算在一起" : "" },
      occurrences.length === 1
        ? "发在"
        : `传播：${groups} 个群 · ${occurrences.length} 次${together ? ` · ${story.files} 个不同的文件` : ""}`),
    el("ol", {}, occurrences.slice(0, 40).map((posting, index) => el("li", {},
      el("button", { class: "gallery-spread-row", type: "button", title: "在消息里看这一次", onclick: () => openChatAtPosting(posting) },
        index === 0 && occurrences.length > 1 ? el("span", { class: "kb-badge ok" }, "首发") : null,
        el("span", { class: "gallery-spread-time" }, unixToHkt(posting.sentAt).slice(5, 16)),
        el("strong", {}, posting.groupName || pictureGroupName(posting.groupId)),
        el("span", { class: "kb-meta" }, posting.speaker || ""),
        together && posting.md5 !== detail.item.md5 ? el("span", { class: "kb-badge", title: "这一次发的是同一张图的另一个文件" }, "另一个文件") : null))),
    occurrences.length > 40 ? el("li", { class: "kb-meta" }, `还有 ${occurrences.length - 40} 次`) : null));
};

const galleryPrompt = (detail) => {
  const record = detail.knowledge;
  if (record === null || record === false || record === undefined) {
    return null;
  }
  const params = record.params ?? {};
  return el("section", { class: "gallery-prompt" },
    promptBlock(record.prompt, "咒语", { clamp: false }),
    el("div", { class: "kb-detail-grid" },
      detailRow("模型", record.checkpoint),
      detailRow("steps", params.steps),
      detailRow("CFG", params.cfgScale),
      detailRow("采样器", params.sampler),
      detailRow("seed", params.seed)),
    record.loras.length === 0
      ? null
      : el("div", { class: "kb-chip-row" }, record.loras.map((lora) =>
        el("span", { class: "kb-chip" }, lora.weight === null ? lora.name : `${lora.name} @${lora.weight}`))));
};

const galleryOthers = (detail) => {
  const others = detail.others;
  if (!Array.isArray(others) || others.length === 0) {
    return null;
  }
  const shown = detail.item.shown ?? detail.item.origin;
  return el("section", { class: "aigc-related" },
    el("span", { class: "kb-prompt-label" }, `${shown?.speaker || "这个人"} 最近的其他${detail.item.sticker ? "表情" : "图"}`),
    el("div", { class: "aigc-related-strip" }, others.map((other) =>
      el("button", { class: "aigc-related-item", type: "button", title: "看这张", onclick: () => openGalleryItem(other, galleryIndexOfMd5(other.md5)) },
        el("img", { src: pictureUrl(other.md5, "thumb"), alt: "", loading: "lazy", decoding: "async" })))));
};

const galleryIndexOfMd5 = (md5) => (app.gallery.results?.items ?? []).findIndex((item) => item.md5 === md5);

const galleryContext = (detail) => {
  const context = detail.context;
  if (context === null) {
    return el("p", { class: "kb-meta" }, "正在读取前后的消息…");
  }
  if (context === false || context.messages.length === 0) {
    return null;
  }
  return el("section", { class: "gallery-context" },
    el("span", { class: "kb-prompt-label" }, "前后的消息"),
    el("ol", {}, context.messages.map((message) => el("li", { class: message.rowId === context.focusRowId ? "focus" : "" },
      el("strong", {}, message.speaker || "有人"),
      el("span", {}, message.isMedia === 1 ? mediaLabelText(message.mediaKinds, message.text) : message.text)))));
};

const galleryDetailImage = (detail) => {
  const item = detail.item;
  if (item.gone && !item.kept) {
    return el("div", { class: "picture-viewer-missing gallery-gone" }, "腾讯服务器已经删除这张图（超过 31 天）。");
  }
  return el("img", {
    class: `kb-overlay-image ${item.sticker ? "sticker" : ""}`,
    src: pictureUrl(item.md5, detail.size),
    // The bigger copy may take a moment to come from Tencent; the thumbnail
    // (already cached by the wall) fills the frame until it arrives.
    style: `background-image:url("${pictureUrl(item.md5, "thumb")}")`,
    alt: item.sticker ? "表情" : "图片",
    // Dragged out to the desktop or a folder, it is the original that lands there.
    draggable: "true",
    onpointerdown: () => prepareTrayDrag(item),
    ondragstart: (event) => startTrayDrag(event, item, [item.md5]),
    onload: () => {
      if (app.gallery.detail?.notice === "正在向腾讯取原图…") {
        galleryDetailPatch(item.md5, { notice: "" });
      }
    },
    onerror: () => galleryDetailPatch(item.md5, { notice: "这张图暂时打不开：QQ 没在运行时拿不到图片钥匙。" }),
  });
};

const galleryDetailOverlay = (detail) => {
  const items = app.gallery.results?.items ?? [];
  const item = detail.item;
  const title = item.generator !== "" ? `AI 图 · ${generatorLabel(item.generator)}` : item.ai ? "AI 图" : item.sticker ? "表情包" : "群图片";
  return el("div", {
    id: "gallery-detail-layer",
    class: "kb-overlay view-layer",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        dismissGalleryDetail();
      }
    },
  },
  el("div", { class: "kb-overlay-panel gallery-detail", role: "dialog", "aria-label": title },
    el("div", { class: "kb-overlay-head" },
      el("strong", {}, title),
      el("div", { class: "kb-overlay-nav" },
        detail.index >= 0 ? el("span", { class: "kb-meta" }, galleryDetailPosition(detail.index, items.length)) : null,
        el("button", { class: "btn small", type: "button", title: "上一张（←）", disabled: detail.index <= 0, onclick: () => stepGalleryDetail(-1) }, "←"),
        el("button", { class: "btn small", type: "button", title: "下一张（→）", disabled: detail.index < 0 || detail.index >= items.length - 1, onclick: () => stepGalleryDetail(1) }, "→"),
        el("button", { class: "btn small", type: "button", onclick: dismissGalleryDetail }, "关闭"))),
    el("div", { class: "kb-overlay-body" },
      el("div", { class: "kb-overlay-media" }, galleryDetailImage(detail)),
      el("div", { class: "kb-overlay-info" },
        el("p", { class: "kb-meta" }, galleryDetailMeta(detail)),
        galleryDetailActions(detail),
        detail.notice ? el("p", { class: "kb-note muted" }, detail.notice) : null,
        galleryDetailSaved(detail),
        gallerySpread(detail),
        galleryPrompt(detail),
        galleryOthers(detail),
        galleryContext(detail)))));
};

const renderGalleryDetailLayer = () => {
  document.getElementById("gallery-detail-layer")?.remove();
  const detail = app.gallery.detail;
  if (detail !== null && app.view === "media") {
    document.body.append(galleryDetailOverlay(detail));
  }
};

// Esc closes the top layer only: the open picture first, then 多选.
document.addEventListener("keydown", (event) => {
  if (app.view !== "media") {
    return;
  }
  // A tile's box keeps focus after a click; only typing places count.
  const focused = document.activeElement;
  const typing = focused?.tagName === "TEXTAREA" || focused?.tagName === "SELECT"
    || (focused?.tagName === "INPUT" && !["checkbox", "radio", "range"].includes(focused.type));
  if (typing) {
    return;
  }
  // 存图托盘: S or 1 = the first tray, 2-9 the next ones; for the open
  // picture, or for the multi-selection.
  const tray = event.ctrlKey || event.metaKey || event.altKey || event.repeat || document.querySelector(".cc-dialog-layer") !== null
    ? null
    : trayForKey(event.key);
  if (tray !== null && pictureUi.viewer === null) {
    const detail = app.gallery.detail;
    if (detail !== null && !(detail.item.gone && !detail.item.kept)) {
      event.preventDefault();
      saveGalleryDetailToTray(detail, tray);
      return;
    }
    if (detail === null && app.gallery.selecting && app.gallery.selected.size > 0) {
      event.preventDefault();
      saveToTrayAndTell([...app.gallery.selected], tray.id);
      return;
    }
  }
  if (app.gallery.detail === null) {
    if (event.key === "Escape" && app.gallery.selecting && pictureUi.viewer === null && !event.defaultPrevented) {
      event.preventDefault();
      leaveGallerySelection();
    }
    return;
  }
  if (event.key === "Escape") {
    dismissGalleryDetail();
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    stepGalleryDetail(event.key === "ArrowRight" ? 1 : -1);
  }
});
