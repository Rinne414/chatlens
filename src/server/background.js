"use strict";

// Keeps the briefing ready without the user asking: every few minutes (while
// the console runs — it can start hidden at login) a refresh child syncs new
// messages, summarizes what is ripe and merges the per-group briefs. Replaces
// the old Windows-only scheduled task.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const platform = require("../platform");
const secrets = require("../secrets");
const { notify } = require("../notify");
const { formatHkt } = require("../unviewed_range");

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 15,
  autoSummarize: true,
  notifyMentions: true,
  notifyDaily: true,
  // Off by default: a common word can match many messages a day.
  notifyWatchWords: false,
  // Re-merge a group's brief at most this often (see briefing_engine). Merges
  // were ~80% of measured AI cost at 60 minutes.
  reduceIntervalMinutes: 120,
  // How long a quiet group's few new messages wait before they are summarized
  // on their own. Longer = fewer, fuller (cheaper) chunks, later summaries.
  tailWaitMinutes: 60,
  // null = no money cap (the daily call cap still applies).
  dailyBudget: null,
};
const MERGE_INTERVALS = new Set([0, 15, 30, 60, 120, 240]);
const RESCHEDULING_SETTINGS = ["enabled", "intervalMinutes", "autoSummarize"];
const TAIL_WAITS = new Set([60, 180, 360]);
const FIRST_TICK_DELAY_MS = 15 * 1000;
const BUSY_RETRY_MS = 2 * 60 * 1000;
const MAX_LOG_LINES = 60;
const DAILY_NOTIFY_HOUR = 9;
const refreshScript = path.join(state.toolRoot, "src", "pipeline", "refresh_run.js");

// The last outcome survives restarts, so a freshly started console can still
// say "updated 12 minutes ago" instead of "waiting for the first refresh".
const statusFile = path.join(state.toolRoot, "store", "background-status.json");

const loadSavedStatus = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return {
      lastStartedAt: saved.lastStartedAt ?? null,
      lastFinishedAt: saved.lastFinishedAt ?? null,
      lastResult: saved.lastResult ?? null,
      lastError: saved.lastError ?? null,
    };
  } catch {
    return { lastStartedAt: null, lastFinishedAt: null, lastResult: null, lastError: null };
  }
};

const saveStatus = () => {
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, `${JSON.stringify({
      lastStartedAt: status.lastStartedAt,
      lastFinishedAt: status.lastFinishedAt,
      lastResult: status.lastResult,
      lastError: status.lastError,
    })}\n`, "utf8");
  } catch (error) {
    console.error(`background status could not be saved: ${error.message}`);
  }
};

const status = {
  running: false,
  ...loadSavedStatus(),
  nextRunAt: null,
  log: [],
};
let timer = null;
let child = null;
// Set by stop(): a refresh killed because the console is closing did not fail.
let stopping = false;

// The refresh hashes the whole QQ database and runs in the background, so it
// yields the CPU to whatever the user is doing. On Windows the processes it
// starts (key scans) inherit the lower priority class.
const lowerPriority = (pid) => {
  if (!Number.isInteger(pid)) {
    return;
  }
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    console.error(`refresh priority could not be lowered: ${error.message}`);
  }
};
let serverUrl = null;
let onTickFinished = () => {};

const settings = () => ({ ...DEFAULTS, ...(state.loadConfig().background ?? {}) });

const saveSettings = (patch) => {
  const raw = state.loadRawConfig();
  const before = { ...DEFAULTS, ...(raw.background ?? {}) };
  const next = { ...before };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.autoSummarize === "boolean") next.autoSummarize = patch.autoSummarize;
  if (typeof patch.notifyMentions === "boolean") next.notifyMentions = patch.notifyMentions;
  if (typeof patch.notifyDaily === "boolean") next.notifyDaily = patch.notifyDaily;
  if (typeof patch.notifyWatchWords === "boolean") next.notifyWatchWords = patch.notifyWatchWords;
  if (patch.reduceIntervalMinutes !== undefined) {
    const minutes = Number(patch.reduceIntervalMinutes);
    if (!MERGE_INTERVALS.has(minutes)) {
      throw new Error("合并间隔无效。");
    }
    next.reduceIntervalMinutes = minutes;
  }
  if (patch.tailWaitMinutes !== undefined) {
    const minutes = Number(patch.tailWaitMinutes);
    if (!TAIL_WAITS.has(minutes)) {
      throw new Error("零散消息的等待时间无效。");
    }
    next.tailWaitMinutes = minutes;
  }
  if (patch.dailyBudget !== undefined) {
    const amount = Number(patch.dailyBudget?.amount);
    if (patch.dailyBudget === null || amount === 0) {
      next.dailyBudget = null;
    } else if (Number.isFinite(amount) && amount > 0 && amount <= 10000 && ["CNY", "USD"].includes(patch.dailyBudget?.currency)) {
      next.dailyBudget = { amount, currency: patch.dailyBudget.currency };
    } else {
      throw new Error("每日预算应为 0-10000 之间的金额，币种 CNY 或 USD。");
    }
  }
  if (patch.intervalMinutes !== undefined) {
    const minutes = Number(patch.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) {
      throw new Error("刷新间隔应为 5-240 分钟。");
    }
    next.intervalMinutes = minutes;
  }
  state.writeConfig({ ...raw, background: next });
  // Only a change to when / whether refreshes run starts one soon; a
  // notification switch (one click on the home page) must not.
  if (RESCHEDULING_SETTINGS.some((key) => next[key] !== before[key])) {
    schedule(FIRST_TICK_DELAY_MS);
  }
  return next;
};

const readiness = () => {
  const config = state.loadConfig();
  if (String(config.ntDbDir ?? "").trim().length === 0) {
    return "还没有设置 QQ 数据库路径";
  }
  if (!secrets.hasSecret("ntqqKey")) {
    return "还没有保存 QQ 数据库密钥";
  }
  if ((config.watchlist ?? []).length === 0) {
    return "关注群列表为空";
  }
  return null;
};

const pushLog = (line) => {
  status.log = [...status.log.slice(-(MAX_LOG_LINES - 1)), line];
};

const schedule = (delayMs) => {
  if (timer !== null) {
    clearTimeout(timer);
  }
  const current = settings();
  if (!current.enabled) {
    timer = null;
    status.nextRunAt = null;
    return;
  }
  const delay = delayMs ?? current.intervalMinutes * 60 * 1000;
  status.nextRunAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(() => {
    timer = null;
    tick({ force: false });
  }, delay);
  timer.unref?.();
};

// While a detailed-level job (e.g. redoing 14 days) still has work and the
// last refresh made progress on it, the next refresh starts after a short
// pause instead of the full interval: a refresh already spends ~30 minutes
// on the job, and the idle 15 minutes after it only made the job slower.
const JOB_FOLLOW_UP_MS = 2 * 60 * 1000;

// ms until the next refresh after one that ended with `result`, or undefined
// for the configured interval.
const followUpDelay = (result) => {
  const briefing = result?.briefing;
  const progressed = Number(briefing?.map?.jobDone) > 0 && (briefing?.map?.routeDown ?? null) === null;
  return progressed && Number(briefing?.jobQueued) > 0 ? JOB_FOLLOW_UP_MS : undefined;
};

const parseResult = (text) => {
  const line = text.split(/\r?\n/u).reverse().find((item) => item.startsWith("refreshResult="));
  if (line === undefined) {
    return null;
  }
  try {
    return JSON.parse(line.slice("refreshResult=".length));
  } catch {
    return null;
  }
};

// One stream's text, line by line: onLine gets each complete line. Each stream
// needs its own partial line - sharing one let half a warning on stderr glue
// itself in front of stdout's "refreshResult=" line, and the whole result was
// lost (2026-09-30 05:10 refresh: no record, no 2-minute follow-up).
const lineReader = (onLine) => {
  let partial = "";
  return (textChunk) => {
    partial += textChunk;
    const lines = partial.split(/\r?\n/u);
    partial = lines.pop() ?? "";
    lines.forEach(onLine);
  };
};

const logLine = (line) => {
  if (line.trim().length > 0 && !line.startsWith("refreshResult=")) {
    pushLog(line.trim().slice(0, 300));
  }
};

const tick = ({ force }) => {
  if (status.running) {
    return { started: false, reason: "running" };
  }
  const blocker = readiness();
  if (blocker !== null) {
    status.lastError = blocker;
    schedule();
    return { started: false, reason: blocker };
  }
  if (jobs.isJobRunning()) {
    // A manual run is busy with the same mirror; try again shortly.
    schedule(BUSY_RETRY_MS);
    return { started: false, reason: "job-running" };
  }
  status.running = true;
  status.lastStartedAt = new Date().toISOString();
  status.lastError = null;
  status.nextRunAt = null;
  const args = [refreshScript, ...(force ? ["--force"] : [])];
  child = spawn(process.execPath, args, { cwd: state.toolRoot, ...platform.spawnOptionsForTree() });
  lowerPriority(child.pid);
  // The result line is on stdout; decoded as UTF-8 across chunk boundaries.
  let stdoutText = "";
  const readStdout = lineReader(logLine);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (textChunk) => {
    stdoutText += textChunk;
    readStdout(textChunk);
  });
  child.stderr.on("data", lineReader(logLine));
  child.on("error", (error) => {
    status.lastError = error.message;
  });
  child.on("close", (code) => {
    child = null;
    status.running = false;
    if (stopping) {
      // Killed because the console is closing: not a failure, and the last
      // refresh that did finish stays the one on record (background-status.json).
      return;
    }
    status.lastFinishedAt = new Date().toISOString();
    const result = parseResult(stdoutText);
    status.lastResult = result;
    if (code !== 0 && status.lastError === null) {
      status.lastError = status.log.at(-1) ?? `刷新进程退出码 ${code}`;
    }
    saveStatus();
    schedule(code === 0 ? followUpDelay(result) : undefined);
    Promise.resolve(onTickFinished({ ok: code === 0, result })).catch((error) => {
      console.error(`background post-tick failed: ${error.message}`);
    });
  });
  return { started: true };
};

/* ---------- notifications ---------- */

const NOTIFY_STATE_KEY = "notify_state";

const messageKey = (item) => `${item.groupId}|${item.rowId}`;

// Messages with a followed word not handled yet, newest first: newer than the
// mark, or in the mark's own second but not among `seen` (a busy group's
// message of that second can arrive a refresh later). A message matching
// several words is one entry.
const unseenWatchHits = (watch, since, seen) => {
  const byMessage = new Map();
  for (const entry of watch ?? []) {
    for (const hit of entry.latest) {
      const key = messageKey(hit);
      if (hit.sentAt > since || (hit.sentAt === since && !seen.has(key))) {
        const words = [...(byMessage.get(key)?.words ?? []), entry.word];
        byMessage.set(key, { ...hit, words });
      }
    }
  }
  return [...byMessage.values()].sort((left, right) => right.sentAt - left.sentAt);
};

const listOf = (values, limit, separator) => `${values.slice(0, limit).join(separator)}${values.length > limit ? " 等" : ""}`;

const watchNotice = (hits) => {
  const groupName = (hit) => hit.groupName || hit.groupId;
  if (hits.length === 1) {
    const [hit] = hits;
    return { title: `「${hit.words.join("」「")}」出现在「${groupName(hit)}」`, body: `${hit.speaker}：${hit.text}` };
  }
  const words = [...new Set(hits.flatMap((hit) => hit.words))];
  const groups = [...new Set(hits.map(groupName))];
  return {
    title: `关注的词有 ${hits.length} 条新消息`,
    body: `「${listOf(words, 4, "」「")}」 · ${listOf(groups, 3, "、")}`,
  };
};

// The first tick only remembers "now"; the mark also moves while switched
// off, so switching on never replays old hits. Not notified: muted people,
// and messages this tick already notified as an @ / reply (`skip`).
// Returns the new mark { at, keys } (keys: the messages of the mark's second
// already handled); a future-dated message cannot push it past now.
const notifyWatchWords = async ({ watch, mark, skip, current, send }) => {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set(mark.keys);
  // A message dated past now (clock skew) waits until real time reaches it,
  // or it would be notified again on every refresh.
  const unseen = unseenWatchHits(watch, mark.at, seen).filter((hit) => hit.sentAt <= now + 60);
  const hits = unseen.filter((hit) => hit.muted !== true && !skip.has(messageKey(hit)));
  if (current.notifyWatchWords && mark.at > 0 && hits.length > 0) {
    await send({ ...watchNotice(hits), url: serverUrl });
  }
  const at = Math.min(Math.max(mark.at > 0 ? mark.at : now, ...unseen.map((hit) => hit.sentAt)), now + 60);
  const atSecond = unseen.filter((hit) => hit.sentAt === at).map(messageKey);
  return { at, keys: at === mark.at ? [...seen, ...atSecond] : atSecond };
};

// Called after each tick with a store handle: @/reply mentions newer than the
// last notification, followed words (when switched on), plus one daily "your
// briefing is ready" nudge. `current` / `send` are replaced in tests.
const notifyAfterTick = async ({ db, briefing, getState, setState, current = settings(), send = notify }) => {
  const saved = getState(db, NOTIFY_STATE_KEY, {}) ?? {};
  const next = { ...saved };
  const direct = briefing.mentions.filter((item) => item.kind === "at" || item.kind === "reply");
  const lastMention = Number(saved.lastMentionAt) || 0;
  // Not while you were in that conversation yourself (a bot answering your
  // command): you saw those already.
  const fresh = direct.filter((item) => item.sentAt > lastMention && item.youWereThere !== true && item.muted !== true);
  if (current.notifyMentions && fresh.length > 0 && lastMention > 0) {
    const first = fresh[0];
    await send({
      title: fresh.length === 1 ? `${first.speaker} 在「${first.groupName}」${first.kind === "reply" ? "回复了你" : "@了你"}` : `有 ${fresh.length} 条消息和你有关`,
      body: fresh.length === 1 ? first.text : fresh.slice(0, 3).map((item) => `${item.groupName}：${item.speaker}`).join("；"),
      url: serverUrl,
    });
  }
  if (direct.length > 0) {
    next.lastMentionAt = Math.max(lastMention, ...direct.map((item) => item.sentAt));
  } else if (lastMention === 0) {
    // First run: remember "now" so old mentions don't all fire at once.
    next.lastMentionAt = Math.floor(Date.now() / 1000);
  }

  const mentionsNotified = current.notifyMentions && lastMention > 0 ? fresh : [];
  const watchMark = await notifyWatchWords({
    watch: briefing.watch,
    mark: { at: Number(saved.lastWatchAt) || 0, keys: Array.isArray(saved.lastWatchKeys) ? saved.lastWatchKeys : [] },
    skip: new Set(mentionsNotified.map(messageKey)),
    current,
    send,
  });
  next.lastWatchAt = watchMark.at;
  next.lastWatchKeys = watchMark.keys;

  const today = formatHkt(Math.floor(Date.now() / 1000)).slice(0, 10);
  const hour = Number(formatHkt(Math.floor(Date.now() / 1000)).slice(11, 13));
  const totalMessages = briefing.totals.textMessages + briefing.totals.mediaMessages;
  if (current.notifyDaily && saved.dailyDay !== today && hour >= DAILY_NOTIFY_HOUR && totalMessages > 0) {
    const topNames = briefing.groups.filter((group) => group.textMessages > 0).slice(0, 3).map((group) => group.name);
    await send({
      title: `群消息简报：${briefing.totals.groups} 个群有 ${totalMessages} 条新消息`,
      body: [
        briefing.highlights.newThings.length > 0 ? `${briefing.highlights.newThings.length} 个新东西` : "",
        briefing.highlights.qa.length > 0 ? `${briefing.highlights.qa.length} 个问答` : "",
        topNames.length > 0 ? `最热闹：${topNames.join("、")}` : "",
      ].filter(Boolean).join(" · "),
      url: serverUrl,
    });
    next.dailyDay = today;
  }
  setState(db, NOTIFY_STATE_KEY, next);
};

const start = ({ url, afterTick }) => {
  serverUrl = url;
  onTickFinished = afterTick ?? (() => {});
  schedule(FIRST_TICK_DELAY_MS);
};

const stop = () => {
  stopping = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (child !== null) {
    platform.killTree(child.pid);
  }
};

const runNow = ({ force = true } = {}) => tick({ force });

const getStatus = () => ({
  settings: settings(),
  readinessProblem: readiness(),
  running: status.running,
  lastStartedAt: status.lastStartedAt,
  lastFinishedAt: status.lastFinishedAt,
  lastResult: status.lastResult,
  lastError: status.lastError,
  nextRunAt: status.nextRunAt,
  log: status.log.slice(-12),
});

module.exports = { start, stop, runNow, getStatus, saveSettings, notifyAfterTick, followUpDelay, lineReader, parseResult, DEFAULTS };
