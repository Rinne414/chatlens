"use strict";

/* ---------- QQ 收藏图: day strip, unsaved stretches, wall, saving ----------
   The day strip shows every day from the first to the last collection: a
   column per day, its saved part and its unsaved part. The stretches list
   names the runs of days with unsaved pictures, so "the middle part I
   missed" and "the newest ones" are one click to look at or select. Tiles
   are QQ's own 200 px thumbnails (loaded without a Referer: QQ answers a
   request with one by a hotlink placeholder). Selection and saving update
   the tiles in place; saving goes a few pictures per request so it shows
   progress and can stop. */

const QQC_SAVE_BATCH = 8;
const QQC_RUNS_PREVIEW = 6;
const QQC_THUMB_SIZE = 200;
const QQC_PREVIEW_SIZE = 400;
// Thumbnails load only this close to the screen: the browser's own lazy
// loading fetched 1,700 of them at once, and the big preview waited behind.
const QQC_LAZY_MARGIN = "600px 0px";
const QQC_FAILED_TEXT = {
  gone: "QQ 服务器上已经没有了",
  mismatch: "下载到的不是原图（md5 对不上），没有存",
  unavailable: "暂时下载不到，稍后再试",
  "too-big": "文件超过 64 MB，没有存",
  "write-failed": "写不进保存文件夹（磁盘满了或没有权限？）",
  "not-found": "收藏里已经没有了（点「重新读取」）",
};
const QQC_FILTERS = [["all", "全部"], ["unsaved", "只看没存的"], ["saved", "只看已存的"]];

const qqcThumbUrl = (picture, size = QQC_THUMB_SIZE) => `https://shp.qpic.cn/collector/${picture.uin}/${picture.uuid}/${size}`;

// The pictures the wall shows (filter and dates), newest first.
const qqcShown = () => qqcPictures().filter((picture) => {
  if (qqc.filter === "saved" && !qqcIsSaved(picture)) {
    return false;
  }
  if (qqc.filter === "unsaved" && qqcIsSaved(picture)) {
    return false;
  }
  if (qqc.range !== null) {
    const day = QqcDays.qqcDay(picture.collectedAt);
    return day >= qqc.range.fromDay && day <= qqc.range.toDay;
  }
  return true;
});

const qqcSetView = (patch) => {
  Object.assign(qqc, patch);
  renderQqCollectionView();
};

const qqcScrollToWall = () => requestAnimationFrame(() => $(".qqc-toolbar")?.scrollIntoView({ block: "start", behavior: "smooth" }));

/* ---------- the day strip and the stretches ---------- */

const qqcStripDay = (day, stat, max) => {
  if (stat === undefined) {
    return el("span", { class: "qqc-strip-day empty", title: `${qqcFormatDay(day)}：没有收藏` });
  }
  const unsaved = stat.total - stat.saved;
  return el("button", {
    class: `qqc-strip-day${qqc.range?.fromDay === day && qqc.range?.toDay === day ? " active" : ""}`,
    type: "button",
    title: `${qqcFormatDay(day)}：收藏 ${stat.total} 张，已存 ${stat.saved}，没存 ${unsaved}。点击只看这天`,
    "aria-label": `${qqcFormatDay(day)} 收藏 ${stat.total} 张 没存 ${unsaved} 张`,
    onclick: () => {
      qqcSetView({ range: { fromDay: day, toDay: day } });
      qqcScrollToWall();
    },
  },
  el("span", { class: "qqc-strip-unsaved", style: `height:${(unsaved / max) * 100}%` }),
  el("span", { class: "qqc-strip-saved", style: `height:${(stat.saved / max) * 100}%` }));
};

const qqcSelectPictures = (pictures) => {
  qqc.selected = new Set([...qqc.selected, ...pictures.filter((picture) => !qqcIsSaved(picture)).map((picture) => picture.md5)]);
  renderQqCollectionView();
};

const qqcRuns = (runs) => {
  if (runs.length === 0) {
    return el("p", { class: "qqc-all-saved" }, "✓ 每一天的图都存过了。");
  }
  const shown = qqc.showAllRuns ? runs : runs.slice(0, QQC_RUNS_PREVIEW);
  const inRun = (run) => qqcPictures().filter((picture) => {
    const day = QqcDays.qqcDay(picture.collectedAt);
    return day >= run.fromDay && day <= run.toDay;
  });
  return el("div", { class: "qqc-runs" },
    el("span", { class: "gp-label" }, `没存的几段（最新的在前，共 ${runs.length} 段）`),
    el("ol", {}, shown.map((run) => el("li", {},
      el("span", { class: "qqc-run-when" }, run.fromDay === run.toDay ? qqcFormatDay(run.fromDay) : `${qqcFormatDay(run.fromDay)} – ${qqcFormatDay(run.toDay)}`),
      el("span", { class: "qqc-run-count" }, `没存 ${briefNumber(run.unsaved)} 张`, run.unsaved < run.total ? el("small", {}, `（共 ${briefNumber(run.total)}）`) : null),
      el("button", {
        class: "btn small", type: "button",
        onclick: () => {
          qqcSetView({ range: { fromDay: run.fromDay, toDay: run.toDay }, filter: "unsaved" });
          qqcScrollToWall();
        },
      }, "只看这段"),
      el("button", { class: "btn small", type: "button", disabled: qqc.save.running, onclick: () => qqcSelectPictures(inRun(run)) }, "选中这段没存的")))),
    runs.length > QQC_RUNS_PREVIEW
      ? el("button", { class: "kb-facet-more", type: "button", onclick: () => qqcSetView({ showAllRuns: !qqc.showAllRuns }) }, qqc.showAllRuns ? "收起" : `显示全部 ${runs.length} 段`)
      : null);
};

const qqcTimeline = () => {
  const stats = QqcDays.qqcDayStats(qqcPictures(), qqcIsSaved);
  const byDay = new Map(stats.map((stat) => [stat.day, stat]));
  const days = QqcDays.qqcDaysBetween(stats[0].day, stats.at(-1).day);
  const max = Math.max(1, ...stats.map((stat) => stat.total));
  return el("section", { class: "card gp-section qqc-timeline" },
    el("div", { class: "gp-section-head" },
      el("h3", {}, "每天收藏了多少、存了多少"),
      el("div", { class: "qqc-legend" },
        el("span", {}, el("i", { class: "qqc-swatch saved" }), "已存"),
        el("span", {}, el("i", { class: "qqc-swatch unsaved" }), "没存"))),
    el("figure", { class: "qqc-strip-figure" },
      el("div", { class: "qqc-strip", role: "group", "aria-label": "每天的收藏，点一天只看那天" },
        el("span", { class: "gp-axis-max" }, briefNumber(max)),
        days.map((day) => qqcStripDay(day, byDay.get(day), max))),
      el("figcaption", { class: "gp-axis-days" },
        el("span", {}, qqcFormatDay(days[0])),
        el("span", {}, qqcFormatDay(days[Math.floor(days.length / 2)])),
        el("span", {}, qqcFormatDay(days.at(-1))))),
    qqcRuns(QqcDays.qqcUnsavedRuns(stats)));
};

/* ---------- filters, selection, saving ---------- */

const qqcToolbar = () => {
  const pictures = qqcPictures();
  const shown = qqcShown();
  const shownUnsaved = shown.filter((picture) => !qqcIsSaved(picture));
  const days = pictures.map((picture) => QqcDays.qqcDay(picture.collectedAt));
  const first = days.at(-1);
  const last = days[0];
  const range = qqc.range ?? { fromDay: first, toDay: last };
  const setRange = (fromDay, toDay) => qqcSetView({ range: fromDay === first && toDay === last ? null : { fromDay, toDay } });
  return el("section", { class: "qqc-toolbar" },
    el("div", { class: "qqc-toolbar-row" },
      el("div", { class: "wall-modes", role: "group", "aria-label": "显示哪些图" }, QQC_FILTERS.map(([filter, label]) => el("button", {
        class: qqc.filter === filter ? "wall-mode active" : "wall-mode",
        type: "button",
        "aria-pressed": String(qqc.filter === filter),
        onclick: () => qqcSetView({ filter }),
      }, label))),
      el("span", { class: qqc.range === null ? "trends-dates" : "trends-dates active" },
        el("input", { type: "date", value: range.fromDay, min: first, max: last, "aria-label": "开始日期", onchange: (event) => event.target.value && setRange(event.target.value, event.target.value > range.toDay ? event.target.value : range.toDay) }),
        el("span", {}, "至"),
        el("input", { type: "date", value: range.toDay, min: first, max: last, "aria-label": "结束日期", onchange: (event) => event.target.value && setRange(event.target.value < range.fromDay ? event.target.value : range.fromDay, event.target.value) })),
      qqc.range === null ? null : el("button", { class: "btn small", type: "button", onclick: () => qqcSetView({ range: null }) }, "全部日期"),
      el("span", { class: "kb-meta" }, `显示 ${briefNumber(shown.length)} 张`)),
    el("div", { class: "qqc-toolbar-row" },
      el("button", { class: "btn small", type: "button", disabled: shownUnsaved.length === 0 || qqc.save.running, onclick: () => qqcSelectPictures(shownUnsaved) },
        `选中上面显示的没存的（${briefNumber(shownUnsaved.length)}）`),
      el("button", { class: "btn small", type: "button", disabled: qqc.selected.size === 0 || qqc.save.running, onclick: () => qqcSetView({ selected: new Set(), anchor: null }) }, "清除选择"),
      el("span", { class: "kb-meta" }, "点图选中，按住 Shift 点另一张选中中间所有的")),
    el("div", { id: "qqc-save-bar", class: "qqc-save-bar", "aria-live": "polite" }));
};

let qqcThumbObserver = null;

// Gives each thumbnail its address when it comes near the screen.
const qqcObserveThumbs = (root) => {
  qqcThumbObserver?.disconnect();
  qqcThumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries.filter((item) => item.isIntersecting)) {
      entry.target.src = entry.target.dataset.src;
      qqcThumbObserver.unobserve(entry.target);
    }
  }, { rootMargin: QQC_LAZY_MARGIN });
  for (const img of root.querySelectorAll("img[data-src]:not([src])")) {
    qqcThumbObserver.observe(img);
  }
};

const qqcSaveText = () => {
  const job = qqc.save;
  if (job.error !== null) {
    return `保存出错：${job.error}`;
  }
  const failed = Object.entries(job.failed).map(([reason, count]) => `${count} 张${QQC_FAILED_TEXT[reason] ?? reason}`).join("，");
  if (job.running) {
    return `正在保存 ${job.done} / ${job.total}…（已存 ${job.saved}）`;
  }
  if (job.total === 0) {
    return "";
  }
  const recompressed = job.recompressed > 0 ? `（其中 ${job.recompressed} 张 QQ 服务器只剩重新压缩的 JPG，和在 QQ 里「另存为」拿到的一样）` : "";
  return `存好了 ${job.saved} 张${recompressed}${failed ? `；${failed}` : ""}${job.stop && job.done < job.total ? `；已停下，还有 ${job.total - job.done} 张没存` : ""}`;
};

const qqcRenderSaveBar = () => {
  const node = $("#qqc-save-bar");
  if (node === null || qqc.data === null) {
    return;
  }
  const { saveDir } = qqc.data.settings;
  const chosen = qqcPictures().filter((picture) => qqc.selected.has(picture.md5) && !qqcIsSaved(picture)).length;
  const percent = qqc.save.total > 0 ? Math.round((qqc.save.done / qqc.save.total) * 100) : 0;
  setChildren(node,
    el("strong", {}, `已选 ${briefNumber(chosen)} 张没存的`),
    qqc.save.running
      ? [el("span", { class: "qqc-progress" }, el("span", { style: `width:${percent}%` })),
        el("button", { class: "btn small", type: "button", onclick: () => { qqc.save.stop = true; } }, "停下")]
      : el("button", {
        class: "btn primary", type: "button",
        disabled: chosen === 0 || saveDir === "" || qqc.data.scan.running,
        title: saveDir === "" ? "先在上面选新图存到哪" : qqc.data.scan.running ? "检查完文件夹再存" : saveDir,
        onclick: qqcRunSave,
      }, saveDir === "" ? "先选新图存到哪" : `存到 ${saveDir.split(/[\\/]/u).filter(Boolean).at(-1)}`),
    el("span", { class: "qqc-save-text" }, qqcSaveText()),
    !qqc.save.running && qqc.save.saved > 0
      ? el("button", { class: "btn small", type: "button", onclick: () => api("/api/qq-collection/open", { method: "POST", body: "{}" }).catch((error) => alert(error.message)) }, "打开文件夹")
      : null);
};

const qqcMarkSaved = (results) => {
  const saved = new Map(results.filter((item) => item.status === "saved").map((item) => [item.md5, item]));
  qqc.data = {
    ...qqc.data,
    pictures: qqcPictures().map((picture) => {
      const item = saved.get(picture.md5);
      return item === undefined ? picture : { ...picture, savedPath: item.file, savedBy: item.recompressed ? "name" : "bytes" };
    }),
  };
  qqc.selected = new Set([...qqc.selected].filter((md5) => !saved.has(md5)));
  for (const md5 of saved.keys()) {
    qqcUpdateTile(md5);
  }
};

const qqcRunSave = async () => {
  if (qqc.save.running) {
    return;
  }
  const chosen = qqcPictures().filter((picture) => qqc.selected.has(picture.md5) && !qqcIsSaved(picture)).map((picture) => picture.md5);
  qqc.save = { running: true, stop: false, done: 0, total: chosen.length, saved: 0, recompressed: 0, failed: {}, error: null };
  qqcRenderSaveBar();
  qqcLockFolders();
  try {
    for (let start = 0; start < chosen.length && !qqc.save.stop; start += QQC_SAVE_BATCH) {
      const batch = chosen.slice(start, start + QQC_SAVE_BATCH);
      const result = await api("/api/qq-collection/save", { method: "POST", body: JSON.stringify({ md5s: batch }) });
      for (const item of result.results) {
        if (item.status === "saved") {
          qqc.save.saved += 1;
          qqc.save.recompressed += item.recompressed ? 1 : 0;
        } else {
          qqc.save.failed[item.status] = (qqc.save.failed[item.status] ?? 0) + 1;
        }
      }
      qqcMarkSaved(result.results);
      qqc.save.done = Math.min(chosen.length, start + batch.length);
      qqcRenderSaveBar();
    }
  } catch (error) {
    qqc.save.error = error.message;
  } finally {
    qqc.save.running = false;
    renderQqCollectionView();
  }
};

/* ---------- the wall ---------- */

const qqcTileClass = (picture) => [
  "qqc-tile",
  qqcIsSaved(picture) ? "saved" : "",
  qqc.selected.has(picture.md5) ? "selected" : "",
].filter(Boolean).join(" ");

const qqcBadge = (picture) => (qqcIsSaved(picture)
  ? el("span", { class: "qqc-badge", title: `已存：${picture.savedPath}` }, picture.savedBy === "name" ? "✓ 已存（同名）" : "✓ 已存")
  : null);

// Selection and saving change one tile, not the page.
const qqcUpdateTile = (md5) => {
  const tile = document.querySelector(`.qqc-tile[data-md5="${md5}"]`);
  const picture = qqcPictures().find((item) => item.md5 === md5);
  if (tile === null || picture === undefined) {
    return;
  }
  tile.className = qqcTileClass(picture);
  tile.querySelector(".qqc-pick")?.setAttribute("aria-pressed", String(qqc.selected.has(md5)));
  tile.querySelector(".qqc-badge")?.remove();
  const badge = qqcBadge(picture);
  if (badge !== null) {
    tile.append(badge);
  }
};

const qqcClickTile = (md5, event) => {
  if (qqc.save.running) {
    return;
  }
  const picture = qqcPictures().find((item) => item.md5 === md5);
  if (picture === undefined || qqcIsSaved(picture)) {
    return;
  }
  // The anchor may be filtered out (or saved and hidden) by now: then only this one.
  const range = event.shiftKey && qqc.anchor !== null
    ? QqcDays.qqcRangeBetween(qqcShown(), qqc.anchor, md5, (item) => item.md5).filter((item) => !qqcIsSaved(item)).map((item) => item.md5)
    : [];
  const changed = range.length > 0 ? range : [md5];
  const selecting = !qqc.selected.has(md5) || event.shiftKey;
  const next = new Set(qqc.selected);
  for (const key of changed) {
    if (selecting) {
      next.add(key);
    } else {
      next.delete(key);
    }
  }
  qqc.selected = next;
  qqc.anchor = md5;
  for (const key of changed) {
    qqcUpdateTile(key);
  }
  qqcRenderSaveBar();
};

const qqcTile = (picture) => el("div", { class: qqcTileClass(picture), "data-md5": picture.md5 },
  el("button", {
    class: "qqc-pick",
    type: "button",
    "aria-pressed": String(qqc.selected.has(picture.md5)),
    title: `${qqcFormatTime(picture.collectedAt)} 收藏 · ${picture.width}×${picture.height}${qqcIsSaved(picture) ? `\n已存：${picture.savedPath}` : "\n点击选中"}`,
    onclick: (event) => qqcClickTile(picture.md5, event),
  },
  el("img", { "data-src": qqcThumbUrl(picture), alt: "", decoding: "async", referrerpolicy: "no-referrer" }),
  el("span", { class: "qqc-check", "aria-hidden": "true" })),
  qqcBadge(picture),
  el("button", { class: "qqc-zoom", type: "button", title: "看大图", "aria-label": "看大图", onclick: () => qqcOpenPreview(picture.md5) }, "⤢"));

const qqcWall = () => {
  const shown = qqcShown();
  if (shown.length === 0) {
    return el("p", { class: "kb-meta qqc-empty" }, "没有符合的图。");
  }
  const byDay = new Map();
  for (const picture of shown) {
    const day = QqcDays.qqcDay(picture.collectedAt);
    byDay.set(day, [...(byDay.get(day) ?? []), picture]);
  }
  return el("div", { class: "qqc-wall" }, [...byDay].map(([day, pictures]) => {
    const unsaved = pictures.filter((picture) => !qqcIsSaved(picture));
    return el("section", { class: "qqc-day", id: `qqc-day-${day}` },
      el("div", { class: "qqc-day-head" },
        el("h4", {}, qqcFormatDay(day)),
        el("span", { class: "kb-meta" }, `${pictures.length} 张${unsaved.length > 0 ? ` · ${unsaved.length} 张没存` : " · 都存了"}`),
        unsaved.length > 0 ? el("button", { class: "btn small", type: "button", disabled: qqc.save.running, onclick: () => qqcSelectPictures(unsaved) }, "选这天没存的") : null),
      el("div", { class: "qqc-grid" }, pictures.map(qqcTile)));
  }));
};

/* ---------- a picture, big ---------- */

const qqcClosePreview = () => {
  qqc.preview = null;
  qqcRenderPreviewLayer();
};

const qqcDismissPreview = () => dismissOverlay(qqcClosePreview);

const qqcOpenPreview = (md5) => {
  qqc.preview = md5;
  qqcRenderPreviewLayer();
  openOverlayEntry({ kind: "qqc", key: md5 }, qqcClosePreview);
};

const qqcStepPreview = (step) => {
  const shown = qqcShown();
  const index = shown.findIndex((picture) => picture.md5 === qqc.preview);
  const next = shown[index + step];
  if (next !== undefined) {
    qqcOpenPreview(next.md5);
  }
};

// The wall's thumbnail (already loaded) at once, the sharper one over it
// when it arrives: with thousands of thumbnails queued, the big one can take
// seconds. Both boxes have the picture's own proportions from the start.
const qqcPreviewImages = (picture) => {
  const width = QQC_PREVIEW_SIZE;
  const height = Math.round((QQC_PREVIEW_SIZE * Math.max(1, picture.height)) / Math.max(1, picture.width));
  const sharp = el("img", {
    class: "qqc-preview-sharp", src: qqcThumbUrl(picture, QQC_PREVIEW_SIZE), alt: "", width, height, referrerpolicy: "no-referrer", fetchpriority: "high",
    onload: (event) => event.target.classList.add("loaded"),
  });
  return [el("img", { class: "qqc-preview-soft", src: qqcThumbUrl(picture), alt: "", width, height, referrerpolicy: "no-referrer" }), sharp];
};

const qqcRenderPreviewLayer = () => {
  $("#qqc-preview-layer")?.remove();
  const picture = qqcPictures().find((item) => item.md5 === qqc.preview);
  if (picture === undefined || app.view !== "qqcollect") {
    return;
  }
  const shown = qqcShown();
  const index = shown.findIndex((item) => item.md5 === picture.md5);
  const layer = el("div", {
    id: "qqc-preview-layer",
    class: "kb-overlay view-layer",
    tabindex: "-1",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        qqcDismissPreview();
      }
    },
    onkeydown: (event) => {
      if (event.key === "Escape") qqcDismissPreview();
      if (event.key === "ArrowLeft") qqcStepPreview(-1);
      if (event.key === "ArrowRight") qqcStepPreview(1);
    },
  },
  el("div", { class: "kb-overlay-panel qqc-preview", role: "dialog", "aria-label": "收藏的图" },
    el("div", { class: "kb-overlay-head" },
      el("strong", {}, `${qqcFormatTime(picture.collectedAt)} 收藏`),
      el("div", { class: "kb-overlay-nav" },
        index >= 0 ? el("span", { class: "kb-meta" }, `${index + 1} / ${shown.length}`) : null,
        el("button", { class: "btn small", type: "button", title: "上一张（←）", disabled: index <= 0, onclick: () => qqcStepPreview(-1) }, "←"),
        el("button", { class: "btn small", type: "button", title: "下一张（→）", disabled: index < 0 || index >= shown.length - 1, onclick: () => qqcStepPreview(1) }, "→"),
        el("button", { class: "btn small", type: "button", onclick: qqcDismissPreview }, "关闭"))),
    el("div", { class: "qqc-preview-body" },
      el("a", { class: "qqc-preview-media", href: qqcThumbUrl(picture, 0), target: "_blank", rel: "noreferrer", title: "在新分页打开原图" },
        qqcPreviewImages(picture)),
      el("div", { class: "qqc-preview-info" },
        el("p", { class: "kb-meta" }, `${picture.width} × ${picture.height} · md5 ${picture.md5}`),
        qqcIsSaved(picture)
          ? [el("p", {}, picture.savedBy === "name" ? "✓ 已存（文件名是这张图的 md5，内容被 QQ 重新压缩过）：" : "✓ 已存："), el("code", {}, picture.savedPath),
            el("button", { class: "btn small", type: "button", onclick: () => api("/api/qq-collection/open", { method: "POST", body: JSON.stringify({ path: picture.savedPath }) }).catch((error) => alert(error.message)) }, "打开所在文件夹")]
          : el("button", {
            class: qqc.selected.has(picture.md5) ? "btn" : "btn primary",
            type: "button",
            onclick: () => {
              qqcClickTile(picture.md5, { shiftKey: false });
              qqcRenderPreviewLayer();
            },
          }, qqc.selected.has(picture.md5) ? "取消选中" : "选中这张"),
        el("p", { class: "kb-meta" }, "点图在新分页打开原图。")))));
  document.body.append(layer);
  layer.focus();
};

VIEW_STEP_RESTORERS.qqcollect = (step, overlay) => {
  openQqCollectionView();
  if (overlay?.kind === "qqc") {
    qqc.preview = overlay.key;
    qqcRenderPreviewLayer();
  }
};

VIEW_LEAVE_HOOKS.push(() => {
  qqc.preview = null;
});
