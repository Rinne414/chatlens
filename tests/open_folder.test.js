"use strict";

// "Open folder" buttons must show the folder. On Windows, starting Explorer
// with windowsHide makes the folder window itself hidden: it opens, and the
// user sees nothing (every such button did this up to v0.0.29).

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const test = require("node:test");

test("opening a folder does not ask for a hidden window", () => {
  const calls = [];
  const realSpawn = childProcess.spawn;
  const platformPath = require.resolve("../src/platform");
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  delete require.cache[platformPath];
  try {
    require("../src/platform").openPath(__dirname);
  } finally {
    childProcess.spawn = realSpawn;
    delete require.cache[platformPath];
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [__dirname]);
  assert.notEqual(calls[0].options.windowsHide, true);
});
