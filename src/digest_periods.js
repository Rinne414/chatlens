"use strict";

// Beijing-time periods for the digests: a day ("YYYY-MM-DD"), a week (named by
// its Monday, "YYYY-MM-DD"), a month ("YYYY-MM"). Pure functions.

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const DAY_SECONDS = 86400;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_PATTERN = /^\d{4}-\d{2}$/u;

// Beijing wall clock of a unix time, as a UTC Date (read with getUTC*).
const wall = (unix) => new Date((unix + BEIJING_OFFSET_SECONDS) * 1000);
const dayOf = (unix) => wall(unix).toISOString().slice(0, 10);
const startOfDay = (unix) => unix - ((unix + BEIJING_OFFSET_SECONDS) % DAY_SECONDS);
const unixOfDay = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000 - BEIJING_OFFSET_SECONDS;

const mondayOf = (unix) => {
  const start = startOfDay(unix);
  const weekday = (wall(start).getUTCDay() + 6) % 7;
  return start - weekday * DAY_SECONDS;
};

const periodOf = (kind, unix) => {
  if (kind === "day") {
    return dayOf(unix);
  }
  if (kind === "week") {
    return dayOf(mondayOf(unix));
  }
  return dayOf(unix).slice(0, 7);
};

const isValidPeriod = (kind, period) => {
  const text = String(period ?? "");
  if (kind === "month") {
    return MONTH_PATTERN.test(text) && Number(text.slice(5, 7)) >= 1 && Number(text.slice(5, 7)) <= 12;
  }
  if (!DAY_PATTERN.test(text) || dayOf(unixOfDay(text)) !== text) {
    return false;
  }
  return kind === "day" || (kind === "week" && periodOf("week", unixOfDay(text)) === text);
};

// { startUnix, endUnix } (end exclusive) of a valid period.
const periodBounds = (kind, period) => {
  if (!isValidPeriod(kind, period)) {
    throw new Error(`无效的时间段：${kind} ${period}`);
  }
  if (kind === "day") {
    const startUnix = unixOfDay(period);
    return { startUnix, endUnix: startUnix + DAY_SECONDS };
  }
  if (kind === "week") {
    const startUnix = unixOfDay(period);
    return { startUnix, endUnix: startUnix + 7 * DAY_SECONDS };
  }
  const [year, month] = period.split("-").map(Number);
  const startUnix = Date.UTC(year, month - 1, 1) / 1000 - BEIJING_OFFSET_SECONDS;
  return { startUnix, endUnix: Date.UTC(year, month, 1) / 1000 - BEIJING_OFFSET_SECONDS };
};

// The period just before the one containing `unix`.
const previousPeriod = (kind, unix) => periodOf(kind, periodBounds(kind, periodOf(kind, unix)).startUnix - 1);

// Every day ("YYYY-MM-DD") inside a period, in order.
const daysIn = (kind, period) => {
  const { startUnix, endUnix } = periodBounds(kind, period);
  const days = [];
  for (let unix = startUnix; unix < endUnix; unix += DAY_SECONDS) {
    days.push(dayOf(unix));
  }
  return days;
};

module.exports = { DAY_SECONDS, dayOf, periodOf, isValidPeriod, periodBounds, previousPeriod, daysIn };
