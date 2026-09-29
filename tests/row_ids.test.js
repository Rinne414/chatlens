"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRowIds } = require("../src/row_ids");

test("19-digit QQ ids of one second compare by their real value", () => {
  assert.equal(Number("7552461346541412001"), Number("7552461346541412003"));
  assert.equal(compareRowIds("7552461346541412001", "7552461346541412003"), -1);
  assert.equal(compareRowIds("7552461346541412003", "7552461346541412001"), 1);
  assert.equal(compareRowIds("7552461346541412002", "7552461346541412002"), 0);
});

test("a media row's m prefix and a digit rollover sort numerically", () => {
  assert.deepEqual(["10000000", "m9999999", "9999998"].sort(compareRowIds), ["9999998", "m9999999", "10000000"]);
});

test("an id that is not a number orders stably instead of throwing", () => {
  assert.equal(compareRowIds(undefined, "7552461346541412001"), -1);
  assert.equal(compareRowIds("abc", "abd"), -1);
  assert.equal(compareRowIds("x", "x"), 0);
});
