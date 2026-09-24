"use strict";

// 备份: turns one scanned range (the export's media-messages.json plus what the
// 咒语库 knows about each picture) into the list of files to save, and renders
// what goes next to them: prompt sidecars, per-day chat logs, the CSV index and
// the "可以放心清理" verdict. Pure — no file system access — so the naming,
// dedupe and verdict rules are testable; pipeline/backup_run.js does the I/O.

const CATEGORY_KEYS = ["aiImages", "askedImages", "images", "videos", "files", "voice", "stickers", "logs"];
const DEFAULT_CATEGORIES = { aiImages: true, askedImages: true, images: true, videos: true, files: true, voice: false, stickers: false, logs: true };
const KIND_LABELS = { image: "图片", video: "视频", file: "文件", audio: "语音", emoji: "表情" };
const KIND_CATEGORY = { video: "videos", file: "files", audio: "voice", emoji: "stickers" };
const MISSING_SAMPLES = 30;

// Windows rejects these characters and names, and silently drops trailing dots
// and spaces; group names and nicknames routinely contain all of them.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/gu;

// Bidi overrides and zero-width marks (common in QQ nicknames) can make a
// file name display as something else, e.g. hide its real extension.
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

const safeSegment = (value, fallback, maxChars = 60) => {
  const cleaned = String(value ?? "").replace(INVISIBLE_CHARS, "").replace(UNSAFE_CHARS, "_").replace(/\s+/gu, " ").trim();
  const clipped = [...cleaned].slice(0, maxChars).join("").replace(/[. ]+$/u, "");
  if (clipped.length === 0) {
    return fallback;
  }
  return WINDOWS_RESERVED.test(clipped) ? `_${clipped}` : clipped;
};

const normalizeCategories = (input) => Object.fromEntries(
  CATEGORY_KEYS.map((key) => [key, typeof input?.[key] === "boolean" ? input[key] : DEFAULT_CATEGORIES[key]]),
);

const compactStamp = (hkt) => String(hkt).slice(0, 19).replace(/-/gu, "").replace(" ", "-").replace(/:/gu, "");

/* ---------- which files one message holds ---------- */

// A message's refs are alternatives as often as they are separate files: a
// video comes as its local path, its token and a preview image. So images are
// one entry per picture (hash), everything else one entry per kind, and an
// image riding along with a video or file is that file's preview.
const entriesOf = (message) => {
  const refs = message.mediaRefs ?? [];
  const carriesFile = refs.some((ref) => ref.kind === "video" || ref.kind === "file");
  const entries = new Map();
  for (const ref of refs) {
    if (ref.kind === "image" && carriesFile) {
      continue;
    }
    const key = ref.kind === "image" ? `image|${ref.hash ?? ref.fileName ?? ref.url ?? ""}` : ref.kind;
    if (key === "image|") {
      continue;
    }
    const entry = entries.get(key);
    if (entry === undefined) {
      entries.set(key, { kind: ref.kind, refs: [ref] });
    } else {
      entry.refs.push(ref);
    }
  }
  return [...entries.values()];
};

const identityOf = (entry) => {
  const withHash = entry.refs.find((ref) => typeof ref.hash === "string" && ref.hash.length > 0);
  const withName = entry.refs.find((ref) => typeof ref.fileName === "string" && ref.fileName.length > 0);
  return { hash: withHash?.hash?.toLowerCase() ?? null, fileName: withName?.fileName ?? null };
};

const categoryOf = (kind, info) => {
  if (kind !== "image") {
    return KIND_CATEGORY[kind] ?? "files";
  }
  if (info?.params) {
    return "aiImages";
  }
  return info?.asks > 0 ? "askedImages" : "images";
};

const isWanted = (kind, info, categories) => {
  if (kind !== "image") {
    return categories[KIND_CATEGORY[kind] ?? "files"] === true;
  }
  return (info?.params === true && categories.aiImages)
    || ((info?.asks ?? 0) > 0 && categories.askedImages)
    || categories.images;
};

const fileStem = (kind, identity, message) => {
  const stamp = compactStamp(message.hkt);
  if (kind === "file" && identity.fileName !== null) {
    return `${stamp}_${safeSegment(identity.fileName.replace(/\.[^.]+$/u, ""), "文件", 80)}`;
  }
  const speaker = safeSegment(message.speaker, "某人", 24);
  const tail = identity.hash !== null ? identity.hash.slice(0, 8) : safeSegment(identity.fileName ?? kind, kind, 24);
  return `${stamp}_${speaker}_${tail}`;
};

const groupFolder = (message) => `${safeSegment(message.groupName, "群", 40)}_${message.groupId}`;

// Only a verified original (or its md5-checked download) counts as backed up;
// a saved thumbnail or compressed copy is retried on the next run.
const FINAL_STATUSES = new Set(["original", "remote"]);

// knowledge: Map(hash -> { params, asks }). ledger: { items: { key: ... } }.
const planBackup = ({ messages, knowledge = new Map(), categories: input, ledger = { items: {} } }) => {
  const categories = normalizeCategories(input);
  const items = [];
  const seen = new Set();
  let duplicates = 0;
  const ordered = [...messages].sort((left, right) => left.sentAt - right.sentAt);
  for (const message of ordered) {
    for (const entry of entriesOf(message)) {
      const identity = identityOf(entry);
      const info = identity.hash === null ? undefined : knowledge.get(identity.hash);
      if (!isWanted(entry.kind, info, categories)) {
        continue;
      }
      const key = `${message.groupId}|${entry.kind}|${identity.hash ?? identity.fileName ?? message.rowId}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      items.push({
        key,
        groupId: String(message.groupId),
        groupName: message.groupName ?? "",
        rowId: String(message.rowId),
        sentAt: message.sentAt,
        hkt: message.hkt,
        speaker: message.speaker ?? "",
        kind: entry.kind,
        category: categoryOf(entry.kind, info),
        hash: identity.hash,
        fileName: identity.fileName,
        refs: entry.refs,
        relativeDir: `${groupFolder(message)}/${String(message.hkt).slice(0, 7)}`,
        stem: fileStem(entry.kind, identity, message),
        ledgerStatus: ledger.items?.[key]?.status ?? null,
        alreadySaved: FINAL_STATUSES.has(ledger.items?.[key]?.status),
      });
    }
  }
  return { categories, items, duplicates };
};

/* ---------- sidecars, logs, index ---------- */

const paramLine = (params, width, height) => [
  params.steps !== undefined ? `steps ${params.steps}` : null,
  params.cfgScale !== undefined ? `CFG ${params.cfgScale}` : null,
  params.sampler ? `采样器 ${params.sampler}` : null,
  params.scheduler ? `调度 ${params.scheduler}` : null,
  params.seed !== undefined ? `seed ${params.seed}` : null,
  params.denoisingStrength !== undefined ? `重绘幅度 ${params.denoisingStrength}` : null,
  width > 0 ? `${width}×${height}` : null,
].filter(Boolean).join(" · ");

// details: { generator, prompt, negativePrompt, checkpoint, params, width,
// height, loras: [{name, weight}], requests: [{asker, askText, askHkt, answerBy, answerText}] }
const sidecarText = (item, details) => {
  const lines = [`来源：${item.groupName || item.groupId}（${item.groupId}） · ${item.speaker} · ${item.hkt}`];
  if (details.generator && details.generator !== "stripped") {
    lines.push(`生成工具：${details.generator}`);
  }
  if (details.checkpoint) {
    lines.push(`模型：${details.checkpoint}`);
  }
  if ((details.loras ?? []).length > 0) {
    lines.push(`LoRA：${details.loras.map((lora) => (lora.weight === null || lora.weight === undefined ? lora.name : `${lora.name} @${lora.weight}`)).join("，")}`);
  }
  const params = paramLine(details.params ?? {}, details.width ?? 0, details.height ?? 0);
  if (params) {
    lines.push(`参数：${params}`);
  }
  if (details.prompt) {
    lines.push("", "咒语：", details.prompt);
  }
  if (details.negativePrompt) {
    lines.push("", "负面咒语：", details.negativePrompt);
  }
  if ((details.requests ?? []).length > 0) {
    lines.push("", "群里的求图记录：");
    for (const request of details.requests) {
      lines.push(`- ${request.askHkt ?? ""} ${request.asker}：${request.askText}`.trim());
      if (request.answerText) {
        lines.push(`  ${request.answerBy || "有人"} 回复：${request.answerText}`);
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
};

// rows: the store's messages for one group and day, oldest first. links:
// Map(QQ rowId -> [paths relative to the log file]).
const renderDayLog = (rows, links, { groupName, groupId, day }) => {
  const lines = [`${groupName || groupId}（${groupId}）  ${day}`, ""];
  for (const row of rows) {
    const clock = row.hkt.slice(11, 19);
    if (row.isMedia === 1) {
      const qqRowId = String(row.rowId).replace(/^m/u, "");
      const kinds = String(row.mediaKinds ?? "").split(",").filter(Boolean);
      const label = kinds.map((kind) => KIND_LABELS[kind] ?? kind).join("/") || "媒体";
      const saved = links.get(qqRowId) ?? [];
      lines.push(`[${clock}] ${row.speaker}: [${label}]${saved.length > 0 ? ` ${saved.join("  ")}` : ""}`);
    } else {
      lines.push(`[${clock}] ${row.speaker}: ${String(row.text).replace(/\r?\n/gu, "\r\n    ")}`);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
};

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};

const CSV_HEADER = ["群", "群号", "时间", "发送者", "类型", "分类", "文件", "大小(字节)", "来源", "md5"];
const CATEGORY_LABELS = { aiImages: "AI 图", askedImages: "被求过的图", images: "图片", videos: "视频", files: "文件", voice: "语音", stickers: "表情" };
const STATUS_LABELS = { original: "原文件", compressed: "非原图（压缩版）", thumb: "只有缩略图", remote: "QQ 服务器下载" };

// UTF-8 BOM so Excel opens the Chinese columns correctly.
const indexCsv = (ledgerItems) => `﻿${[
  CSV_HEADER,
  ...ledgerItems
    .sort((left, right) => left.sentAt - right.sentAt)
    .map((item) => [item.groupName, item.groupId, item.hkt, item.speaker, KIND_LABELS[item.kind] ?? item.kind,
      CATEGORY_LABELS[item.category] ?? item.category, item.path, item.bytes, STATUS_LABELS[item.status] ?? item.status, item.hash ?? ""]),
].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

/* ---------- the report ---------- */

const emptyCounts = () => ({ total: 0, saved: 0, already: 0, compressed: 0, thumbOnly: 0, missing: 0, bytes: 0 });

// items carry a resolution { status: original|compressed|thumb|remote|missing,
// bytes }; keptPrevious = a lesser copy saved by an earlier run, not re-copied.
const summarizeBackup = (items, { logs = new Map() } = {}) => {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.groupId) ?? groups.set(item.groupId, {
      groupId: item.groupId, groupName: item.groupName, byKind: {}, ai: 0, asked: 0, logDays: 0, missingSamples: [],
    }).get(item.groupId);
    group.groupName = group.groupName || item.groupName;
    const counts = group.byKind[item.kind] ?? (group.byKind[item.kind] = emptyCounts());
    counts.total += 1;
    counts.bytes += item.resolution?.bytes ?? 0;
    const status = item.alreadySaved ? "original" : item.resolution?.status ?? "missing";
    if (item.alreadySaved || item.keptPrevious) {
      counts.already += 1;
    } else if (status === "missing") {
      counts.missing += 1;
    } else {
      counts.saved += 1;
    }
    counts.thumbOnly += status === "thumb" ? 1 : 0;
    counts.compressed += status === "compressed" ? 1 : 0;
    if (["missing", "thumb", "compressed"].includes(status) && group.missingSamples.length < MISSING_SAMPLES) {
      group.missingSamples.push({ hkt: item.hkt, speaker: item.speaker, kind: item.kind, status });
    }
    group.ai += item.category === "aiImages" ? 1 : 0;
    group.asked += item.category === "askedImages" ? 1 : 0;
  }
  for (const [groupId, days] of logs) {
    const group = groups.get(groupId);
    if (group !== undefined) {
      group.logDays = days;
    }
  }
  const list = [...groups.values()].map((group) => {
    const gaps = Object.values(group.byKind).reduce((total, counts) => total + counts.missing + counts.thumbOnly + counts.compressed, 0);
    return { ...group, gaps, verdict: gaps === 0 ? "safe" : "check" };
  }).sort((left, right) => right.gaps - left.gaps || left.groupName.localeCompare(right.groupName));
  return {
    groups: list,
    safe: list.every((group) => group.verdict === "safe"),
    totals: list.reduce((totals, group) => {
      for (const counts of Object.values(group.byKind)) {
        for (const key of Object.keys(totals)) {
          totals[key] += counts[key];
        }
      }
      return totals;
    }, emptyCounts()),
  };
};

module.exports = {
  CATEGORY_KEYS,
  DEFAULT_CATEGORIES,
  safeSegment,
  normalizeCategories,
  entriesOf,
  planBackup,
  sidecarText,
  renderDayLog,
  indexCsv,
  summarizeBackup,
};
