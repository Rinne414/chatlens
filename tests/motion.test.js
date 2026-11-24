"use strict";

// When a window over the page gets its entrance (web/motion.js): the pages
// redraw a window by removing it and appending a new one, and that must not
// look like the window opening again.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { WEB, makeSandbox } = require("./web_sandbox");

const load = () => {
  const context = vm.createContext(makeSandbox());
  vm.runInContext(`${fs.readFileSync(path.join(WEB, "motion.js"), "utf8")}\nglobalThis.motionEntranceFor = motionEntranceFor; globalThis.MOTION_ENTER_MS = MOTION_ENTER_MS;`, context, { filename: "motion.js" });
  return context;
};

const state = (overrides) => ({ removedKinds: new Set(), lastInput: "pointer", enteredAt: new Map(), now: 1000, ...overrides });

test("a window opened with the mouse gets its whole entrance", () => {
  const { motionEntranceFor } = load();
  assert.equal(motionEntranceFor("kb-overlay", state({})), 0);
});

test("a window opened with a key appears at once", () => {
  const { motionEntranceFor } = load();
  assert.equal(motionEntranceFor("quick-look", state({ lastInput: "key" })), null);
});

test("a redraw of an open window is not an entrance", () => {
  const { motionEntranceFor } = load();
  const redraw = state({ removedKinds: new Set(["kb-overlay"]), enteredAt: new Map([["kb-overlay", 0]]) });
  assert.equal(motionEntranceFor("kb-overlay", redraw), null);
});

test("a redraw during the entrance carries it on from where it was", () => {
  const { motionEntranceFor } = load();
  const redraw = state({ removedKinds: new Set(["kb-overlay"]), enteredAt: new Map([["kb-overlay", 960]]) });
  assert.equal(motionEntranceFor("kb-overlay", redraw), 40);
});

test("a redraw of a window that came without an entrance stays without one", () => {
  const { motionEntranceFor } = load();
  assert.equal(motionEntranceFor("kb-overlay", state({ removedKinds: new Set(["kb-overlay"]) })), null);
});

test("another kind of window being removed does not cancel an entrance", () => {
  const { motionEntranceFor } = load();
  assert.equal(motionEntranceFor("cc-dialog-layer", state({ removedKinds: new Set(["kb-overlay"]) })), 0);
});

test("the script's entrance length is the stylesheet's", () => {
  const { MOTION_ENTER_MS } = load();
  const css = fs.readFileSync(path.join(WEB, "motion.css"), "utf8");
  assert.match(css, new RegExp(`--motion-enter: ${MOTION_ENTER_MS}ms;`, "u"));
});

test("less motion: the stylesheet drops movement when the system asks for it", () => {
  const css = fs.readFileSync(path.join(WEB, "motion.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(css, /transition: all/u);
});
