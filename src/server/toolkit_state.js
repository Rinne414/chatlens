const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("../report_utils");
const { collectRun, collectRuns, pathExists, dirSize, parseRunTimestamp } = require("../run_index");
const messageStore = require("../message_store");
const briefingStore = require("../briefing_store");
const pictureStore = require("../picture_store");
const { summarizeCatchup } = require("../run_catchup");
const { normalizeLlmError, readLlmError, readLlmUnused } = require("../llm_status");
const { resolvePasteCursor: resolvePasteCursorMatch } = require("../paste_cursor");
const { formatHkt } = require("../unviewed_range");
const toolRoot = path.resolve(__dirname, "..", "..");
const configPath = path.join(toolRoot, "config", "defaults.json");
const configExamplePath = path.join(toolRoot, "config", "defaults.example.json");
const storeDbPath = path.join(toolRoot, "store", "messages.db");

// First run on a fresh clone: bootstrap the local config from the tracked template.
const loadRawConfig = () => {
  if (!fs.existsSync(configPath) && fs.existsSync(configExamplePath)) {
    fs.copyFileSync(configExamplePath, configPath);
  }
  return readJson(configPath);
};

// Relative dirs in the template resolve against the toolkit root, not the cwd.
const loadConfig = () => {
  const config = loadRawConfig();
  for (const key of ["runsDir", "reportsDir"]) {
    if (typeof config[key] === "string" && config[key].length > 0 && !path.isAbsolute(config[key])) {
      config[key] = path.join(toolRoot, config[key]);
    }
  }
  return config;
};

// getGroupSummaries reads every stored message (~0.4 s on 422k rows) and
// /api/state alone needed it twice; it is reused until a message arrives or a
// read mark moves (row deletions are rare: repairs, never routine pruning).
const summariesCache = new Map();
const groupSummaries = (db, floor = 0) => {
  const key = JSON.stringify([
    db.prepare("SELECT MAX(rowid) AS n FROM messages").get().n,
    db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS at, TOTAL(sent_at) AS marks FROM read_marks").get(),
  ]);
  const cached = summariesCache.get(floor);
  if (cached?.key === key) {
    return cached.rows;
  }
  const rows = messageStore.getGroupSummaries(db, { unreadFloor: floor });
  summariesCache.set(floor, { key, rows });
  // Only the current floors matter; an old one is never asked for again.
  if (summariesCache.size > 4) {
    summariesCache.delete(summariesCache.keys().next().value);
  }
  return rows;
};

let storeHandle = null;
const getStore = () => {
  if (storeHandle === null) {
    storeHandle = messageStore.openStore(storeDbPath);
  }
  return storeHandle;
};

const normalizeWatchlist = (config) =>
  (config.watchlist ?? [])
    .map((item) =>
      typeof item === "string"
        ? { groupId: item.trim(), name: "" }
        : { groupId: String(item?.groupId ?? "").trim(), name: String(item?.name ?? "") },
    )
    .filter((entry) => /^\d+$/u.test(entry.groupId));

const normalizeGroupSets = (sets) => (sets ?? [])
  .map((set) => ({
    name: String(set?.name ?? "").trim().slice(0, 40),
    groupIds: [...new Set((set?.groupIds ?? []).map(String).map((value) => value.trim()))]
      .filter((groupId) => /^\d+$/u.test(groupId)),
  }))
  .filter((set) => set.name.length > 0 && set.groupIds.length > 0 && set.groupIds.length <= 50)
  .slice(0, 20);

// Persist against the raw on-disk shape (loadConfig absolutizes runsDir/reportsDir
// in memory — writing that back would bake machine paths into the config), and
// swap in atomically so a concurrent reader never sees a half-written file.
const writeConfig = (config) => {
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, configPath);
};

const saveWatchlist = (entries) => {
  const config = loadRawConfig();
  config.watchlist = entries.map((entry) => ({ groupId: entry.groupId, name: entry.name }));
  writeConfig(config);
};

const getKnownGroups = (config) => {
  const reportsDir = config.reportsDir;
  if (!pathExists(reportsDir)) {
    return [];
  }

  const latestList = fs
    .readdirSync(reportsDir)
    .filter((name) => /^group-list-\d{8}-\d{6}\.txt$/u.test(name))
    .sort()
    .at(-1);
  if (latestList === undefined) {
    return [];
  }

  return fs
    .readFileSync(path.join(reportsDir, latestList), "utf8")
    .split(/\r?\n/u)
    .map((line) => {
      const [groupId, name = ""] = line.split("\t", 2);
      return { groupId: (groupId ?? "").trim(), name: name.trim() };
    })
    .filter((entry) => /^\d+$/u.test(entry.groupId));
};

const updateWatchlist = ({ add = [], remove = [] }) => {
  const config = loadConfig();
  const known = new Map(getKnownGroups(config).map((group) => [group.groupId, group.name]));
  const removeSet = new Set(remove.map(String));
  let entries = normalizeWatchlist(config).filter((entry) => !removeSet.has(entry.groupId));

  for (const rawGroupId of add) {
    const groupId = String(rawGroupId).trim();
    if (!/^\d+$/u.test(groupId)) {
      throw new Error(`Invalid group id: ${rawGroupId}`);
    }
    if (!entries.some((entry) => entry.groupId === groupId)) {
      entries = [...entries, { groupId, name: known.get(groupId) ?? "" }];
    }
  }

  saveWatchlist(entries);
  return entries;
};

const updateGroupSets = ({ save, remove }) => {
  const config = loadRawConfig();
  const current = normalizeGroupSets(config.groupSets);
  const removeName = typeof remove === "string" ? remove.trim() : "";
  let next = removeName.length > 0 ? current.filter((set) => set.name !== removeName) : current;
  if (save !== null && save !== undefined) {
    const normalized = normalizeGroupSets([save]);
    if (normalized.length !== 1) {
      throw new Error("常用群组合需要名称，并包含 1-50 个有效群号。");
    }
    const set = normalized[0];
    next = [...next.filter((entry) => entry.name !== set.name), set];
  }
  config.groupSets = next;
  writeConfig(config);
  return next;
};

const currentCoverageWindow = (days, toUnix) => {
  const daySeconds = 24 * 60 * 60;
  const beijingOffsetSeconds = 8 * 60 * 60;
  const currentDayStart = Math.floor((toUnix + beijingOffsetSeconds) / daySeconds) * daySeconds
    - beijingOffsetSeconds;
  return { fromUnix: currentDayStart - (days - 1) * daySeconds, toUnix };
};

const historicalCoverageWindow = (days, toUnix) => ({
  fromUnix: toUnix - days * TIMELINE_DAY_SECONDS,
  toUnix,
});

const getWatchlistHealth = (watchlist, nowUnix) => {
  const db = getStore();
  const { fromUnix, toUnix } = currentCoverageWindow(7, nowUnix);
  const summaries = new Map(groupSummaries(db, unreadFloor(db)).map((group) => [group.groupId, group]));
  const coverageEnds = messageStore.getCoverageEnds(db);
  return watchlist.map((entry) => {
    const health = messageStore.getCoverageHealth(db, [entry.groupId], fromUnix, toUnix);
    const summary = summaries.get(entry.groupId);
    return {
      groupId: entry.groupId,
      name: entry.name,
      coverageRatio: health.coverageRatio,
      missingSeconds: health.missingSeconds,
      earliestGapUnix: health.earliestGapUnix,
      latestScanUnix: coverageEnds[entry.groupId] ?? null,
      latestMessageUnix: summary?.lastUnix ?? null,
      localUnviewedCount: summary?.unreadCount ?? 0,
    };
  });
};

const getGroupActivity = () => {
  const db = getStore();
  const summaries = new Map(groupSummaries(db, unreadFloor(db)).map((group) => [group.groupId, group]));
  return Object.entries(messageStore.getCoverageEnds(db))
    .map(([groupId, latestScanUnix]) => ({
      groupId,
      latestScanUnix,
      latestMessageUnix: summaries.get(groupId)?.lastUnix ?? null,
    }))
    .sort((left, right) => right.latestScanUnix - left.latestScanUnix);
};

const getAutomationCoverage = () => {
  const config = loadConfig();
  const watchlist = normalizeWatchlist(config);
  const coverageEnds = messageStore.getCoverageEnds(getStore());
  const covered = watchlist
    .map((entry) => coverageEnds[entry.groupId])
    .filter((value) => Number.isFinite(value));
  return {
    targetGroupCount: watchlist.length,
    unscannedGroupCount: watchlist.length - covered.length,
    coverageThroughUnix: covered.length === watchlist.length && covered.length > 0 ? Math.min(...covered) : null,
  };
};

const getState = () => {
  const config = loadConfig();
  const watchlist = normalizeWatchlist(config);
  return {
    watchlist,
    groupSets: normalizeGroupSets(config.groupSets),
    watchHealth: getWatchlistHealth(watchlist, Math.floor(Date.now() / 1000)),
    groupActivity: getGroupActivity(),
    runDefaults: config.runDefaults ?? {},
    knownGroups: getKnownGroups(config),
    runs: collectRuns(config.runsDir, config.reportsDir, { includeDisk: false }).map((run) => ({
      ...run,
      // Absolute paths stay for /api/open; webPath is what the UI links to.
      runId: run.runId,
    })),
  };
};

const toWebPath = (runsDir, absolutePath) => {
  const relative = path.relative(runsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return `/runs/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
};

const trimTopic = (topic) => ({
  id: topic.id,
  name: topic.name,
  count: topic.count,
  sampleMessages: (topic.sampleMessages ?? []).slice(-8),
});

const withLlmSummary = (analysisDir, analysis) => {
  let next = analysis;
  if (!(analysis?.llmSummary && String(analysis.llmSummary.summary ?? "").trim() !== "")) {
    const llmPath = path.join(analysisDir, "llm-summary.json");
    if (pathExists(llmPath)) {
      next = { ...next, llmSummary: readJson(llmPath) };
    }
  }
  const usedLlm = next?.llmSummary && String(next.llmSummary.summary ?? "").trim() !== "";
  if (!usedLlm) {
    const llmError = readLlmError(analysisDir);
    if (llmError !== null) {
      next = { ...next, llmError, llmUnused: false };
    } else if (readLlmUnused(analysisDir) !== null) {
      next = { ...next, llmUnused: true };
    }
  }
  return next;
};

const groupViewFromAnalysis = (groupId, analysis) => ({
  groupId,
  name: analysis.groupNames?.[groupId] || groupId,
  textMessages: analysis.parsedTextMessages ?? 0,
  mediaMessages: analysis.parsedMediaMessages ?? 0,
  firstHkt: analysis.firstMessageHkt ?? null,
  lastHkt: analysis.lastMessageHkt ?? null,
  llmSummary: analysis.llmSummary ?? null,
  llmError: analysis.llmSummary ? null : normalizeLlmError(analysis.llmError),
  llmUnused: Boolean(analysis.llmSummary || analysis.llmError) ? false : analysis.llmUnused === true,
  localTopics: (analysis.topics ?? [])
    .filter((topic) => topic.count > 0 && topic.id !== "media")
    .slice(0, 10)
    .map(trimTopic),
  topSpeakers: (analysis.topSpeakers ?? []).slice(0, 5),
  urls: (analysis.urls ?? []).slice(-10),
});

const getRunDetail = (runId) => {
  if (!/^qq-[\w.-]+$/u.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }

  const config = loadConfig();
  const runDir = path.join(config.runsDir, runId);
  const analysisPath = path.join(runDir, "analysis", "analysis.json");
  if (!pathExists(analysisPath)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const analysisDir = path.join(runDir, "analysis");
  const combined = withLlmSummary(analysisDir, readJson(analysisPath));
  const digestPath = path.join(analysisDir, "digest.json");
  const digest = pathExists(digestPath) ? readJson(digestPath) : null;

  const groupsDir = path.join(analysisDir, "groups");
  let groups;
  if (pathExists(groupsDir)) {
    groups = fs
      .readdirSync(groupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const groupDir = path.join(groupsDir, entry.name);
        const groupAnalysisPath = path.join(groupDir, "analysis.json");
        return pathExists(groupAnalysisPath)
          ? groupViewFromAnalysis(entry.name, withLlmSummary(groupDir, readJson(groupAnalysisPath)))
          : null;
      })
      .filter((group) => group !== null)
      .sort((left, right) => right.textMessages - left.textMessages);
  } else {
    const groupId = String(combined.groupIds?.[0] ?? "unknown");
    groups = [groupViewFromAnalysis(groupId, combined)];
  }

  const manifestPath = path.join(runDir, "media", "media-manifest.json");
  const media = pathExists(manifestPath)
    ? readJson(manifestPath)
        .filter((item) => typeof item.copiedPath === "string" && item.copiedPath.length > 0)
        .map((item) => ({
          hkt: item.hkt,
          groupId: String(item.groupId ?? ""),
          speaker: item.speaker,
          kind: item.kind,
          webPath: toWebPath(config.runsDir, item.copiedPath),
        }))
        .filter((item) => item.webPath !== null)
        .slice(0, 120)
    : [];

  const reportHtml = path.join(config.reportsDir, `${runId}.html`);
  const runMeta = collectRun(runDir, config.reportsDir);
  if (runMeta === null) {
    throw new Error(`Run metadata is unreadable: ${runId}`);
  }
  return {
    runId,
    runDir,
    reportHtml: pathExists(reportHtml) ? reportHtml : null,
    firstHkt: combined.firstMessageHkt ?? null,
    lastHkt: combined.lastMessageHkt ?? null,
    textMessages: combined.parsedTextMessages ?? 0,
    mediaMessages: combined.parsedMediaMessages ?? 0,
    digest,
    catchup: summarizeCatchup({
      runId,
      textMessages: combined.parsedTextMessages ?? 0,
      mediaMessages: combined.parsedMediaMessages ?? 0,
      firstHkt: combined.firstMessageHkt ?? null,
      lastHkt: combined.lastMessageHkt ?? null,
      digest,
      groups,
      scanCoverage: runMeta.scanCoverage,
      aiCoverage: runMeta.aiCoverage,
    }),
    groups,
    media,
    scanCoverage: runMeta.scanCoverage,
    aiCoverage: runMeta.aiCoverage,
  };
};

const parseUnixParam = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const resolvePasteCursor = (body) => {
  const requested = Array.isArray(body?.groupIds)
    ? body.groupIds.map(String).filter((id) => /^\d+$/u.test(id))
    : [];
  const preferredGroupIds = requested.length > 0
    ? requested
    : normalizeWatchlist(loadConfig()).map((entry) => entry.groupId);
  return resolvePasteCursorMatch({
    db: getStore(),
    startPaste: body?.startPaste ?? "",
    endPaste: body?.endPaste ?? "",
    preferredGroupIds,
    formatHkt,
  });
};

const getStoreMessages = (query) => {
  const groupId = String(query.groupId ?? "");
  if (!/^\d+$/u.test(groupId)) {
    throw new Error("groupId is required");
  }

  const db = getStore();
  const result = messageStore.queryMessages(db, {
    groupId,
    fromUnix: parseUnixParam(query.from),
    toUnix: parseUnixParam(query.to),
    afterSentAt: parseUnixParam(query.afterSentAt),
    afterRowId: typeof query.afterRowId === "string" && query.afterRowId.length > 0 ? query.afterRowId : undefined,
    beforeSentAt: parseUnixParam(query.beforeSentAt),
    beforeRowId: typeof query.beforeRowId === "string" && query.beforeRowId.length > 0 ? query.beforeRowId : undefined,
    limit: Number.parseInt(query.limit ?? "300", 10),
    search: typeof query.q === "string" ? query.q : undefined,
    mediaOnly: query.media === "1",
  });

  // Picture facts for media rows, so the chat can show every picture (the
  // console fetches it from Tencent when QQ never saved it).
  const byRow = pictureStore.picturesForRows(db, groupId, result.messages.filter((message) => message.isMedia === 1).map((message) => message.rowId));
  const messages = result.messages.map((message) => (byRow.has(message.rowId)
    ? { ...message, pictures: byRow.get(message.rowId).map(({ rowId, seq, ...picture }) => picture) }
    : message));

  return {
    ...result,
    messages,
    coverage: messageStore.getCoverage(db, groupId),
    readMark: messageStore.getReadMark(db, groupId),
    // So the chat can mark what is addressed to you.
    selfUins: messageStore.getSelfIdentity(db).uins,
  };
};

// Before the briefing's first "看完了" (or on a store without it) nothing is
// floored: a group without a read mark counts its whole history.
const unreadFloor = (db) => {
  try {
    return Number(briefingStore.getState(db, "briefing_since", 0)) || 0;
  } catch {
    return 0;
  }
};

const getStoreOverview = () => {
  const db = getStore();
  return {
    groups: groupSummaries(db, unreadFloor(db)).map((group) => ({
      ...group,
      readMark: messageStore.getReadMark(db, group.groupId),
    })),
    // Straight from scan_ranges: also covers groups whose stored messages
    // have no text rows, so "自上次记录" never skips their gap silently.
    coverageEnds: messageStore.getCoverageEnds(db),
    retentionPolicy: "unlimited",
  };
};

const TIMELINE_DAY_SECONDS = 24 * 60 * 60;

const getStoreTimeline = (query) => {
  const groupIds = [...new Set(String(query.groupIds ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  if (groupIds.length === 0 || groupIds.some((groupId) => !/^\d+$/u.test(groupId))) {
    throw new Error("groupIds must contain at least one numeric group id");
  }
  if (groupIds.length > 50) {
    throw new Error("groupIds cannot contain more than 50 groups");
  }

  const days = Number.parseInt(query.days, 10);
  if (![1, 7, 30].includes(days)) {
    throw new Error("days must be 1, 7 or 30");
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const requestedToUnix = query.toUnix === undefined ? null : String(query.toUnix);
  if (requestedToUnix !== null && (!/^\d+$/u.test(requestedToUnix) || Number(requestedToUnix) > nowUnix)) {
    throw new Error(`toUnix must be a Unix timestamp no later than ${nowUnix}`);
  }
  const toUnix = requestedToUnix === null ? nowUnix : Number(requestedToUnix);
  const { fromUnix } = requestedToUnix === null
    ? currentCoverageWindow(days, toUnix)
    : historicalCoverageWindow(days, toUnix);
  const slotSeconds = days === 1 ? 60 * 60 : days === 7 ? 6 * 60 * 60 : TIMELINE_DAY_SECONDS;
  return {
    fromUnix,
    toUnix,
    slotSeconds,
    groups: messageStore.getCoverageTimeline(getStore(), groupIds, fromUnix, toUnix, slotSeconds),
    health: messageStore.getCoverageHealth(getStore(), groupIds, fromUnix, toUnix),
  };
};

// Beijing time (UTC+8), matching every other timestamp the pipeline and UI
// show; machine-local time here made quick-summary citations look shifted on
// non-UTC+8 machines.
const toLocalStamp = (unix) => {
  const date = new Date((unix + 8 * 3600) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

const prepareQuickSummary = ({ groupId, fromUnix, toUnix }) => {
  const normalizedGroupId = String(groupId ?? "");
  if (!/^\d+$/u.test(normalizedGroupId)) {
    throw new Error("groupId is required");
  }
  const from = Number.parseInt(fromUnix, 10);
  const to = Number.parseInt(toUnix, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) {
    throw new Error("Invalid selection time range");
  }

  const db = getStore();
  // Every message of the selection, page by page: the summarizer splits a
  // long selection into parts itself, so nothing is dropped here.
  const messages = [];
  for (let page = null; page === null || page.hasMore;) {
    const last = messages.at(-1);
    page = messageStore.queryMessages(db, {
      groupId: normalizedGroupId,
      fromUnix: from,
      toUnix: to + 1,
      limit: 500,
      ...(last === undefined ? {} : { afterSentAt: last.sentAt, afterRowId: last.rowId }),
    });
    messages.push(...page.messages);
  }
  const textMessages = messages.filter((message) => message.isMedia !== 1 && message.text.trim().length > 0);
  if (textMessages.length === 0) {
    throw new Error("选中的范围内没有文本消息。");
  }

  const groupName = db.prepare("SELECT name FROM group_names WHERE group_id = ?").get(normalizedGroupId)?.name ?? "";
  const tmpDir = path.join(toolRoot, "store", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = Date.now();
  const inputPath = path.join(tmpDir, `quick-${stamp}-in.json`);
  const outputPath = path.join(tmpDir, `quick-${stamp}-out.json`);
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      groupId: normalizedGroupId,
      groupName,
      messages: textMessages.map((message) => ({
        hkt: toLocalStamp(message.sentAt),
        speaker: message.speaker,
        text: message.text,
      })),
    }),
    "utf8",
  );

  return { inputPath, outputPath, count: textMessages.length, groupId: normalizedGroupId, groupName };
};

// Destination for a knowledge-base export. Deliberately derived, never taken
// from the request: the caller only picks a label, so no input can escape
// reportsDir.
const resolveKnowledgeExportDir = (label) => {
  const config = loadConfig();
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeLabel = String(label ?? "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  const base = safeLabel.length > 0 ? `prompt-export-${safeLabel}-${stamp}` : `prompt-export-${stamp}`;
  let exportDir = path.join(config.reportsDir, base);
  for (let suffix = 2; fs.existsSync(exportDir); suffix += 1) {
    exportDir = path.join(config.reportsDir, `${base}-${suffix}`);
  }
  return exportDir;
};

const saveReadMark = ({ groupId, sentAt, rowId, toLatest }) => {
  const normalizedGroupId = String(groupId ?? "");
  if (!/^\d+$/u.test(normalizedGroupId)) {
    throw new Error("groupId is required");
  }

  const db = getStore();
  if (toLatest === true) {
    const latest = messageStore.getLatestMessage(db, normalizedGroupId);
    if (latest !== null) {
      messageStore.setReadMark(db, normalizedGroupId, latest.sentAt, latest.rowId);
    }
    return messageStore.getReadMark(db, normalizedGroupId);
  }

  const normalizedSentAt = Number.parseInt(sentAt, 10);
  if (!Number.isFinite(normalizedSentAt) || normalizedSentAt <= 0) {
    throw new Error("sentAt is required");
  }

  messageStore.setReadMark(db, normalizedGroupId, normalizedSentAt, typeof rowId === "string" ? rowId : "");
  return messageStore.getReadMark(db, normalizedGroupId);
};


const finalizeMediaIndex = (allItems, scannedRefs) => {
  const primaryByKey = new Map();
  for (const item of allItems) {
    const primary = primaryByKey.get(item.dedupKey);
    if (primary === undefined || item.hkt > primary.hkt) {
      primaryByKey.set(item.dedupKey, item);
    }
  }

  const items = allItems
    .map((item) => ({ ...item, dup: primaryByKey.get(item.dedupKey) !== item }))
    .sort((left, right) => right.hkt.localeCompare(left.hkt));
  return {
    totalItems: primaryByKey.size,
    truncated: false,
    scannedRefs,
    items,
  };
};

const STAT_BATCH = 64;

const sizeOrNull = async (filePath) => {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch {
    return null;
  }
};

// One run's manifest turned into index items. Every copied file is stat()ed
// here (missing ones are left out), so this runs once per manifest version,
// asynchronously in batches: the server keeps answering meanwhile.
const buildManifestItems = async (runsDir, runId, manifestPath, manifestStat) => {
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    // A truncated manifest from a killed run must not break the whole index.
    console.error(`media-index: 跳过无法解析的 manifest（${runId}）: ${error.message}`);
    return null;
  }
  const candidates = [];
  let scannedRefs = 0;
  for (const item of Array.isArray(manifest) ? manifest : []) {
    if (typeof item.copiedPath !== "string" || item.copiedPath.length === 0) {
      continue;
    }
    scannedRefs += 1;
    const webPath = toWebPath(runsDir, item.copiedPath);
    if (webPath !== null) {
      candidates.push({ item, webPath });
    }
  }
  const items = [];
  for (let start = 0; start < candidates.length; start += STAT_BATCH) {
    const batch = candidates.slice(start, start + STAT_BATCH);
    const sizes = await Promise.all(batch.map(({ item }) => sizeOrNull(item.copiedPath)));
    batch.forEach(({ item, webPath }, index) => {
      if (sizes[index] !== null) {
        items.push(manifestItem(runId, item, webPath, sizes[index]));
      }
    });
  }
  return { mtimeMs: manifestStat.mtimeMs, size: manifestStat.size, items, scannedRefs };
};

const manifestItem = (runId, item, webPath, bytes) => {
  const contentKeySource = typeof item.hash === "string" && item.hash.length > 0 ? "hash" : "filename";
  const contentKey = contentKeySource === "hash" ? item.hash : path.basename(item.copiedPath).toLowerCase();
  return {
    runId,
    groupId: String(item.groupId ?? ""),
    groupName: item.groupName ?? "",
    rowId: String(item.rowId ?? ""),
    hkt: item.hkt ?? "",
    speaker: item.speaker ?? "",
    kind: item.kind ?? "file",
    bytes,
    webPath,
    contentKey,
    contentKeySource,
    // Group-scoped key: the same file posted in two groups must stay
    // visible under BOTH groups' filters in the media tab.
    dedupKey: `${String(item.groupId ?? "")}|${contentKey}`,
  };
};

const newMediaIndexCache = () => ({ manifests: new Map(), signature: null, payload: null, building: null });

// The run manifests on disk right now: [{ runId, manifestPath, stat }].
const listManifests = (runsDir) => {
  if (!pathExists(runsDir)) {
    return [];
  }
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("qq-"))
    .flatMap((entry) => {
      const manifestPath = path.join(runsDir, entry.name, "media", "media-manifest.json");
      try {
        return [{ runId: entry.name, manifestPath, stat: fs.statSync(manifestPath) }];
      } catch {
        return [];
      }
    });
};

const rebuildMediaIndex = async (runsDir, cache, found, key) => {
  const manifests = new Map();
  for (const { runId, manifestPath, stat } of found) {
    const cached = cache.manifests.get(manifestPath);
    const built = cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size
      ? cached
      : await buildManifestItems(runsDir, runId, manifestPath, stat);
    if (built !== null) {
      manifests.set(manifestPath, built);
    }
  }
  // Duplicates stay in the index (the chat view joins by timestamp and needs every
  // occurrence); the media tab hides dup=true so each file shows once.
  const all = [...manifests.values()];
  cache.manifests = manifests;
  cache.payload = finalizeMediaIndex(all.flatMap((built) => built.items), all.reduce((total, built) => total + built.scannedRefs, 0));
  cache.signature = key;
  return cache.payload;
};

// The media copies of every past run. A run's copies never change after it
// ends, so each manifest is built once (stat()ing ~90k copied files on every
// rebuild took 13.6 s, measured 2026-09-30) and the whole index is reused
// until a manifest appears, changes or goes away. One build at a time.
const collectMediaIndex = async (runsDir, cache) => {
  const found = listManifests(runsDir);
  const key = found.map(({ manifestPath, stat }) => `${manifestPath}|${stat.mtimeMs}|${stat.size}`).join("\n");
  if (cache.payload !== null && cache.signature === key) {
    return cache.payload;
  }
  if (cache.building === null) {
    cache.building = rebuildMediaIndex(runsDir, cache, found, key).finally(() => {
      cache.building = null;
    });
  }
  return cache.building;
};

// One group's part, for a chat (the whole index is ~45 MB).
const mediaIndexForGroup = (payload, groupId) => {
  const items = payload.items.filter((item) => item.groupId === String(groupId));
  return { ...payload, items, totalItems: items.filter((item) => !item.dup).length };
};

let mediaIndex = newMediaIndexCache();

// refresh: read every manifest again (e.g. after copied files were deleted).
const buildMediaIndex = async (forceRefresh, groupId = null) => {
  if (forceRefresh === true && mediaIndex.building === null) {
    mediaIndex = newMediaIndexCache();
  }
  const payload = await collectMediaIndex(loadConfig().runsDir, mediaIndex);
  return groupId === null ? payload : mediaIndexForGroup(payload, groupId);
};

// Free disk space by removing per-run temp data. "clean-db" copies are always
// safe to drop (regenerated on the next run); with olderThanDays > 0, whole run
// directories past the cutoff (including their media copies) go too. Every
// deletion is confined to runsDir with a resolved-path guard.
const cleanupGeneratedData = ({ olderThanDays = 0 } = {}) => {
  const config = loadConfig();
  const runsDir = config.runsDir;
  const result = { removedCleanDbCount: 0, removedRunCount: 0, freedBytes: 0 };
  if (!pathExists(runsDir)) {
    return result;
  }

  const runsResolved = path.resolve(runsDir);
  const insideRuns = (target) => {
    const relative = path.relative(runsResolved, path.resolve(target));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const cutoffMs = olderThanDays > 0 ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;

  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = path.join(runsDir, entry.name);
    if (!insideRuns(runDir)) {
      continue;
    }

    // Age from the run-id timestamp: directory mtime is unreliable here —
    // deleting clean-db below bumps it and would make every such run look
    // fresh, turning "删除 N 天前的旧运行" into a silent no-op.
    let referenceMs = parseRunTimestamp(entry.name);
    if (referenceMs === null) {
      try {
        referenceMs = fs.statSync(runDir).mtimeMs;
      } catch {
        referenceMs = null;
      }
    }
    if (cutoffMs !== null && referenceMs !== null && referenceMs < cutoffMs) {
      result.freedBytes += dirSize(runDir);
      fs.rmSync(runDir, { recursive: true, force: true });
      result.removedRunCount += 1;
      continue;
    }

    const cleanDbDir = path.join(runDir, "clean-db");
    if (pathExists(cleanDbDir)) {
      result.freedBytes += dirSize(cleanDbDir);
      fs.rmSync(cleanDbDir, { recursive: true, force: true });
      result.removedCleanDbCount += 1;
    }
  }
  return result;
};

const isPathAllowedToOpen = (targetPath) => {
  const config = loadConfig();
  const resolved = path.resolve(targetPath);
  return [config.runsDir, config.reportsDir].some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
};

module.exports = {
  toolRoot,
  configPath,
  getStore,
  loadConfig,
  loadRawConfig,
  writeConfig,
  cleanupGeneratedData,
  getState,
  updateWatchlist,
  updateGroupSets,
  getAutomationCoverage,
  currentCoverageWindow,
  historicalCoverageWindow,
  normalizeGroupSets,
  getRunDetail,
  isPathAllowedToOpen,
  getStoreMessages,
  resolvePasteCursor,
  getStoreOverview,
  getStoreTimeline,
  saveReadMark,
  advanceLocalReadMarks: (groupIds) => messageStore.advanceLocalReadMarks(getStore(), groupIds),
  buildMediaIndex,
  finalizeMediaIndex,
  collectMediaIndex,
  newMediaIndexCache,
  mediaIndexForGroup,
  prepareQuickSummary,
  resolveKnowledgeExportDir,
};
