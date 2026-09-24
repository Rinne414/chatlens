"use strict";

// Server glue for 备份: what the page needs to set up a backup (groups, default
// folder, last report), request validation, and starting the scan / save job.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const review = require("../review_store");
const { normalizeCategories } = require("../backup_plan");

const backupDir = path.join(state.toolRoot, "store", "backup");
const requestPath = path.join(backupDir, "request.json");
const reportPath = path.join(backupDir, "last-report.json");
const MAX_GROUPS = 200;
const MAX_DAYS = 400;
const DAY_SECONDS = 86400;

const defaultTargetDir = () =>
  (process.platform === "win32" ? path.join(os.homedir(), "Documents", "QQ备份") : path.join(os.homedir(), "QQ备份"));

// Windows paths are case-insensitive: compare them that way, or "d:\qq" would
// slip past a check for "D:\QQ".
const comparable = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));

const isInside = (parent, child) => {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// The backup folder must never be inside QQ's own account folder (it holds
// nt_qq with both the database and nt_data) or the tool's store.
const validateTargetDir = (targetDir, config) => {
  const value = String(targetDir ?? "").trim();
  if (value.length === 0 || !path.isAbsolute(value)) {
    throw new Error("请填写完整的备份文件夹路径，例如 D:\\QQ备份。");
  }
  const qqRoots = [config.ntDbDir, config.ntDataDir]
    .map((dir) => String(dir ?? "").trim())
    .filter((dir) => dir.length > 0)
    .map((dir) => path.dirname(path.dirname(path.resolve(dir))));
  if (qqRoots.some((root) => isInside(root, value))) {
    throw new Error("备份文件夹不能放在 QQ 自己的数据目录里，请换一个位置。");
  }
  if (isInside(path.join(state.toolRoot, "store"), value)) {
    throw new Error("备份文件夹不能放在工具的 store 目录里。");
  }
  return path.resolve(value);
};

const readReport = () => {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
};

const groupChoices = (config) => {
  const watch = new Set((config.watchlist ?? []).map((item) => String(typeof item === "string" ? item : item?.groupId ?? "")));
  const rows = state.getStore().prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS name, COUNT(*) AS messages,
           MIN(m.sent_at) AS firstSentAt, MAX(m.sent_at) AS lastSentAt
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    GROUP BY m.group_id
  `).all();
  const known = new Map(rows.map((row) => [row.groupId, row]));
  for (const groupId of watch) {
    if (/^\d+$/u.test(groupId) && !known.has(groupId)) {
      known.set(groupId, { groupId, name: "", messages: 0, firstSentAt: null, lastSentAt: null });
    }
  }
  return [...known.values()]
    .map((row) => ({ ...row, name: row.name || row.groupId, watched: watch.has(row.groupId) }))
    .sort((left, right) => Number(right.watched) - Number(left.watched) || right.messages - left.messages);
};

const getSetup = () => {
  const config = state.loadConfig();
  return {
    targetDir: config.backup?.targetDir ?? defaultTargetDir(),
    groups: groupChoices(config),
    categories: normalizeCategories(config.backup?.categories),
    lastReport: readReport(),
    ntDataConfigured: String(config.ntDataDir ?? "").trim().length > 0,
  };
};

const start = ({ mode, groupIds, fromDay, toDay, categories, remote, targetDir }) => {
  if (!["scan", "save"].includes(mode)) {
    throw new Error("未知的备份操作。");
  }
  const ids = [...new Set((Array.isArray(groupIds) ? groupIds : []).map(String).filter((id) => /^\d+$/u.test(id)))];
  if (ids.length === 0 || ids.length > MAX_GROUPS) {
    throw new Error("请至少选一个群。");
  }
  const from = review.dayBounds(fromDay);
  const to = review.dayBounds(toDay);
  if (to.start < from.start || (to.start - from.start) / DAY_SECONDS > MAX_DAYS) {
    throw new Error(`日期范围应在 ${MAX_DAYS} 天以内，且结束不早于开始。`);
  }
  const config = state.loadConfig();
  const target = validateTargetDir(targetDir, config);
  const normalized = normalizeCategories(categories);
  const request = {
    mode,
    groupIds: ids,
    fromUnix: from.start,
    // Uncapped so a save right after a scan maps to the same work folder.
    toUnix: to.end,
    categories: normalized,
    remote: remote === true,
    targetDir: target,
  };
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, backup: { ...(raw.backup ?? {}), targetDir: target, categories: normalized } });
  const job = jobs.startBackupJob({ requestPath, mode });
  return { started: true, jobId: job.id };
};

module.exports = { getSetup, start, readReport, validateTargetDir, defaultTargetDir };
