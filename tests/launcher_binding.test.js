"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { needsNativeRebuild } = require("../src/launcher");

test("a native module built for another Node is rebuilt instead of asking for npm", () => {
  const nodeError = [
    "The module 'better_sqlite3.node'",
    "was compiled against a different Node.js version using",
    "NODE_MODULE_VERSION 141. This version of Node.js requires",
    "NODE_MODULE_VERSION 137. Please try re-compiling or re-installing",
    "the module (for instance, using `npm rebuild` or `npm install`).",
  ].join("\n");
  assert.equal(needsNativeRebuild(nodeError), true);
  assert.equal(needsNativeRebuild("Could not locate the bindings file. Tried:\n → build/Release/better_sqlite3.node"), true);
});

test("other database failures are not treated as a Node mismatch", () => {
  assert.equal(needsNativeRebuild("SQLITE_CORRUPT: database disk image is malformed"), false);
  assert.equal(needsNativeRebuild(""), false);
});
