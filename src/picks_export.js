"use strict";

// Saves selected gallery originals into a stable per-group album.
//
// Unlike media-export's timestamped dump, repeating the same action for the
// next group (or the same group later) appends to reports/picks/<group>/ and
// skips files whose content hash is already in the ledger.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LEDGER_SCHEMA = "qqsummarytools.picks-export";
const LEDGER_VERSION = 1;
const LEDGER_FILENAME = "picks-ledger.json";
const MAX_STEM_CHARS = 60;
const HASH_BUFFER_BYTES = 1024 * 1024;
const GROUP_ID_PATTERN = /^\d+$/u;

const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const ledgerPath = (toolRoot) => path.join(toolRoot, "store", LEDGER_FILENAME);

const emptyLedger = () => ({
  schema: LEDGER_SCHEMA,
  version: LEDGER_VERSION,
  picks: {},
});

const loadLedger = (toolRoot) => {
  const target = ledgerPath(toolRoot);
  if (!fs.existsSync(target)) {
    return emptyLedger();
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new Error(`精选记录文件损坏，无法解析：${target}（重命名或删除后重试）`);
  }
  if (parsed?.schema !== LEDGER_SCHEMA) {
    throw new Error(`${target} 不是本工具的精选记录文件，请先移走或改名`);
  }
  return {
    schema: LEDGER_SCHEMA,
    version: LEDGER_VERSION,
    picks: typeof parsed.picks === "object" && parsed.picks !== null ? parsed.picks : {},
  };
};

const saveLedger = (toolRoot, ledger) => {
  const target = ledgerPath(toolRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${LEDGER_FILENAME}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({
    schema: LEDGER_SCHEMA,
    version: LEDGER_VERSION,
    picks: ledger.picks,
  }, null, 2), "utf8");
  fs.renameSync(temp, target);
};

const sanitizeStem = (value, fallback) => {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001F<>:"/\\|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, MAX_STEM_CHARS);
  if (cleaned.length === 0 || RESERVED_NAMES.has(cleaned.toLowerCase())) {
    return fallback;
  }
  return cleaned;
};

const groupFolderName = ({ groupId, groupName }) => {
  const id = String(groupId ?? "");
  if (!GROUP_ID_PATTERN.test(id)) {
    throw new Error(`Gallery picks require a numeric group id: ${id}`);
  }
  const label = sanitizeStem(groupName, "");
  return label.length > 0 ? `${label}-${id}` : id;
};

const ensureInside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("精选保存路径超出 reports/picks。");
  }
};

const hashFileMd5 = (filePath) => {
  const descriptor = fs.openSync(filePath, "r");
  const hash = crypto.createHash("md5");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
};

const dateStamp = (hkt) => {
  const match = String(hkt ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  return match === null ? "00000000" : `${match[1]}${match[2]}${match[3]}`;
};

const buildFileName = (item, hash) => {
  const speaker = sanitizeStem(item.speaker, "image");
  const extension = path.extname(String(item.sourcePath ?? "")).toLowerCase() || ".bin";
  return `${dateStamp(item.hkt)}_${speaker}_${hash.slice(0, 8)}${extension}`;
};

const uniqueName = (directory, fileName) => {
  if (!fs.existsSync(path.join(directory, fileName))) {
    return fileName;
  }
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!fs.existsSync(path.join(directory, candidate))) {
      return candidate;
    }
  }
  throw new Error(`无法为精选文件分配文件名：${fileName}`);
};

const optionalText = (value) => {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "";
};

const attachPickIdentity = (entry, item) => {
  const contentKey = optionalText(item.contentKey);
  const webPath = optionalText(item.webPath);
  if (contentKey.length > 0 && optionalText(entry.contentKey) === "") {
    entry.contentKey = contentKey;
  }
  if (webPath.startsWith("/runs/") && optionalText(entry.webPath) === "") {
    entry.webPath = webPath;
  }
  return entry;
};

const saveOne = (picksRoot, ledger, item) => {
  if (typeof item.sourcePath !== "string" || item.sourcePath.length === 0) {
    throw new Error("无法解析媒体路径");
  }
  if (!fs.existsSync(item.sourcePath) || !fs.statSync(item.sourcePath).isFile()) {
    throw new Error("原文件不存在或无法读取");
  }
  const hash = hashFileMd5(item.sourcePath);
  const existing = ledger.picks[hash];
  if (existing !== undefined) {
    attachPickIdentity(existing, item);
    return {
      status: "skipped",
      hash,
      contentKey: optionalText(existing.contentKey),
      folder: path.join(picksRoot, path.dirname(existing.relativePath)),
    };
  }
  const folder = path.join(picksRoot, groupFolderName(item));
  ensureInside(picksRoot, folder);
  fs.mkdirSync(folder, { recursive: true });
  const fileName = uniqueName(folder, buildFileName(item, hash));
  const destination = path.join(folder, fileName);
  ensureInside(picksRoot, destination);
  fs.copyFileSync(item.sourcePath, destination);
  const relativePath = path.join(path.basename(folder), fileName).replaceAll("\\", "/");
  const entry = attachPickIdentity({
    groupId: String(item.groupId),
    groupName: String(item.groupName ?? ""),
    speaker: String(item.speaker ?? ""),
    hkt: String(item.hkt ?? ""),
    savedAt: new Date().toISOString(),
    relativePath,
    bytes: fs.statSync(destination).size,
  }, item);
  ledger.picks[hash] = entry;
  return { status: "saved", hash, contentKey: optionalText(entry.contentKey), folder };
};

const savePicks = ({ toolRoot, reportsDir, items }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("没有选中任何媒体文件。");
  }
  const picksRoot = path.join(path.resolve(reportsDir), "picks");
  ensureInside(path.resolve(reportsDir), picksRoot);
  fs.mkdirSync(picksRoot, { recursive: true });
  const ledger = loadLedger(toolRoot);
  const folders = new Set();
  const result = { saved: 0, skipped: 0, failed: [], hashes: [], skippedHashes: [], contentKeys: [] };
  for (const item of items) {
    try {
      const outcome = saveOne(picksRoot, ledger, item);
      folders.add(outcome.folder);
      if (optionalText(outcome.contentKey) !== "") {
        result.contentKeys.push(outcome.contentKey);
      }
      if (outcome.status === "saved") {
        result.saved += 1;
        result.hashes.push(outcome.hash);
      } else {
        result.skipped += 1;
        result.skippedHashes.push(outcome.hash);
      }
    } catch (error) {
      result.failed.push({
        webPath: String(item.webPath ?? item.sourcePath ?? ""),
        reason: error.message,
      });
    }
  }
  saveLedger(toolRoot, ledger);
  return { ...result, folders: [...folders].sort() };
};

const listPicks = (toolRoot, reportsDir) => {
  const ledger = loadLedger(toolRoot);
  const picksRoot = reportsDir === undefined ? null : path.join(path.resolve(reportsDir), "picks");
  const items = Object.entries(ledger.picks).map(([hash, entry]) => ({
    hash,
    contentKey: entry.contentKey ?? "",
    webPath: entry.webPath ?? "",
    groupId: entry.groupId,
    groupName: entry.groupName,
    speaker: entry.speaker,
    hkt: entry.hkt,
    savedAt: entry.savedAt,
    relativePath: entry.relativePath,
    bytes: entry.bytes,
    folder: picksRoot === null ? null : path.join(picksRoot, path.dirname(entry.relativePath)),
    fileName: path.basename(entry.relativePath),
  }));
  return { schema: LEDGER_SCHEMA, count: items.length, items };
};

module.exports = {
  LEDGER_SCHEMA,
  LEDGER_VERSION,
  groupFolderName,
  listPicks,
  loadLedger,
  savePicks,
  sanitizeStem,
};
