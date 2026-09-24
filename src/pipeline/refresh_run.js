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
const { ensureBriefingSchema } = require("../briefing_store");
const engine = require("../briefing_engine");
const { createClient, setUsageRecorder } = require("../llm_summarizer");
const { ensureUsageSchema, recordUsage, todaySpend } = require("../llm_usage");
const { priceTable } = require("../llm_pricing");
const { readSecretSync, hasSecret } = require("../secrets");
const { lowerOwnPriority } = require("../platform");
const { resolveLlmOptions } = require("./llm_options");
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

const groupStartsFor = (groupIds, now) => {
  const db = messageStore.openStore(common.storeDbPath);
  try {
    const ends = messageStore.getCoverageEnds(db);
    return Object.fromEntries(groupIds.map((groupId) => {
      const end = Number(ends[groupId]);
      const start = Number.isFinite(end) && end > 0 ? end - OVERLAP_SECONDS : now - FIRST_SCAN_SECONDS;
      return [groupId, Math.max(start, now - MAX_LOOKBACK_SECONDS)];
    }));
  } finally {
    db.close();
  }
};

const briefingEnabled = (config, values) =>
  values["no-llm"] !== true && config.background?.autoSummarize !== false && hasSecret("llmKey");

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

const runBriefing = async ({ config, groupIds, now, force }) => {
  let llm;
  try {
    llm = resolveLlmOptions(config);
  } catch (error) {
    common.warn(`跳过自动总结：${error.message}`);
    return { skipped: "llm-not-configured" };
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
    const client = createClient(llm);
    const intervalMinutes = Number(config.background?.reduceIntervalMinutes);
    const tailWaitMinutes = Number(config.background?.tailWaitMinutes);
    const gate = {
      ...(Number.isFinite(tailWaitMinutes) && tailWaitMinutes >= 60 ? { tailMaxAgeSeconds: tailWaitMinutes * 60 } : {}),
      spendCheck: moneyBudgetCheck(db, config, now),
      ...(Number.isFinite(intervalMinutes) && intervalMinutes >= 0 ? { reduceIntervalSeconds: intervalMinutes * 60 } : {}),
    };
    const created = engine.closeChunks(db, groupIds, { now, force, ...gate });
    common.progress(`briefing-chunks:${created}`);
    const map = await engine.mapPendingChunks(db, client, { now, log: common.info, ...gate });
    const reduce = await engine.reduceBriefs(db, client, groupIds, { now, force, log: common.info, ...gate });
    return { chunksCreated: created, map, reduce, budget: engine.budgetStatus(db, now), pause: engine.pauseStatus(db, now) };
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
    mirrorMs,
    elapsedMs: Date.now() - startedAt,
    timings,
    briefing,
  }));
};

if (require.main === module) {
  common.runMain(main);
}
