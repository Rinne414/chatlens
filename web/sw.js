"use strict";

// Minimal service worker so the console can be installed as an app window.
// It never caches: index.html carries a per-boot access token, and every
// other response is live local data. A failed fetch (console not running)
// gets a short explanation instead of the browser's error page.

const OFFLINE_HTML = [
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>",
  "<title>QQ 群消息简报</title>",
  "<body style='font-family:sans-serif;padding:40px;line-height:1.7;color:#1c2127'>",
  "<h2>后台服务没有在运行</h2>",
  "<p>请用开始菜单 / 应用菜单里的「QQ 群消息简报」重新打开，或双击安装目录里的 Start-QQ-Console。</p>",
  "<p>在设置页开启「开机自动在后台运行」后，下次开机就不用再手动启动了。</p>",
].join("");

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
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })),
  );
});
