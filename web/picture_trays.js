"use strict";

/* ---------- 存图托盘: one action saves a picture's original to a folder ----------
   A tray is a named folder (src/picture_trays.js). A picture gets there by a
   drop on the tray, the 存 button on a tile, a button or a number key in the
   big view, or the tray's own button for the multi-selection. The copies are
   made by the same export the multi-select 「另存到文件夹」 uses. */

const TRAY_DRAG_TYPE = "application/x-chatlens-pictures";
const TRAY_BATCH = 5;
const TRAY_KEYS = 9;
// What a dragged-out file is called until the server has said (format code -> extension).
const TRAY_FORMAT_EXTENSIONS = { 1000: ".jpg", 1001: ".png", 1002: ".webp", 1005: ".bmp", 2000: ".gif", 2001: ".png" };
const TRAY_MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

const pictureTrays = {
  list: null,
  // tray id -> { chain, running, done, total, saved, last } (last: the sentence of the finished save)
  jobs: new Map(),
  // null | "new" | tray id: the tray whose name and folder are being edited.
  editing: null,
  dragging: false,
  // Told which pictures were just saved: (md5s, savedAtUnix, folder).
  onSaved: () => {},
  // Told after a tray was added, changed or removed.
  onChanged: () => {},
  // Told when a drag ends (a wall holds its redraw while a tile is dragged).
  onDragEnd: () => {},
  // Names the server gave for dragging out: md5 -> file name.
  names: new Map(),
};

const loadPictureTrays = async () => {
  try {
    pictureTrays.list = (await api("/api/pictures/trays")).trays;
  } catch {
    pictureTrays.list = null;
  }
  renderTrayDock();
};

const trayById = (id) => pictureTrays.list?.find((tray) => tray.id === id) ?? null;
const firstTray = () => pictureTrays.list?.[0] ?? null;
// "1".."9" -> that tray; "s" -> the first one.
const trayForKey = (key) => {
  if (key === "s" || key === "S") {
    return firstTray();
  }
  return /^[1-9]$/u.test(key) ? pictureTrays.list?.[Number(key) - 1] ?? null : null;
};

const trayJob = (id) => {
  if (!pictureTrays.jobs.has(id)) {
    pictureTrays.jobs.set(id, { chain: Promise.resolve(), running: false, done: 0, total: 0, last: "" });
  }
  return pictureTrays.jobs.get(id);
};

const trayResultText = (tray, result) => {
  if (result.error !== null) {
    return `${result.saved.length === 0 ? "" : `存了 ${briefNumber(result.saved.length)} 张后`}出错，没存完：${result.error}`;
  }
  const originals = result.saved.length - result.previews;
  if (result.saved.length > 0 && result.already === result.saved.length) {
    return `「${tray.name}」里已经有${result.saved.length === 1 ? `这张了：${result.file}` : `这 ${briefNumber(result.saved.length)} 张了`}，没有再存一份`;
  }
  const failed = Object.entries(result.failed)
    .map(([reason, count]) => `${count} 张${PICTURE_EXPORT_REASONS[reason] ?? reason}`)
    .join("，");
  return [
    result.saved.length === 0 ? "" : `已存到「${tray.name}」：${result.saved.length === 1 ? result.file : `${briefNumber(result.saved.length)} 张`}`,
    result.already > 0 ? `（其中 ${briefNumber(result.already)} 张已经在里面，没有再存一份）` : "",
    result.previews > 0 ? `（${originals > 0 ? `其中 ${result.previews} 张` : ""}是以文件发的图，本机没有原文件，存的是 QQ 的预览）` : "",
    failed === "" ? "" : `${result.saved.length === 0 ? "没存成：" : "；没存成："}${failed}`,
  ].join("");
};

const saveBatchesToTray = async (md5s, tray, job) => {
  const result = { saved: [], previews: 0, already: 0, failed: {}, file: "", error: null };
  let counted = 0;
  try {
    for (let start = 0; start < md5s.length; start += TRAY_BATCH) {
      const batch = md5s.slice(start, start + TRAY_BATCH);
      const answer = await api("/api/pictures/export", { method: "POST", body: JSON.stringify({ md5s: batch, tray: tray.id }) });
      const saved = answer.results.filter((item) => item.status === "exported");
      for (const item of answer.results) {
        if (item.status !== "exported") {
          result.failed[item.status] = (result.failed[item.status] ?? 0) + 1;
        }
      }
      result.saved.push(...saved.map((item) => item.md5));
      result.previews += saved.filter((item) => item.previewOnly).length;
      result.already += saved.filter((item) => item.already).length;
      result.file = saved[0]?.file ?? result.file;
      job.done += batch.length;
      counted += batch.length;
      if (saved.length > 0) {
        pictureTrays.onSaved(saved.map((item) => item.md5), Math.floor(Date.now() / 1000), tray.path);
      }
      renderTrayDock();
    }
  } catch (error) {
    result.error = error.message;
    // What this save will not get to still counts as gone through, or the
    // tray would say 「正在存」 for good.
    job.done += md5s.length - counted;
  }
  return result;
};

// Saves the originals into one tray; several saves to the same tray run one
// after another. Resolves to the sentence that says what happened.
const saveToTray = (md5s, trayId) => {
  const tray = trayById(trayId);
  const chosen = [...new Set(md5s)];
  if (tray === null || chosen.length === 0) {
    return Promise.resolve("");
  }
  const job = trayJob(tray.id);
  if (!job.running) {
    Object.assign(job, { done: 0, total: 0, last: "" });
  }
  job.running = true;
  job.total += chosen.length;
  renderTrayDock();
  const run = job.chain.then(() => saveBatchesToTray(chosen, tray, job)).then((result) => {
    const text = trayResultText(tray, result);
    job.last = text;
    return { text, failed: result.error !== null || result.saved.length === 0 };
  });
  job.chain = run.then(() => {
    if (job.done >= job.total) {
      job.running = false;
    }
    renderTrayDock();
  });
  return run;
};

// For places with no line of their own to say it in (a tile's 存 button, a drop).
const saveToTrayAndTell = (md5s, trayId) => saveToTray(md5s, trayId).then((outcome) => {
  if (outcome !== "" && outcome.text !== "") {
    notify(outcome.text, { isError: outcome.failed });
  }
  return outcome;
});

/* ---------- dragging pictures ---------- */

const trayDragName = (item) => {
  const known = pictureTrays.names.get(item.md5);
  return known ?? `${item.md5}${TRAY_FORMAT_EXTENSIONS[item.format] ?? ".jpg"}`;
};

// Asked when the pointer goes down on a tile, so the name is usually here by
// the time a drag starts (a drag cannot wait for an answer).
const prepareTrayDrag = (item) => {
  if (pictureTrays.names.has(item.md5)) {
    return;
  }
  // null = asked, and the original is not on this computer yet.
  pictureTrays.names.set(item.md5, null);
  api(`/api/pictures/save-name?md5=${item.md5}`)
    .then((answer) => pictureTrays.names.set(item.md5, answer.name ?? null))
    .catch(() => pictureTrays.names.delete(item.md5));
};

// md5s: everything that travels with the drag (the whole selection when the
// dragged tile is part of it). A single picture can also be dropped on the
// desktop or into a folder window: the browser downloads its original there.
const startTrayDrag = (event, item, md5s) => {
  const transfer = event.dataTransfer;
  transfer.effectAllowed = "copy";
  transfer.setData(TRAY_DRAG_TYPE, JSON.stringify(md5s));
  if (md5s.length === 1) {
    const name = trayDragName(item);
    const type = TRAY_MIME[/\.[a-z0-9]+$/iu.exec(name)?.[0].toLowerCase()] ?? "application/octet-stream";
    const url = `${location.origin}/picture-save?md5=${item.md5}`;
    transfer.setData("DownloadURL", `${type}:${name}:${url}`);
    transfer.setData("text/uri-list", url);
  } else {
    const count = el("div", { class: "tray-drag-count" }, `${briefNumber(md5s.length)} 张`);
    document.body.append(count);
    transfer.setDragImage(count, 24, 18);
    setTimeout(() => count.remove(), 0);
  }
  pictureTrays.dragging = true;
  document.getElementById("tray-dock")?.classList.add("dragging");
};

const endTrayDrag = () => {
  pictureTrays.dragging = false;
  document.getElementById("tray-dock")?.classList.remove("dragging");
  for (const node of document.querySelectorAll(".tray.over")) {
    node.classList.remove("over");
  }
  pictureTrays.onDragEnd();
};

const draggedMd5s = (event) => {
  try {
    const md5s = JSON.parse(event.dataTransfer.getData(TRAY_DRAG_TYPE));
    return Array.isArray(md5s) ? md5s.filter((md5) => /^[a-f0-9]{32}$/u.test(md5)) : [];
  } catch {
    return [];
  }
};

/* ---------- the dock ---------- */

const changeTrays = async (body) => {
  try {
    pictureTrays.list = (await api("/api/pictures/trays", { method: "POST", body: JSON.stringify(body) })).trays;
    pictureTrays.editing = null;
    pictureTrays.onChanged();
  } catch (error) {
    // The form stays as typed, so the folder can be corrected.
    notifyError(error);
    return;
  }
  renderTrayDock();
};

const trayEditForm = (tray) => {
  const isNew = tray === null;
  const isFirst = tray?.id === pictureTrays.list?.[0]?.id;
  const name = el("input", { type: "text", value: tray?.ownName ?? "", placeholder: "不填就用文件夹的名字", "aria-label": "托盘的名字", maxlength: "24" });
  const dir = el("input", { type: "text", value: tray?.dir ?? "", placeholder: "例如 D:\\图片\\角色", "aria-label": "托盘的文件夹" });
  const close = () => {
    pictureTrays.editing = null;
    renderTrayDock();
  };
  return el("form", {
    class: "tray-edit",
    onsubmit: (event) => {
      event.preventDefault();
      changeTrays(isNew
        ? { action: "add", name: name.value, dir: dir.value }
        : { action: "update", id: tray.id, name: name.value, dir: dir.value });
    },
  },
  el("label", {}, el("span", {}, "文件夹"), dir),
  isFirst && tray.dir === "" ? el("span", { class: "kb-meta" }, `现在存到 ${tray.path}`) : null,
  el("label", {}, el("span", {}, "名字"), name),
  el("div", { class: "tray-edit-actions" },
    el("button", { class: "btn small primary", type: "submit" }, isNew ? "加上" : "保存"),
    el("button", { class: "btn small", type: "button", onclick: close }, "取消"),
    isNew || isFirst
      ? null
      : el("button", {
        class: "btn small",
        type: "button",
        title: "只是从这里拿掉，文件夹和里面的图都不动",
        onclick: () => changeTrays({ action: "remove", id: tray.id }),
      }, "移除托盘")));
};

// The end of the path is what tells two trays apart; the whole path is in the title.
const trayPathLabel = (folder) => {
  const parts = String(folder).split(/[\\/]+/u).filter((part) => part !== "");
  return parts.length <= 3 ? folder : `…\\${parts.slice(-2).join("\\")}`;
};

const trayStatusText = (tray) => {
  const job = pictureTrays.jobs.get(tray.id);
  if (job === undefined) {
    return "";
  }
  return job.running ? `正在存 ${briefNumber(job.done)} / ${briefNumber(job.total)}…` : job.last;
};

const trayNode = (tray, index, { selected = [] } = {}) => {
  if (pictureTrays.editing === tray.id) {
    return el("div", { class: "tray editing" }, trayEditForm(tray));
  }
  const key = index < TRAY_KEYS ? String(index + 1) : "";
  const status = trayStatusText(tray);
  return el("div", {
    class: "tray",
    dataset: { tray: tray.id },
    ondragover: (event) => {
      if (event.dataTransfer.types.includes(TRAY_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.classList.add("over");
      }
    },
    ondragleave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove("over");
      }
    },
    ondrop: (event) => {
      event.preventDefault();
      const md5s = draggedMd5s(event);
      endTrayDrag();
      saveToTrayAndTell(md5s, tray.id);
    },
  },
  el("div", { class: "tray-head" },
    key === "" ? null : el("kbd", { class: "tray-key", title: index === 0 ? "看大图或多选时按 1 或 S，存到这里" : `看大图或多选时按 ${key}，存到这里` }, key),
    el("strong", { class: "tray-name" }, tray.name),
    el("button", {
      class: "kb-linkish",
      type: "button",
      title: tray.path,
      onclick: () => api("/api/pictures/export/open", { method: "POST", body: JSON.stringify({ folder: `tray:${tray.id}` }) }).catch((error) => notifyError(error)),
    }, "打开"),
    el("button", { class: "kb-linkish", type: "button", onclick: () => { pictureTrays.editing = tray.id; renderTrayDock(); } }, "改")),
  el("code", { class: "tray-path", title: tray.path }, trayPathLabel(tray.path)),
  selected.length === 0
    ? null
    : el("button", { class: "btn small primary tray-take", type: "button", onclick: () => saveToTrayAndTell(selected, tray.id) },
      `存入已选的 ${briefNumber(selected.length)} 张`),
  status === "" ? null : el("span", { class: "tray-status", "aria-live": "polite" }, status));
};

// selected(): the md5s a tray's own button would save (the page's multi-selection).
const trayDockOptions = { selected: () => [] };

const trayDockNodes = () => {
  const trays = pictureTrays.list;
  if (trays === null) {
    return [];
  }
  const selected = trayDockOptions.selected();
  return [
    el("div", { class: "tray-dock-head" },
      el("strong", {}, "存图托盘"),
      el("span", { class: "kb-meta" }, "把图片拖进来，原图就存进文件夹。看大图时按托盘的数字也行")),
    trays.map((tray, index) => trayNode(tray, index, { selected })),
    pictureTrays.editing === "new"
      ? el("div", { class: "tray editing" }, trayEditForm(null))
      : el("button", { class: "kb-linkish tray-add", type: "button", onclick: () => { pictureTrays.editing = "new"; renderTrayDock(); } }, "＋ 加一个托盘"),
  ];
};

// selected: () => md5s of the page's multi-selection.
const trayDock = ({ selected = () => [] } = {}) => {
  trayDockOptions.selected = selected;
  return el("aside", { id: "tray-dock", class: pictureTrays.dragging ? "tray-dock dragging" : "tray-dock", "aria-label": "存图托盘" }, trayDockNodes());
};

const renderTrayDock = () => {
  const node = document.getElementById("tray-dock");
  // A form being typed in is not rebuilt by a save that finishes meanwhile.
  if (node !== null && !(pictureTrays.editing !== null && node.contains(document.activeElement) && document.activeElement.tagName === "INPUT")) {
    setChildren(node, trayDockNodes());
  }
};

document.addEventListener("dragend", endTrayDrag);
