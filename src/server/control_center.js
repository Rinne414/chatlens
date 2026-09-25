const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const settings = require("./settings_ops");
const storage = require("./storage_ops");
const background = require("./background");
const briefing = require("./briefing_ops");
const desktop = require("./desktop_ops");
const llmOps = require("./llm_ops");
const reviewOps = require("./review_ops");
const knowledgeAigc = require("./knowledge_aigc");
const backupOps = require("./backup_ops");
const update = require("./update_ops");
const knowledge = require("./knowledge_ops");
const pictureRoutes = require("./picture_routes");
const galleryOps = require("./gallery_ops");
const railOps = require("./rail_ops");
const groupOps = require("./group_ops");
const trendsOps = require("./trends_ops");
const picturePass = require("./picture_pass");
const knowledgeExport = require("../knowledge_export");
const platform = require("../platform");
const { parseAutostart, withAutostart } = require("../autostart");
const { ensureInstanceId, acquireServerLock, releaseServerLock } = require("../instance");
const packageInfo = require("../../package.json");

const BASE_PORT = 8321;
const MAX_PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 64 * 1024;

const token = crypto.randomBytes(16).toString("hex");
const tokenBuffer = Buffer.from(token);
const instance = ensureInstanceId(state.toolRoot);

// Everything the console loads is same-origin, except QQ avatars (https CDN).
// Inline style attributes are used by the DOM builder, inline scripts never.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
const webDir = path.join(state.toolRoot, "web");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".jfif": "image/jpeg",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".amr": "audio/amr",
  ".silk": "application/octet-stream",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const sendJson = (response, statusCode, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendError = (response, statusCode, message) => sendJson(response, statusCode, { error: message });

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });

const isLocalHost = (request) => {
  const host = String(request.headers.host ?? "").toLowerCase();
  return host.startsWith("127.0.0.1:") || host.startsWith("localhost:") || host === "127.0.0.1" || host === "localhost";
};

// /runs/ and /knowledge-file cannot carry the token (<img>/<video> sources),
// so any web page the user has open could otherwise embed them and probe which
// pictures exist. Browsers label such requests; only our own pages and direct
// navigation get through.
const isCrossSite = (request) => {
  const site = request.headers["sec-fetch-site"];
  return site === "cross-site" || site === "same-site";
};

// Constant-time comparison: the token is the only gate on /api/*.
const isAuthorized = (request) => {
  const header = request.headers["x-cc-token"];
  if (typeof header !== "string") {
    return false;
  }
  const candidate = Buffer.from(header);
  return candidate.length === tokenBuffer.length && crypto.timingSafeEqual(candidate, tokenBuffer);
};

const serveStaticFile = (response, filePath, fallbackType) => {
  // fallbackType lets run-media with unusual/absent extensions download
  // instead of 404ing (QQ caches occasionally store extension-less originals).
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? fallbackType;
  if (contentType === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(response, 404, "Not found");
    return;
  }

  response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(response);
};

const serveRunsFile = (response, urlPath) => {
  const config = state.loadConfig();
  let relative;
  try {
    relative = decodeURIComponent(urlPath.slice("/runs/".length));
  } catch {
    sendError(response, 400, "Malformed URL encoding");
    return;
  }
  const resolved = path.resolve(config.runsDir, relative);
  const rootCheck = path.relative(path.resolve(config.runsDir), resolved);
  if (rootCheck.startsWith("..") || path.isAbsolute(rootCheck)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  serveStaticFile(response, resolved, "application/octet-stream");
};

// Serves a knowledge-base image out of the QQ cache or protected media store.
//
// The path is NEVER taken from the request: the caller supplies a 32-hex md5,
// which is looked up in the store, and the stored path is then confirmed to sit
// inside either configured nt_data or store/media-objects. So this cannot be
// walked to read arbitrary files even if the store were somehow tampered with.
//
// `thumb` serves QQ's own reduced copy instead of the original. Grid cards use
// it because full-resolution originals cost ~2 MB each and ~14 MB of decoded
// bitmap, which made a 60-card page allocate hundreds of MB.
const serveKnowledgeImage = (response, hash, { thumb = false } = {}) => {
  const filePath = thumb
    ? (knowledge.thumbnailFilePath(state.toolRoot, hash) ?? knowledge.imageFilePath(state.toolRoot, hash))
    : knowledge.imageFilePath(state.toolRoot, hash);
  if (filePath === null) {
    sendError(response, 404, "Not found");
    return;
  }

  const config = state.loadConfig();
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    String(config.ntDataDir ?? ""),
    path.join(state.toolRoot, "store", "media-objects"),
  ].filter((root) => root !== "");
  const allowed = allowedRoots.some((root) => {
    const rootCheck = path.relative(path.resolve(root), resolved);
    return !rootCheck.startsWith("..") && !path.isAbsolute(rootCheck);
  });
  if (!allowed) {
    sendError(response, 403, "Forbidden");
    return;
  }

  serveStaticFile(response, resolved, "application/octet-stream");
};

const serveIndex = (response) => {
  const indexPath = path.join(webDir, "index.html");
  const html = fs.readFileSync(indexPath, "utf8").replace("__CC_TOKEN__", token);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
};

const launchExplorer = (targetPath) => {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error("path is required");
  }
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
  platform.openPath(targetPath);
};

const openLocalPath = (targetPath) => {
  if (!state.isPathAllowedToOpen(targetPath)) {
    throw new Error("Path is outside the reports/runs directories");
  }
  launchExplorer(targetPath);
};

const storageContext = () => {
  const job = jobs.jobSnapshot(0).job;
  const quickJob = jobs.quickSummarySnapshot().job;
  return {
    toolRoot: state.toolRoot,
    secretDir: settings.getSecretDirectory(),
    config: state.loadConfig(),
    activity: {
      jobRunning: job?.status === "running",
      quickSummaryRunning: quickJob?.status === "running",
    },
  };
};

const handleApi = async (request, response, url) => {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Missing or invalid token");
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, state.getState());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/job") {
      const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
      sendJson(response, 200, jobs.jobSnapshot(cursor));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/run-detail") {
      sendJson(response, 200, state.getRunDetail(url.searchParams.get("id") ?? ""));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/messages") {
      sendJson(response, 200, state.getStoreMessages(Object.fromEntries(url.searchParams)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/store-overview") {
      sendJson(response, 200, state.getStoreOverview());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/paste-cursor") {
      sendJson(response, 200, state.resolvePasteCursor(await readBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/unread-hint") {
      const filePath = path.join(state.toolRoot, "store", "qq-unread-hint.json");
      if (!fs.existsSync(filePath)) {
        sendJson(response, 200, { available: false, reason: "not-probed" });
        return;
      }
      try {
        sendJson(response, 200, JSON.parse(fs.readFileSync(filePath, "utf8")));
      } catch (error) {
        sendJson(response, 200, { available: false, reason: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/trends") {
      sendJson(response, 200, trendsOps.getTrends({
        days: url.searchParams.get("days") ?? "3",
        fromUnix: Number(url.searchParams.get("fromUnix")),
        toUnix: Number(url.searchParams.get("toUnix")),
        fresh: url.searchParams.get("fresh") === "1",
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/group/timeline") {
      sendJson(response, 200, groupOps.getGroupTimeline(url.searchParams));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/inbox-extras") {
      sendJson(response, 200, railOps.getInboxExtras(url.searchParams.get("groupIds")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/group") {
      sendJson(response, 200, groupOps.getGroupInsights(url.searchParams));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/rail") {
      sendJson(response, 200, railOps.getRail());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/store-timeline") {
      sendJson(response, 200, state.getStoreTimeline(Object.fromEntries(url.searchParams)));
      return;
    }


    if (request.method === "POST" && url.pathname === "/api/readmark") {
      const body = await readBody(request);
      const readMark = state.saveReadMark(body);
      railOps.invalidateRail();
      sendJson(response, 200, { readMark });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/media-index") {
      sendJson(response, 200, state.buildMediaIndex(url.searchParams.get("refresh") === "1"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/overview") {
      sendJson(response, 200, knowledge.overview(state.toolRoot));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/search") {
      sendJson(response, 200, knowledge.searchImages(state.toolRoot, {
        query: url.searchParams.get("q") ?? "",
        generator: url.searchParams.get("generator") ?? "",
        groupId: url.searchParams.get("groupId") ?? "",
        sender: url.searchParams.get("sender") ?? "",
        sort: url.searchParams.get("sort") ?? "recent",
        limit: url.searchParams.get("limit"),
        offset: Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/facets") {
      sendJson(response, 200, knowledge.facets(state.toolRoot, {
        query: url.searchParams.get("q") ?? "",
        scope: url.searchParams.get("scope") ?? "prompt",
        generator: url.searchParams.get("generator") ?? "",
        groupId: url.searchParams.get("groupId") ?? "",
        sender: url.searchParams.get("sender") ?? "",
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/requests") {
      sendJson(response, 200, knowledge.promptRequests(state.toolRoot, {
        onlyAnswered: url.searchParams.get("answered") === "1",
        limit: url.searchParams.get("limit"),
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/coverage") {
      sendJson(response, 200, knowledge.coverage(state.toolRoot, {
        since: Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/export-preview") {
      const rawHashes = url.searchParams.get("hashes");
      const collected = knowledge.collectForExport(state.toolRoot, {
        query: url.searchParams.get("q") ?? "",
        generator: url.searchParams.get("generator") ?? "",
        groupId: url.searchParams.get("groupId") ?? "",
        sender: url.searchParams.get("sender") ?? "",
        sort: url.searchParams.get("sort") ?? "recent",
        // Same selection the export will use, so the estimate cannot describe a
        // different set from what gets written.
        hashes: rawHashes === null || rawHashes === "" ? null : rawHashes.split(","),
      });
      const mode = url.searchParams.get("mode") === "all" ? "all" : "new";
      sendJson(response, 200, {
        available: collected.available,
        matched: collected.items.length,
        ...knowledgeExport.previewExport(state.toolRoot, collected.items, mode),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/export") {
      const body = await readBody(request);
      const collected = knowledge.collectForExport(state.toolRoot, {
        query: body.query ?? "",
        generator: body.generator ?? "",
        groupId: body.groupId ?? "",
        sender: body.sender ?? "",
        sort: body.sort ?? "recent",
        limit: Number.parseInt(body.limit ?? "0", 10) || 0,
        hashes: Array.isArray(body.hashes) ? body.hashes : null,
      });
      if (!collected.available) {
        sendError(response, 404, "还没有咒语库");
        return;
      }
      const outputDir = state.resolveKnowledgeExportDir(body.label);
      const result = knowledgeExport.exportImages({
        toolRoot: state.toolRoot,
        outputDir,
        items: collected.items,
        mode: body.mode === "all" ? "all" : "new",
        includeImages: body.includeImages !== false,
        includeSidecars: body.includeSidecars !== false,
        includeIndex: body.includeIndex !== false,
        verifyHash: body.verifyHash === true,
      });

      // Report whether the folder REALLY opened. Previously the response claimed
      // it had regardless, and a failure here would have thrown past the reply.
      let folderOpened = false;
      let openError = null;
      if (result.exported > 0 && body.openFolder !== false) {
        try {
          openLocalPath(result.outputDir);
          folderOpened = true;
        } catch (error) {
          openError = error.message;
        }
      }
      sendJson(response, 200, {
        ...result,
        records: undefined,
        recordCount: result.records.length,
        folderOpened,
        openError,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/forget-exports") {
      const body = await readBody(request);
      const hashes = Array.isArray(body.hashes) ? body.hashes : null;
      sendJson(response, 200, knowledgeExport.forgetExports(state.toolRoot, hashes));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/badges") {
      const body = await readBody(request);
      sendJson(response, 200, knowledgeAigc.badgesFor(state.toolRoot, body.hashes));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/related") {
      sendJson(response, 200, knowledgeAigc.relatedImages(state.toolRoot, url.searchParams.get("hash")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/image") {
      const image = knowledge.imageByHash(state.toolRoot, url.searchParams.get("hash"));
      if (image === null) {
        sendError(response, 404, "Not found");
        return;
      }
      sendJson(response, 200, image);
      return;
    }


    if (request.method === "POST" && url.pathname === "/api/quick-summary") {
      const body = await readBody(request);
      const prepared = state.prepareQuickSummary(body);
      let job;
      try {
        job = jobs.startQuickSummaryJob({
          inputPath: prepared.inputPath,
          outputPath: prepared.outputPath,
          meta: { groupId: prepared.groupId, groupName: prepared.groupName, count: prepared.count },
          llm: state.loadConfig().llm ?? {},
        });
      } catch (error) {
        // The job never started, so its cleanup will never run — remove the prepared input here.
        fs.rmSync(prepared.inputPath, { force: true });
        throw error;
      }
      sendJson(response, 200, { started: true, jobId: job.id, count: prepared.count });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/quick-summary") {
      sendJson(response, 200, jobs.quickSummarySnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(request);
      const job = jobs.startSummaryJob(body);
      sendJson(response, 200, { started: true, jobId: job.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run/repair-coverage/estimate") {
      const body = await readBody(request);
      sendJson(response, 200, jobs.estimateCoverageRepair({ batches: body.batches }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run/repair-coverage") {
      const body = await readBody(request);
      const job = jobs.startCoverageRepairJob({ batches: body.batches });
      sendJson(response, 200, { started: true, jobId: job.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/grouplist/refresh") {
      const job = jobs.startGroupListJob();
      sendJson(response, 200, { started: true, jobId: job.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/job/cancel") {
      jobs.cancelJob();
      sendJson(response, 200, { cancelled: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/watchlist") {
      const body = await readBody(request);
      const entries = state.updateWatchlist({
        add: Array.isArray(body.add) ? body.add : [],
        remove: Array.isArray(body.remove) ? body.remove : [],
      });
      sendJson(response, 200, { watchlist: entries });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group-sets") {
      const body = await readBody(request);
      const groupSets = state.updateGroupSets({ save: body.save, remove: body.remove });
      sendJson(response, 200, { groupSets });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backup/setup") {
      sendJson(response, 200, backupOps.getSetup());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/backup/start") {
      sendJson(response, 200, backupOps.start(await readBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backup/report") {
      sendJson(response, 200, { report: backupOps.readReport() });
      return;
    }

    // Opens the folder of the last backup; the path comes from the tool's own
    // report, never from the request.
    if (request.method === "POST" && url.pathname === "/api/backup/open-folder") {
      const target = backupOps.readReport()?.targetDir ?? null;
      if (target === null || !fs.existsSync(target)) {
        throw new Error("备份文件夹还不存在，先保存一次。");
      }
      launchExplorer(target);
      sendJson(response, 200, { opened: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/open") {
      const body = await readBody(request);
      openLocalPath(body.path);
      sendJson(response, 200, { opened: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/storage/overview") {
      sendJson(response, 200, storage.getStorageOverview(storageContext()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/storage/measure") {
      const body = await readBody(request);
      sendJson(response, 200, await storage.measureStorageCategory(storageContext(), body.category));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/storage/cleanup") {
      const body = await readBody(request);
      sendJson(response, 200, await storage.cleanupStorageCategory(
        storageContext(),
        body.category,
        body.confirmation,
      ));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/storage/open") {
      const body = await readBody(request);
      const targetPath = storage.resolveStorageOpenPath(storageContext(), body.category);
      launchExplorer(targetPath);
      sendJson(response, 200, { opened: true, category: body.category });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, settings.getSettingsStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/keys") {
      const body = await readBody(request);
      const saved = [];
      if (typeof body.ntqqKey === "string" && body.ntqqKey.trim().length > 0) {
        await settings.saveSecret("ntqqKey", body.ntqqKey);
        saved.push("ntqqKey");
      }
      if (typeof body.llmKey === "string" && body.llmKey.trim().length > 0) {
        await settings.saveSecret("llmKey", body.llmKey);
        saved.push("llmKey");
      }
      if (saved.length === 0) {
        throw new Error("没有提供任何密钥。");
      }
      sendJson(response, 200, { saved });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/keys/auto-detect") {
      sendJson(response, 200, await settings.autoDetectKey());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/llm") {
      const body = await readBody(request);
      sendJson(response, 200, settings.saveLlmConfig(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/qq-paths") {
      const body = await readBody(request);
      sendJson(response, 200, settings.saveQqPaths(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/detect-qq") {
      sendJson(response, 200, { candidates: settings.detectQqPaths() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/llm/models") {
      sendJson(response, 200, { models: await settings.fetchLlmModels() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/update/check") {
      sendJson(response, 200, await update.checkUpdate());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/update/apply") {
      sendJson(response, 200, await update.applyUpdate());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/briefing") {
      sendJson(response, 200, briefing.getBriefing());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/briefing/seen") {
      const result = briefing.markSeen(await readBody(request));
      background.runNow({ force: false });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/background") {
      sendJson(response, 200, { ...background.getStatus(), desktop: desktop.getDesktopStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/background") {
      sendJson(response, 200, { settings: background.saveSettings(await readBody(request)) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/background/run-now") {
      const body = await readBody(request);
      sendJson(response, 200, background.runNow({ force: body.force !== false }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/review/calendar") {
      sendJson(response, 200, reviewOps.getCalendar({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/review/day") {
      sendJson(response, 200, reviewOps.getDay({ day: url.searchParams.get("day") }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review/backfill") {
      sendJson(response, 200, reviewOps.backfill(await readBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/review/search") {
      sendJson(response, 200, reviewOps.search({ q: url.searchParams.get("q"), messageOffset: url.searchParams.get("messageOffset") ?? 0 }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/llm/usage") {
      sendJson(response, 200, llmOps.getUsage({ days: url.searchParams.get("days") }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/llm/providers") {
      sendJson(response, 200, llmOps.getProviders());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/llm/prices") {
      sendJson(response, 200, llmOps.savePrices(await readBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/pause") {
      sendJson(response, 200, llmOps.setPause(await readBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/desktop/shortcut") {
      sendJson(response, 200, await desktop.ensureAppShortcut());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/desktop/autostart") {
      const body = await readBody(request);
      sendJson(response, 200, await desktop.setAutostart(body.enabled === true));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      sendJson(response, 200, { stopping: true });
      shutdown();
      return;
    }

    if (await pictureRoutes.handlePictureApi(request, response, url, { sendJson, sendError, readBody })) {
      return;
    }

    if (galleryOps.handleGalleryApi(request, response, url, { sendJson, sendError })) {
      return;
    }

    sendError(response, 404, "Unknown API route");
  } catch (error) {
    sendError(response, 400, error.message);
  }
};

const handleRequest = (request, response) => {
  // A single synchronous throw here would take down the whole server process.
  try {
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
    response.setHeader("referrer-policy", "no-referrer");

    if (!isLocalHost(request)) {
      sendError(response, 403, "Forbidden host");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    // Unauthenticated liveness probe for the launcher: no data, no paths.
    if (url.pathname === "/healthz") {
      sendJson(response, 200, { app: "chatlens", version: packageInfo.version, instance });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch(() => {
        if (!response.writableEnded) {
          sendError(response, 500, "Internal error");
        }
      });
      return;
    }

    if (request.method !== "GET") {
      sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveIndex(response);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1565c0"/><text x="16" y="22" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff" font-family="Arial">QQ</text></svg>');
      return;
    }

    if (/^\/[\w-]+\.(?:css|js|webmanifest)$/u.test(url.pathname)) {
      serveStaticFile(response, path.join(webDir, url.pathname.slice(1)));
      return;
    }

    if (/^\/icons\/[\w-]+\.png$/u.test(url.pathname)) {
      serveStaticFile(response, path.join(webDir, url.pathname.slice(1)));
      return;
    }

    if ((url.pathname.startsWith("/runs/") || url.pathname === "/knowledge-file" || url.pathname === "/picture") && isCrossSite(request)) {
      sendError(response, 403, "Forbidden");
      return;
    }

    if (url.pathname.startsWith("/runs/")) {
      serveRunsFile(response, url.pathname);
      return;
    }

    // Alongside /runs/ rather than behind the API token, because <img src> and
    // <video src> cannot send the x-cc-token header. Same protection as /runs/:
    // local Host only, cross-site requests refused (above), and the path is
    // resolved from a store-held md5 that must live under nt_data.
    if (url.pathname === "/knowledge-file") {
      serveKnowledgeImage(response, url.searchParams.get("hash"), {
        thumb: url.searchParams.get("thumb") === "1",
      });
      return;
    }

    if (url.pathname === "/picture") {
      pictureRoutes.servePicture(response, url).catch((error) => {
        console.error(`picture failed: ${error.message}`);
        if (!response.writableEnded) {
          sendError(response, 500, "Internal error");
        }
      });
      return;
    }

    sendError(response, 404, "Not found");
  } catch (error) {
    if (!response.writableEnded) {
      try {
        sendError(response, 500, "Internal error");
      } catch {
        response.destroy();
      }
    }
    console.error(`Request failed: ${error.message}`);
  }
};

let httpServer = null;

function shutdown() {
  background.stop();
  picturePass.stop();
  releaseServerLock(state.toolRoot);
  // Let the HTTP response flush before exiting.
  setTimeout(() => process.exit(0), 300).unref();
  httpServer?.close();
}

const listen = (port, attempt) => {
  const server = http.createServer(handleRequest);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`Control center failed to start: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    httpServer = server;
    const url = `http://127.0.0.1:${port}/`;
    console.log(`QQ 摘要控制台已启动: ${url}`);
    background.start({
      url,
      afterTick: async (tick) => {
        await briefing.afterTick(tick);
        // Pictures after the refresh: its ingest is what adds new ones.
        picturePass.runPass({ reason: "tick" }).catch((error) => console.error(`picture pass failed: ${error.message}`));
      },
    });
    desktop.removeLegacyScheduledTask()
      .then((removed) => {
        if (removed) {
          console.log("已移除旧版的 Windows 定时任务（后台刷新已取代它）。");
        }
      })
      .catch((error) => console.error(`legacy task cleanup failed: ${error.message}`));
    // First start: put the app in the Start menu / app launcher so it can be
    // reopened without finding the install folder.
    if (!desktop.getDesktopStatus().appShortcut) {
      desktop.ensureAppShortcut().catch((error) => console.error(`app shortcut failed: ${error.message}`));
    }
    const autostartFlag = process.argv.find((arg) => arg.startsWith("--autostart="));
    const autostart = autostartFlag === undefined ? null : parseAutostart(`run=${autostartFlag.slice("--autostart=".length)}`);
    if (!process.argv.includes("--no-open")) {
      platform.openUrl(withAutostart(url, autostart));
    }
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", () => releaseServerLock(state.toolRoot));

// Is a console of THIS install already answering? (Distinguishes a live
// console from an unrelated process that reused the lock holder's pid.)
const probeOwnConsole = (port) =>
  new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 800 }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body).instance === instance);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });

const ownConsoleRunning = async () => {
  for (let port = BASE_PORT; port < BASE_PORT + MAX_PORT_ATTEMPTS; port += 1) {
    if (await probeOwnConsole(port)) {
      return true;
    }
  }
  return false;
};

acquireServerLock(state.toolRoot, ownConsoleRunning)
  .then((acquired) => {
    if (!acquired) {
      console.log("这个安装的控制台已经在运行，本次不再重复启动。");
      process.exit(0);
    }
    listen(BASE_PORT, 0);
  })
  .catch((error) => {
    console.error(`Control center failed to start: ${error.message}`);
    process.exit(1);
  });
