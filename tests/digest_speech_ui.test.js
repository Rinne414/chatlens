"use strict";

// 朗读 on an overview: what is read, and which of the computer's voices reads it.

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

const plain = (value) => JSON.parse(JSON.stringify(value));

test("the headline, the summary and the highlights' names are read, not their details", () => {
  const run = loadPage();
  const digest = { summary: {
    headline: "新模型上线",
    summary: "今天主要在聊新模型。",
    highlights: [{ title: "模型发布", detail: "很长的细节" }, { title: "额度收紧", detail: "另一段细节" }, { title: "  " }],
    groups: [{ group: "一群", oneLine: "不读" }],
  } };
  assert.deepEqual(plain(run(`digestSpeechParts(${JSON.stringify(digest)})`)), ["新模型上线", "今天主要在聊新模型。", "重点有 2 件：模型发布；额度收紧。"]);
  assert.deepEqual(plain(run(`digestSpeechParts(${JSON.stringify({ summary: { headline: "", highlights: [] } })})`)), []);
});

test("a Mandarin voice is picked over a Cantonese one, and none when the computer has no Chinese voice", () => {
  const run = loadPage();
  const pick = (voices) => run(`window.speechSynthesis = { getVoices: () => ${JSON.stringify(voices)} }; digestVoice()?.name ?? null`);
  assert.equal(pick([{ name: "Tracy", lang: "zh-HK" }, { name: "Hanhan", lang: "zh-TW" }, { name: "David", lang: "en-US" }]), "Hanhan");
  assert.equal(pick([{ name: "Hanhan", lang: "zh-TW" }, { name: "Xiaoxiao", lang: "zh-CN" }]), "Xiaoxiao");
  assert.equal(pick([{ name: "Tracy", lang: "zh-HK" }]), "Tracy");
  assert.equal(pick([{ name: "David", lang: "en-US" }]), null);
});

test("问群聊这件事 starts the question about that thing", () => {
  const run = loadPage();
  assert.equal(run("askDraftAbout('LoRA 炼丹')"), "关于「LoRA 炼丹」：");
});
