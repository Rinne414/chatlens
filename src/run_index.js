const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("./report_utils");
const { readLlmError, readLlmUnused } = require("./llm_status");

const pathExists = (filePath) => fs.existsSync(filePath);

const fileSize = (filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

const dirSize = (dirPath) => {
  if (!pathExists(dirPath)) {
    return 0;
  }

  const stack = [dirPath];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        total += fileSize(entryPath);
      }
    }
  }

  return total;
};

// Finished runs do not change size until the next export. /api/state used to
// walk every file (tens of GB) on each boot; cache the totals next to analysis.
const DISK_STATS_SCHEMA = "qqsummarytools.run-disk-stats";
const DISK_STATS_VERSION = 1;
const EXPORT_META_PREFIX_BYTES = 256 * 1024;

const fileStamp = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "0:0";
  }
};

const dirStamp = (dirPath) => {
  try {
    const stat = fs.statSync(dirPath);
    return stat.isDirectory() ? `${Math.trunc(stat.mtimeMs)}` : "0";
  } catch {
    return "0";
  }
};

const exportStamp = (exportsDir) => {
  if (!pathExists(exportsDir)) {
    return "";
  }
  return fs
    .readdirSync(exportsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${name}:${fileStamp(path.join(exportsDir, name))}`)
    .join(",");
};

const diskFingerprint = (runDir) => [
  fileStamp(path.join(runDir, "analysis", "analysis.json")),
  fileStamp(path.join(runDir, "analysis", "digest.json")),
  fileStamp(path.join(runDir, "media", "media-manifest.json")),
  dirStamp(path.join(runDir, "media")),
  dirStamp(path.join(runDir, "clean-db")),
  exportStamp(path.join(runDir, "exports")),
].join("|");

const diskStatsPath = (runDir) => path.join(runDir, "analysis", "disk-stats.json");

const readDiskStats = (runDir, fingerprint) => {
  const target = diskStatsPath(runDir);
  if (!pathExists(target)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
  if (parsed?.schema !== DISK_STATS_SCHEMA || parsed.version !== DISK_STATS_VERSION) {
    return null;
  }
  if (parsed.fingerprint !== fingerprint) {
    return null;
  }
  if (![parsed.mediaBytes, parsed.cleanDbBytes, parsed.runBytes, parsed.mtimeMs, parsed.mediaRefs,
    parsed.copiedMedia, parsed.missingMedia, parsed.urlOnlyMedia].every(Number.isFinite)) {
    return null;
  }
  if (parsed.scanCoverage === null || typeof parsed.scanCoverage !== "object" || Array.isArray(parsed.scanCoverage)) {
    return null;
  }
  return parsed;
};

const writeDiskStats = (runDir, stats) => {
  try {
    fs.writeFileSync(diskStatsPath(runDir), `${JSON.stringify(stats)}\n`);
  } catch {
    // Listing must still work when the runs directory is readable but not writable.
  }
};

// Export JSON is almost all message bodies. Coverage only needs the header
// written before `messages`; parsing 10MB+ arrays on every listing is wasted.
const readExportCoverageMeta = (filePath) => {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size <= EXPORT_META_PREFIX_BYTES) {
    return readJson(filePath);
  }
  const fd = fs.openSync(filePath, "r");
  let prefix;
  try {
    const buffer = Buffer.alloc(EXPORT_META_PREFIX_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const cut = prefix.search(/,\s*"(?:messages|mediaMessages|quoteLinks)"\s*:/u);
  if (cut !== -1) {
    try {
      return JSON.parse(`${prefix.slice(0, cut)}}`);
    } catch {
      // Prefix was not a complete object (header larger than the window).
    }
  }
  return readJson(filePath);
};

const parseRunTimestamp = (runId) => {
  const match = runId.match(/(\d{8})-(\d{6})$/u);
  if (match === null) {
    return null;
  }

  const [, datePart, timePart] = match;
  const iso = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}+08:00`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const countManifest = (manifestPath) => {
  if (!pathExists(manifestPath)) {
    return {
      refs: 0,
      copied: 0,
      missing: 0,
      urlOnly: 0,
    };
  }

  const manifest = readJson(manifestPath);
  return {
    refs: manifest.length,
    copied: manifest.filter((item) => typeof item.copiedPath === "string" && item.copiedPath.length > 0).length,
    missing: manifest.filter((item) => item.copiedPath === null && item.url === null).length,
    urlOnly: manifest.filter((item) => item.copiedPath === null && typeof item.url === "string" && item.url.length > 0).length,
  };
};

const groupLabel = (analysis) =>
  (analysis.byGroup ?? [])
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ") || (analysis.groupIds ?? []).join(", ") || "Unknown";

const summarizeTopics = (analysis) => {
  if (analysis.llmSummary?.summary) {
    return analysis.llmSummary.summary;
  }

  return (analysis.topics ?? [])
    .filter((topic) => topic.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((topic) => topic.name)
    .join(" / ") || "No summary";
};

const numberOrNull = (value) => Number.isFinite(value) ? value : null;

const collectScanCoverage = (runDir) => {
  const exportsDir = path.join(runDir, "exports");
  if (!pathExists(exportsDir)) {
    return {
      status: "unknown",
      coverageRatio: null,
      coveredSeconds: null,
      missingSeconds: null,
      requestedStartUnix: null,
      requestedEndUnix: null,
    };
  }

  const exports = fs
    .readdirSync(exportsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const value = readExportCoverageMeta(path.join(exportsDir, entry.name));
      if (value === null || typeof value !== "object") {
        return null;
      }
      const startUnix = numberOrNull(value.startUnix);
      const endUnix = numberOrNull(value.endUnix);
      const groupIds = Array.isArray(value.groupIds) ? value.groupIds.map(String) : [];
      if (startUnix === null || endUnix === null || startUnix >= endUnix || groupIds.length === 0) {
        return null;
      }
      const coveredFromUnix = Object.prototype.hasOwnProperty.call(value, "coveredFromUnix")
        ? numberOrNull(value.coveredFromUnix)
        : startUnix;
      const coveredStartUnix = coveredFromUnix === null ? endUnix : Math.max(startUnix, Math.min(endUnix, coveredFromUnix));
      return { startUnix, endUnix, coveredStartUnix, groupCount: groupIds.length };
    })
    .filter((entry) => entry !== null);

  if (exports.length === 0) {
    return {
      status: "unknown",
      coverageRatio: null,
      coveredSeconds: null,
      missingSeconds: null,
      requestedStartUnix: null,
      requestedEndUnix: null,
    };
  }

  const totalSeconds = exports.reduce(
    (total, entry) => total + (entry.endUnix - entry.startUnix) * entry.groupCount,
    0,
  );
  const coveredSeconds = exports.reduce(
    (total, entry) => total + (entry.endUnix - entry.coveredStartUnix) * entry.groupCount,
    0,
  );
  const coverageRatio = totalSeconds > 0 ? coveredSeconds / totalSeconds : 0;
  return {
    status: coverageRatio >= 0.999 ? "complete" : coverageRatio > 0 ? "partial" : "none",
    coverageRatio,
    coveredSeconds,
    missingSeconds: totalSeconds - coveredSeconds,
    requestedStartUnix: Math.min(...exports.map((entry) => entry.startUnix)),
    requestedEndUnix: Math.max(...exports.map((entry) => entry.endUnix)),
  };
};

const llmCoverageRow = (entry, analysisDir) => ({
  total: entry.llmSummary?.coverage?.totalTextMessages ?? entry.parsedTextMessages ?? 0,
  included: entry.llmSummary?.coverage?.includedTextMessages ?? null,
  used: entry.llmSummary !== null && entry.llmSummary !== undefined,
  failed: readLlmError(analysisDir) !== null,
  unused: readLlmUnused(analysisDir) !== null,
});

const llmCoverageRows = (runDir, analysis, digest) => {
  const groupsDir = path.join(runDir, "analysis", "groups");
  if (digest !== null && pathExists(groupsDir)) {
    return fs
      .readdirSync(groupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const groupDir = path.join(groupsDir, entry.name);
        const analysisPath = path.join(groupDir, "analysis.json");
        return pathExists(analysisPath) ? llmCoverageRow(readJson(analysisPath), groupDir) : null;
      })
      .filter((entry) => entry !== null);
  }
  return [llmCoverageRow(analysis, path.join(runDir, "analysis"))];
};

const collectAiCoverage = (runDir, analysis, digest) => {
  const rows = llmCoverageRows(runDir, analysis, digest);
  const usedRows = rows.filter((row) => row.used);
  if (usedRows.length === 0) {
    const totalMessages = rows.reduce((total, row) => total + row.total, 0);
    if (rows.some((row) => row.failed)) {
      return { status: "failed", coverageRatio: null, includedMessages: 0, totalMessages };
    }
    if (rows.length > 0 && rows.every((row) => row.unused)) {
      return { status: "not-used", coverageRatio: null, includedMessages: 0, totalMessages: 0 };
    }
    return { status: "indeterminate", coverageRatio: null, includedMessages: 0, totalMessages };
  }
  if (usedRows.some((row) => !Number.isFinite(row.included))) {
    return {
      status: "unknown",
      coverageRatio: null,
      includedMessages: null,
      totalMessages: rows.reduce((total, row) => total + row.total, 0),
    };
  }
  const totalMessages = rows.reduce((total, row) => total + row.total, 0);
  const includedMessages = rows.reduce((total, row) => total + row.included, 0);
  if (totalMessages === 0) {
    return { status: "empty", coverageRatio: 1, includedMessages: 0, totalMessages: 0 };
  }
  const coverageRatio = totalMessages > 0 ? includedMessages / totalMessages : 1;
  return {
    status: coverageRatio >= 0.999 ? "complete" : "partial",
    coverageRatio,
    includedMessages,
    totalMessages,
  };
};

// A run left behind with truncated/corrupt JSON must not take down the whole listing.
const collectRun = (runDir, reportsDir, options) => {
  try {
    return collectRunUnsafe(runDir, reportsDir, options);
  } catch (error) {
    console.error(`run-index: skipping unreadable run ${path.basename(runDir)}: ${error.message}`);
    return null;
  }
};

const collectRunUnsafe = (runDir, reportsDir, options = {}) => {
  const runId = path.basename(runDir);
  const analysisPath = path.join(runDir, "analysis", "analysis.json");
  if (!pathExists(analysisPath)) {
    return null;
  }

  const analysis = readJson(analysisPath);
  const digestPath = path.join(runDir, "analysis", "digest.json");
  const digest = pathExists(digestPath) ? readJson(digestPath) : null;
  const mediaDir = path.join(runDir, "media");
  const manifestPath = path.join(mediaDir, "media-manifest.json");
  const reportHtml = path.join(reportsDir, `${runId}.html`);
  const reportMd = path.join(reportsDir, `${runId}.md`);
  const cleanDbDir = path.join(runDir, "clean-db");
  const fingerprint = diskFingerprint(runDir);
  const cached = readDiskStats(runDir, fingerprint);
  let mediaStats;
  let mediaBytes;
  let cleanDbBytes;
  let runBytes;
  let mtimeMs;
  let scanCoverage;
  if (cached !== null) {
    mediaStats = {
      refs: cached.mediaRefs,
      copied: cached.copiedMedia,
      missing: cached.missingMedia,
      urlOnly: cached.urlOnlyMedia,
    };
    mediaBytes = cached.mediaBytes;
    cleanDbBytes = cached.cleanDbBytes;
    runBytes = cached.runBytes;
    mtimeMs = cached.mtimeMs;
    scanCoverage = cached.scanCoverage;
  } else {
    mediaStats = countManifest(manifestPath);
    try {
      mtimeMs = fs.statSync(analysisPath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    scanCoverage = collectScanCoverage(runDir);
    if (options.includeDisk === false) {
      mediaBytes = 0;
      cleanDbBytes = 0;
      runBytes = 0;
    } else {
      mediaBytes = dirSize(mediaDir);
      cleanDbBytes = dirSize(cleanDbDir);
      runBytes = dirSize(runDir);
      writeDiskStats(runDir, {
        schema: DISK_STATS_SCHEMA,
        version: DISK_STATS_VERSION,
        fingerprint,
        mediaBytes,
        cleanDbBytes,
        runBytes,
        mtimeMs,
        mediaRefs: mediaStats.refs,
        copiedMedia: mediaStats.copied,
        missingMedia: mediaStats.missing,
        urlOnlyMedia: mediaStats.urlOnly,
        scanCoverage,
      });
    }
  }
  const aiCoverage = collectAiCoverage(runDir, analysis, digest);

  return {
    runId,
    runDir,
    analysisPath,
    reportHtml,
    reportMd,
    mediaDir,
    manifestPath,
    hasReportHtml: pathExists(reportHtml),
    hasReportMd: pathExists(reportMd),
    hasMedia: pathExists(manifestPath),
    hasCleanDb: pathExists(cleanDbDir),
    firstMessageHkt: analysis.firstMessageHkt ?? "N/A",
    lastMessageHkt: analysis.lastMessageHkt ?? "N/A",
    isDigest: digest !== null,
    groups: groupLabel(analysis),
    summary: digest?.overview ?? summarizeTopics(analysis),
    textMessages: analysis.parsedTextMessages ?? 0,
    mediaMessages: analysis.parsedMediaMessages ?? 0,
    mediaRefs: analysis.mediaSummary?.refs ?? mediaStats.refs,
    copiedMedia: mediaStats.copied,
    missingMedia: mediaStats.missing,
    urlOnlyMedia: mediaStats.urlOnly,
    llmStatus: (digest ? digest.llmGroups > 0 : analysis.llmSummary)
      ? "done"
      : aiCoverage.status === "failed"
        ? "failed"
        : aiCoverage.status === "not-used"
          ? "not-used"
          : "unknown",
    llmModel: digest ? `${digest.llmGroups}/${digest.groupCount} 群 LLM` : analysis.llmSummary?.provider?.model ?? "",
    mediaBytes,
    cleanDbBytes,
    runBytes,
    groupIds: (analysis.groupIds ?? []).map(String),
    scanCoverage,
    aiCoverage,
    createdMs: parseRunTimestamp(runId),
    mtimeMs,
  };
};

const collectRuns = (runsDir, reportsDir, options) => {
  if (!pathExists(runsDir)) {
    return [];
  }

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("qq-"))
    .map((entry) => collectRun(path.join(runsDir, entry.name), reportsDir, options))
    .filter((run) => run !== null)
    .sort((left, right) => (right.createdMs ?? right.mtimeMs) - (left.createdMs ?? left.mtimeMs));
};

module.exports = {
  pathExists,
  dirSize,
  countManifest,
  parseRunTimestamp,
  collectRun,
  collectRuns,
  readExportCoverageMeta,
  diskStatsPath,
  collectScanCoverage,
  collectAiCoverage,
};
