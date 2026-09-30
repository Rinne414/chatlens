"use strict";

/* ---------- QQ 收藏图 ----------
   QQ's own collection, its pictures and which of them the user already
   saved. QQ's collection page saves one picture at a time and syncs in jumps
   without saying so; this page says how far QQ synced to this computer,
   finds which pictures are already in the user's folders (same md5, or a file
   named after the md5: QQ's own "save" re-compresses but keeps that name),
   shows the stretches of days not saved yet and saves any selection.
   This file: state, loading, sync status, folders and their scan. The day
   strip, stretches, wall, selection, saving and preview are in
   qq_collection_wall.js; pure day maths in qq_collection_days.js. */

const QQC_SCAN_POLL_MS = 1000;

const qqc = {
  data: null,
  loading: false,
  error: null,
  editingFolders: false,
  scanTimer: null,
  filter: "all",
  range: null,
  selected: new Set(),
  anchor: null,
  save: { running: false, stop: false, done: 0, total: 0, saved: 0, recompressed: 0, failed: {}, error: null },
  preview: null,
  showAllRuns: false,
};

const qqcPictures = () => qqc.data?.pictures ?? [];
const qqcIsSaved = (picture) => picture.savedPath !== null;
const qqcFormatTime = (ms) => {
  const hkt = unixToHkt(Math.floor(ms / 1000));
  return `${Number(hkt.slice(5, 7))}月${Number(hkt.slice(8, 10))}日 ${hkt.slice(11, 16)}`;
};
const qqcFormatDay = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

/* ---------- loading ---------- */

const loadQqCollection = async (path = "/api/qq-collection", options = undefined) => {
  qqc.loading = true;
  qqc.error = null;
  renderQqCollectionView();
  try {
    qqc.data = await api(path, options);
    const known = new Set(qqcPictures().map((picture) => picture.md5));
    qqc.selected = new Set([...qqc.selected].filter((md5) => known.has(md5)));
  } catch (error) {
    qqc.error = error.message;
  }
  qqc.loading = false;
  renderQqCollectionView();
  qqcAutoScan();
};

const openQqCollectionView = () => {
  showView("qqcollect");
  if (qqc.data === null) {
    loadQqCollection();
  } else {
    renderQqCollectionView();
  }
  if (qqc.data?.scan.running) {
    qqcPollScan();
  }
};

VIEW_RELOADERS.qqcollect = () => loadQqCollection();

/* ---------- scanning the folders ---------- */

const qqcScanText = (scan) => {
  if (scan.error) {
    return `检查出错：${scan.error}`;
  }
  if (scan.running) {
    return scan.phase === "listing"
      ? "正在列出文件夹里的图…"
      : `正在检查 ${briefNumber(scan.done)} / ${briefNumber(scan.total)} 个文件（读了 ${briefNumber(scan.hashed)} 个新的或改过的）`;
  }
  const last = scan.last;
  if (last === null || last === undefined) {
    return "还没检查过文件夹。";
  }
  const failed = last.failed > 0 ? `；${briefNumber(last.failed)} 个读不了（可能正被占用），下次检查再读` : "";
  return `${qqcFormatTime(last.finishedAt)} 检查过 ${briefNumber(last.files)} 个文件${last.stopped ? "（中途停下了）" : ""}${failed}`;
};

// Folders the last scan could not open (a drive not plugged in, no
// permission): what was known about them is kept, so say so.
const qqcUnreadableNote = (scan) => {
  const dirs = scan.running ? [] : scan.last?.unreadable ?? [];
  if (dirs.length === 0) {
    return null;
  }
  return el("details", { class: "qqc-unreadable" },
    el("summary", {}, `${briefNumber(dirs.length)} 个文件夹打不开（磁盘没接上或没有权限？），里面记下的图先保留`),
    el("ul", {}, dirs.map((dir) => el("li", {}, el("code", {}, dir)))));
};

const qqcRenderScanStatus = () => {
  const node = $("#qqc-scan-status");
  const scan = qqc.data?.scan;
  if (node === null || scan === undefined) {
    return;
  }
  const percent = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;
  setChildren(node,
    el("span", {}, qqcScanText(scan)),
    scan.running ? el("span", { class: "qqc-progress", role: "progressbar", "aria-valuenow": String(percent), "aria-valuemin": "0", "aria-valuemax": "100" }, el("span", { style: `width:${percent}%` })) : null,
    scan.running
      ? el("button", { class: "btn small", type: "button", onclick: () => api("/api/qq-collection/scan/stop", { method: "POST" }).catch(() => {}) }, "停下")
      : el("button", { class: "btn small", type: "button", disabled: qqc.save.running || qqc.data.settings.scanDirs.length === 0, onclick: qqcStartScan }, "重新检查文件夹"),
    qqcUnreadableNote(scan));
};

const qqcPollScan = () => {
  clearTimeout(qqc.scanTimer);
  qqc.scanTimer = setTimeout(async () => {
    try {
      const scan = await api("/api/qq-collection/scan");
      qqc.data.scan = scan;
      if (scan.running) {
        qqcRenderScanStatus();
        qqcPollScan();
        return;
      }
      await loadQqCollection();
    } catch {
      qqcPollScan();
    }
  }, QQC_SCAN_POLL_MS);
};

const qqcStartScan = async () => {
  try {
    qqc.data.scan = await api("/api/qq-collection/scan", { method: "POST" });
    qqcRenderScanStatus();
    qqcPollScan();
  } catch (error) {
    alert(error.message);
  }
};

// The first visit with folders set but never checked: check right away.
const qqcAutoScan = () => {
  const data = qqc.data;
  if (data !== null && data.settings.scanDirs.length > 0 && !data.scan.running && data.scan.last === null && data.scan.indexedFiles === 0) {
    qqcStartScan();
  }
};

/* ---------- sections ---------- */

const qqcSyncNotice = (data) => {
  const sync = data.sync;
  if (sync === null) {
    return null;
  }
  return el("div", { class: "qqc-sync" },
    el("p", {},
      "QQ 在这台电脑上的收藏只同步到 ",
      el("strong", {}, sync.newestAt ? qqcFormatTime(sync.newestAt) : "（不知道）"),
      sync.checkedAt ? `（QQ ${qqcFormatTime(sync.checkedAt)} 连过收藏服务器）` : "",
      "。之后收藏的图，QQ 还没下载到这台电脑，这里也看不到。"),
    sync.placeholders > 0 ? el("p", { class: "kb-meta" }, `另有 ${briefNumber(sync.placeholders)} 条收藏 QQ 只记了一个编号、内容没下载，看不到是什么。`) : null,
    el("p", { class: "kb-meta" }, "想补上最新的：先在 QQ 里打开「收藏」，往下拉刷新、再往下翻到底，让 QQ 同步，然后点右边的「重新读取」。"));
};

const qqcHeader = (data) => {
  const pictures = qqcPictures();
  const saved = pictures.filter(qqcIsSaved).length;
  return el("section", { class: "card qqc-head" },
    el("div", { class: "qqc-head-main" },
      el("h2", {}, "QQ 收藏里的图"),
      el("p", { class: "qqc-counts" },
        el("strong", {}, briefNumber(pictures.length)), " 张 · ",
        el("span", { class: "qqc-saved-text" }, "已存 ", el("strong", {}, briefNumber(saved))), " · ",
        el("span", { class: "qqc-unsaved-text" }, "没存 ", el("strong", {}, briefNumber(pictures.length - saved)))),
      qqcSyncNotice(data)),
    el("div", { class: "gp-head-actions" },
      el("button", {
        class: "btn", type: "button", disabled: qqc.loading || qqc.save.running,
        title: "再读一次 QQ 的收藏（QQ 同步了新的收藏之后）",
        onclick: () => loadQqCollection("/api/qq-collection/reload", { method: "POST" }),
      }, qqc.loading ? "正在读取…" : "重新读取"),
      data.readAt ? el("span", { class: "kb-meta" }, `读取于 ${qqcFormatTime(data.readAt)}`) : null));
};

const qqcSaveFolders = async (form) => {
  const scanDirs = form.querySelector("[name=scanDirs]").value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const saveDir = form.querySelector("[name=saveDir]").value.trim();
  try {
    const result = await api("/api/qq-collection/settings", { method: "POST", body: JSON.stringify({ scanDirs, saveDir }) });
    qqc.data.settings = result.settings;
    qqc.editingFolders = false;
    renderQqCollectionView();
    qqcStartScan();
  } catch (error) {
    alert(error.message);
  }
};

const qqcFolderForm = (settings) => {
  const form = el("form", {
    class: "qqc-folder-form",
    onsubmit: (event) => {
      event.preventDefault();
      qqcSaveFolders(event.currentTarget);
    },
  },
  el("label", {}, el("span", { class: "gp-label" }, "检查这些文件夹（每行一个，子文件夹也会检查）"),
    el("textarea", { name: "scanDirs", rows: "3", spellcheck: "false", placeholder: "例如 D:\\Pictures\\QQ收藏" }, settings.scanDirs.join("\n"))),
  el("label", {}, el("span", { class: "gp-label" }, "新存的图放到"),
    el("input", { name: "saveDir", type: "text", spellcheck: "false", value: settings.saveDir, placeholder: "例如 D:\\Pictures\\QQ收藏\\新存的" })),
  el("div", { class: "qqc-form-actions" },
    el("button", { class: "btn primary", type: "submit", dataset: { waitSave: "" }, disabled: qqc.save.running, title: qqc.save.running ? "存完图再改" : null }, "保存并检查"),
    settings.scanDirs.length > 0 ? el("button", { class: "btn", type: "button", onclick: () => { qqc.editingFolders = false; renderQqCollectionView(); } }, "取消") : null));
  return form;
};

const qqcFolders = (data) => {
  const settings = data.settings;
  const editing = qqc.editingFolders || settings.scanDirs.length === 0;
  return el("section", { class: "card qqc-folders" },
    el("div", { class: "gp-section-head" },
      el("h3", {}, "你的图存在哪"),
      editing ? null : el("button", { class: "btn small", type: "button", dataset: { waitSave: "" }, disabled: qqc.save.running, title: qqc.save.running ? "存完图再改" : null, onclick: () => { qqc.editingFolders = true; renderQqCollectionView(); } }, "更改")),
    el("p", { class: "kb-meta" }, "同一张图（内容一样），或文件名就是这张图的 md5（在 QQ 收藏里「另存为」会重新压缩成 JPG，但保留这个名字）都算已存；分到哪个子文件夹、改没改名都认得出来。"),
    editing
      ? qqcFolderForm(settings)
      : el("dl", { class: "qqc-folder-list" },
        el("dt", {}, "检查"), el("dd", {}, settings.scanDirs.map((dir) => el("code", {}, dir))),
        el("dt", {}, "新图存到"), el("dd", {}, settings.saveDir ? el("code", {}, settings.saveDir) : el("span", { class: "kb-meta" }, "还没选"))),
    el("div", { id: "qqc-scan-status", class: "qqc-scan-status", "aria-live": "polite" }));
};

// A save starting: the folder buttons wait, in place (a form being typed in
// keeps its text); the page is drawn again when the save ends.
const qqcLockFolders = () => {
  for (const button of document.querySelectorAll("#view-qqcollect .qqc-folders [data-wait-save]")) {
    button.disabled = true;
    button.title = "存完图再改";
  }
  qqcRenderScanStatus();
};

const renderQqCollectionView = () => {
  const root = $("#view-qqcollect");
  if (root === null || app.view !== "qqcollect") {
    return;
  }
  const data = qqc.data;
  if (data === null) {
    setChildren(root, qqc.error ? el("div", { class: "notice risk" }, `读取失败：${qqc.error}`) : el("p", { class: "kb-meta" }, "正在读取 QQ 收藏…"));
    return;
  }
  setChildren(root, el("div", { class: `qqc-page ${qqc.loading ? "is-loading" : ""}` },
    qqc.error ? el("div", { class: "notice risk" }, qqc.error) : null,
    data.error ? el("div", { class: "notice risk" }, data.error) : null,
    qqcHeader(data),
    qqcFolders(data),
    qqcPictures().length === 0 ? null : [qqcTimeline(), qqcToolbar(), qqcWall()]));
  qqcRenderScanStatus();
  qqcRenderSaveBar();
  qqcRenderPreviewLayer();
  qqcObserveThumbs(root);
};
