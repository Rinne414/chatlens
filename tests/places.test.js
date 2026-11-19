"use strict";

// A sentence that names another page takes the user there (web/places.js):
// the place becomes a link, the rest of the sentence stays as written.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loadPlaces = () => {
  const opened = [];
  const context = vm.createContext({
    el: (tag, attributes, ...children) => ({ tag, attributes, children }),
    openGalleryKept: () => opened.push("kept"),
    openView: (name) => opened.push(`view:${name}`),
    openSettingsView: async () => opened.push("settings"),
    showView: () => {},
    loadGallerySaveTarget: () => {},
    applyGalleryFilter: () => opened.push("removed"),
    galleryScopePatch: () => ({}),
    replaceGallery: () => {},
    renderMediaView: () => {},
    document: { querySelector: () => null },
  });
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, "..", "web", "places.js"), "utf8")}\nthis.linked = linked;`, context);
  return { linked: context.linked, opened };
};

// Through JSON: the nodes come from another realm (the vm context).
const shape = (nodes) => JSON.parse(JSON.stringify(nodes.map((node) => (typeof node === "string" ? node : { link: node.children[0] }))));
const press = (node) => node.attributes.onclick({ preventDefault() {}, stopPropagation() {} });

test("a named place becomes a link and the words around it stay", () => {
  const { linked, opened } = loadPlaces();
  const nodes = linked("留存的原图不会被清，在画廊「留存的原图」里看；占多少在「存储」页。");
  assert.deepEqual(shape(nodes), [
    "留存的原图不会被清，在", { link: "画廊「留存的原图」" }, "里看；占多少在", { link: "「存储」页" }, "。",
  ]);
  press(nodes[1]);
  press(nodes[3]);
  assert.deepEqual(opened, ["kept", "view:storage"]);
});

test("the longer name wins: 取消留存的 is its own place, not the kept library", () => {
  const { linked, opened } = loadPlaces();
  const nodes = linked("到 画廊 →「取消留存的」可以放回留存。");
  assert.deepEqual(shape(nodes), ["到 ", { link: "画廊 →「取消留存的」" }, "可以放回留存。"]);
  press(nodes[1]);
  assert.deepEqual(opened, ["removed"]);
});

test("a sentence with no place comes back as it was", () => {
  const { linked } = loadPlaces();
  assert.deepEqual(shape(linked("每张约 1–3 MB。")), ["每张约 1–3 MB。"]);
});

test("every sentence in the pages that names one of these places is passed through linked()", () => {
  // The names a user would look for and not find a way to: a new sentence
  // that mentions one must link it (wrap the text in linked(...)).
  const named = /画廊「留存的原图」|画廊 →「留存的原图」|「取消留存的」|「设置 → [^」]+」|设置 →「[^」]+」|「存储」页|备份页/u;
  const webDir = path.join(__dirname, "..", "web");
  const unlinked = [];
  for (const file of fs.readdirSync(webDir).filter((name) => name.endsWith(".js") && !["places.js", "whatsnew.js"].includes(name))) {
    const lines = fs.readFileSync(path.join(webDir, file), "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      const code = line.trim();
      // Prose in a comment has no quote; a sentence may continue a linked( opened just above.
      const isComment = code.startsWith("//") || code.startsWith("/*") || code.startsWith("*") || !/["`]/u.test(code);
      const linkedAbove = lines.slice(Math.max(0, index - 2), index).some((earlier) => {
        const fromCall = earlier.slice(Math.max(0, earlier.indexOf("linked(")));
        return earlier.includes("linked(") && fromCall.split("(").length > fromCall.split(")").length;
      });
      // Tooltips (title:) and messages returned as plain strings cannot hold a link.
      const plainOnly = /\btitle: |^const [A-Z_]+ = |^\[?"[a-z_]+"?[,:]|return \[?`|^\? `|^: `|keptUi\.notice|\+ \(|^[a-z_]+: "/u.test(code);
      if (!isComment && !plainOnly && !linkedAbove && named.test(code) && !code.includes("linked(")) {
        unlinked.push(`${file}:${index + 1}: ${code.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(unlinked, []);
});
