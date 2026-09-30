"use strict";

// QQ 收藏图: the pure part (no DOM), tested directly in Node and loaded in
// the browser as window.QqcDays. Collection days in Beijing time, per-day
// saved / unsaved counts, and the stretches of days whose pictures are not
// saved yet (what the page is for: "somewhere in the middle, and the newest
// ones, I have not saved").

const QQC_DAY_MS = 86400000;
const QQC_BEIJING_OFFSET_MS = 8 * 3600000;

const qqcDay = (ms) => new Date(ms + QQC_BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const qqcNextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + QQC_DAY_MS).toISOString().slice(0, 10);

// Every day from `from` to `to`, both included (YYYY-MM-DD).
const qqcDaysBetween = (from, to) => {
  const days = [];
  for (let day = from; day <= to; day = qqcNextDay(day)) {
    days.push(day);
  }
  return days;
};

// [{ day, total, saved }] for days that have pictures, oldest first.
const qqcDayStats = (pictures, isSaved) => {
  const byDay = new Map();
  for (const picture of pictures) {
    const day = qqcDay(picture.collectedAt);
    const stat = byDay.get(day) ?? { day, total: 0, saved: 0 };
    stat.total += 1;
    stat.saved += isSaved(picture) ? 1 : 0;
    byDay.set(day, stat);
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
};

// Stretches of collection days with unsaved pictures, newest first. A
// stretch ends at a day whose pictures are all saved; days without pictures
// in between do not end it.
const qqcUnsavedRuns = (stats) => {
  const runs = [];
  let current = null;
  for (const stat of stats) {
    if (stat.saved === stat.total) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { fromDay: stat.day, toDay: stat.day, unsaved: 0, total: 0 };
      runs.push(current);
    }
    current.toDay = stat.day;
    current.unsaved += stat.total - stat.saved;
    current.total += stat.total;
  }
  return runs.reverse();
};

// The items from one position to another in a shown list (either order).
const qqcRangeBetween = (items, fromKey, toKey, keyOf) => {
  const from = items.findIndex((item) => keyOf(item) === fromKey);
  const to = items.findIndex((item) => keyOf(item) === toKey);
  if (from === -1 || to === -1) {
    return [];
  }
  return items.slice(Math.min(from, to), Math.max(from, to) + 1);
};

const qqcDays = { qqcDay, qqcDaysBetween, qqcDayStats, qqcUnsavedRuns, qqcRangeBetween };

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = qqcDays;
}
if (typeof window !== "undefined") {
  window.QqcDays = qqcDays;
}
