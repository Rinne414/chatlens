"use strict";

// After a refresh that made progress on a detailed-level job, the next one
// follows shortly instead of after the full interval.

const assert = require("node:assert/strict");
const test = require("node:test");
const { followUpDelay } = require("../src/server/background");

const resultWith = (briefing) => ({ briefing });

test("a refresh that moved the detailed job on is followed soon while work is left", () => {
  assert.equal(followUpDelay(resultWith({ map: { jobDone: 12, routeDown: null }, jobQueued: 400 })), 2 * 60 * 1000);
});

test("otherwise the configured interval applies", () => {
  // Nothing left, no progress (standard level / Grok down), the account refused, or no briefing at all.
  assert.equal(followUpDelay(resultWith({ map: { jobDone: 12, routeDown: null }, jobQueued: 0 })), undefined);
  assert.equal(followUpDelay(resultWith({ map: { jobDone: 0, jobDeferred: 40, routeDown: null }, jobQueued: 400 })), undefined);
  assert.equal(followUpDelay(resultWith({ map: { jobDone: 3, routeDown: { status: 402 } }, jobQueued: 400 })), undefined);
  assert.equal(followUpDelay(resultWith({ skipped: "disabled" })), undefined);
  assert.equal(followUpDelay(null), undefined);
});
