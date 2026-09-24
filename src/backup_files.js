"use strict";

// File side of 备份 (the rules live in backup_plan.js): finding each planned
// file in the PC QQ cache, copying it out, writing prompt sidecars, day logs,
// the ledger that makes re-runs incremental, and the CSV index. Only ever
// READS QQ's directories; every write goes under the chosen backup folder.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const { findSourcePath, fetchRemoteGroupImage } = require("./export_media_files");
const { sidecarText, renderDayLog, indexCsv } = require("./backup_plan");
const { formatHkt } = require("./unviewed_range");

const LEDGER_DIR = ".qq-backup";
const LEDGER_FILE = "ledger.json";
const REMOTE_CONCURRENCY = 4;
const DAY_SECONDS = 86400;
const BEIJING_OFFSET_SECONDS = 8 * 3600;
const SIDECAR_CATEGORIES = new Set(["aiImages", "askedImages"]);

const README = [
  "这个文件夹由「QQ 群消息简报」的备份功能生成。",
  "",
  "<群名_群号>/<年-月>/   图片、视频、文件。文件名 = 时间_发送者_md5 前 8 位。",
  "  同名的 .txt          AI 图的咒语、参数、LoRA，以及群里的求图和回复记录。",
  "  *_缩略图.*           电脑上只有缩略图，没有原图。",
  "  *_非原图.*           电脑上只有 QQ 压缩过的版本，和原图不一致（AI 参数可能已丢失）。",
  "<群名_群号>/聊天记录/  每天一个文本文件，[图片] 后面是这张图在备份里的位置。",
  "备份清单.csv           全部已备份文件的清单（Excel 可直接打开）。",
  ".qq-backup/            记录已经备份过哪些文件，下次只补新的。请不要删除。",
  "",
  "本工具只读取电脑版 QQ 的本地缓存，从不删除或修改 QQ 里的任何东西。",
].join("\r\n");

/* ---------- ledger ---------- */

const ledgerPath = (targetDir) => path.join(targetDir, LEDGER_DIR, LEDGER_FILE);

// Entries whose file the user has since deleted or moved count as not saved.
const loadLedger = (targetDir) => {
  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(targetDir), "utf8"));
    const items = Object.fromEntries(Object.entries(ledger.items ?? {})
      .filter(([, item]) => typeof item?.path === "string" && fs.existsSync(path.join(targetDir, item.path))));
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
};

const saveLedger = (targetDir, ledger) => {
  const filePath = ledgerPath(targetDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
};

/* ---------- finding files ---------- */

// QQ keeps reduced copies in Thumb directories, named <md5>_<size>.
const isThumbnail = (filePath) => /[\\/]Thumb[\\/]/iu.test(filePath) || /^[a-f0-9]{32}_\d+\./iu.test(path.basename(filePath));

const statSize = (filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
};

const MISSING = { status: "missing", sourcePath: null, bytes: 0 };
const MAX_HASHED_CANDIDATES = 4;
const isTemporary = (filePath) => /[\\/](?:Ori|Thumb)Temp[\\/]/iu.test(filePath) || /\.tmp$/iu.test(filePath);

// Where a true original most likely is: the tool's own verified copies, then
// QQ's Ori folders, then anything else; thumbnails last.
const candidateRank = (filePath) => {
  if (/[\\/]media-objects[\\/]/iu.test(filePath)) {
    return 0;
  }
  if (/[\\/]Ori[\\/]/iu.test(filePath)) {
    return 1;
  }
  return isThumbnail(filePath) ? 3 : 2;
};

const md5File = (filePath) => {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
};

// QQ keeps several files under one picture's md5 (original, compressed copy,
// thumbnails, a sticker-folder copy), and they can differ. Only a file whose
// content hashes to that md5 is the original — the one with the AI metadata.
const resolveImage = (item, index) => {
  const paths = new Set(index.byHash.get(item.hash) ?? []);
  for (const ref of item.refs) {
    const direct = findSourcePath({ ...ref, hash: null, fileName: null }, index, []);
    if (direct !== null) {
      paths.add(direct);
    }
  }
  const candidates = [...paths]
    .filter((filePath) => !isTemporary(filePath))
    .map((filePath) => ({ filePath, bytes: statSize(filePath), rank: candidateRank(filePath) }))
    .filter((candidate) => candidate.bytes !== null)
    .sort((left, right) => left.rank - right.rank || right.bytes - left.bytes);
  const full = candidates.filter((candidate) => candidate.rank < 3);
  const original = full.slice(0, MAX_HASHED_CANDIDATES).find((candidate) => md5File(candidate.filePath) === item.hash);
  if (original !== undefined) {
    return { status: "original", sourcePath: original.filePath, bytes: original.bytes };
  }
  const fallback = full[0] ?? candidates[0];
  return fallback === undefined
    ? MISSING
    : { status: fallback.rank === 3 ? "thumb" : "compressed", sourcePath: fallback.filePath, bytes: fallback.bytes };
};

// { status: original|compressed|thumb|missing, sourcePath, bytes }
const resolveItem = (item, index) => {
  if (item.kind === "image" && item.hash !== null) {
    return resolveImage(item, index);
  }
  for (const ref of item.refs) {
    const sourcePath = findSourcePath(ref, index, []);
    const bytes = sourcePath === null ? null : statSize(sourcePath);
    if (bytes !== null) {
      return { status: isThumbnail(sourcePath) ? "thumb" : "original", sourcePath, bytes };
    }
  }
  return MISSING;
};

const STATUS_RANK = { original: 0, remote: 0, compressed: 1, thumb: 2, missing: 3 };

// A re-run only re-copies when it found something better than last time.
const isImprovement = (status, previousStatus) =>
  previousStatus === null || STATUS_RANK[status] < (STATUS_RANK[previousStatus] ?? 3);

// Only a well-formed md5 goes into the CDN URL.
const canTryRemote = (item) => item.kind === "image" && /^[a-f0-9]{32}$/u.test(item.hash ?? "");

/* ---------- 咒语库 facts for classification and sidecars ---------- */

const openKnowledge = (knowledgeDbPath) =>
  fs.existsSync(knowledgeDbPath) ? new Database(knowledgeDbPath, { readonly: true, fileMustExist: true }) : null;

// Map(hash -> { params, asks }) for the hashes in this scan.
const knowledgeFlags = (db, hashes) => {
  const flags = new Map();
  if (db === null) {
    return flags;
  }
  const unique = [...new Set(hashes)];
  for (let start = 0; start < unique.length; start += 400) {
    const batch = unique.slice(start, start + 400);
    const marks = batch.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT hash, generator FROM images WHERE hash IN (${marks})`).all(...batch)) {
      flags.set(row.hash, { params: row.generator !== "stripped", asks: 0 });
    }
    for (const row of db.prepare(`SELECT image_hash AS hash, COUNT(*) AS asks FROM prompt_requests WHERE image_hash IN (${marks}) GROUP BY image_hash`).all(...batch)) {
      flags.set(row.hash, { params: flags.get(row.hash)?.params ?? false, asks: row.asks });
    }
  }
  return flags;
};

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const sidecarDetails = (db, hash) => {
  const image = db.prepare("SELECT generator, prompt, negative_prompt AS negativePrompt, checkpoint, params_json AS paramsJson, width, height FROM images WHERE hash = ?").get(hash);
  const loras = db.prepare("SELECT lora_name AS name, weight FROM image_loras WHERE hash = ?").all(hash);
  const requests = db.prepare(`
    SELECT asker, ask_text AS askText, ask_sent_at AS askSentAt, answer_by AS answerBy,
           CASE WHEN answer_kind = 'text' THEN answer_text ELSE '' END AS answerText
    FROM prompt_requests WHERE image_hash = ? ORDER BY ask_sent_at
  `).all(hash).map((row) => ({ ...row, askHkt: row.askSentAt > 0 ? formatHkt(row.askSentAt).slice(0, 16) : "" }));
  return { ...(image ?? {}), params: parseJson(image?.paramsJson ?? "{}", {}), loras, requests };
};

/* ---------- writing ---------- */

const extensionFor = (item, sourcePath, remoteExtension) =>
  (remoteExtension ?? path.extname(sourcePath ?? "") ?? "").toLowerCase()
  || item.refs.find((ref) => ref.extension)?.extension
  || "";

// Never overwrites: a different file already at the name gets a suffix.
const freeTarget = (directory, stem, extension) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `${stem}${attempt === 0 ? "" : `_${attempt + 1}`}${extension}`;
    if (!fs.existsSync(path.join(directory, name))) {
      return name;
    }
  }
  throw new Error(`备份目录里同名文件太多：${stem}`);
};

const STATUS_SUFFIX = { thumb: "_缩略图", compressed: "_非原图" };

const writeItem = (targetDir, item, { bytes, sourcePath, extension, status }, knowledgeDb) => {
  const directory = path.join(targetDir, ...item.relativeDir.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  const name = freeTarget(directory, `${item.stem}${STATUS_SUFFIX[status] ?? ""}`, extension);
  const target = path.join(directory, name);
  if (sourcePath !== null) {
    fs.copyFileSync(sourcePath, target, fs.constants.COPYFILE_EXCL);
  } else {
    fs.writeFileSync(target, bytes, { flag: "wx" });
  }
  if (SIDECAR_CATEGORIES.has(item.category) && item.hash !== null && knowledgeDb !== null) {
    fs.writeFileSync(path.join(directory, `${name.replace(/\.[^.]+$/u, "")}.txt`), sidecarText(item, sidecarDetails(knowledgeDb, item.hash)), "utf8");
  }
  return `${item.relativeDir}/${name}`;
};

// A better copy just replaced the thumbnail / compressed one an earlier run
// saved: remove that file (and its sidecar) so the folder and the CSV index
// agree. Only ever touches a path this tool's own ledger recorded under the
// backup folder.
const removeSuperseded = (targetDir, previous) => {
  if (previous === undefined || !["thumb", "compressed"].includes(previous.status)) {
    return;
  }
  const filePath = path.resolve(targetDir, ...previous.path.split("/"));
  const relative = path.relative(path.resolve(targetDir), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  for (const candidate of [filePath, filePath.replace(/\.[^.\\/]+$/u, ".txt")]) {
    fs.rmSync(candidate, { force: true });
  }
};

const ledgerEntry = (item, relativePath, status, bytes) => ({
  path: relativePath,
  bytes,
  status,
  savedAt: Math.floor(Date.now() / 1000),
  groupId: item.groupId,
  groupName: item.groupName,
  sentAt: item.sentAt,
  hkt: item.hkt,
  speaker: item.speaker,
  kind: item.kind,
  category: item.category,
  hash: item.hash,
  rowId: item.rowId,
});

// Downloads by md5 from QQ's group-image server (checked against the md5).
const fetchRemote = async (items, fetchImplementation = fetch) => {
  const results = new Map();
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        const remote = await fetchRemoteGroupImage(item.hash, fetchImplementation);
        results.set(item.key, remote.status === "downloaded" ? remote : null);
      } catch {
        results.set(item.key, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, items.length) }, lane));
  return results;
};

/* ---------- chat logs ---------- */

const dayStarts = (fromUnix, toUnix) => {
  const first = fromUnix - ((fromUnix + BEIJING_OFFSET_SECONDS) % DAY_SECONDS);
  const days = [];
  for (let start = first; start < toUnix; start += DAY_SECONDS) {
    days.push(start);
  }
  return days;
};

const dayRows = (storeDb, groupId, start, end) =>
  storeDb.prepare(`
    SELECT row_id AS rowId, sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?
    ORDER BY sent_at, row_id
  `).all(String(groupId), start, end).map((row) => ({ ...row, hkt: formatHkt(row.sentAt) }));

// Writes <group>/聊天记录/<day>.txt for each day with messages (when `write`),
// and returns how many days each group has.
const writeDayLogs = ({ storeDb, targetDir, groups, fromUnix, toUnix, ledger, write }) => {
  const links = new Map();
  for (const item of Object.values(ledger.items)) {
    const list = links.get(item.rowId) ?? links.set(item.rowId, []).get(item.rowId);
    list.push(`../${item.path.split("/").slice(1).join("/")}`);
  }
  const counts = new Map();
  for (const group of groups) {
    let days = 0;
    for (const start of dayStarts(fromUnix, toUnix)) {
      const rows = dayRows(storeDb, group.groupId, Math.max(start, fromUnix), Math.min(start + DAY_SECONDS, toUnix));
      if (rows.length === 0) {
        continue;
      }
      days += 1;
      if (write) {
        const day = formatHkt(start).slice(0, 10);
        const directory = path.join(targetDir, group.folder, "聊天记录");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `${day}.txt`), renderDayLog(rows, links, { groupName: group.groupName, groupId: group.groupId, day }), "utf8");
      }
    }
    counts.set(group.groupId, days);
  }
  return counts;
};

const writeIndexFiles = (targetDir, ledger) => {
  fs.writeFileSync(path.join(targetDir, "备份清单.csv"), indexCsv(Object.values(ledger.items)), "utf8");
  const readme = path.join(targetDir, "说明.txt");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `${README}\r\n`, "utf8");
  }
};

// Free bytes on the drive holding targetDir (or its nearest existing parent).
const freeBytesAt = (targetDir) => {
  let probe = targetDir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  try {
    const stats = fs.statfsSync(probe);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

module.exports = {
  loadLedger,
  saveLedger,
  isThumbnail,
  resolveItem,
  isImprovement,
  canTryRemote,
  openKnowledge,
  knowledgeFlags,
  extensionFor,
  writeItem,
  removeSuperseded,
  ledgerEntry,
  fetchRemote,
  writeDayLogs,
  writeIndexFiles,
  freeBytesAt,
};
