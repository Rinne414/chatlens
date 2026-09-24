"use strict";

// HTTP side of the picture service. /picture is served beside /runs/ and
// /knowledge-file (an <img src> cannot send the API token): local Host only,
// cross-site requests refused by the caller, and the file is looked up by md5
// in the store, never by a client-supplied path.

const fs = require("node:fs");
const path = require("node:path");
const jobs = require("./picture_jobs");
const picturePass = require("./picture_pass");
const service = require("./picture_service");

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const STATE_TEXT = {
  gone: "腾讯服务器已删除这张图（超过 31 天）。",
  "no-rkey": "拿不到 QQ 的图片钥匙：请确认 QQ 正在运行。",
  unavailable: "暂时下载不到这张图，稍后再试。",
  "not-found": "没有这张图的记录。",
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

const servePicture = async (response, url) => {
  const md5 = String(url.searchParams.get("md5") ?? "").toLowerCase();
  const size = url.searchParams.get("size") ?? "thumb";
  const result = await jobs.resolvePicture(md5, size);
  if (result.filePath !== undefined) {
    sendImage(response, result.filePath);
    return;
  }
  if (result.fallback) {
    sendImage(response, result.fallback, { "x-picture-state": result.error, "cache-control": "no-cache" });
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-picture-state": result.error });
  response.end(STATE_TEXT[result.error] ?? "Not found");
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

module.exports = { servePicture, handlePictureApi, STATE_TEXT };
