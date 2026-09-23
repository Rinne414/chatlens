"use strict";

const HKT_OFFSET_SECONDS = 8 * 3600;
const MAX_PASTE_CHARS = 16_000;

const parseClock = (year, month, day, hour, minute, second) => {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second ?? 0);
  if (![y, mo, d, h, mi, s].every(Number.isFinite)) {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000) - HKT_OFFSET_SECONDS;
};

const MEDIA_PLACEHOLDER = /^\[(?:图片|圖片|动画表情|動畫表情|表情|语音|語音|视频|視頻|文件|檔案|QQ红包|QQ紅包|image|photo|video|file|voice)\]$/iu;

const isMediaPlaceholder = (text) => MEDIA_PLACEHOLDER.test(String(text ?? "").trim());

const normalizeText = (raw) =>
  String(raw ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const normalizeSpeaker = (raw) =>
  String(raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const TIME_TOKEN = String.raw`(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?|\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}(?::\d{2})?)`;

const parseTimeToken = (token) => {
  const text = String(token ?? "").trim();
  const cn = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (cn) {
    return parseClock(cn[1], cn[2], cn[3], cn[4], cn[5], cn[6]);
  }
  const west = text.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (west) {
    return parseClock(west[1], west[2], west[3], west[4], west[5], west[6]);
  }
  return null;
};

const HEADER_LINE = new RegExp(String.raw`^(?:【([^】]{1,40})】\s*)?(.*\S)\s+${TIME_TOKEN}\s*$`, "u");
const BRACKET_HEADER = new RegExp(String.raw`^\[${TIME_TOKEN}\]\s*(.+?)\s*$`, "u");
const TIME_ONLY = new RegExp(String.raw`^${TIME_TOKEN}$`, "u");

const messageFrom = ({ speaker, unix, groupHint, lines }) => {
  const text = normalizeText(lines.join("\n"));
  const firstLine = text.split("\n")[0] ?? "";
  return {
    speaker: normalizeSpeaker(speaker),
    text,
    unix: Number.isFinite(unix) ? unix : null,
    groupHint: String(groupHint ?? "").trim(),
    isMediaPlaceholder: text.length === 0 || isMediaPlaceholder(firstLine),
  };
};

const splitLines = (raw) =>
  String(raw ?? "")
    .slice(0, MAX_PASTE_CHARS)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd());

const parseHeaderLines = (lines) => {
  const messages = [];
  let current = null;
  const flush = () => {
    if (current !== null) {
      messages.push(messageFrom(current));
      current = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const bracket = trimmed.match(BRACKET_HEADER);
    if (bracket) {
      const unix = parseTimeToken(bracket[1]);
      if (unix !== null) {
        flush();
        current = { speaker: bracket[2], unix, groupHint: "", lines: [] };
        continue;
      }
    }

    const header = trimmed.match(HEADER_LINE);
    if (header) {
      const unix = parseTimeToken(header[3]);
      if (unix !== null) {
        flush();
        current = { speaker: header[2], unix, groupHint: header[1] ?? "", lines: [] };
        continue;
      }
    }

    if (current !== null) {
      current.lines.push(line);
    }
  }
  flush();
  return { messages, format: messages.length > 0 ? "qqnt-header" : "empty" };
};

const parseStackedBlocks = (lines) => {
  const blocks = [];
  let block = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (block.length > 0) {
        blocks.push(block);
        block = [];
      }
      continue;
    }
    block.push(line.trim());
  }
  if (block.length > 0) {
    blocks.push(block);
  }

  const messages = [];
  for (const parts of blocks) {
    if (parts.length < 2) {
      continue;
    }
    const groupOnName = parts[0].match(/^【([^】]{1,40})】\s*(.+)$/u);
    const nameLine = groupOnName ? groupOnName[2] : parts[0];
    const groupHint = groupOnName ? groupOnName[1] : "";
    if (TIME_ONLY.test(parts[1]) && parseTimeToken(parts[1]) !== null) {
      messages.push(messageFrom({
        speaker: nameLine,
        unix: parseTimeToken(parts[1]),
        groupHint,
        lines: parts.slice(2),
      }));
      continue;
    }
    if (TIME_ONLY.test(parts[0]) && parseTimeToken(parts[0]) !== null) {
      messages.push(messageFrom({
        speaker: parts[1],
        unix: parseTimeToken(parts[0]),
        groupHint: "",
        lines: parts.slice(2),
      }));
    }
  }
  return { messages, format: messages.length > 0 ? "stacked" : "empty" };
};

const parseColonLines = (lines) => {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = trimmed.match(/^(.{1,32}?)[：:]\s*(.+)$/u);
    if (match === null) {
      continue;
    }
    const speaker = normalizeSpeaker(match[1]);
    if (speaker.length === 0 || /^https?:/iu.test(speaker) || TIME_ONLY.test(speaker)) {
      continue;
    }
    const text = normalizeText(match[2]);
    if (text.length === 0) {
      continue;
    }
    messages.push(messageFrom({ speaker, unix: null, groupHint: "", lines: [text] }));
  }
  return { messages, format: messages.length > 0 ? "colon" : "empty" };
};

const parseQqPaste = (raw) => {
  const lines = splitLines(raw);
  const headered = parseHeaderLines(lines);
  if (headered.messages.length > 0) {
    return headered;
  }
  const stacked = parseStackedBlocks(lines);
  if (stacked.messages.length > 0) {
    return stacked;
  }
  return parseColonLines(lines);
};

module.exports = {
  HKT_OFFSET_SECONDS,
  MAX_PASTE_CHARS,
  parseQqPaste,
  parseTimeToken,
  normalizeText,
  normalizeSpeaker,
  isMediaPlaceholder,
};
