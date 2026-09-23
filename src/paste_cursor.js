"use strict";

const { parseQqPaste, normalizeText, normalizeSpeaker, MAX_PASTE_CHARS } = require("./qq_paste");

const LIKE_STRIP = /[%_]/gu;
const MIN_ACCEPT_SCORE = 10;

const escapeLike = (value) => String(value).replaceAll(LIKE_STRIP, "");

const needleFor = (parsed) => {
  if (parsed.isMediaPlaceholder) {
    return "";
  }
  const text = normalizeText(parsed.text).slice(0, 32);
  return text.length >= 2 ? escapeLike(text) : "";
};

const speakerScore = (stored, pasted) => {
  const left = normalizeSpeaker(stored).toLowerCase();
  const right = normalizeSpeaker(pasted).toLowerCase();
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  if (left === right) {
    return 8;
  }
  if (left.includes(right) || right.includes(left)) {
    return 5;
  }
  return 0;
};

const textScore = (stored, pasted, isMediaPlaceholder) => {
  if (isMediaPlaceholder) {
    return 0;
  }
  const left = normalizeText(stored);
  const right = normalizeText(pasted);
  if (right.length === 0) {
    return 0;
  }
  if (left === right) {
    return 10;
  }
  if (left.startsWith(right) || right.startsWith(left)) {
    return 7;
  }
  if (left.includes(right) || right.includes(left)) {
    return 4;
  }
  return 0;
};

const timeScore = (storedUnix, pasteUnix) => {
  if (!Number.isFinite(pasteUnix) || !Number.isFinite(storedUnix)) {
    return 0;
  }
  const delta = Math.abs(storedUnix - pasteUnix);
  if (delta <= 2) {
    return 8;
  }
  if (delta <= 120) {
    return 6;
  }
  if (delta <= 600) {
    return 3;
  }
  if (delta <= 3600) {
    return 1;
  }
  return 0;
};

const groupHintScore = (groupName, hint) => {
  const name = normalizeSpeaker(groupName);
  const want = normalizeSpeaker(hint);
  if (name.length === 0 || want.length === 0) {
    return 0;
  }
  if (name === want || name.includes(want) || want.includes(name)) {
    return 3;
  }
  return 0;
};

const findRows = (db, { groupIds, textNeedle, aroundUnix, windowSeconds }) => {
  const conditions = [];
  const params = {};
  const ids = [...new Set((groupIds ?? []).map(String).filter((id) => /^\d+$/u.test(id)))].slice(0, 50);
  if (ids.length > 0) {
    const placeholders = ids.map((_, index) => `@g${index}`).join(", ");
    conditions.push(`m.group_id IN (${placeholders})`);
    for (const [index, id] of ids.entries()) {
      params[`g${index}`] = id;
    }
  }
  if (typeof textNeedle === "string" && textNeedle.length >= 2) {
    conditions.push("m.text LIKE @needle");
    params.needle = `%${textNeedle}%`;
  }
  if (Number.isFinite(aroundUnix) && Number.isFinite(windowSeconds)) {
    conditions.push("m.sent_at BETWEEN @lo AND @hi");
    params.lo = aroundUnix - windowSeconds;
    params.hi = aroundUnix + windowSeconds;
  }
  if (conditions.length === 0) {
    return [];
  }
  return db.prepare(`
    SELECT m.group_id AS groupId,
           m.row_id AS rowId,
           m.sent_at AS sentAt,
           m.speaker,
           m.text,
           m.is_media AS isMedia,
           COALESCE(n.name, '') AS groupName
    FROM messages m
    LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.sent_at DESC
    LIMIT 80
  `).all(params);
};

const scoreRow = (row, parsed, preferredSet) => {
  let score = speakerScore(row.speaker, parsed.speaker)
    + textScore(row.text, parsed.text, parsed.isMediaPlaceholder)
    + timeScore(row.sentAt, parsed.unix)
    + groupHintScore(row.groupName, parsed.groupHint);
  if (parsed.isMediaPlaceholder && row.isMedia === 1) {
    score += 3;
  }
  if (preferredSet.has(String(row.groupId))) {
    score += 2;
  }
  return { ...row, score };
};

const pickBest = (scored) => {
  const ranked = scored.filter((row) => row.score >= MIN_ACCEPT_SCORE).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.sentAt - left.sentAt;
  });
  if (ranked.length === 0) {
    return { ok: false, reason: "not-found", candidates: [] };
  }
  const top = ranked[0];
  const rivals = ranked.filter((row) =>
    row.groupId !== top.groupId && top.score - row.score <= 2);
  if (rivals.length > 0) {
    return { ok: false, reason: "ambiguous", candidates: [top, ...rivals].slice(0, 6) };
  }
  return { ok: true, row: top, candidates: ranked.slice(0, 6) };
};

const matchParsedMessage = (db, parsed, preferredGroupIds) => {
  if (parsed.isMediaPlaceholder && !Number.isFinite(parsed.unix)) {
    return {
      ok: false,
      reason: "no-time-for-media",
      error: "贴上的是图片/语音占位，但没有时间。请连 QQ 时间一起复制，或改贴一条文字消息。",
      candidates: [],
    };
  }

  const preferred = [...new Set((preferredGroupIds ?? []).map(String).filter((id) => /^\d+$/u.test(id)))];
  const preferredSet = new Set(preferred);
  const textNeedle = needleFor(parsed);
  const windows = Number.isFinite(parsed.unix) ? [120, 1800, 86_400, null] : [null];
  const groupPasses = preferred.length > 0 ? [preferred, []] : [[]];

  let last = { ok: false, reason: "not-found", candidates: [] };
  for (const groupIds of groupPasses) {
    for (const windowSeconds of windows) {
      const rows = findRows(db, {
        groupIds,
        textNeedle,
        aroundUnix: parsed.unix,
        windowSeconds,
      });
      const scored = rows.map((row) => scoreRow(row, parsed, preferredSet));
      last = pickBest(scored);
      if (last.ok === true || last.reason === "ambiguous") {
        return last.ok === true
          ? last
          : {
              ok: false,
              reason: "ambiguous",
              error: "有不止一个群对得上这段话。请先选群，或再贴前后一两句。",
              candidates: last.candidates,
            };
      }
    }
  }

  return {
    ok: false,
    reason: "not-found",
    error: "本地库没有这则。可能还没扫过那段时间——先用「最近 24 小时」跑一次再贴。图片请连时间一起复制。",
    candidates: last.candidates ?? [],
  };
};

const previewOf = (row) => ({
  groupId: String(row.groupId),
  name: row.groupName ?? "",
  speaker: row.speaker,
  sentAt: row.sentAt,
  text: String(row.text ?? "").slice(0, 80),
  rowId: row.rowId,
  isMedia: row.isMedia === 1,
});

const resolvePasteCursor = ({
  db,
  startPaste,
  endPaste = "",
  preferredGroupIds = [],
  formatHkt,
} = {}) => {
  if (typeof formatHkt !== "function") {
    throw new TypeError("formatHkt is required");
  }
  const startParsed = parseQqPaste(String(startPaste ?? "").slice(0, MAX_PASTE_CHARS));
  if (startParsed.messages.length === 0) {
    return {
      ok: false,
      reason: "empty",
      error: "没有解析出 QQ 消息。请从 QQ 复制带昵称和时间的记录再贴（不要只贴正文）。",
      candidates: [],
    };
  }

  const startTarget = startParsed.messages[0];
  const startHit = matchParsedMessage(db, startTarget, preferredGroupIds);
  if (startHit.ok !== true) {
    return startHit;
  }

  const startRow = startHit.row;
  const endText = String(endPaste ?? "").trim();
  let endRow = null;
  let endUnix = null;
  let endHkt = "";
  if (endText.length > 0) {
    const endParsed = parseQqPaste(endText.slice(0, MAX_PASTE_CHARS));
    if (endParsed.messages.length === 0) {
      return {
        ok: false,
        reason: "empty-end",
        error: "终点没有解析出 QQ 消息。留空表示总结到现在，或再贴一条带时间的记录。",
        candidates: [],
      };
    }
    const endHit = matchParsedMessage(db, endParsed.messages.at(-1), preferredGroupIds);
    if (endHit.ok !== true) {
      return endHit;
    }
    endRow = endHit.row;
    if (String(endRow.groupId) !== String(startRow.groupId)) {
      return {
        ok: false,
        reason: "different-groups",
        error: "起点和终点对上了不同的群。一次只总结一个对话。",
        candidates: [startRow, endRow].map(previewOf),
      };
    }
    if (endRow.sentAt < startRow.sentAt) {
      return {
        ok: false,
        reason: "end-before-start",
        error: "终点比起点还早。请对调两段粘贴，或只贴起点总结到现在。",
        candidates: [],
      };
    }
    endUnix = endRow.sentAt + 1;
    endHkt = formatHkt(endUnix);
  }

  const groupIds = [String(startRow.groupId)];
  const groupName = startRow.groupName || groupIds[0];
  const startHkt = formatHkt(startRow.sentAt);
  const until = endHkt === "" ? "现在" : endHkt.slice(0, 16);
  return {
    ok: true,
    startUnix: startRow.sentAt,
    endUnix,
    startHkt,
    endHkt,
    groupIds,
    groups: [previewOf(startRow)],
    startMessage: previewOf(startRow),
    endMessage: endRow === null ? null : previewOf(endRow),
    parsedStartCount: startParsed.messages.length,
    parsedEndCount: endText.length === 0 ? 0 : parseQqPaste(endText).messages.length,
    label: `从 QQ 粘贴：${groupName} · ${startHkt.slice(0, 16)} 起至${until}`,
  };
};

module.exports = {
  resolvePasteCursor,
  matchParsedMessage,
};
