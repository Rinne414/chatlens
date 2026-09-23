"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveUnviewedRange,
  formatHkt,
  resolveSummaryRange,
} = require("../src/unviewed_range");

const NOW = 1_700_000_000;

test("uses the earliest read mark across groups, minus a 30-minute overlap", () => {
  const result = resolveUnviewedRange({
    nowUnix: NOW,
    fallbackHours: 24,
    groups: [
      { groupId: "1", readMarkSentAt: NOW - 3600 },
      { groupId: "2", readMarkSentAt: NOW - 3 * 3600 },
    ],
  });

  assert.equal(result.startUnix, NOW - 3 * 3600 - 1800);
  assert.equal(result.endUnix, NOW);
  assert.equal(result.markedGroupCount, 2);
  assert.deepEqual(result.unmarkedGroupIds, []);
  assert.equal(result.usedFallback, false);
  assert.equal(result.groupStarts["1"], NOW - 3600 - 1800);
  assert.equal(result.groupStarts["2"], NOW - 3 * 3600 - 1800);
});

test("falls back to recent hours for groups that have never been opened in the tool", () => {
  const result = resolveUnviewedRange({
    nowUnix: NOW,
    fallbackHours: 6,
    groups: [
      { groupId: "1", readMarkSentAt: NOW - 3600 },
      { groupId: "2", readMarkSentAt: null },
    ],
  });

  assert.equal(result.startUnix, NOW - 6 * 3600);
  assert.equal(result.usedFallback, true);
  assert.deepEqual(result.unmarkedGroupIds, ["2"]);
  assert.equal(result.markedGroupCount, 1);
});

test("with no groups, uses the fallback window rather than throwing", () => {
  const result = resolveUnviewedRange({ nowUnix: NOW, fallbackHours: 24, groups: [] });
  assert.equal(result.startUnix, NOW - 24 * 3600);
  assert.equal(result.usedFallback, true);
});

test("refuses a start time in the future", () => {
  const result = resolveUnviewedRange({
    nowUnix: NOW,
    fallbackHours: 24,
    groups: [{ groupId: "1", readMarkSentAt: NOW + 9999 }],
  });
  assert.equal(result.startUnix, NOW);
});

test("formats unix seconds as Beijing time without a timezone suffix", () => {
  // 1700000000 = 2023-11-14 22:13:20 UTC = 2023-11-15 06:13:20 UTC+8
  assert.equal(formatHkt(1700000000), "2023-11-15 06:13:20");
});

test("resolveSummaryRange turns sinceRead into a custom StartTime the job runner already understands", () => {
  const resolved = resolveSummaryRange(
    { type: "sinceRead" },
    {
      nowUnix: NOW,
      fallbackHours: 24,
      groups: [{ groupId: "1", readMarkSentAt: NOW - 7200 }],
    },
  );

  assert.equal(resolved.range.type, "custom");
  assert.equal(resolved.range.start, formatHkt(NOW - 7200 - 1800));
  assert.equal(resolved.range.end, "");
  assert.match(resolved.label, /未查看/u);
});

test("resolveSummaryRange leaves hours/days/custom ranges untouched", () => {
  const hours = resolveSummaryRange({ type: "hours", hours: 6 }, { nowUnix: NOW, groups: [] });
  assert.deepEqual(hours.range, { type: "hours", hours: 6 });
  assert.equal(hours.label, null);
});
