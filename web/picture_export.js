"use strict";

/* ---------- exporting chosen pictures' originals to a folder ----------
   Shared by 画廊 and the backup page's expiring AI originals. The selection
   goes to the server a few at a time (an original may have to come from
   Tencent first), so the page can show progress and stop part-way. Each
   caller shows the status with pictureExportStatus(owner). */

const PICTURE_EXPORT_BATCH = 5;
const PICTURE_EXPORT_MAX = 1000;
const PICTURE_EXPORT_REASONS = {
  gone: "腾讯已删除",
  "no-rkey": "QQ 没在运行，拿不到图片钥匙",
  unavailable: "暂时下载不到",
  "not-found": "没有记录",
};

const pictureExport = { owner: null, running: false, stop: false, done: 0, total: 0, exported: 0, prompts: 0, failed: {}, folder: null, path: null, error: null };

const pictureExportFailedText = () => Object.entries(pictureExport.failed)
  .map(([reason, count]) => `${count} 张${PICTURE_EXPORT_REASONS[reason] ?? reason}`)
  .join("，");

const pictureExportText = () => {
  const job = pictureExport;
  if (job.error !== null) {
    return `导出出错：${job.error}`;
  }
  const failed = pictureExportFailedText();
  if (job.running) {
    return `正在导出 ${job.done} / ${job.total}…`;
  }
  return [
    `导出了 ${job.exported} 张原图${job.prompts > 0 ? `（${job.prompts} 张附咒语 .txt）` : ""}`,
    failed === "" ? "" : `；${failed}`,
    job.stop && job.done < job.total ? `；已停下，还有 ${job.total - job.done} 张没导出` : "",
  ].join("");
};

const pictureExportStatusNodes = (owner) => {
  if (pictureExport.owner !== owner) {
    return [];
  }
  return [
    el("span", {}, pictureExportText()),
    pictureExport.running
      ? el("button", { class: "btn small", type: "button", onclick: () => { pictureExport.stop = true; } }, "停下")
      : pictureExport.folder === null
        ? null
        : el("button", {
          class: "btn small",
          type: "button",
          title: pictureExport.path ?? "",
          onclick: () => api("/api/pictures/export/open", { method: "POST", body: JSON.stringify({ folder: pictureExport.folder }) })
            .catch((error) => alert(error.message)),
        }, "打开文件夹"),
  ];
};

// A slot the caller places in its page; it is refreshed in place while the
// export runs, so the page itself never re-renders mid-export.
const pictureExportStatus = (owner) =>
  el("div", { class: "picture-export-status", "data-export-status": owner, "aria-live": "polite" }, pictureExportStatusNodes(owner));

const renderPictureExportStatus = () => {
  for (const node of document.querySelectorAll("[data-export-status]")) {
    setChildren(node, pictureExportStatusNodes(node.dataset.exportStatus));
  }
};

const runPictureExport = async (md5s, owner) => {
  if (pictureExport.running) {
    return;
  }
  const chosen = [...new Set(md5s)].slice(0, PICTURE_EXPORT_MAX);
  Object.assign(pictureExport, { owner, running: true, stop: false, done: 0, total: chosen.length, exported: 0, prompts: 0, failed: {}, folder: null, path: null, error: null });
  renderPictureExportStatus();
  try {
    for (let start = 0; start < chosen.length && !pictureExport.stop; start += PICTURE_EXPORT_BATCH) {
      const batch = chosen.slice(start, start + PICTURE_EXPORT_BATCH);
      const result = await api("/api/pictures/export", { method: "POST", body: JSON.stringify({ md5s: batch, folder: pictureExport.folder }) });
      pictureExport.folder = result.folder;
      pictureExport.path = result.path;
      for (const item of result.results) {
        if (item.status === "exported") {
          pictureExport.exported += 1;
          pictureExport.prompts += item.prompt ? 1 : 0;
        } else {
          pictureExport.failed[item.status] = (pictureExport.failed[item.status] ?? 0) + 1;
        }
      }
      pictureExport.done = Math.min(chosen.length, start + batch.length);
      renderPictureExportStatus();
    }
  } catch (error) {
    pictureExport.error = error.message;
  } finally {
    pictureExport.running = false;
    renderPictureExportStatus();
  }
};
