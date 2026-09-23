"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseAutostart, withAutostart } = require("../src/autostart");

test("parses ?run=unviewed and ignores anything else", () => {
  assert.equal(parseAutostart("?run=unviewed"), "unviewed");
  assert.equal(parseAutostart("run=unviewed"), "unviewed");
  assert.equal(parseAutostart("?run=UNVIEWED"), "unviewed");
  assert.equal(parseAutostart("?run=hours"), null);
  assert.equal(parseAutostart(""), null);
  assert.equal(parseAutostart("?foo=1"), null);
});

test("appends the autostart query without breaking an existing path", () => {
  assert.equal(withAutostart("http://127.0.0.1:8321/", "unviewed"), "http://127.0.0.1:8321/?run=unviewed");
  assert.equal(withAutostart("http://127.0.0.1:8321", "unviewed"), "http://127.0.0.1:8321/?run=unviewed");
  assert.equal(withAutostart("http://127.0.0.1:8321/", null), "http://127.0.0.1:8321/");
});
