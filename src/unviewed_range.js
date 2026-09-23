"use strict";

// "Unviewed" means this tool's read_marks, not QQ's unread badge. A group the
// user has only ever read inside QQ has no mark here, so we fall back to the
// configured recent-hours window rather than pretending we know QQ's cursor.

const DEFAULT_OVERLAP_SECONDS = 30 * 60;
const HKT_OFFSET_SECONDS = 8 * 3600;

const formatHkt = (unixSeconds) => {
  const date = new Date((Number(unixSeconds) + HKT_OFFSET_SECONDS) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const resolveUnviewedRange = ({
  nowUnix,
  fallbackHours = 24,
  overlapSeconds = DEFAULT_OVERLAP_SECONDS,
  groups = [],
} = {}) => {
  if (!Number.isFinite(nowUnix)) {
    throw new TypeError("nowUnix must be a unix timestamp");
  }
  const hours = Number(fallbackHours);
  if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 90) {
    throw new RangeError(`Invalid fallbackHours: ${fallbackHours}`);
  }
  const fallbackStart = nowUnix - hours * 3600;
  if (!Array.isArray(groups) || groups.length === 0) {
    return {
      startUnix: fallbackStart,
      endUnix: nowUnix,
      usedFallback: true,
      unmarkedGroupIds: [],
      markedGroupCount: 0,
      groupStarts: {},
    };
  }

  const starts = groups.map((group) => {
    const mark = Number(group.readMarkSentAt);
    if (Number.isFinite(mark) && mark > 0) {
      return { groupId: String(group.groupId), start: mark - overlapSeconds, marked: true };
    }
    return { groupId: String(group.groupId), start: fallbackStart, marked: false };
  });

  const startUnix = Math.min(nowUnix, Math.max(0, Math.min(...starts.map((entry) => entry.start))));
  const unmarkedGroupIds = starts.filter((entry) => !entry.marked).map((entry) => entry.groupId);
  const groupStarts = {};
  for (const entry of starts) {
    groupStarts[entry.groupId] = Math.min(nowUnix, Math.max(0, entry.start));
  }
  return {
    startUnix,
    endUnix: nowUnix,
    usedFallback: unmarkedGroupIds.length > 0,
    unmarkedGroupIds,
    markedGroupCount: starts.length - unmarkedGroupIds.length,
    groupStarts,
  };
};

const resolveSummaryRange = (range, context) => {
  if (range?.type !== "sinceRead") {
    return { range, label: null, resolved: null };
  }
  const resolved = resolveUnviewedRange(context);
  const start = formatHkt(resolved.startUnix);
  const label = resolved.markedGroupCount === 0
    ? `总结未查看（尚无本工具已读记录，改用最近 ${context.fallbackHours ?? 24} 小时）`
    : `总结未查看（从 ${start.slice(0, 16)} 起）`;
  return {
    range: { type: "custom", start, end: "" },
    label,
    resolved,
  };
};

module.exports = {
  DEFAULT_OVERLAP_SECONDS,
  formatHkt,
  resolveUnviewedRange,
  resolveSummaryRange,
};
