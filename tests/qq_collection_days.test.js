"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { qqcDay, qqcDaysBetween, qqcDayStats, qqcUnsavedRuns, qqcRangeBetween } = require("../web/qq_collection_days");

const at = (day, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`);

test("days are Beijing days", () => {
  assert.equal(qqcDay(Date.parse("2026-09-15T23:30:00+08:00")), "2026-09-15");
  assert.equal(qqcDay(Date.parse("2026-09-15T16:30:00Z")), "2026-09-16");
  assert.deepEqual(qqcDaysBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("per-day counts of all and saved pictures, oldest first", () => {
  const pictures = [
    { md5: "a", collectedAt: at("2026-09-02") },
    { md5: "b", collectedAt: at("2026-09-01") },
    { md5: "c", collectedAt: at("2026-09-02", 20) },
  ];
  assert.deepEqual(qqcDayStats(pictures, (picture) => picture.md5 === "a"), [
    { day: "2026-09-01", total: 1, saved: 0 },
    { day: "2026-09-02", total: 2, saved: 1 },
  ]);
});

test("unsaved stretches: a fully saved day ends one, empty days do not; newest first", () => {
  const stats = [
    { day: "2026-08-01", total: 3, saved: 3 },
    { day: "2026-08-02", total: 4, saved: 1 },
    { day: "2026-08-05", total: 2, saved: 0 },
    { day: "2026-08-06", total: 5, saved: 5 },
    { day: "2026-09-10", total: 6, saved: 0 },
  ];
  assert.deepEqual(qqcUnsavedRuns(stats), [
    { fromDay: "2026-09-10", toDay: "2026-09-10", unsaved: 6, total: 6 },
    { fromDay: "2026-08-02", toDay: "2026-08-05", unsaved: 5, total: 6 },
  ]);
  assert.deepEqual(qqcUnsavedRuns([{ day: "2026-08-01", total: 1, saved: 1 }]), []);
});

test("a shift-click range covers the items between two clicks in either order", () => {
  const items = ["a", "b", "c", "d"].map((md5) => ({ md5 }));
  const keys = (list) => list.map((item) => item.md5);
  assert.deepEqual(keys(qqcRangeBetween(items, "b", "d", (item) => item.md5)), ["b", "c", "d"]);
  assert.deepEqual(keys(qqcRangeBetween(items, "d", "b", (item) => item.md5)), ["b", "c", "d"]);
  assert.deepEqual(qqcRangeBetween(items, "x", "b", (item) => item.md5), []);
});
