"use strict";

// HTTP side of 简报 → 值得知道的事 (src/brief_things.js). Reading the page
// starts a new merge on its own when the window moved on enough, under the
// same switches as the background summaries (AI 自动总结, 暂停 AI 整理, the
// daily budget); 重新整理 starts one by hand. One child at a time.

const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const briefingOps = require("./briefing_ops");
const engine = require("../briefing_engine");
const { followedGroups, readBriefThings, windowStartOf, MERGE_LOCK, MERGE_LOCK_STALE_MS } = require("../brief_things");
const { isLockHeld } = require("../vault_files");
const { isLlmConfigured } = require("../llm_route");
const { todaySpend } = require("../llm_usage");
const { priceTable } = require("../llm_pricing");

const ERROR_TAIL_CHARS = 400;
// A failed automatic merge is not retried on every page poll, and a finished
// one that still reads as stale (its keys did not match, say) is not redone
// at once either.
const AUTO_RETRY_AFTER_SECONDS = 30 * 60;
const AUTO_REDO_AFTER_SECONDS = 45 * 60;
const storeDir = path.join(state.toolRoot, "store");
let running = null;
let lastResult = null;

const nowUnix = () => Math.floor(Date.now() / 1000);

// Why an automatic merge may not start now (null: it may).
const autoBlocker = (db, config, now) => {
  if (!isLlmConfigured(config)) {
    return "no-ai";
  }
  if (config.background?.autoSummarize === false) {
    return "auto-off";
  }
  if (engine.pauseStatus(db, now).paused) {
    return "paused";
  }
  const budget = config.background?.dailyBudget;
  const amount = Number(budget?.amount);
  if (Number.isFinite(amount) && amount > 0 && ["CNY", "USD"].includes(budget?.currency)
    && todaySpend(db, { nowUnix: now, prices: priceTable(config), currency: budget.currency }) >= amount) {
    return "money-budget";
  }
  return null;
};

const spawnMerge = (windowStart, trigger) => {
  const job = { windowStart, trigger, startedAt: nowUnix() };
  running = job;
  const child = spawn(process.execPath, [path.join(state.toolRoot, "src", "brief_things_run.js")], { cwd: state.toolRoot, windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-ERROR_TAIL_CHARS);
  });
  // A failed spawn emits both "error" and "close": the first one counts,
  // and never for a merge started after this one.
  const finish = (status, error) => {
    if (running !== job) {
      return;
    }
    lastResult = { ...job, status, error, endedAt: nowUnix() };
    running = null;
  };
  child.on("close", (code) => finish(code === 0 ? "done" : "failed", code === 0 ? null : stderr.trim().split(/\r?\n/u).at(-1) || `退出码 ${code}`));
  child.on("error", (error) => finish("failed", error.message));
};

// A merge this console did not start: one left running across a restart.
const mergeElsewhere = () => running === null && isLockHeld(storeDir, MERGE_LOCK, { staleMs: MERGE_LOCK_STALE_MS });

const jobFor = (windowStart) => {
  if (running !== null) {
    return { status: "running", trigger: running.trigger, startedAt: running.startedAt };
  }
  if (mergeElsewhere()) {
    return { status: "running", trigger: "auto", startedAt: null };
  }
  return lastResult !== null && lastResult.windowStart === windowStart ? lastResult : null;
};

const getBriefThings = () => {
  const config = state.loadConfig();
  const db = state.getStore();
  const now = nowUnix();
  const windowStart = windowStartOf(db, now);
  const result = readBriefThings(db, {
    watchlist: followedGroups(config),
    windowStart,
    watchWords: briefingOps.watchWordsOf(config),
    nowUnix: now,
  });
  const blocker = autoBlocker(db, config, now);
  const sinceLast = lastResult !== null && lastResult.windowStart === windowStart ? now - lastResult.endedAt : Infinity;
  const tooSoon = lastResult?.status === "failed" ? sinceLast < AUTO_RETRY_AFTER_SECONDS : sinceLast < AUTO_REDO_AFTER_SECONDS;
  if (result.stale && running === null && blocker === null && !tooSoon && !mergeElsewhere()) {
    spawnMerge(windowStart, "auto");
  }
  return { ...result, auto: blocker ?? "on", job: jobFor(windowStart) };
};

const startBriefThings = () => {
  if (running !== null || mergeElsewhere()) {
    throw new Error("正在整理，等这次好了再点。");
  }
  if (!isLlmConfigured(state.loadConfig())) {
    throw new Error("还没有配置 AI 服务：请在「设置」页登录 Grok 或保存 LLM API key。");
  }
  spawnMerge(windowStartOf(state.getStore(), nowUnix()), "manual");
  return { started: true };
};

module.exports = { getBriefThings, startBriefThings };
