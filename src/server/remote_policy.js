"use strict";

// What a paired phone may do through the remote entrance (remote_gateway.js).
//
// Deny by default: an API route not listed here answers 403 to a phone even
// though the page that calls it exists. The list is reading and the actions
// that go with reading (read marks, bookmarks, asking the AI). Everything that
// changes the computer itself stays on the computer: keys and settings,
// backup, storage cleanup, opening folders, exports to disk, updates, quitting,
// QQ 收藏图, and the phone-connection settings themselves.

const REMOTE_API_ROUTES = new Set([
  // pages and their data
  "GET /api/state",
  "GET /api/rail",
  "GET /api/briefing",
  "GET /api/background",
  "GET /api/job",
  "GET /api/run-detail",
  "GET /api/messages",
  "GET /api/store-overview",
  "GET /api/store-timeline",
  "GET /api/unread-hint",
  "GET /api/inbox-extras",
  "GET /api/media-index",
  "GET /api/trends",
  "GET /api/group",
  "GET /api/group/timeline",
  "GET /api/group/person",
  "GET /api/group/person/messages",
  "GET /api/person-across",
  "GET /api/review/calendar",
  "GET /api/review/day",
  "GET /api/review/search",
  "GET /api/digest",
  "GET /api/digests",
  "GET /api/ask",
  "GET /api/ask/item",
  "GET /api/quick-summary",
  "GET /api/bookmarks",
  "GET /api/bookmarks/keys",
  "GET /api/gallery",
  "GET /api/gallery/facets",
  "GET /api/gallery/picture",
  "GET /api/gallery/context",
  "GET /api/pictures/status",
  "GET /api/pictures/expiring",
  "GET /api/pictures/workflow",
  "GET /api/pictures/save-dir",
  "GET /api/knowledge/overview",
  "GET /api/knowledge/search",
  "GET /api/knowledge/facets",
  "GET /api/knowledge/requests",
  "GET /api/knowledge/coverage",
  "GET /api/knowledge/related",
  "GET /api/knowledge/image",
  "GET /api/llm/usage",
  "GET /api/llm/providers",
  "GET /api/llm/redo-report",
  "GET /api/update/check",
  // actions that belong to reading
  "POST /api/readmark",
  "POST /api/briefing/seen",
  "POST /api/briefing/retry-failed",
  "POST /api/watch-words",
  "POST /api/background/run-now",
  "POST /api/paste-cursor",
  "POST /api/quick-summary",
  "POST /api/review/backfill",
  "POST /api/digest/generate",
  "POST /api/ask",
  "POST /api/ask/delete",
  "POST /api/bookmarks",
  "POST /api/bookmarks/remove",
  "POST /api/knowledge/badges",
  // following a group (群 page) decides what the briefing covers
  "POST /api/watchlist",
  // keeps a picture's original before it expires; writes nothing outside the
  // console's own picture store
  "POST /api/pictures/keep",
]);

const isRemoteApiAllowed = (method, pathname) => REMOTE_API_ROUTES.has(`${method} ${pathname}`);

// runs/ also holds message exports (.json/.txt) and database copies
// (clean-db/*.db); a phone gets only the pictures, videos and voice clips the
// chat shows. QQ stores some originals without an extension.
const RUNS_MEDIA_EXTENSIONS = new Set([
  "", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".jfif", ".heic",
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
  ".mp3", ".m4a", ".wav", ".amr", ".silk",
]);

const isRemoteRunsFileAllowed = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const name = decoded.slice(decoded.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return name !== "" && RUNS_MEDIA_EXTENSIONS.has(dot <= 0 ? "" : name.slice(dot).toLowerCase());
};

// Reachable without a paired device: the pairing page, and the app manifest
// and icons (browsers fetch those without cookies). None carries any data.
const PUBLIC_PATHS = new Set(["/pair", "/pair.js", "/pair.css", "/sw.js", "/manifest.webmanifest", "/favicon.ico"]);
const PUBLIC_ICON = /^\/icons\/[\w-]+\.png$/u;

const isPublicPath = (method, pathname) =>
  method === "GET" && (PUBLIC_PATHS.has(pathname) || PUBLIC_ICON.test(pathname));

const DEVICE_COOKIE = "__Host-chatlens-device";
// A year; revoking the device on the computer ends it sooner.
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const readCookie = (header, name) => {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
};

const deviceCookie = (token) =>
  `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`;

const clearedDeviceCookie = () => `${DEVICE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;

// Host the phone used, as the remote entrance must see it: the Tailscale name
// of this computer. Port 443 may or may not be spelled out.
const hostMatches = (header, expected) => {
  if (typeof expected !== "string" || expected === "") {
    return false;
  }
  const host = String(header ?? "").toLowerCase();
  return host === expected || host === `${expected}:443`;
};

module.exports = {
  isRemoteApiAllowed,
  isRemoteRunsFileAllowed,
  isPublicPath,
  readCookie,
  deviceCookie,
  clearedDeviceCookie,
  hostMatches,
  DEVICE_COOKIE,
  REMOTE_API_ROUTES,
};
