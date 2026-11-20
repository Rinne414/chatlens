"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { removedDirFor } = require("../media_removed");

const STORAGE_CATEGORIES = new Set([
  "qq-account",
  "qq-databases",
  "qq-media-cache",
  "tool-config",
  "tool-secrets",
  "message-store",
  "knowledge-store",
  "knowledge-media",
  "media-removed",
  "picture-cache",
  "coverage-checkpoints",
  "database-mirror",
  "temporary-files",
  "run-files",
  "reports-exports",
]);

const CLEANABLE_CATEGORIES = new Set([
  "temporary-files",
  "run-files",
  "reports-exports",
]);

const PROTECTED_TOOL_DIRECTORIES = new Set([
  "config",
  "node",
  "node_modules",
  "scripts",
  "src",
  "store",
  "web",
]);

const ensureObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
};

const ensureAbsolutePath = (value, label, allowEmpty) => {
  if (allowEmpty && (value === null || value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || value.trim().length === 0 || !path.isAbsolute(value.trim())) {
    throw new TypeError(`${label} must be an absolute path. value=${String(value)}`);
  }
  return path.resolve(value.trim());
};

const validateContext = (context) => {
  const value = ensureObject(context, "Storage context");
  const config = ensureObject(value.config, "Storage context config");
  const activity = ensureObject(value.activity, "Storage context activity");
  if (typeof activity.jobRunning !== "boolean" || typeof activity.quickSummaryRunning !== "boolean") {
    throw new TypeError("Storage context activity flags must be booleans.");
  }
  return {
    toolRoot: ensureAbsolutePath(value.toolRoot, "Storage context toolRoot", false),
    secretDir: ensureAbsolutePath(value.secretDir, "Storage context secretDir", false),
    config: {
      ntDbDir: ensureAbsolutePath(config.ntDbDir, "config.ntDbDir", true),
      ntDataDir: ensureAbsolutePath(config.ntDataDir, "config.ntDataDir", true),
      runsDir: ensureAbsolutePath(config.runsDir, "config.runsDir", false),
      reportsDir: ensureAbsolutePath(config.reportsDir, "config.reportsDir", false),
    },
    activity: {
      jobRunning: activity.jobRunning,
      quickSummaryRunning: activity.quickSummaryRunning,
    },
  };
};

const isPathInside = (rootPath, targetPath, allowRoot) => {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative.length === 0) {
    return allowRoot;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

const ROOT_LABELS = { runsDir: "运行产物文件夹", reportsDir: "报告文件夹" };

const cleanableRootError = (context, targetPath, key) => {
  const label = ROOT_LABELS[key] ?? key;
  const relative = path.relative(context.toolRoot, targetPath);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `${label}不在本程序的文件夹里，为了安全这里不删除（位置：${targetPath}）。`;
  }
  const topLevel = relative.split(path.sep)[0].toLowerCase();
  if (PROTECTED_TOOL_DIRECTORIES.has(topLevel)) {
    return `${label}设在了本程序自己要用的文件夹里，为了安全这里不删除（位置：${targetPath}）。`;
  }
  return null;
};

const activityBlockReason = (activity) => {
  if (activity.jobRunning) {
    return "当前有扫描、补扫或报告任务运行中；完成或取消后才能清理。";
  }
  if (activity.quickSummaryRunning) {
    return "当前有选段 AI 总结运行中；完成后才能清理。";
  }
  return null;
};

const pathExists = (targetPath) => targetPath.length > 0 && fs.existsSync(targetPath);

// The folder that holds nt_qq (nt_db and nt_data) for this account, e.g.
// .../Tencent Files/<QQ号>; on Linux the QQ config folder. "" without a path.
const qqAccountDir = (context) =>
  (context.config.ntDbDir.length === 0 ? "" : path.dirname(path.dirname(path.resolve(context.config.ntDbDir))));

const publicItem = (item, activity) => {
  const runningReason = CLEANABLE_CATEGORIES.has(item.id) ? activityBlockReason(activity) : null;
  const blockedReason = runningReason ?? item.cleanupBlockedReason;
  return {
    id: item.id,
    section: item.section,
    label: item.label,
    description: item.description,
    paths: [...item.paths],
    exists: item.exists,
    openable: pathExists(item.openPath),
    policy: item.policy,
    policyLabel: item.policyLabel,
    cleanupAllowed: item.cleanupCategory !== null && blockedReason === null,
    cleanupCategory: item.cleanupCategory,
    cleanupImpact: item.cleanupImpact,
    cleanupBlockedReason: blockedReason,
    measurement: item.measurement,
  };
};

const storageCatalog = (context) => {
  const storeDir = path.join(context.toolRoot, "store");
  const coverageDir = path.join(storeDir, "coverage-repairs");
  const configPath = path.join(context.toolRoot, "config", "defaults.json");
  const messagePaths = ["messages.db", "messages.db-wal", "messages.db-shm"].map((name) => path.join(storeDir, name));
  const knowledgePaths = ["knowledge.db", "knowledge.db-wal", "knowledge.db-shm", "export-ledger.json"]
    .map((name) => path.join(storeDir, name));
  const knowledgeMediaDir = path.join(storeDir, "media-objects");
  const removedMediaDir = removedDirFor(knowledgeMediaDir);
  const pictureCacheDir = path.join(storeDir, "pictures");
  const mirrorDir = path.join(storeDir, "db-mirror");
  const accountDir = qqAccountDir(context);
  const temporaryTargets = collectTemporaryTargets(context, false).targets;
  const runCleanupError = cleanableRootError(context, context.config.runsDir, "runsDir");
  const reportCleanupError = cleanableRootError(context, context.config.reportsDir, "reportsDir");
  return [
    {
      id: "qq-account",
      section: "protected",
      label: "QQ 账号文件夹（全部）",
      description: "QQ 在这台电脑上为这个账号存的全部数据：下面的数据库和媒体缓存，加上收到的文件、日志等。看「QQ 一共占多少」就看这一项。",
      paths: accountDir === "" ? [] : [accountDir],
      exists: pathExists(accountDir),
      openPath: accountDir,
      policy: "protected",
      policyLabel: "请在 QQ 内管理",
      cleanupCategory: null,
      cleanupImpact: "这是 QQ 自己的数据，只能在 QQ 里清理。",
      cleanupBlockedReason: "QQ 账号文件夹只能查看。",
      measurement: "manual",
    },
    {
      id: "qq-databases",
      section: "protected",
      label: "QQ 的聊天数据库",
      description: "QQ 存聊天记录的文件（加密的）。本程序只复制一份来读，从不修改原文件。",
      paths: context.config.ntDbDir.length === 0 ? [] : [context.config.ntDbDir],
      exists: pathExists(context.config.ntDbDir),
      openPath: context.config.ntDbDir,
      policy: "protected",
      policyLabel: "绝不由本程序删除",
      cleanupCategory: null,
      cleanupImpact: "删掉会毁掉 QQ 在这台电脑上的聊天记录，只能由 QQ 自己管理。",
      cleanupBlockedReason: "QQ 的聊天数据库永远不会被本程序删除。",
      measurement: "automatic",
    },
    {
      id: "qq-media-cache",
      section: "protected",
      label: "QQ 媒体缓存",
      description: "QQ 下载的图片、视频、语音和文件。本程序只读取或复制需要的文件。",
      paths: context.config.ntDataDir.length === 0 ? [] : [context.config.ntDataDir],
      exists: pathExists(context.config.ntDataDir),
      openPath: context.config.ntDataDir,
      policy: "protected",
      policyLabel: "请在 QQ 内管理",
      cleanupCategory: null,
      cleanupImpact: "在 QQ 里清理后，旧图片和视频可能无法预览或导出；本程序不会替 QQ 删除。",
      cleanupBlockedReason: "QQ 媒体缓存只能查看，这里不能删除。",
      measurement: "manual",
    },
    {
      id: "tool-config",
      section: "protected",
      label: "本程序的设置",
      description: "QQ 的位置、关注的群、AI 服务和各项选项。",
      paths: [configPath],
      exists: pathExists(configPath),
      openPath: path.dirname(configPath),
      policy: "protected",
      policyLabel: "应保留",
      cleanupCategory: null,
      cleanupImpact: "删掉会丢失全部设置，要重新设置一遍。",
      cleanupBlockedReason: "设置文件不能在这里删除。",
      measurement: "automatic",
    },
    {
      id: "tool-secrets",
      section: "protected",
      label: "密钥（加密保存）",
      description: "QQ 数据库密钥和 AI 服务的 API Key。只存在这台电脑上，别的电脑账户读不到（Windows 用系统自带的加密 DPAPI；Linux 存进系统钥匙圈，没有钥匙圈时存成只有你能读的文件）。",
      paths: [context.secretDir],
      exists: pathExists(context.secretDir),
      openPath: context.secretDir,
      policy: "protected",
      policyLabel: "应保留",
      cleanupCategory: null,
      cleanupImpact: "删掉后要重新获取 QQ 密钥、重新填 AI 服务的 API Key。",
      cleanupBlockedReason: "密钥不能在这里删除。",
      measurement: "automatic",
    },
    {
      id: "message-store",
      section: "important",
      label: "本程序的消息库",
      description: "已经从 QQ 读进来的群消息、读到了哪里、你看到了哪里；会随新消息一直增加。",
      paths: [path.join(storeDir, "messages.db")],
      exists: messagePaths.some(pathExists),
      openPath: storeDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "删掉会丢失本程序里的全部消息和阅读进度，只能从 QQ 现有的记录重新读一遍。",
      cleanupBlockedReason: "程序运行时一直在用它，不能在这里删除。",
      measurement: "automatic",
    },
    {
      id: "knowledge-store",
      section: "important",
      label: "咒语库和导出记录",
      description: "AI 图的生成参数（咒语）索引、图片在哪里，以及哪些已经导出过。",
      paths: [path.join(storeDir, "knowledge.db"), path.join(storeDir, "export-ledger.json")],
      exists: knowledgePaths.some(pathExists),
      openPath: storeDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "删掉会丢失整理好的咒语索引和导出记录。",
      cleanupBlockedReason: "程序运行时在用它，不能在这里删除。",
      measurement: "automatic",
    },
    {
      id: "knowledge-media",
      section: "important",
      label: "留存的原图（咒语库的图片也在这里）",
      description: "你留存的群图片原图，和咒语库从这台电脑复制来的图片；同一张图只存一份。QQ 清理缓存、腾讯删掉过期的图以后，这里的图照样能看。",
      paths: [knowledgeMediaDir],
      exists: pathExists(knowledgeMediaDir),
      openPath: knowledgeMediaDir,
      policy: "keep",
      policyLabel: "重要，不应删除",
      cleanupCategory: null,
      cleanupImpact: "不想留的图：在 画廊 →「留存的原图」里点开或多选，按「取消留存」。取消后文件先移到下面的「取消留存的原图」，不会马上删。",
      cleanupBlockedReason: "这里不能整批删除，请在 画廊 →「留存的原图」里取消留存。",
      measurement: "background",
    },
    {
      id: "media-removed",
      section: "important",
      label: "取消留存的原图",
      description: "你在画廊取消留存的原图先放在这里，还没有删除，所以还占着空间。",
      paths: [removedMediaDir],
      exists: pathExists(removedMediaDir),
      openPath: removedMediaDir,
      policy: "keep",
      policyLabel: "在画廊里处理",
      cleanupCategory: null,
      cleanupImpact: "到 画廊 →「取消留存的」可以放回留存，或彻底删除、腾出空间；彻底删除后拿不回来。",
      cleanupBlockedReason: "请在 画廊 →「取消留存的」里放回或彻底删除。",
      measurement: "background",
    },
    {
      id: "picture-cache",
      section: "important",
      label: "群图片缓存",
      description: "后台自动取的群图片缩略图、AI 图预览和你看过的大图。有上限（设置 →「群图片」可调），到上限自动从最旧的清起。留存的原图不在这里，在上面的「留存的原图」里。",
      paths: [pictureCacheDir],
      exists: pathExists(pictureCacheDir),
      openPath: pictureCacheDir,
      policy: "keep",
      policyLabel: "自动管理",
      cleanupCategory: null,
      cleanupImpact: "到上限会自动清理；想少占一些，在 设置 →「群图片」调低上限。",
      cleanupBlockedReason: "群图片缓存按上限自动清理，不在这里删除。",
      measurement: "background",
    },
    {
      id: "coverage-checkpoints",
      section: "important",
      label: "补扫进度记录",
      description: "补扫（把漏掉的旧消息从 QQ 再读一遍）时，记下哪些部分已经读完、哪些失败了，中断后可以接着读。通常很小。",
      paths: [coverageDir],
      exists: pathExists(coverageDir),
      openPath: coverageDir,
      policy: "keep",
      policyLabel: "建议保留",
      cleanupCategory: null,
      cleanupImpact: "删掉后，中断的补扫要从头再来。",
      cleanupBlockedReason: "补扫要靠它接着读，不在这里删除。",
      measurement: "automatic",
    },
    {
      id: "database-mirror",
      section: "regenerable",
      label: "QQ 聊天数据库的副本",
      description: "本程序从这份副本读消息，不碰 QQ 的原文件。每次刷新只复制有变化的部分，几秒就完成；大小和 QQ 的聊天数据库差不多（也叫数据库镜像）。",
      paths: [mirrorDir],
      exists: pathExists(mirrorDir),
      openPath: mirrorDir,
      policy: "keep",
      policyLabel: "可重建",
      cleanupCategory: null,
      cleanupImpact: "删掉后，下次刷新会重新完整复制一次（这次较慢），之后又只复制有变化的部分。",
      cleanupBlockedReason: "后台刷新随时可能在用它。要腾出空间：先在 设置 →「后台与通知」按「停止后台服务」，再手动删除这个文件夹。",
      measurement: "automatic",
    },
    {
      id: "temporary-files",
      section: "regenerable",
      label: "临时数据库副本",
      description: "扫描和补扫时临时复制的数据库，以及其它临时文件（clean-db、.work、tmp）；需要时会重新生成。",
      paths: [
        path.join(context.config.runsDir, "*", "clean-db"),
        path.join(coverageDir, "*.work"),
        path.join(storeDir, "tmp"),
      ],
      exists: temporaryTargets.length > 0,
      openPath: storeDir,
      policy: "cleanup",
      policyLabel: "可安全清理",
      cleanupCategory: "temporary-files",
      cleanupImpact: "不会删除消息库、补扫进度、报告或留存的原图；下次扫描可能要重新复制一次数据库。",
      cleanupBlockedReason: null,
      measurement: "automatic",
    },
    {
      id: "run-files",
      section: "history",
      label: "每次运行的产物",
      description: "每次总结运行导出的消息、分析数据，以及复制出来的图片、视频等。",
      paths: [context.config.runsDir],
      exists: pathExists(context.config.runsDir),
      openPath: context.config.runsDir,
      policy: "deletable",
      policyLabel: "可删除，但会影响历史",
      cleanupCategory: "run-files",
      cleanupImpact: "删掉后，历史报告里的图片预览、聊天里嵌的媒体和运行详情可能打不开；消息库和留存的原图不受影响。",
      cleanupBlockedReason: runCleanupError,
      measurement: "automatic",
    },
    {
      id: "reports-exports",
      section: "history",
      label: "报告和导出文件",
      description: "生成的报告（网页和 Markdown）、导出的媒体和咒语库。在画廊或备份页「另存到文件夹」又没选自己的文件夹时，图片也存在这里。",
      paths: [context.config.reportsDir],
      exists: pathExists(context.config.reportsDir),
      openPath: context.config.reportsDir,
      policy: "deletable",
      policyLabel: "可删除，但不可恢复",
      cleanupCategory: "reports-exports",
      cleanupImpact: "删掉后这些报告和导出的文件全部消失，不能恢复；消息库和每次运行的产物不受影响。",
      cleanupBlockedReason: reportCleanupError,
      measurement: "automatic",
    },
  ];
};

const nearestExistingPath = (targetPath) => {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent found for storage path. path=${targetPath}`);
    }
    current = parent;
  }
  return current;
};

const volumeStats = (targetPath) => {
  const existing = nearestExistingPath(targetPath);
  const stat = fs.statfsSync(existing);
  const blockSize = Number(stat.bsize);
  return {
    root: path.parse(existing).root,
    totalBytes: Number(stat.blocks) * blockSize,
    freeBytes: Number(stat.bavail) * blockSize,
  };
};

const getStorageOverview = (rawContext) => {
  const context = validateContext(rawContext);
  const itemCatalog = storageCatalog(context);
  const volumePaths = [context.toolRoot, context.config.ntDbDir, context.config.ntDataDir]
    .filter((value) => value.length > 0);
  const volumes = [];
  const seenRoots = new Set();
  for (const volumePath of volumePaths) {
    try {
      const stats = volumeStats(volumePath);
      const key = stats.root.toLowerCase();
      if (!seenRoots.has(key)) {
        seenRoots.add(key);
        volumes.push({ ...stats, error: null });
      }
    } catch (error) {
      const root = path.parse(volumePath).root;
      const key = root.toLowerCase();
      if (!seenRoots.has(key)) {
        seenRoots.add(key);
        volumes.push({ root, totalBytes: null, freeBytes: null, error: error.message });
      }
    }
  }
  return {
    measuredAt: null,
    activity: { ...context.activity },
    volumes,
    items: itemCatalog.map((item) => publicItem(item, context.activity)),
  };
};

const categoryItem = (context, category) => {
  if (typeof category !== "string" || !STORAGE_CATEGORIES.has(category)) {
    throw new TypeError(`Unknown storage category. category=${String(category)}`);
  }
  const item = storageCatalog(context).find((candidate) => candidate.id === category);
  if (item === undefined) {
    throw new Error(`Storage category is not configured. category=${category}`);
  }
  return item;
};

const categoryMeasurePaths = (context, category) => {
  const storeDir = path.join(context.toolRoot, "store");
  if (category === "qq-account") {
    const accountDir = qqAccountDir(context);
    return accountDir === "" ? [] : [accountDir];
  }
  if (category === "picture-cache") {
    return [path.join(storeDir, "pictures")];
  }
  if (category === "qq-databases") {
    return context.config.ntDbDir.length === 0 ? [] : [context.config.ntDbDir];
  }
  if (category === "qq-media-cache") {
    return context.config.ntDataDir.length === 0 ? [] : [context.config.ntDataDir];
  }
  if (category === "tool-config") {
    return [path.join(context.toolRoot, "config", "defaults.json")];
  }
  if (category === "tool-secrets") {
    return [context.secretDir];
  }
  if (category === "message-store") {
    return ["messages.db", "messages.db-wal", "messages.db-shm"].map((name) => path.join(storeDir, name));
  }
  if (category === "knowledge-store") {
    return ["knowledge.db", "knowledge.db-wal", "knowledge.db-shm", "export-ledger.json"]
      .map((name) => path.join(storeDir, name));
  }
  if (category === "knowledge-media") {
    return [path.join(storeDir, "media-objects")];
  }
  if (category === "media-removed") {
    return [removedDirFor(path.join(storeDir, "media-objects"))];
  }
  if (category === "coverage-checkpoints") {
    return [path.join(storeDir, "coverage-repairs")];
  }
  if (category === "database-mirror") {
    return [path.join(storeDir, "db-mirror")];
  }
  if (category === "temporary-files") {
    return collectTemporaryTargets(context, false).targets;
  }
  if (category === "run-files") {
    return [context.config.runsDir];
  }
  if (category === "reports-exports") {
    return [context.config.reportsDir];
  }
  throw new Error(`Storage measurement paths are not implemented. category=${category}`);
};

const shouldSkipDirectory = (category, directoryPath) => {
  const name = path.basename(directoryPath).toLowerCase();
  if (category === "coverage-checkpoints" && name.endsWith(".work")) {
    return true;
  }
  return category === "run-files" && name === "clean-db";
};

const measurePaths = async (targetPaths, category) => {
  const stack = [...new Set(targetPaths.map((targetPath) => path.resolve(targetPath)))];
  const measurement = {
    bytes: 0,
    fileCount: 0,
    directoryCount: 0,
    skippedSymlinkCount: 0,
    changedPathCount: 0,
  };
  let processed = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        measurement.changedPathCount += 1;
        continue;
      }
      throw new Error(`Storage measurement failed. category=${category} path=${current} cause=${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      measurement.skippedSymlinkCount += 1;
    } else if (stat.isFile()) {
      measurement.bytes += stat.size;
      measurement.fileCount += 1;
    } else if (stat.isDirectory()) {
      if (shouldSkipDirectory(category, current)) {
        continue;
      }
      measurement.directoryCount += 1;
      let entries;
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch (error) {
        throw new Error(`Storage directory could not be read. category=${category} path=${current} cause=${error.message}`);
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry.name));
      }
    }
    processed += 1;
    if (processed % 512 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return measurement;
};

const measureStorageCategory = async (rawContext, category) => {
  const context = validateContext(rawContext);
  categoryItem(context, category);
  const targetPaths = categoryMeasurePaths(context, category).filter((targetPath) => fs.existsSync(targetPath));
  const measurement = await measurePaths(targetPaths, category);
  return {
    category,
    measuredAt: new Date().toISOString(),
    ...measurement,
  };
};

const directChildPaths = (directoryPath) => {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory for storage cleanup. path=${directoryPath}`);
  }
  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .map((entry) => path.join(directoryPath, entry.name));
};

function collectTemporaryTargets(context, strictRunsRoot) {
  const targets = [];
  const warnings = [];
  const storeTmp = path.join(context.toolRoot, "store", "tmp");
  if (fs.existsSync(storeTmp)) {
    targets.push(storeTmp);
  }

  const coverageRoot = path.join(context.toolRoot, "store", "coverage-repairs");
  if (fs.existsSync(coverageRoot)) {
    for (const entry of fs.readdirSync(coverageRoot, { withFileTypes: true })) {
      if (entry.name.endsWith(".work")) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          targets.push(path.join(coverageRoot, entry.name));
        } else if (strictRunsRoot) {
          warnings.push(`跳过了不是普通目录的补扫临时项。path=${path.join(coverageRoot, entry.name)}`);
        }
      }
    }
  }

  const runsError = cleanableRootError(context, context.config.runsDir, "runsDir");
  if (runsError !== null) {
    if (strictRunsRoot) {
      warnings.push(runsError);
    }
    return { targets, warnings };
  }
  if (fs.existsSync(context.config.runsDir)) {
    for (const runEntry of fs.readdirSync(context.config.runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
        continue;
      }
      const cleanDbPath = path.join(context.config.runsDir, runEntry.name, "clean-db");
      if (fs.existsSync(cleanDbPath)) {
        if (!fs.lstatSync(cleanDbPath).isSymbolicLink()) {
          targets.push(cleanDbPath);
        } else if (strictRunsRoot) {
          warnings.push(`跳过了符号链接形式的 clean-db。path=${cleanDbPath}`);
        }
      }
    }
  }
  return { targets, warnings };
}

const cleanupTargets = (context, category) => {
  if (category === "temporary-files") {
    return collectTemporaryTargets(context, true);
  }
  if (category === "run-files") {
    const error = cleanableRootError(context, context.config.runsDir, "runsDir");
    if (error !== null) {
      throw new Error(error);
    }
    return { targets: directChildPaths(context.config.runsDir), warnings: [] };
  }
  if (category === "reports-exports") {
    const error = cleanableRootError(context, context.config.reportsDir, "reportsDir");
    if (error !== null) {
      throw new Error(error);
    }
    return { targets: directChildPaths(context.config.reportsDir), warnings: [] };
  }
  throw new TypeError(`Storage category cannot be cleaned. category=${category}`);
};

const assertCleanupTarget = (context, category, targetPath) => {
  const allowedRoots = category === "reports-exports"
    ? [context.config.reportsDir]
    : category === "run-files"
      ? [context.config.runsDir]
      : [context.toolRoot];
  if (!allowedRoots.some((rootPath) => isPathInside(rootPath, targetPath, false))) {
    throw new Error(`Refusing storage cleanup outside the allowed root. category=${category} path=${targetPath}`);
  }
};

const cleanupStorageCategory = async (rawContext, category, confirmation) => {
  const context = validateContext(rawContext);
  categoryItem(context, category);
  if (!CLEANABLE_CATEGORIES.has(category)) {
    throw new TypeError(`Storage category is protected and cannot be cleaned. category=${category}`);
  }
  if (confirmation !== category) {
    throw new TypeError(`Storage cleanup confirmation does not match. category=${category}`);
  }
  const runningReason = activityBlockReason(context.activity);
  if (runningReason !== null) {
    throw new Error(runningReason);
  }

  const collected = cleanupTargets(context, category);
  for (const targetPath of collected.targets) {
    assertCleanupTarget(context, category, targetPath);
  }
  const before = await measurePaths(collected.targets, `cleanup:${category}`);
  const diskBefore = volumeStats(context.toolRoot).freeBytes;
  let removedTargetCount = 0;
  for (const targetPath of collected.targets) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Storage cleanup target disappeared before deletion. category=${category} path=${targetPath}`);
    }
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to delete a symbolic link. category=${category} path=${targetPath}`);
    }
    fs.rmSync(targetPath, { recursive: stat.isDirectory(), force: false });
    removedTargetCount += 1;
  }
  const diskAfter = volumeStats(context.toolRoot).freeBytes;
  return {
    category,
    removedTargetCount,
    removedFileCount: before.fileCount,
    removedDirectoryCount: before.directoryCount,
    deletedBytes: before.bytes,
    freeDiskDeltaBytes: diskAfter - diskBefore,
    warnings: collected.warnings,
  };
};

const resolveStorageOpenPath = (rawContext, category) => {
  const context = validateContext(rawContext);
  const item = categoryItem(context, category);
  if (item.openPath.length === 0 || !fs.existsSync(item.openPath)) {
    throw new Error(`Storage location does not exist. category=${category} path=${item.openPath}`);
  }
  return item.openPath;
};

module.exports = {
  cleanupStorageCategory,
  getStorageOverview,
  measureStorageCategory,
  resolveStorageOpenPath,
};
