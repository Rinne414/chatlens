"use strict";

// Minimal service worker so the console can be installed as an app window.
// It never caches: index.html carries a per-boot access token, and every
// other response is live local data. A failed fetch (console not running)
// gets a short explanation instead of the browser's error page.

const OFFLINE_HTML = [
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>",
  "<title>ChatLens</title>",
  "<body style='font-family:sans-serif;padding:40px;line-height:1.7;color:#1c2127'>",
  "<h2>后台服务没有在运行</h2>",
  "<p>请用开始菜单 / 应用菜单或桌面上的「ChatLens」重新打开，或双击安装目录里的 Start-ChatLens.cmd。</p>",
  "<p>在设置页开启「开机自动在后台运行」后，下次开机就不用再手动启动了。</p>",
].join("");

// A phone (手机连线) reaches the computer through Tailscale: the computer may
// be off or asleep, or the console closed (Tailscale then answers 502).
const REMOTE_OFFLINE_HTML = [
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'>",
  "<title>ChatLens</title>",
  "<body style='font-family:system-ui,sans-serif;padding:28px 20px;line-height:1.7;color:#1c2127;background:#f4f5f2'>",
  "<h2 style='font-size:20px'>连不上电脑上的 ChatLens</h2>",
  "<p>请确认：电脑开着且没有睡眠，ChatLens 在电脑上运行，手机的 Tailscale 已打开。</p>",
  "<p><a href='/' style='color:#1565c0;font-weight:600'>重试</a></p>",
].join("");

const isLocal = ["127.0.0.1", "localhost"].includes(self.location.hostname);
const UNREACHABLE = new Set([502, 503, 504]);

const offline = () => new Response(isLocal ? OFFLINE_HTML : REMOTE_OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => (!isLocal && UNREACHABLE.has(response.status) ? offline() : response))
      .catch(offline),
  );
});
