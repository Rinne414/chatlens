"use strict";

// "stripped" means no generation parameters were read from the picture file.
// Most such pictures are ordinary screenshots and photos; only the few whose
// prompt was later pasted in a group reply may say the prompt came from chat.

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
  return (expression) => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
};

const item = (fields) => JSON.stringify({ loras: [], promptRequests: [], sightings: [], ...fields });

test("a picture without parameters or a chat prompt is not labelled as a chat prompt", () => {
  const run = loadPage();

  const badges = run(`knowledgeBadges(${item({ generator: "stripped", isPlaceholder: true, prompt: "" })})`);

  assert.equal(badges[0].text, "未检测到生成参数");
});

test("a picture whose prompt came from a group reply says so", () => {
  const run = loadPage();

  const badges = run(`knowledgeBadges(${item({ generator: "stripped", isPlaceholder: true, prompt: "1girl, solo" })})`);

  assert.equal(badges[0].text, "咒语来自回复");
});

test("a picture with parameters shows its generator", () => {
  const run = loadPage();

  const badges = run(`knowledgeBadges(${item({ generator: "comfyui", isPlaceholder: false, prompt: "1girl" })})`);

  assert.equal(badges[0].text, "ComfyUI");
});

test("the source facet does not call parameter-less pictures chat prompts", () => {
  const run = loadPage();

  assert.equal(run("facetGeneratorLabel('stripped')"), "未检测到生成参数");
});
