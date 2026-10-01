"use strict";

// app.js calls boot() while the scripts after it (rail.js, brief.js, ...) are
// still downloading. On a slow load /api/state answered first and boot called
// startRail() before rail.js had run: "无法连接控制台服务: startRail is not defined".
// The page scripts run here in a vm with a stand-in DOM; nothing needs a browser.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const WEB = path.join(__dirname, "..", "web");
const SCRIPTS_UP_TO_APP = ["timeline_tools.js", "gallery_tools.js", "view_history.js", "app.js"];

// Every property, call and iteration works and yields another stand-in, so the
// DOM work in boot() runs. `then` stays undefined so awaiting one never hangs.
const standIn = () => new Proxy(function standInNode() {}, {
  get: (target, key) => {
    if (key === "then") {
      return undefined;
    }
    if (key === Symbol.iterator) {
      return function* nothing() {};
    }
    if (key === Symbol.toPrimitive) {
      return () => "";
    }
    return standIn();
  },
  set: () => true,
  apply: () => standIn(),
  construct: () => standIn(),
});

const withStandIns = (base) => new Proxy(base, { get: (target, key) => (key in target ? target[key] : standIn()) });

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const respond = (payload) => Promise.resolve({ status: 200, ok: true, json: async () => payload });

// Runs index.html's scripts up to and including app.js, which starts boot().
const loadPageUpToApp = () => {
  const listeners = [];
  const document = withStandIns({
    readyState: "loading",
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    querySelector: () => standIn(),
    querySelectorAll: () => [],
    createElement: () => standIn(),
    createTextNode: () => standIn(),
    documentElement: standIn(),
  });
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams,
    Node: class Node {},
    document,
    navigator: standIn(),
    history: standIn(),
    location: { search: "", pathname: "/" },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    matchMedia: () => standIn(),
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    fetch: (url) => respond(url === "/api/state" ? { runDefaults: {} } : {}),
  };
  const context = vm.createContext(sandbox);
  sandbox.window = vm.runInContext("this", context);
  for (const name of SCRIPTS_UP_TO_APP) {
    vm.runInContext(fs.readFileSync(path.join(WEB, name), "utf8"), context, { filename: name });
  }
  return {
    // Stands in for the later scripts running: their globals now exist.
    runLaterScripts: (globals) => Object.assign(sandbox, globals),
    finishParsing: () => {
      document.readyState = "interactive";
      for (const { type, listener } of listeners) {
        if (type === "DOMContentLoaded") {
          listener();
        }
      }
    },
  };
};

const settle = async () => {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("boot waits for the later scripts when /api/state answers before they have run", async () => {
  const calls = [];
  const page = loadPageUpToApp();
  await settle();

  page.runLaterScripts({ startRail: () => calls.push("rail"), openBriefView: async () => calls.push("brief") });
  page.finishParsing();
  await settle();

  assert.deepEqual(calls, ["rail", "brief"]);
});

test("boot still starts when every script has run before /api/state answers", async () => {
  const calls = [];
  const page = loadPageUpToApp();
  page.runLaterScripts({ startRail: () => calls.push("rail"), openBriefView: async () => calls.push("brief") });
  page.finishParsing();
  await settle();

  assert.deepEqual(calls, ["rail", "brief"]);
});
