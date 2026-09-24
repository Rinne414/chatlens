"use strict";

// 备份 job. Scans (and with mode "save", saves) the chosen groups' pictures,
// videos, files and chat logs for a date range, out of the PC QQ cache into a
// backup folder, then reports whether the range can be cleaned up safely.
//
//   node src/pipeline/backup_run.js <request.json>
//
// request: { mode: "scan"|"save", groupIds, fromUnix, toUnix, categories,
//            remote, targetDir }. A save right after a scan of the same range
// reuses that scan's export. Prints backupReport=<path> at the end.

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../server/toolkit_state");
const messageStore = require("../message_store");
const { readSecretSync } = require("../secrets");
const { lowerOwnPriority } = require("../platform");
const { buildMediaIndex } = require("../export_media_files");
const { planBackup, summarizeBackup, safeSegment } = require("../backup_plan");
const files = require("../backup_files");
const common = require("./common");

const backupRoot = path.join(common.storeDir, "backup");
const REUSE_EXPORT_MS = 60 * 60 * 1000;

const readRequest = (requestPath) => {
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!["scan", "save"].includes(request.mode) || !Array.isArray(request.groupIds) || request.groupIds.length === 0) {
    throw new Error("备份请求无效。");
  }
  if (!Number.isFinite(request.fromUnix) || !Number.isFinite(request.toUnix) || request.toUnix <= request.fromUnix) {
    throw new Error("备份时间范围无效。");
  }
  if (typeof request.targetDir !== "string" || !path.isAbsolute(request.targetDir)) {
    throw new Error("备份文件夹必须是完整路径。");
  }
  return request;
};

const workDirFor = (request) =>
  path.join(backupRoot, `work-${common.shortStableHash([request.groupIds.join(","), request.fromUnix, request.toUnix].join("|"))}`);

// Mirror -> export -> ingest (for the chat logs) -> analyze (media list) ->
// harvest (so AI parameters and prompt requests are known for this range).
const exportRange = async (config, request, workDir) => {
  const exportPath = path.join(workDir, "export.json");
  const analysisDir = path.join(workDir, "analysis");
  const mediaMessages = path.join(analysisDir, "media-messages.json");
  const fresh = fs.existsSync(mediaMessages) && Date.now() - fs.statSync(mediaMessages).mtimeMs < REUSE_EXPORT_MS;
  if (request.mode === "save" && fresh) {
    common.info("沿用刚才扫描的导出结果。");
    return mediaMessages;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(analysisDir, { recursive: true });
  const env = { NTQQ_DB_KEY: readSecretSync("ntqqKey") };
  const scanLimit = Number(config.defaultScanLimit) > 0 ? Number(config.defaultScanLimit) : 1000000;
  common.progress("copy-start");
  await common.withFreshMirror(config, "backup", async (mirror) => {
    common.progress("export-start");
    await common.runNodeScriptOrThrow("export_group_recent.js",
      [mirror.messageDb, mirror.groupDb, request.groupIds.join(","), request.fromUnix, request.toUnix, exportPath, scanLimit],
      { env }, "导出消息失败");
  });
  await common.runNodeScript("ingest_store.js", [exportPath, common.storeDbPath, `backup-${common.localStamp()}`], { env, quiet: true });
  await common.runNodeScriptOrThrow("analyze_export.js", [exportPath, analysisDir], { env, quiet: true }, "分析消息失败");
  const ntDataDir = String(config.ntDataDir ?? "").trim();
  if (fs.existsSync(mediaMessages) && ntDataDir.length > 0) {
    await common.runNodeScript("harvest_run_media.js", [mediaMessages, ntDataDir, common.knowledgeDbPath, exportPath], { env, quiet: true });
  }
  fs.rmSync(exportPath, { force: true });
  return mediaMessages;
};

const lesserCopy = (item) => !item.alreadySaved && item.resolution.status !== "original";

// Group pictures the PC lacks an original of, fetched by md5 (verified).
const saveRemote = async ({ request, items, ledger, knowledgeDb }) => {
  const wanted = items.filter((item) => lesserCopy(item) && files.canTryRemote(item));
  if (wanted.length === 0) {
    return;
  }
  common.info(`从 QQ 图片服务器下载 ${wanted.length} 张电脑上没有原图的图片…`);
  const downloads = await files.fetchRemote(wanted);
  for (const item of wanted) {
    const remote = downloads.get(item.key);
    if (remote === null || remote === undefined) {
      continue;
    }
    const saved = files.writeItem(request.targetDir, item, { sourcePath: null, bytes: remote.bytes, extension: remote.extension, status: "remote" }, knowledgeDb);
    item.resolution = { status: "remote", sourcePath: null, bytes: remote.bytes.length };
    // Written first, so a failed write never loses the earlier lesser copy.
    files.removeSuperseded(request.targetDir, ledger.items[item.key]);
    ledger.items[item.key] = files.ledgerEntry(item, saved, "remote", remote.bytes.length);
  }
};

const saveItems = async ({ request, items, ledger, knowledgeDb }) => {
  if (request.remote === true) {
    await saveRemote({ request, items, ledger, knowledgeDb });
  }
  let done = 0;
  for (const item of items) {
    const { sourcePath, bytes, status } = item.resolution;
    if (item.alreadySaved || status === "missing" || status === "remote") {
      continue;
    }
    if (!files.isImprovement(status, item.ledgerStatus)) {
      // Same thumbnail / compressed copy as last time: keep that one.
      item.keptPrevious = true;
      continue;
    }
    const saved = files.writeItem(request.targetDir, item, { sourcePath, extension: files.extensionFor(item, sourcePath), status }, knowledgeDb);
    files.removeSuperseded(request.targetDir, ledger.items[item.key]);
    ledger.items[item.key] = files.ledgerEntry(item, saved, status, bytes);
    done += 1;
    if (done % 200 === 0) {
      common.info(`已保存 ${done} 个文件…`);
    }
  }
};

const groupsOf = (request, mediaMessages, storeDb) => {
  const names = new Map(mediaMessages.map((message) => [String(message.groupId), message.groupName]));
  return request.groupIds.map((groupId) => {
    const name = names.get(groupId) ?? storeDb.prepare("SELECT name FROM group_names WHERE group_id = ?").get(groupId)?.name ?? "";
    return { groupId, groupName: name, folder: `${safeSegment(name, "群", 40)}_${groupId}` };
  });
};

const main = async () => {
  const request = readRequest(process.argv[2]);
  const config = loadConfig();
  const ntDataDir = String(config.ntDataDir ?? "").trim();
  if (ntDataDir.length === 0 || !fs.existsSync(ntDataDir)) {
    throw new Error("找不到 QQ 的 nt_data 目录，请先在「设置」里探测路径。");
  }
  lowerOwnPriority();
  const workDir = workDirFor(request);
  const mediaMessagesPath = await exportRange(config, request, workDir);
  common.progress("media-start");
  const mediaMessages = fs.existsSync(mediaMessagesPath) ? JSON.parse(fs.readFileSync(mediaMessagesPath, "utf8")) : [];
  const knowledgeDb = files.openKnowledge(common.knowledgeDbPath);
  const storeDb = messageStore.openStore(common.storeDbPath);
  try {
    const hashes = mediaMessages.flatMap((message) => (message.mediaRefs ?? []).map((ref) => ref.hash).filter(Boolean)).map((hash) => hash.toLowerCase());
    const ledger = files.loadLedger(request.targetDir);
    const { items, categories, duplicates } = planBackup({ messages: mediaMessages, knowledge: files.knowledgeFlags(knowledgeDb, hashes), categories: request.categories, ledger });
    common.info(`计划 ${items.length} 个文件（同群重复 ${duplicates} 个已合并），正在电脑 QQ 缓存里查找…`);
    const index = buildMediaIndex(ntDataDir, path.join(common.storeDir, "media-objects"));
    for (const item of items) {
      item.resolution = item.alreadySaved ? { status: "original", sourcePath: null, bytes: ledger.items[item.key]?.bytes ?? 0 } : files.resolveItem(item, index);
    }
    common.progress("report-start");
    if (request.mode === "save") {
      fs.mkdirSync(request.targetDir, { recursive: true });
      await saveItems({ request, items, ledger, knowledgeDb });
    }
    const groups = groupsOf(request, mediaMessages, storeDb);
    const logs = categories.logs
      ? files.writeDayLogs({ storeDb, targetDir: request.targetDir, groups, fromUnix: request.fromUnix, toUnix: request.toUnix, ledger, write: request.mode === "save" })
      : new Map();
    if (request.mode === "save") {
      files.saveLedger(request.targetDir, ledger);
      files.writeIndexFiles(request.targetDir, ledger);
    }
    const summary = summarizeBackup(items, { logs });
    const pending = items.filter((item) => !item.alreadySaved && item.resolution.status !== "missing");
    const report = {
      ...summary,
      mode: request.mode,
      targetDir: request.targetDir,
      fromUnix: request.fromUnix,
      toUnix: request.toUnix,
      groupIds: request.groupIds,
      categories,
      remote: request.remote === true,
      remoteCandidates: items.filter((item) => lesserCopy(item) && item.resolution.status !== "remote" && files.canTryRemote(item)).length,
      pendingBytes: request.mode === "scan" ? pending.reduce((total, item) => total + item.resolution.bytes, 0) : 0,
      freeBytes: files.freeBytesAt(request.targetDir),
      emptyGroups: groups.filter((group) => !summary.groups.some((entry) => entry.groupId === group.groupId)).map((group) => ({ ...group, logDays: logs.get(group.groupId) ?? 0 })),
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(backupRoot, { recursive: true });
    const reportPath = path.join(backupRoot, "last-report.json");
    common.writeJson(reportPath, report);
    common.result("backupReport", reportPath);
  } finally {
    knowledgeDb?.close();
    storeDb.close();
  }
};

if (require.main === module) {
  common.runMain(main);
}
