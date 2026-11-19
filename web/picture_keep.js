"use strict";

/* ---------- two different ways to hold on to an original ----------
   留存: the original goes into this tool's own store (store/media-objects),
     so it still opens after Tencent deleted it; 画廊 →「留存的原图」lists them.
   另存为: a copy goes to a place the user picks, outside the tool.
   One picture is saved as through the browser (a real "save as" dialog where
   the browser has one, its downloads folder otherwise); many at once go to
   the save folder (picture_export.js). */

const PICTURE_KEEP_BATCH = 5;
const PICTURE_KEEP_REASONS = {
  gone: "腾讯已删除",
  "no-rkey": "QQ 没在运行，拿不到图片钥匙",
  unavailable: "暂时下载不到",
  "not-found": "没有记录",
  "file-only": "是以文件发的图，腾讯那边没有原图",
};
const SAVE_AS_PROBLEMS = {
  gone: "腾讯服务器已经删除这张图，原图取不到了。",
  "no-rkey": "拿不到 QQ 的图片钥匙，请确认 QQ 正在运行。",
  unavailable: "暂时下载不到原图，稍后再试。",
  "not-found": "没有这张图的记录。",
  "file-only": "这张图是以文件发的，本机找不到原文件，也还没有 QQ 的预览。",
};
const KEEP_LABEL_TITLE = "把原图存进本工具（store/media-objects），腾讯删掉之后也能看，在画廊「留存的原图」里找；不会出现在你自己的文件夹里";
const SAVE_AS_TITLE = "把原图存到你选的位置。文件名是「时间_群_发图人_编号」，不会和别的图重名";

/* ---------- 留存 many ---------- */

const pictureKeep = { owner: null, running: false, stop: false, done: 0, total: 0, kept: 0, failed: {}, error: null };

const pictureKeepText = () => {
  const job = pictureKeep;
  if (job.error !== null) {
    return `留存出错：${job.error}`;
  }
  if (job.running) {
    return `正在留存 ${job.done} / ${job.total}…`;
  }
  const failed = Object.entries(job.failed)
    .map(([reason, count]) => `${count} 张${PICTURE_KEEP_REASONS[reason] ?? reason}`)
    .join("，");
  return [
    `留存了 ${job.kept} 张原图，在「留存的原图」里能看到`,
    failed === "" ? "" : `；没留成：${failed}`,
    job.stop && job.done < job.total ? `；已停下，还有 ${job.total - job.done} 张没处理` : "",
  ].join("");
};

const pictureKeepStatusNodes = (owner) => {
  if (pictureKeep.owner !== owner) {
    return [];
  }
  return [
    el("span", {}, pictureKeepText()),
    pictureKeep.running
      ? el("button", { class: "btn small", type: "button", onclick: () => { pictureKeep.stop = true; } }, "停下")
      : null,
  ];
};

// A slot the caller places in its page, refreshed in place while the job runs.
const pictureKeepStatus = (owner) =>
  el("div", { class: "picture-export-status", "data-keep-status": owner, "aria-live": "polite" }, pictureKeepStatusNodes(owner));

const renderPictureKeepStatus = () => {
  for (const node of document.querySelectorAll("[data-keep-status]")) {
    setChildren(node, pictureKeepStatusNodes(node.dataset.keepStatus));
  }
};

// onKept(md5s) is told after each batch which pictures are now kept, so the
// caller can mark its tiles without reloading.
const runPictureKeep = async (md5s, owner, onKept = () => {}) => {
  if (pictureKeep.running) {
    return;
  }
  const chosen = [...new Set(md5s)];
  Object.assign(pictureKeep, { owner, running: true, stop: false, done: 0, total: chosen.length, kept: 0, failed: {}, error: null });
  renderPictureKeepStatus();
  try {
    for (let start = 0; start < chosen.length && !pictureKeep.stop; start += PICTURE_KEEP_BATCH) {
      const batch = chosen.slice(start, start + PICTURE_KEEP_BATCH);
      const result = await api("/api/pictures/keep", { method: "POST", body: JSON.stringify({ md5s: batch }) });
      const kept = result.results.filter((item) => item.status === "kept").map((item) => item.md5);
      pictureKeep.kept += kept.length;
      for (const item of result.results) {
        if (item.status !== "kept") {
          pictureKeep.failed[item.status] = (pictureKeep.failed[item.status] ?? 0) + 1;
        }
      }
      pictureKeep.done = Math.min(chosen.length, start + batch.length);
      onKept(kept);
      renderPictureKeepStatus();
    }
  } catch (error) {
    pictureKeep.error = error.message;
  } finally {
    pictureKeep.running = false;
    renderPictureKeepStatus();
  }
};

/* ---------- 另存为 one ---------- */

// The name the server gives the file (时间_群_发图人_编号.ext).
const pictureDownloadName = (response, md5) => {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A name that does not decode falls back to the plain one below.
    }
  }
  return /filename="([^"]+)"/iu.exec(header)?.[1] ?? md5;
};

const saveBlobWithPicker = async (blob, name) => {
  const extension = /\.[a-z0-9]+$/iu.exec(name)?.[0] ?? "";
  const options = { suggestedName: name };
  if (extension !== "" && blob.type !== "") {
    options.types = [{ description: "图片", accept: { [blob.type]: [extension] } }];
  }
  const handle = await window.showSaveFilePicker(options);
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle.name;
};

const saveBlobAsDownload = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

// Returns the sentence to show. A smaller stand-in the server sends when the
// original cannot be had is never saved as if it were the original.
const savePictureAs = async (md5) => {
  const response = await fetch(pictureUrl(md5, "original"));
  const problem = response.headers.get("x-picture-state");
  if (!response.ok || problem !== null) {
    return SAVE_AS_PROBLEMS[problem] ?? "这张图暂时取不到，没有另存。";
  }
  const blob = await response.blob();
  const name = pictureDownloadName(response, md5);
  if (typeof window.showSaveFilePicker === "function") {
    try {
      return `已另存为 ${await saveBlobWithPicker(blob, name)}。`;
    } catch (error) {
      if (error.name === "AbortError") {
        return "";
      }
      // The browser refused the dialog (too long since the click, or not
      // allowed here): an ordinary download still gets the file out.
      if (error.name !== "SecurityError" && error.name !== "NotAllowedError") {
        throw error;
      }
    }
  }
  saveBlobAsDownload(blob, name);
  return `已交给浏览器下载：${name}（在浏览器的下载文件夹里）。`;
};
