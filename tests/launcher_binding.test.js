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

test("a source install updated in place knows which new packages it still lacks", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { missingPackages } = require("../src/launcher");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatlens-deps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3-multiple-ciphers": "^12", "opencc-js": "^1.4.2" } }));
  fs.mkdirSync(path.join(root, "node_modules", "better-sqlite3-multiple-ciphers"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "better-sqlite3-multiple-ciphers", "package.json"), "{}");

  assert.deepEqual(missingPackages(root), ["opencc-js"]);
});

test("the npm that installs them is this Node's own", () => {
  const { npmCliFor } = require("../src/launcher");
  const found = npmCliFor(process.execPath);
  // Every official Node install has one; a missing npm is reported, not guessed.
  assert.ok(found === null || /npm-cli\.js$/u.test(found));
  assert.equal(npmCliFor("/no/such/node"), null);
});
