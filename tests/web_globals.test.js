"use strict";

// The web/ scripts share one global scope: a top-level name declared in two
// of them stops the second script from loading at all (the browser throws
// "Identifier has already been declared"), which the page sandbox would
// otherwise swallow. Every page script must load cleanly in order.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

test("no two page scripts declare the same top-level name", () => {
  const context = vm.createContext(makeSandbox());
  const clashes = [];
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch (error) {
      if (/has already been declared/u.test(String(error.message))) {
        clashes.push(`${script}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(clashes, []);
});
