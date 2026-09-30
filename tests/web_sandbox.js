"use strict";

// A fake page for the web/ scripts: they are classic scripts sharing one
// global scope, loaded here in index.html's order into one vm context.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");

// The scripts the page actually loads, in the order it loads them.
const pageScripts = () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  return [...html.matchAll(/<script src="\/([^"]+)"><\/script>/gu)].map((match) => match[1]);
};

const makeNode = (tag) => ({
  tagName: String(tag).toUpperCase(),
  children: [],
  dataset: {},
  style: { setProperty() {}, removeProperty() {} },
  attributes: {},
  isConnected: true,
  classList: {
    _set: new Set(),
    add(...names) { for (const name of names) { this._set.add(name); } },
    remove(...names) { for (const name of names) { this._set.delete(name); } },
    toggle(name, on) { if (on) { this._set.add(name); } else { this._set.delete(name); } },
    contains(name) { return this._set.has(name); },
  },
  setAttribute(key, value) { this.attributes[key] = value; },
  addEventListener() {},
  removeEventListener() {},
  append(...kids) { this.children.push(...kids); },
  replaceChildren(...kids) { this.children = kids; },
  getBoundingClientRect() { return { top: 0, left: 0, width: 1200, height: 800 }; },
  get clientWidth() { return 1200; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  set textContent(value) { this._text = value; },
  get textContent() { return this._text ?? ""; },
  set className(value) { this._class = value; },
  get className() { return this._class ?? ""; },
  set innerHTML(value) { this._html = value; },
  get innerHTML() { return this._html ?? ""; },
  focus() {},
  scrollIntoView() {},
  remove() {},
  closest() { return null; },
  insertBefore() {},
});

const makeSandbox = () => {
  const nodes = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      createElement: makeNode,
      createDocumentFragment: () => makeNode("fragment"),
      querySelector: (selector) => {
        if (!nodes.has(selector)) { nodes.set(selector, makeNode("div")); }
        return nodes.get(selector);
      },
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
      documentElement: makeNode("html"),
      body: makeNode("body"),
      head: makeNode("head"),
      activeElement: null,
      visibilityState: "visible",
    },
    localStorage: {
      _data: new Map(),
      getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
      setItem(key, value) { this._data.set(key, String(value)); },
      removeItem(key) { this._data.delete(key); },
    },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "test" },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    queueMicrotask(fn) { fn(); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    alert() {},
    confirm: () => false,
    prompt: () => null,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    URLSearchParams,
    URL,
    Intl,
    Date,
    // el() checks `child instanceof Node`; without it, boot's async work throws
    // after the test ends and surfaces as an unhandled rejection.
    Node: class Node {},
    // Boot fetches state on DOMContentLoaded. Rejecting immediately keeps the
    // scripts from starting real work we do not want to assert on here.
    Promise,
    _nodes: nodes,
  };
  sandbox.window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    location: { href: "http://127.0.0.1:8321/", search: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    open() {},
    devicePixelRatio: 1,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
};

module.exports = { WEB, pageScripts, makeNode, makeSandbox };
