"use strict";

// The remote entrance: a second listener, on 127.0.0.1 only, that
// `tailscale serve` forwards the phone's HTTPS requests to. The computer's own
// console (control_center.js on 8321) is untouched by it.
//
// Every request must name this computer's Tailscale host, and everything
// except the pairing page needs a paired device's cookie. API calls must also
// be on the phone list (remote_policy.js) and still carry the page token, as
// on the computer.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  isRemoteApiAllowed,
  isRemoteRunsFileAllowed,
  isPublicPath,
  readCookie,
  deviceCookie,
  clearedDeviceCookie,
  hostMatches,
  DEVICE_COOKIE,
} = require("./remote_policy");

const MAX_PAIR_BODY_BYTES = 1024;
// Pairing attempts accepted per minute, from all phones together.
const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60 * 1000;

const PAIR_FAILURES = {
  "no-code": "电脑上还没有生成配对码：请在电脑的 设置 → 手机连线 里点「配对新手机」。",
  expired: "配对码已过期，请在电脑上重新生成。",
  wrong: "配对码不对，请再核对一次。",
  burned: "错误次数太多，这个配对码已作废，请在电脑上重新生成。",
  full: "已配对的设备太多了，请先在电脑上取消不用的设备。",
};

const readSmallJson = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PAIR_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });

// Another site's page asking for our pictures or scripts. Opening the console
// from a link is still allowed (a top-level GET navigation).
const isForeignRequest = (request) => {
  const site = request.headers["sec-fetch-site"];
  if (site !== "cross-site" && site !== "same-site") {
    return false;
  }
  return !(request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate");
};

const wantsPage = (request, pathname) =>
  request.method === "GET" && (pathname === "/" || pathname === "/index.html" || String(request.headers.accept ?? "").includes("text/html"));

const createRemoteGateway = ({ devices, routeRequest, applySecurityHeaders, sendJson, sendError, webDir, port, now = Date.now, log = console.log }) => {
  let server = null;
  let listenError = null;
  let pairWindow = { startedAt: 0, count: 0 };

  const takePairAttempt = () => {
    const at = now();
    if (at - pairWindow.startedAt >= PAIR_RATE_WINDOW_MS) {
      pairWindow = { startedAt: at, count: 0 };
    }
    pairWindow = { ...pairWindow, count: pairWindow.count + 1 };
    return pairWindow.count <= PAIR_RATE_LIMIT;
  };

  const servePairPage = (response) => {
    const html = fs.readFileSync(path.join(webDir, "pair.html"), "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  };

  const handlePair = async (request, response) => {
    if (!takePairAttempt()) {
      sendJson(response, 429, { error: "尝试太频繁，请一分钟后再试。" });
      return;
    }
    let body;
    try {
      body = await readSmallJson(request);
    } catch (error) {
      sendError(response, 400, error.message);
      return;
    }
    const result = devices.pair(body?.code, { userAgent: request.headers["user-agent"] });
    if (!result.ok) {
      sendJson(response, 400, { error: PAIR_FAILURES[result.reason] ?? "配对失败。", reason: result.reason });
      return;
    }
    log(`手机连线：新设备已配对（${result.device.name}）。`);
    response.setHeader("set-cookie", deviceCookie(result.token));
    sendJson(response, 200, { ok: true, device: result.device });
  };

  const refuseUnpaired = (request, response, pathname) => {
    if (wantsPage(request, pathname)) {
      response.writeHead(303, { location: "/pair", "cache-control": "no-store" });
      response.end();
      return;
    }
    sendJson(response, 401, { error: "这台设备还没配对，或已在电脑上被取消。", code: "device-unpaired" });
  };

  const handle = (request, response) => {
    applySecurityHeaders(response);
    response.setHeader("strict-transport-security", "max-age=31536000");
    const settings = devices.getSettings();
    if (!settings.enabled || !hostMatches(request.headers.host, settings.host)) {
      sendError(response, 403, "Forbidden host");
      return;
    }
    if (isForeignRequest(request)) {
      sendError(response, 403, "Forbidden");
      return;
    }
    const url = new URL(request.url, "https://remote.invalid");
    const { pathname } = url;

    if (isPublicPath(request.method, pathname)) {
      if (pathname === "/pair") {
        servePairPage(response);
      } else {
        routeRequest(request, response, { remote: true });
      }
      return;
    }
    if (request.method === "POST" && pathname === "/remote/pair") {
      handlePair(request, response).catch(() => {
        if (!response.writableEnded) {
          sendError(response, 500, "Internal error");
        }
      });
      return;
    }

    const device = devices.authenticate(readCookie(request.headers.cookie, DEVICE_COOKIE));
    if (device === null) {
      refuseUnpaired(request, response, pathname);
      return;
    }
    if (request.method === "POST" && pathname === "/remote/unpair") {
      devices.revoke(device.id);
      log(`手机连线：设备自行取消了配对（${device.name}）。`);
      response.setHeader("set-cookie", clearedDeviceCookie());
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname.startsWith("/api/") && !isRemoteApiAllowed(request.method, pathname)) {
      sendJson(response, 403, { error: "这个功能只能在电脑上用。", code: "desktop-only" });
      return;
    }
    if (pathname.startsWith("/runs/") && !isRemoteRunsFileAllowed(pathname)) {
      sendError(response, 403, "Forbidden");
      return;
    }
    routeRequest(request, response, { remote: true });
  };

  const safeHandle = (request, response) => {
    // A single synchronous throw here would take down the whole server process.
    try {
      handle(request, response);
    } catch (error) {
      console.error(`Remote request failed: ${error.message}`);
      if (!response.writableEnded) {
        try {
          sendError(response, 500, "Internal error");
        } catch {
          response.destroy();
        }
      }
    }
  };

  const start = () =>
    new Promise((resolve) => {
      if (server !== null) {
        resolve({ ok: true });
        return;
      }
      const candidate = http.createServer(safeHandle);
      candidate.once("error", (error) => {
        listenError = error.code === "EADDRINUSE" ? `端口 ${port} 已被别的程序占用` : error.message;
        console.error(`手机连线入口启动失败: ${listenError}`);
        resolve({ ok: false, error: listenError });
      });
      candidate.listen(port, "127.0.0.1", () => {
        server = candidate;
        listenError = null;
        resolve({ ok: true });
      });
    });

  // Also drops open keep-alive connections, so turning phone access off (or
  // revoking a device, which is checked per request anyway) takes effect at once.
  const stop = () =>
    new Promise((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      closing.close(() => resolve());
      closing.closeAllConnections?.();
    });

  return {
    start,
    stop,
    handle: safeHandle,
    isListening: () => server !== null,
    listenError: () => listenError,
  };
};

module.exports = { createRemoteGateway, isForeignRequest, PAIR_RATE_LIMIT };
