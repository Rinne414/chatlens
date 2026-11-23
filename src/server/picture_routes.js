"use strict";

// HTTP side of the picture service. /picture is served beside /runs/ and
// /knowledge-file (an <img src> cannot send the API token): local Host only,
// cross-site requests refused by the caller, and the file is looked up by md5
// in the store, never by a client-supplied path.

const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream");
const jobs = require("./picture_jobs");
const picturePass = require("./picture_pass");
const service = require("./picture_service");
const exportOps = require("./picture_export_ops");
const unkeepOps = require("./picture_unkeep");
const { fingerprintOfSmallGray } = require("../picture_similar");

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const STATE_TEXT = {
  gone: "腾讯服务器已删除这张图（超过 31 天）。",
  "no-rkey": "拿不到 QQ 的图片钥匙：请确认 QQ 正在运行。",
  unavailable: "暂时下载不到这张图，稍后再试。",
  "not-found": "没有这张图的记录。",
  "file-only": "这张图是以文件发的，本机找不到原文件，也还没有 QQ 的预览。",
};

const sendImage = (response, filePath, extraHeaders = {}) => {
  const type = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
  if (type === undefined || !fs.existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": type,
    // md5-named content never changes; a day of caching keeps chat scrolling cheap.
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(response);
};

// RFC 6266: an ASCII fallback plus the real (Chinese) name.
const disposition = (md5, filePath) => {
  const name = exportOps.downloadName(md5, filePath);
  return `inline; filename="${md5}${path.extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const servePicture = async (response, url) => {
  const md5 = String(url.searchParams.get("md5") ?? "").toLowerCase();
  const size = url.searchParams.get("size") ?? "thumb";
  const result = await jobs.resolvePicture(md5, size);
  if (result.filePath !== undefined) {
    sendImage(response, result.filePath, { "content-disposition": disposition(md5, result.filePath) });
    return;
  }
  if (result.fallback) {
    sendImage(response, result.fallback, { "x-picture-state": result.error, "cache-control": "no-cache" });
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-picture-state": result.error });
  response.end(STATE_TEXT[result.error] ?? "Not found");
};

// /picture-save: the original as a download, for a picture dragged out of the
// page onto the desktop or into a folder. Unlike /picture it never sends a
// smaller stand-in: a file saved under the original's name is the original.
const servePictureDownload = async (response, url) => {
  const md5 = String(url.searchParams.get("md5") ?? "").toLowerCase();
  const source = await exportOps.originalForDownload(md5);
  if (source.error !== undefined) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-picture-state": source.error });
    response.end(STATE_TEXT[source.error] ?? "Not found");
    return;
  }
  const done = () => {
    if (source.temporary) {
      fs.rmSync(source.filePath, { force: true });
    }
  };
  response.writeHead(200, {
    "content-type": IMAGE_TYPES[path.extname(source.name).toLowerCase()] ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${md5}${path.extname(source.name)}"; filename*=UTF-8''${encodeURIComponent(source.name)}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  // pipeline closes the file when the browser gives up half-way too, so the
  // temp copy can always be removed.
  pipeline(fs.createReadStream(source.filePath), response, done);
};

const workflowResponse = (response, md5, sendError) => {
  const chunks = picturePass.workflow(md5);
  if (chunks === null) {
    sendError(response, 404, "这张图没有保存的工作流。");
    return;
  }
  const body = typeof chunks.workflow === "string" ? chunks.workflow : JSON.stringify(chunks, null, 2);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${md5}-${typeof chunks.workflow === "string" ? "workflow" : "metadata"}.json"`,
    "cache-control": "no-store",
  });
  response.end(body);
};

// Returns true when the request was one of ours.
const handlePictureApi = async (request, response, url, { sendJson, sendError, readBody }) => {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/pictures/status":
      sendJson(response, 200, picturePass.status());
      return true;
    case "POST /api/pictures/settings":
      sendJson(response, 200, { settings: service.saveSettings(await readBody(request)) });
      return true;
    case "POST /api/pictures/run":
      picturePass.runPass({ reason: "manual" }).catch((error) => console.error(`picture pass failed: ${error.message}`));
      sendJson(response, 200, { started: true });
      return true;
    case "POST /api/pictures/keep":
      sendJson(response, 200, await jobs.keepOriginals((await readBody(request)).md5s));
      return true;
    case "POST /api/pictures/unkeep":
      sendJson(response, 200, await unkeepOps.unkeep(await readBody(request)));
      return true;
    case "POST /api/pictures/reconcile":
      sendJson(response, 200, await unkeepOps.reconcile(await readBody(request)));
      return true;
    case "POST /api/pictures/restore":
      sendJson(response, 200, await unkeepOps.restore(await readBody(request)));
      return true;
    case "POST /api/pictures/empty-removed":
      sendJson(response, 200, await unkeepOps.empty(await readBody(request)));
      return true;
    case "POST /api/pictures/export":
      sendJson(response, 200, await exportOps.exportPictures(await readBody(request)));
      return true;
    case "POST /api/pictures/export/undo":
      sendJson(response, 200, exportOps.undoSaves(await readBody(request)));
      return true;
    case "GET /api/pictures/save-dir":
      sendJson(response, 200, exportOps.getSaveTarget());
      return true;
    case "POST /api/pictures/save-dir":
      sendJson(response, 200, exportOps.setSaveDir(await readBody(request)));
      return true;
    case "POST /api/pictures/fingerprint":
      // A picture of the user's own, already shrunk to 32x32 grey values by
      // the page: only its fingerprint is worked out, nothing is stored.
      sendJson(response, 200, fingerprintOfSmallGray((await readBody(request)).gray));
      return true;
    case "GET /api/pictures/trays":
      sendJson(response, 200, exportOps.getTrays());
      return true;
    case "POST /api/pictures/trays":
      sendJson(response, 200, exportOps.changeTrays(await readBody(request)));
      return true;
    case "GET /api/pictures/save-name":
      sendJson(response, 200, exportOps.saveName(String(url.searchParams.get("md5") ?? "").toLowerCase()));
      return true;
    case "POST /api/pictures/export/open":
      sendJson(response, 200, exportOps.openExportFolder(await readBody(request)));
      return true;
    case "GET /api/pictures/expiring":
      sendJson(response, 200, picturePass.expiring());
      return true;
    case "GET /api/pictures/workflow":
      workflowResponse(response, String(url.searchParams.get("md5") ?? "").toLowerCase(), sendError);
      return true;
    default:
      return false;
  }
};

module.exports = { servePicture, servePictureDownload, handlePictureApi, STATE_TEXT };
