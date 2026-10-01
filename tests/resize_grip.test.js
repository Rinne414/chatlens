"use strict";

// Scrolling lists (the rail's followed groups and the like) get a grip below
// them: drag to make the list taller or shorter, double-click for the default.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { WEB, pageScripts, makeSandbox } = require("./web_sandbox");

const loadPage = () => {
  const context = vm.createContext(makeSandbox());
  for (const script of pageScripts()) {
    try {
      vm.runInContext(fs.readFileSync(path.join(WEB, script), "utf8"), context, { filename: script });
    } catch {
      // Render paths may throw in the fake DOM; the helpers under test are pure.
    }
  }
  return (expression) => vm.runInContext(expression, context);
};

test("dragging down by 100 screen pixels makes the list 100 pixels taller", () => {
  const run = loadPage();

  assert.equal(run("resizedHeight({ startHeight: 132, dragged: 100, scale: 1, max: 900 })"), 232);
});

test("with the page zoomed, the list follows the pointer on screen", () => {
  const run = loadPage();

  // At 125 %, 100 screen pixels are 80 CSS pixels.
  assert.equal(run("resizedHeight({ startHeight: 132, dragged: 100, scale: 1.25, max: 900 })"), 212);
});

test("a list cannot be dragged shorter than the minimum or taller than all its rows", () => {
  const run = loadPage();

  assert.equal(run("resizedHeight({ startHeight: 132, dragged: -500, scale: 1, max: 900 })"), run("RESIZE_MIN_PX"));
  assert.equal(run("resizedHeight({ startHeight: 132, dragged: 5000, scale: 1, max: 640 })"), 640);
});

test("a stored height survives a redraw and a bad stored value is ignored", () => {
  const run = loadPage();

  run("wallWritePref('cc-size-test', '300')");
  assert.equal(run("storedResizeHeight('test')"), 300);
  run("wallWritePref('cc-size-test', 'abc')");
  assert.equal(run("storedResizeHeight('test')"), null);
});

test("the grip is a keyboard-reachable separator that says what it does", () => {
  const run = loadPage();

  const grip = run("resizeGrip('test')");

  assert.equal(grip.attributes.role, "separator");
  assert.equal(grip.attributes.tabindex, "0");
  assert.match(grip.attributes.title, /拖动.*双击/u);
});
