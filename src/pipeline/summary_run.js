"use strict";

// One summary run: mirror sync -> export -> store -> analyze -> knowledge ->
// per-group LLM -> media -> reports. Replaces run_one_click_summary.ps1 and
// summarize_groups.ps1 (same steps, same progress markers, any OS).
//
//   node src/pipeline/summary_run.js (--watchlist | --groups 1,2)
//     [--since-hours N | --days N | --start "2026-07-02 18:30" [--end ...] | --since-last-record]
//     [--group-starts file.json] [--llm | --no-llm] [--media | --no-media]

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { loadConfig } = require("../server/toolkit_state");
const messageStore = require("../message_store");
const { writeLlmError, writeLlmUnused, clearLlmUnused } = require("../llm_status");
const { readSecretSync } = require("../secrets");
const { resolveLlmOptions, llmEnv } = require("./llm_options");
const common = require("./common");

const SINCE_RECORD_OVERLAP_SECONDS = 600;
const SINCE_RECORD_MAX_LOOKBACK_SECONDS = 30 * 24 * 3600;
const SINCE_RECORD_FALLBACK_HOURS = 26;
const DEFAULT_MEDIA_FORMATS = "jpg,jpeg,png,gif,webp,mp4,mov,avi,mkv";

const parseCli = (argv) => parseArgs({
  args: argv,
  options: {
    watchlist: { type: "boolean" },
    groups: { type: "string" },
    "since-hours": { type: "string" },
    days: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    "since-last-record": { type: "boolean" },
    "group-starts": { type: "string" },
    llm: { type: "boolean" },
    "no-llm": { type: "boolean" },
    media: { type: "boolean" },
    "no-media": { type: "boolean" },
  },
  strict: true,
}).values;

const flag = (values, on, off) => (values[on] === true ? true : values[off] === true ? false : undefined);

const selectGroups = (values, config) => {
  if (values.watchlist === true) {
    const ids = common.watchlistGroupIds(config);
    if (ids.length === 0) {
      throw new Error("关注群列表为空。请先在控制台「设置 → 关注群」添加。");
    }
    return ids;
  }
  const source = values.groups !== undefined ? [values.groups] : config.defaultGroupIds ?? [];
  const ids = common.normalizeGroupIds(source);
  if (ids.length === 0) {
    throw new Error("没有可用的群号。请传 --groups 123,456 或 --watchlist。");
  }
  return ids;
};

const positive = (text, name, max) => {
  const value = Number.parseInt(String(text), 10);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`无效的${name}: ${text}`);
  }
  return value;
};

const coverageStartFromStore = (groupIds) => {
  if (!fs.existsSync(common.storeDbPath)) {
    return null;
  }
  const db = messageStore.openStore(common.storeDbPath);
  try {
    const ends = messageStore.getCoverageEnds(db);
    const known = groupIds.map((groupId) => ends[groupId]).filter((value) => Number.isFinite(value) && value > 0);
    return known.length === 0 ? null : Math.min(...known);
  } finally {
    db.close();
  }
};

const resolveRange = (values, config, groupIds) => {
  const now = common.nowUnix();
  const explicit = ["since-hours", "days", "start", "end"].some((key) => values[key] !== undefined);
  if (values["since-last-record"] === true && !explicit) {
    const coverageStart = coverageStartFromStore(groupIds);
    if (coverageStart !== null) {
      common.info("本次从上次记录点继续扫描（重叠 10 分钟用于去重）。");
      const start = Math.max(coverageStart, now - SINCE_RECORD_MAX_LOOKBACK_SECONDS) - SINCE_RECORD_OVERLAP_SECONDS;
      return { startUnix: start, endUnix: now, label: "since-store" };
    }
    common.warn("还没有本地扫描记录可作起点，本次改用最近 26 小时。");
    return { startUnix: now - SINCE_RECORD_FALLBACK_HOURS * 3600, endUnix: now, label: `last-${SINCE_RECORD_FALLBACK_HOURS}h` };
  }
  if (values.start !== undefined || values.end !== undefined) {
    if (values.start === undefined) {
      throw new Error("提供了结束时间时必须同时提供开始时间（--start）。");
    }
    const startUnix = common.parseBeijingTime(values.start);
    const endUnix = values.end === undefined ? now : common.parseBeijingTime(values.end);
    return { startUnix, endUnix, label: "custom" };
  }
  const defaultHours = Number(config.runDefaults?.sinceHours);
  const hours = values["since-hours"] !== undefined
    ? positive(values["since-hours"], "小时数", 24 * 365)
    : values.days === undefined && Number.isInteger(defaultHours) && defaultHours > 0 ? defaultHours : null;
  if (hours !== null) {
    return { startUnix: now - hours * 3600, endUnix: now, label: `last-${hours}h` };
  }
  const days = values.days !== undefined ? positive(values.days, "天数", 3650) : positive(config.defaultDays ?? 7, "默认天数", 3650);
  return { startUnix: now - days * 86400, endUnix: now, label: `last-${days}d` };
};

const tryResolveLlm = (config, explicit) => {
  try {
    return resolveLlmOptions(config);
  } catch (error) {
    if (explicit) {
      throw error;
    }
    // LLM came from config defaults: a missing key must not block the run.
    common.warn(`本次跳过 AI 总结（${error.message}），报告将使用本地分组。`);
    return null;
  }
};

const llmArgs = (analysisDir, llm) => [
  path.join(analysisDir, "analysis.json"),
  path.join(analysisDir, "messages.json"),
  path.join(analysisDir, "llm-summary.json"),
  llm.baseUrl,
  llm.model,
  llm.apiKeyEnv,
  llm.maxMessages,
  llm.maxChars,
];

const markLlmFailure = (analysisDir, code) => {
  clearLlmUnused(analysisDir);
  if (!fs.existsSync(path.join(analysisDir, "llm-error.json"))) {
    writeLlmError(analysisDir, new Error(`LLM adapter exited ${code}`));
  }
};

const summarizeGroups = async ({ groupIds, exportPath, analysisDir, llm, llmOptional, env }) => {
  if (groupIds.length > 1) {
    // Digest mode: one analysis + one LLM summary per group, so topics never mix.
    for (const groupId of groupIds) {
      common.progress(`group-start:${groupId}`);
      const groupDir = path.join(analysisDir, "groups", groupId);
      fs.mkdirSync(groupDir, { recursive: true });
      await common.runNodeScriptOrThrow("analyze_export.js", [exportPath, groupDir, groupId], { env, quiet: true }, `分析群 ${groupId} 失败`);
      if (llm === null) {
        writeLlmUnused(groupDir);
        common.progress(`group-llm-done:${groupId}`);
        continue;
      }
      const outcome = await common.runNodeScript("llm_adapter.js", llmArgs(groupDir, llm), { env });
      if (outcome.code === 0) {
        common.progress(`group-llm-done:${groupId}`);
      } else {
        common.warn(`群 ${groupId} 的 AI 总结失败（退出码 ${outcome.code}），该群将使用本地分组。`);
        common.progress(`group-llm-failed:${groupId}`);
        markLlmFailure(groupDir, outcome.code);
      }
    }
    return;
  }
  if (llm === null) {
    writeLlmUnused(analysisDir);
    return;
  }
  common.progress("llm-start");
  const outcome = await common.runNodeScript("llm_adapter.js", llmArgs(analysisDir, llm), { env });
  if (outcome.code === 0) {
    common.progress("llm-done");
    return;
  }
  if (!llmOptional) {
    throw new Error(`AI 总结失败（退出码 ${outcome.code}）。`);
  }
  common.warn(`AI 总结失败（退出码 ${outcome.code}），报告将使用本地分组。`);
  common.progress("llm-failed");
  markLlmFailure(analysisDir, outcome.code);
};

const exportMedia = async ({ config, runDir, env }) => {
  common.progress("media-start");
  const ntDataDir = String(config.ntDataDir ?? "").trim();
  if (ntDataDir.length === 0 || !fs.existsSync(ntDataDir)) {
    common.warn("未配置或找不到 nt_data 目录，本次跳过媒体导出（报告不受影响）。可在设置页填写 QQ 数据库路径。");
    return;
  }
  const mediaMessages = path.join(runDir, "analysis", "media-messages.json");
  if (!fs.existsSync(mediaMessages)) {
    common.warn("找不到媒体消息清单，跳过媒体导出。");
    return;
  }
  const formats = String(config.runDefaults?.mediaFormats ?? DEFAULT_MEDIA_FORMATS);
  const outcome = await common.runNodeScript("export_media_files.js", [
    mediaMessages,
    ntDataDir,
    path.join(runDir, "media"),
    formats,
    path.join(common.storeDir, "media-objects"),
    common.knowledgeDbPath,
    common.toolRoot,
  ], { env });
  if (outcome.code !== 0) {
    common.warn(`媒体导出失败（退出码 ${outcome.code}），本次报告将没有本地媒体预览，其余不受影响。`);
  }
};

const harvestKnowledge = async ({ config, analysisDir, exportPath, env }) => {
  const ntDataDir = String(config.ntDataDir ?? "").trim();
  const mediaMessages = path.join(analysisDir, "media-messages.json");
  if (ntDataDir.length === 0 || !fs.existsSync(ntDataDir) || !fs.existsSync(mediaMessages)) {
    return;
  }
  // The only moment both the image (QQ evicts cached originals) and its
  // sender are available: harvest AI generation parameters now.
  const outcome = await common.runNodeScript("harvest_run_media.js", [mediaMessages, ntDataDir, common.knowledgeDbPath, exportPath], { env });
  if (outcome.code !== 0) {
    common.warn(`图片参数入库失败（退出码 ${outcome.code}），本次报告不受影响。`);
  }
  common.progress("knowledge-done");
};

const writeReports = async ({ runDir, reportPath, config, env }) => {
  common.progress("report-start");
  if (fs.existsSync(path.join(runDir, "analysis", "groups"))) {
    await common.runNodeScriptOrThrow("generate_digest_report.js", [runDir, reportPath], { env }, "生成多群摘要报告失败");
  } else {
    await common.runNodeScriptOrThrow(
      "generate_report.js",
      [path.join(runDir, "analysis", "analysis.json"), path.join(runDir, "analysis", "messages-clean.txt"), reportPath],
      { env },
      "生成报告失败",
    );
  }
  const configPath = path.join(common.toolRoot, "config", "defaults.json");
  await common.runNodeScriptOrThrow("generate_report_center.js", [configPath, path.join(config.reportsDir, "index.html")], { env }, "生成报告中心失败");
};

const main = async () => {
  const values = parseCli(process.argv.slice(2));
  const config = loadConfig();
  const groupIds = selectGroups(values, config);
  const llmFlag = flag(values, "llm", "no-llm");
  const mediaFlag = flag(values, "media", "no-media");
  const useLlm = llmFlag ?? config.runDefaults?.useLlm === true;
  const useMedia = mediaFlag ?? config.runDefaults?.exportMedia === true;
  const range = resolveRange(values, config, groupIds);
  if (range.startUnix >= range.endUnix) {
    throw new Error(`时间范围无效：开始时间必须早于结束时间。start=${range.startUnix} end=${range.endUnix}`);
  }
  const scanLimit = Number(config.defaultScanLimit) > 0 ? Number(config.defaultScanLimit) : 1000000;
  const runId = common.makeRunId(groupIds, "time", range.label);
  const runDir = path.join(config.runsDir, runId);
  const reportPath = path.join(config.reportsDir, `${runId}.md`);
  const analysisDir = path.join(runDir, "analysis");
  const csv = groupIds.join(",");
  const exportPath = path.join(runDir, "exports", `groups_${common.shortStableHash(csv)}_${range.startUnix}_${range.endUnix}.json`);
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });

  const llm = useLlm ? tryResolveLlm(config, llmFlag === true) : null;
  const env = {
    NTQQ_DB_KEY: readSecretSync("ntqqKey"),
    ...llmEnv(llm),
    ...(values["group-starts"] ? { QQ_GROUP_STARTS_JSON: path.resolve(values["group-starts"]) } : {}),
  };

  common.progress("copy-start");
  await common.withFreshMirror(config, "summary", async (mirror) => {
    common.info(`数据库副本已同步（${Math.round(mirror.elapsedMs / 100) / 10} 秒）。`);
    common.progress("export-start");
    await common.runNodeScriptOrThrow(
      "export_group_recent.js",
      [mirror.messageDb, mirror.groupDb, csv, range.startUnix, range.endUnix, exportPath, scanLimit],
      { env },
      "导出消息失败",
    );
    common.progress("export-done");
    const hint = await common.runNodeScript("probe_qq_unread.js", [
      mirror.messageDb,
      path.join(common.storeDir, "qq-unread-hint.json"),
      path.join(common.toolRoot, "config", "defaults.json"),
    ], { env });
    if (hint.code !== 0) {
      common.warn(`QQ 未读提示读取失败（退出码 ${hint.code}）；总结继续。`);
    }
  });

  const ingest = await common.runNodeScript("ingest_store.js", [exportPath, common.storeDbPath, runId], { env });
  if (ingest.code !== 0) {
    common.warn(`消息库写入失败（退出码 ${ingest.code}），「消息」页可能缺这次的数据；报告不受影响。`);
  }
  common.progress("store-done");

  await common.runNodeScriptOrThrow("analyze_export.js", [exportPath, analysisDir], { env }, "分析消息失败");
  common.progress("analyze-done");
  await harvestKnowledge({ config, analysisDir, exportPath, env });
  await summarizeGroups({ groupIds, exportPath, analysisDir, llm, llmOptional: llmFlag !== true, env });
  if (useMedia) {
    await exportMedia({ config, runDir, env });
  }
  await writeReports({ runDir, reportPath, config, env });

  const htmlPath = reportPath.replace(/\.md$/u, ".html");
  common.info("");
  common.info("完成");
  common.result("runDir", runDir);
  common.result("reportPath", reportPath);
  common.result("htmlPath", htmlPath);
  common.result("messagesText", path.join(analysisDir, "messages-clean.txt"));
  common.result("groupIds", csv);
  common.result("mode", "time");
  common.result("startUnix", range.startUnix);
  common.result("endUnix", range.endUnix);
  if (llm !== null) {
    common.result("llmProvider", llm.provider);
    common.result("llmModel", llm.model);
  }
  if (useMedia) {
    common.result("mediaDir", path.join(runDir, "media"));
  }
};

if (require.main === module) {
  common.runMain(main);
}

module.exports = { resolveRange, selectGroups, parseCli };
