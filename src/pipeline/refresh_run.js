"use strict";

// One background refresh tick (spawned by server/background.js every ~15 min):
//   mirror sync -> per-group export from where the store's coverage ends ->
//   ingest -> harvest image parameters -> close/summarize/merge briefing chunks.
// Each watched group continues from its own coverage end (capped at a 7-day
// look-back), so gaps left while the app was closed fill themselves in.
//
//   node src/pipeline/refresh_run.js [--force] [--no-llm]
// Prints one machine-readable line at the end: refreshResult={...json}

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { loadConfig } = require("../server/toolkit_state");
const messageStore = require("../message_store");
const { ensureBriefingSchema, getState, setState, redoStats, requeueDeclined } = require("../briefing_store");
const { REMOTE_LIFETIME_SECONDS, ingestPictures } = require("../picture_store");
const { REPAIR_STATE_KEY } = require("../repair_picture_text");
const { backfillStarts, recordFailedExport } = require("../backfill_replies");
const engine = require("../briefing_engine");
const { createClient, currentModel, currentDetail, setUsageRecorder, isDeclinedSummary } = require("../llm_summarizer");
const digestEngine = require("../digest_engine");
const { ensureDigestSchema } = require("../digest_store");
const { ensureUsageSchema, recordUsage, todaySpend } = require("../llm_usage");
const { priceTable } = require("../llm_pricing");
const { readSecretSync } = require("../secrets");
const { lowerOwnPriority } = require("../platform");
const { isLlmConfigured, resolveLlmRoute, markGrokUnavailable } = require("../llm_route");
const { profileFor } = require("../llm_profiles");
const common = require("./common");

const OVERLAP_SECONDS = 600;
const FIRST_SCAN_SECONDS = 26 * 3600;
const MAX_LOOKBACK_SECONDS = 7 * 24 * 3600;
const refreshRoot = path.join(common.storeDir, "refresh");
const STALE_WORK_DIR_MS = 24 * 3600 * 1000;

// Each tick works in its own directory, so two overlapping refreshes (e.g. a
// manual "立即刷新" racing the timer) can never delete each other's files.
const createWorkDir = () => {
  fs.mkdirSync(refreshRoot, { recursive: true });
  for (const entry of fs.readdirSync(refreshRoot, { withFileTypes: true })) {
    const entryPath = path.join(refreshRoot, entry.name);
    try {
      if (Date.now() - fs.statSync(entryPath).mtimeMs > STALE_WORK_DIR_MS) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Another tick removed it first.
    }
  }
  return fs.mkdtempSync(path.join(refreshRoot, `${process.pid}-`));
};

// From the end of each group's unbroken coverage (a gap inside the look-back
// is read again), else from its newest coverage end.
const groupStartsFor = (groupIds, now) => {
  const db = messageStore.openStore(common.storeDbPath);
  try {
    const ends = messageStore.getCoverageEnds(db);
    const resume = messageStore.getCoverageResume(db, now - MAX_LOOKBACK_SECONDS);
    return Object.fromEntries(groupIds.map((groupId) => {
      const end = Number(resume[groupId] ?? ends[groupId]);
      const start = Number.isFinite(end) && end > 0 ? end - OVERLAP_SECONDS : now - FIRST_SCAN_SECONDS;
      return [groupId, Math.max(start, now - MAX_LOOKBACK_SECONDS)];
    }));
  } finally {
    db.close();
  }
};

// Pictures of the last 31 days (what Tencent still serves) for groups whose
// history was stored before the picture table existed, or that were added to
// the watchlist since. Done once per group.
// v2: stickers are recorded too (the first backfill left them out).
const PICTURE_BACKFILL_KEY = "pictures_backfill_v2";

const pictureBackfillGroups = (groupIds) => {
  const db = ensureBriefingSchema(messageStore.openStore(common.storeDbPath));
  try {
    const done = new Set(getState(db, PICTURE_BACKFILL_KEY, null)?.groups ?? []);
    return groupIds.filter((groupId) => !done.has(groupId));
  } finally {
    db.close();
  }
};

const ingestPictureBackfill = (filePath, groupIds) => {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const failed = new Set(data.failedGroups.map((item) => item.groupId));
  const db = ensureBriefingSchema(messageStore.openStore(common.storeDbPath));
  try {
    let inserted = 0;
    db.transaction(() => {
      for (const item of data.items) {
        inserted += ingestPictures(db, item.pictures.map((picture, index) => ({
          ...picture, groupId: item.groupId, rowId: `m${item.rowId}`, seq: picture.seq ?? index, sentAt: item.sentAt,
        })));
      }
      const done = getState(db, PICTURE_BACKFILL_KEY, null)?.groups ?? [];
      setState(db, PICTURE_BACKFILL_KEY, { groups: [...new Set([...done, ...groupIds.filter((groupId) => !failed.has(groupId))])] });
    })();
    return inserted;
  } finally {
    db.close();
  }
};

// Rows stored before v0.0.14 carry picture leftovers as text; repaired once
// (src/repair_picture_text.js, which records when it is done).
const pictureTextRepairDone = () => {
  const db = ensureBriefingSchema(messageStore.openStore(common.storeDbPath));
  try {
    return getState(db, REPAIR_STATE_KEY, null) !== null;
  } finally {
    db.close();
  }
};

// Replies stored before v0.0.21 are missing (only msg_type1 2 was exported);
// added over each group's stored span until every group's export completed
// (src/backfill_replies.js keeps track). null when nothing is left to do.
const replyBackfillStarts = (groupIds) => {
  const db = ensureBriefingSchema(messageStore.openStore(common.storeDbPath));
  try {
    const starts = backfillStarts(db, groupIds);
    return Object.keys(starts).length > 0 ? starts : null;
  } finally {
    db.close();
  }
};

// The replies-only export wrote nothing: counts as a try, so it is given up
// after enough of them instead of re-reading all history every refresh.
const replyBackfillFailed = (groupIds) => {
  const db = ensureBriefingSchema(messageStore.openStore(common.storeDbPath));
  try {
    recordFailedExport(db, groupIds);
  } finally {
    db.close();
  }
};

const briefingEnabled = (config, values) =>
  values["no-llm"] !== true && config.background?.autoSummarize !== false && isLlmConfigured(config);

// Optional daily money budget from 设置 (config.background.dailyBudget):
// once today's estimated spend reaches it, the briefing stops calling the LLM.
const moneyBudgetCheck = (db, config, now) => {
  const budget = config.background?.dailyBudget;
  const amount = Number(budget?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !["CNY", "USD"].includes(budget?.currency)) {
    return undefined;
  }
  const prices = priceTable(config);
  return () => (todaySpend(db, { nowUnix: now, prices, currency: budget.currency }) >= amount ? "money-budget" : null);
};

// The detail level fixes the engine's chunk size, waits and merge cadence;
// at the standard level the user's own 合并频率 / 等待 settings apply.
const engineOptions = (config, detail) => {
  const profile = profileFor(detail);
  if (!profile.userTunable) {
    return profile.engine;
  }
  const intervalMinutes = Number(config.background?.reduceIntervalMinutes);
  const tailWaitMinutes = Number(config.background?.tailWaitMinutes);
  return {
    ...(Number.isFinite(tailWaitMinutes) && tailWaitMinutes >= 60 ? { tailMaxAgeSeconds: tailWaitMinutes * 60 } : {}),
    ...(Number.isFinite(intervalMinutes) && intervalMinutes >= 0 ? { reduceIntervalSeconds: intervalMinutes * 60 } : {}),
  };
};

// 每日总览 / 周报 / 月报 after the briefing: each call passes the same pause,
// daily-cap and money gate, plus a per-run cap so a month's backlog of day
// overviews is spread over several refreshes.
const runDigests = async (db, client, { now, gate }) => {
  let calls = 0;
  const maxCalls = profileFor(currentDetail(client)).digest.maxScheduledCalls;
  const digestGate = () => {
    if (calls >= maxCalls) {
      return "digest-run-cap";
    }
    const blocked = engine.allowSpend(db, now, { ...engine.DEFAULTS, ...gate });
    if (blocked === null) {
      calls += 1;
    }
    return blocked;
  };
  try {
    const outcome = await digestEngine.runScheduledDigests(ensureDigestSchema(db), client, { now, gate: digestGate });
    for (const item of outcome.filter((entry) => entry.status === "done" || entry.status === "failed")) {
      common.info(`digest ${item.kind} ${item.period} ${item.status}${item.error ? `: ${item.error}` : ""}`);
    }
    return outcome;
  } catch (error) {
    common.warn(`总览/周报生成失败：${error.message}`);
    return [];
  }
};

// Before v0.0.20 a refused AI account (e.g. an empty DeepSeek balance) used up
// every chunk's attempts, and those messages were never summarized. Such
// chunks get one more go, once; a detailed-level backlog goes into the job
// queue so it cannot crowd out new messages.
const REQUEUE_ACCOUNT_FAILURES_KEY = "requeue_account_failures_v1";

const requeueAccountFailuresOnce = (db, { now, asJob }) => {
  if (getState(db, REQUEUE_ACCOUNT_FAILURES_KEY, null) !== null) {
    return;
  }
  const requeued = engine.requeueFailedChunks(db, { onlyAccountErrors: true, asJob });
  setState(db, REQUEUE_ACCOUNT_FAILURES_KEY, { at: now, requeued, asJob });
  if (requeued > 0) {
    common.info(`briefing requeued ${requeued} chunks the AI account had refused${asJob ? " (detailed job)" : ""}`);
  }
};

// Before v0.0.20 a refusal that came back in the right shape ("我不能整理…",
// every list empty) was stored as the summary; those chunks are summarized
// again, once (a fresh refusal is now caught and asked elsewhere).
const REQUEUE_DECLINED_KEY = "requeue_declined_v1";
const requeueDeclinedOnce = (db, { now }) => {
  if (getState(db, REQUEUE_DECLINED_KEY, null) !== null) {
    return;
  }
  const requeued = requeueDeclined(db, isDeclinedSummary);
  setState(db, REQUEUE_DECLINED_KEY, { at: now, requeued });
  if (requeued > 0) {
    common.info(`briefing requeued ${requeued} chunks whose stored summary was a refusal`);
  }
};

const runBriefing = async ({ config, groupIds, now, force }) => {
  let route;
  try {
    route = await resolveLlmRoute(config);
  } catch (error) {
    common.warn(`跳过自动总结：${error.message}`);
    return { skipped: "llm-not-configured" };
  }
  if (route.grokSkipped !== null) {
    common.warn(`Grok 暂时不可用，本次改用 ${route.primary.model}：${route.grokSkipped}`);
  }
  const db = ensureUsageSchema(ensureBriefingSchema(messageStore.openStore(common.storeDbPath)));
  setUsageRecorder((entry) => {
    try {
      recordUsage(db, entry);
    } catch (error) {
      common.warn(`AI 用量未能记录：${error.message}`);
    }
  });
  try {
    const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
    const gate = { ...engineOptions(config, route.primary.detail), spendCheck: moneyBudgetCheck(db, config, now) };
    requeueAccountFailuresOnce(db, { now, asJob: route.primary.detail === "detailed" });
    requeueDeclinedOnce(db, { now });
    const created = engine.closeChunks(db, groupIds, { now, force, ...gate });
    common.progress(`briefing-chunks:${created}`);
    const map = await engine.mapPendingChunks(db, client, { now, log: common.info, ...gate });
    // The account was refused: merges and digests would be refused as well.
    const aiDown = map.routeDown !== null;
    const reduce = aiDown ? { skipped: "ai-down" } : await engine.reduceBriefs(db, client, groupIds, { now, force, log: common.info, ...gate });
    const digests = aiDown ? [] : await runDigests(db, client, { now, gate });
    return {
      chunksCreated: created,
      map,
      reduce,
      digests,
      // Detailed-level job chunks still queued (the console continues sooner while they last).
      jobQueued: redoStats(db).queued,
      budget: engine.budgetStatus(db, now, profileFor(route.primary.detail).engine.dailyLlmCallLimit),
      pause: engine.pauseStatus(db, now),
      llm: {
        model: currentModel(client),
        usedFallback: client.state.usingFallback || route.grokSkipped !== null,
        // Calls the primary could not answer (e.g. Grok declining adult chat) that the fallback did.
        answeredByFallback: client.state.answeredByFallback,
      },
    };
  } finally {
    setUsageRecorder(null);
    db.close();
  }
};

const main = async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { force: { type: "boolean" }, "no-llm": { type: "boolean" } },
    strict: true,
  });
  const config = loadConfig();
  const groupIds = common.watchlistGroupIds(config);
  if (groupIds.length === 0) {
    common.result("refreshResult", JSON.stringify({ skipped: "no-watchlist" }));
    return;
  }
  lowerOwnPriority();
  const startedAt = Date.now();
  const now = common.nowUnix();
  const starts = groupStartsFor(groupIds, now);
  const earliest = Math.min(...Object.values(starts));
  const workDir = createWorkDir();
  try {
    await refreshIn(workDir, { config, values, groupIds, starts, earliest, now, startedAt });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const refreshIn = async (workDir, { config, values, groupIds, starts, earliest, now, startedAt }) => {
  const startsPath = path.join(workDir, "group-starts.json");
  const exportPath = path.join(workDir, "export.json");
  const analysisDir = path.join(workDir, "analysis");
  const picturesPath = path.join(workDir, "pictures.json");
  const backfillGroups = pictureBackfillGroups(groupIds);
  const repairText = !pictureTextRepairDone();
  let textRepair = null;
  const replyStarts = replyBackfillStarts(groupIds);
  const replyStartsPath = path.join(workDir, "reply-starts.json");
  const replyExportPath = path.join(workDir, "reply-export.json");
  let replyBackfill = null;
  common.writeJson(startsPath, starts);
  const env = { NTQQ_DB_KEY: readSecretSync("ntqqKey"), QQ_GROUP_STARTS_JSON: startsPath };
  const scanLimit = Number(config.defaultScanLimit) > 0 ? Number(config.defaultScanLimit) : 1000000;

  // Per-step wall time, reported with the result so a slow tick can be
  // diagnosed from the settings page without re-running anything.
  const timings = {};
  const timed = async (name, fn) => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - started;
    }
  };

  let mirrorMs = 0;
  try {
    await common.withFreshMirror(config, "background", async (mirror) => {
      mirrorMs = mirror.elapsedMs;
      timings.mirror = mirror.elapsedMs;
      await timed("export", () => common.runNodeScriptOrThrow(
        "export_group_recent.js",
        [mirror.messageDb, mirror.groupDb, groupIds.join(","), earliest, now, exportPath, scanLimit],
        { env },
        "导出消息失败",
      ));
      if (repairText) {
        const repair = await timed("textRepair", () => common.runNodeScript("repair_picture_text.js", [mirror.messageDb, common.storeDbPath], { env }));
        const line = repair.stdout.split(/\r?\n/u).find((item) => item.startsWith("repairResult="));
        textRepair = line === undefined ? { failed: true } : JSON.parse(line.slice("repairResult=".length));
      }
      if (replyStarts !== null) {
        common.writeJson(replyStartsPath, replyStarts);
        const replyGroups = Object.keys(replyStarts);
        const exported = await timed("replyExport", () => common.runNodeScript("export_group_recent.js", [
          mirror.messageDb, mirror.groupDb, replyGroups.join(","), Math.min(...Object.values(replyStarts)), now, replyExportPath, scanLimit,
        ], { env: { ...env, QQ_GROUP_STARTS_JSON: replyStartsPath, QQ_EXPORT_REPLIES_ONLY: "1" } }));
        if (exported.code !== 0) {
          common.warn(`补回旧的回复消息失败，下次刷新再试（退出码 ${exported.code}）`);
        }
        if (!fs.existsSync(replyExportPath)) {
          replyBackfillFailed(replyGroups);
        }
      }
      if (backfillGroups.length > 0) {
        await timed("pictureBackfill", () => common.runNodeScript("export_pictures.js", [
          mirror.messageDb, backfillGroups.join(","), now - REMOTE_LIFETIME_SECONDS, now, picturesPath,
        ], { env }));
      }
      await timed("unreadHint", () => common.runNodeScript("probe_qq_unread.js", [
        mirror.messageDb,
        path.join(common.storeDir, "qq-unread-hint.json"),
        path.join(common.toolRoot, "config", "defaults.json"),
      ], { env, quiet: true }));
    }, { wait: false });
  } catch (error) {
    if (/被占用/u.test(error.message)) {
      common.result("refreshResult", JSON.stringify({ skipped: "busy" }));
      return;
    }
    throw error;
  }

  const ingest = await timed("ingest", () => common.runNodeScript("ingest_store.js", [exportPath, common.storeDbPath, `bg-${common.localStamp()}`], { env }));
  const inserted = Number(/inserted=(\d+)/u.exec(ingest.stdout)?.[1] ?? 0);
  const picturesBackfilled = fs.existsSync(picturesPath) ? ingestPictureBackfill(picturesPath, backfillGroups) : 0;
  if (fs.existsSync(replyExportPath)) {
    const backfill = await timed("replyBackfill", () => common.runNodeScript("backfill_replies.js", [replyExportPath, common.storeDbPath], { env }));
    const line = backfill.stdout.split(/\r?\n/u).find((item) => item.startsWith("backfillResult="));
    replyBackfill = line === undefined ? { failed: true } : JSON.parse(line.slice("backfillResult=".length));
  }

  const ntDataDir = String(config.ntDataDir ?? "").trim();
  if (ntDataDir.length > 0 && fs.existsSync(ntDataDir)) {
    await timed("knowledge", async () => {
      await common.runNodeScript("analyze_export.js", [exportPath, analysisDir], { env, quiet: true });
      const mediaMessages = path.join(analysisDir, "media-messages.json");
      if (fs.existsSync(mediaMessages)) {
        await common.runNodeScript("harvest_run_media.js", [mediaMessages, ntDataDir, common.knowledgeDbPath, exportPath], { env, quiet: true });
      }
    });
  }

  const briefing = briefingEnabled(config, values)
    ? await timed("briefing", () => runBriefing({ config, groupIds, now, force: values.force === true }))
    : { skipped: "disabled" };

  common.result("refreshResult", JSON.stringify({
    groups: groupIds.length,
    inserted,
    picturesBackfilled,
    textRepair,
    replyBackfill,
    // Where each group's window began: older messages of this tick came
    // from the reply backfill (notices skip them).
    windowStarts: starts,
    mirrorMs,
    elapsedMs: Date.now() - startedAt,
    timings,
    briefing,
  }));
};

if (require.main === module) {
  common.runMain(main);
}
