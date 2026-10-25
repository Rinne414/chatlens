"use strict";

// HTTP side of 设置 → Obsidian 笔记库: the settings, the vaults Obsidian
// knows, the last sync, 立即同步 (a child process, src/pipeline/vault_run.js),
// bringing back notes the user deleted, and 整理旧消息 (summary chunks for
// messages the AI never saw, worked through by the background refresh).

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const background = require("./background");
const { notesSettings, restoreDeleted, LANGUAGES } = require("../vault_sync");
const { readNotesStatus } = require("../vault_ai");
const { coverageOf } = require("../vault_data");
const { detectVaults } = require("../vault_detect");
const { folderRoot } = require("../vault_files");
const { ensureBriefingSchema, redoStats } = require("../briefing_store");
const { ensureConsensusSchema } = require("../things_consensus");
const review = require("../review_store");
const { detailLevel, isLlmConfigured } = require("../llm_route");
const { profileFor } = require("../llm_profiles");
const { formatHkt } = require("../unviewed_range");

const ERROR_TAIL_CHARS = 400;
const DAY_SECONDS = 86400;
// Counting every stored message takes ~0.2 s on this thread; the card polls
// every 2 s while a sync runs.
const COVERAGE_CACHE_MS = 60 * 1000;
// Writing thousands of notes takes seconds, but 立即同步 first lets the AI put
// new things into topics: the very first time ~20 calls, four at a time, a
// few minutes each on Grok. One stuck this long is killed (what the AI placed
// so far is kept).
const SYNC_TIMEOUT_MS = 45 * 60 * 1000;
const storeDir = path.join(state.toolRoot, "store");
let running = null;
let lastRun = null;
let coverageCache = null;

const cachedCoverage = (db) => {
  if (coverageCache === null || Date.now() - coverageCache.at > COVERAGE_CACHE_MS) {
    coverageCache = { at: Date.now(), value: coverageOf(db) };
  }
  return coverageCache.value;
};

// Topics with 群里的共识 (rows from before topics were per thing).
const consensusCount = (db) => ensureConsensusSchema(db).prepare("SELECT COUNT(*) AS n FROM kb_consensus WHERE anchor LIKE 'topic:%'").get().n;

const getNotes = () => {
  const config = state.loadConfig();
  const db = ensureBriefingSchema(state.getStore());
  return {
    settings: notesSettings(config),
    vaults: detectVaults(),
    status: readNotesStatus(storeDir),
    running: running !== null,
    lastRun,
    coverage: cachedCoverage(db),
    queuedChunks: redoStats(db).queued + db.prepare("SELECT COUNT(*) AS n FROM summary_chunks WHERE status = 'pending' AND redo = 0").get().n,
    consensusCount: consensusCount(db),
    aiReady: isLlmConfigured(config),
  };
};

const FOLDER_NAME = /^[^\\/:*?"<>|#^[\]]{1,60}$/u;

const validVaultPath = (value) => {
  const vaultPath = String(value ?? "").trim();
  if (vaultPath === "") {
    return "";
  }
  if (!path.isAbsolute(vaultPath)) {
    throw new Error("请填笔记库文件夹的完整路径，例如 D:\\Notes\\Obsidian。");
  }
  let stat;
  try {
    stat = fs.statSync(vaultPath);
  } catch {
    throw new Error(`找不到这个文件夹：${vaultPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`这不是文件夹：${vaultPath}`);
  }
  const resolved = path.resolve(vaultPath);
  if (path.parse(resolved).root === resolved) {
    throw new Error("请选笔记库所在的文件夹，不要选整个磁盘。");
  }
  return resolved;
};

const saveNotesSettings = (patch) => {
  const raw = state.loadRawConfig();
  const next = { ...notesSettings(raw) };
  if (patch.vaultPath !== undefined) next.vaultPath = validVaultPath(patch.vaultPath);
  if (patch.folder !== undefined) {
    const folder = String(patch.folder).trim();
    if (!FOLDER_NAME.test(folder) || folder.startsWith(".") || folder === "..") {
      throw new Error("文件夹名不能为空，也不能带 \\ / : * ? \" < > | # ^ [ ]。");
    }
    next.folder = folder;
  }
  if (patch.language !== undefined) {
    if (!LANGUAGES.has(patch.language)) {
      throw new Error("笔记文字只能是简体或繁体。");
    }
    next.language = patch.language;
  }
  for (const key of ["enabled", "autoSync", "consensus"]) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }
  if (next.enabled && next.vaultPath === "") {
    throw new Error("先选一个笔记库。");
  }
  if (next.vaultPath !== "") {
    folderRoot(next.vaultPath, next.folder);
  }
  state.writeConfig({ ...raw, notes: next });
  return { settings: next, looksLikeVault: next.vaultPath === "" || fs.existsSync(path.join(next.vaultPath, ".obsidian")) };
};

const startSync = () => {
  const settings = notesSettings(state.loadConfig());
  if (!settings.enabled || settings.vaultPath === "") {
    throw new Error("先选一个笔记库并打开同步。");
  }
  if (running !== null) {
    throw new Error("正在同步，等它好了再点。");
  }
  running = { startedAt: Date.now() };
  lastRun = null;
  const child = spawn(process.execPath, [path.join(state.toolRoot, "src", "pipeline", "vault_run.js")], {
    cwd: state.toolRoot,
    env: { ...process.env, CHATLENS_URL: background.serverUrlOf() ?? "" },
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    stderr = `${stderr}\n同步超过 ${SYNC_TIMEOUT_MS / 60000} 分钟没有结束，已停止。`;
    child.kill();
  }, SYNC_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    stdout += text;
  });
  child.stderr.on("data", (text) => {
    stderr = `${stderr}${text}`.slice(-ERROR_TAIL_CHARS);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    coverageCache = null;
    const line = stdout.split(/\r?\n/u).reverse().find((item) => item.startsWith("notesResult="));
    let result = null;
    try {
      result = line === undefined ? null : JSON.parse(line.slice("notesResult=".length));
    } catch {
      result = null;
    }
    lastRun = code === 0
      ? { status: "done", result, endedAt: Date.now() }
      : { status: "failed", error: stderr.trim().split(/\r?\n/u).at(-1) || `退出码 ${code}`, endedAt: Date.now() };
    running = null;
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    lastRun = { status: "failed", error: error.message, endedAt: Date.now() };
    running = null;
  });
  return { started: true };
};

const nextDay = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + DAY_SECONDS * 1000).toISOString().slice(0, 10);

// 整理旧消息: every stored day's messages that no summary covers become
// chunks for the background (detailed-level job work when the detailed
// provider is in use, so they never crowd out new messages).
const queueBackfill = () => {
  const config = state.loadConfig();
  if (!isLlmConfigured(config)) {
    throw new Error("还没有配置 AI 服务：请先在本页登录 Grok 或保存 LLM API key。");
  }
  const db = ensureBriefingSchema(state.getStore());
  const first = db.prepare("SELECT MIN(sent_at) AS first FROM messages").get().first;
  if (first === null) {
    return { chunks: 0, messages: 0, started: false };
  }
  const now = Math.floor(Date.now() / 1000);
  const detail = detailLevel(config);
  const maxMessages = profileFor(detail).engine.maxMessages;
  let chunks = 0;
  let messages = 0;
  const today = formatHkt(now).slice(0, 10);
  for (let day = formatHkt(first).slice(0, 10); day <= today; day = nextDay(day)) {
    const done = review.backfillDay(db, { day, now, asDetailedJob: detail === "detailed", maxMessages });
    chunks += done.chunks;
    messages += done.messages;
  }
  const tick = chunks > 0 ? background.runNow({ force: false }) : { started: false };
  coverageCache = null;
  return { chunks, messages, started: tick.started === true };
};

const handle = async (request, response, url, { sendJson, readBody }) => {
  if (request.method === "GET" && url.pathname === "/api/notes") {
    sendJson(response, 200, getNotes());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes/settings") {
    sendJson(response, 200, saveNotesSettings(await readBody(request)));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes/sync") {
    sendJson(response, 200, startSync());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes/restore-deleted") {
    sendJson(response, 200, restoreDeleted({ config: state.loadConfig(), storeDir }));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes/backfill") {
    sendJson(response, 200, queueBackfill());
    return true;
  }
  return false;
};

module.exports = { handle, getNotes, saveNotesSettings, queueBackfill };
