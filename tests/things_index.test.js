"use strict";

// 笔记库: the things the AI noticed, merged across chunks, groups and
// spellings (src/things_index.js).

const assert = require("node:assert/strict");
const test = require("node:test");

const { nameKey, linkKey, buildThings, isNoteworthy, answersByThing, collectMentions, collectAnswers } = require("../src/things_index");

const mention = (name, extra = {}) => ({
  chunkId: extra.chunkId ?? 1,
  index: extra.index ?? 0,
  groupId: extra.groupId ?? "100001",
  sentAt: extra.sentAt ?? 1000,
  kind: extra.kind ?? "model",
  name,
  key: nameKey(name),
  detail: extra.detail ?? "",
  link: extra.link ?? "",
  linkKey: linkKey(extra.link ?? ""),
  speaker: extra.speaker ?? "",
});

test("spelling noise is one name, but C++ and C# stay apart from C", () => {
  assert.equal(nameKey("Krea 2"), nameKey("krea2"));
  assert.equal(nameKey("MOSS-Image"), nameKey("moss image"));
  assert.notEqual(nameKey("C++"), nameKey("C"));
  assert.notEqual(nameKey("C#"), nameKey("C"));
});

test("a link names one project: repos are cut to owner/repo, a bare site names nothing", () => {
  assert.equal(linkKey("https://github.com/OpenMOSS/MOSS-Image/tree/main/docs"), "github.com/openmoss/moss-image");
  assert.equal(linkKey("https://huggingface.co/spaces/a/b/discussions"), "huggingface.co/spaces/a/b");
  assert.equal(linkKey("https://www.youtube.com/watch?v=abc&t=3"), "youtube.com/watch/abc");
  assert.equal(linkKey("https://github.com/"), "");
  assert.equal(linkKey("not a url"), "");
});

test("mentions with one name key or one project link become one thing; a shared video does not merge", () => {
  const things = buildThings([
    mention("Moss", { chunkId: 1, link: "https://github.com/openmoss/moss-image" }),
    mention("MOSS-Image", { chunkId: 2, link: "https://github.com/OpenMOSS/MOSS-Image" }),
    mention("moss", { chunkId: 3 }),
    mention("Gemini 4", { chunkId: 4, link: "https://www.bilibili.com/video/BV1x" }),
    mention("Claude Fable 5.5", { chunkId: 4, index: 1, link: "https://www.bilibili.com/video/BV1x" }),
  ]);

  const moss = things.find((thing) => thing.keys.includes("moss"));
  assert.deepEqual([...moss.keys].sort(), ["moss", "mossimage"]);
  assert.equal(moss.chunkCount, 3);
  assert.ok(things.some((thing) => thing.name === "Gemini 4"));
  assert.ok(things.some((thing) => thing.name === "Claude Fable 5.5"));
});

test("the written-out spelling names a thing typed mostly in lower case", () => {
  const [thing] = buildThings([
    mention("krea2", { chunkId: 1 }), mention("krea2", { chunkId: 2 }), mention("krea2", { chunkId: 3 }), mention("Krea2", { chunkId: 4 }),
  ]);

  assert.equal(thing.name, "Krea2");
  assert.equal(thing.anchor, "krea2");
});

test("the user's own groups win: two of them are never joined by a shared link", () => {
  const link = "https://github.com/a/b";
  const things = buildThings([mention("甲", { chunkId: 1, link }), mention("乙", { chunkId: 2, link })], {
    userGroups: [[nameKey("甲")], [nameKey("乙")]],
  });

  assert.equal(things.length, 2);
});

test("AI alias edges join names, unless the user separated them", () => {
  const mentions = [mention("qwen2.1", { chunkId: 1 }), mention("Qwen Image 2.1", { chunkId: 2 })];
  const edges = [["qwen21", "qwenimage21"]];

  assert.equal(buildThings(mentions, { aliasEdges: edges }).length, 1);
  assert.equal(buildThings(mentions, { aliasEdges: edges, userGroups: [["qwen21"], ["qwenimage21"]] }).length, 2);
});

test("a note is worth writing with a source or more than one stretch of chat; a lone 'other' needs three", () => {
  const [once] = buildThings([mention("一次", { chunkId: 1 })]);
  const [twice] = buildThings([mention("两次", { chunkId: 1 }), mention("两次", { chunkId: 2 })]);
  const [sourced] = buildThings([mention("有链接", { chunkId: 1, link: "https://github.com/a/b" })]);
  const [otherTwice] = buildThings([mention("杂", { chunkId: 1, kind: "other" }), mention("杂", { chunkId: 2, kind: "other" })]);

  assert.equal(isNoteworthy(once), false);
  assert.equal(isNoteworthy(twice), true);
  assert.equal(isNoteworthy(sourced), true);
  assert.equal(isNoteworthy(otherTwice), false);
});

test("answers attach to the things they name, not to a name inside a longer latin word", () => {
  const things = buildThings([mention("H3", { chunkId: 1 }), mention("H3", { chunkId: 2 })]);
  const answer = (question) => ({ chunkId: 9, index: 0, groupId: "1", sentAt: 5, question, answer: "答" });

  const byThing = answersByThing(things, [answer("H3 怎么跑？"), answer("MiniMaxH3 呢？"), answer("h3c 交换机？"), answer("用h3出图")]);

  assert.deepEqual(byThing.get(0).map((item) => item.question), ["H3 怎么跑？", "用h3出图"]);
});

test("a name is matched between spaces in latin text too, and across an emoji", () => {
  const things = buildThings([mention("Flux", { chunkId: 1 }), mention("Flux", { chunkId: 2 })]);
  const answer = (question) => ({ chunkId: 9, index: 0, groupId: "1", sentAt: 5, question, answer: "答" });

  const byThing = answersByThing(things, [answer("Flux is great"), answer("fluxdev is not"), answer("😀flux 呢")]);

  assert.deepEqual(byThing.get(0).map((item) => item.question), ["Flux is great", "😀flux 呢"]);
});

test("only a full project address merges: not a person's page, an organisation, or a link shared by names in one chunk", () => {
  const things = buildThings([
    mention("WanVideoWrapper", { chunkId: 1, link: "https://github.com/kijai" }),
    mention("KJNodes", { chunkId: 2, link: "https://github.com/kijai" }),
    mention("Qwen-Image", { chunkId: 3, link: "https://huggingface.co/Qwen" }),
    mention("Qwen3-VL", { chunkId: 4, link: "https://huggingface.co/Qwen" }),
    mention("甲", { chunkId: 5, link: "https://github.com/a/b" }),
    mention("乙", { chunkId: 5, index: 1, link: "https://github.com/a/b" }),
    mention("乙", { chunkId: 6, link: "https://github.com/a/b" }),
  ]);

  assert.equal(things.length, 6);
});

test("chunk summaries give mentions with believable times and only answered questions", () => {
  const chunk = {
    chunkId: 7,
    groupId: "100001",
    startAt: 1_000_000,
    endAt: 1_003_600,
    partial: {
      newThings: [{ kind: "tool", name: "Penna", detail: "写提示词的工具", hkt: "1970-01-01 08:00", link: "https://github.com/storyaura/penna" }, { name: "  " }],
      qa: [{ question: "怎么装？", answer: "pip", resolved: true }, { question: "有人知道吗？", answer: null, resolved: false }],
    },
  };

  const [item] = collectMentions([chunk]);
  assert.equal(item.sentAt, chunk.startAt);
  assert.equal(item.linkKey, "github.com/storyaura/penna");
  assert.equal(collectMentions([chunk]).length, 1);
  assert.deepEqual(collectAnswers([chunk]).map((answer) => answer.question), ["怎么装？"]);
});
