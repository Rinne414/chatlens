"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const common = require("../src/pipeline/common");
const { normalizeLlmSummary, deterministicMerge } = require("../src/llm_summarizer");
const { desktopEntry } = require("../src/server/desktop_ops");
const { clip } = require("../src/notify");
const platform = require("../src/platform");

test("Beijing time parsing ignores the machine timezone and honours explicit offsets", () => {
  assert.equal(common.parseBeijingTime("2026-09-01 08:00"), 1788220800);
  assert.equal(common.parseBeijingTime("2026-09-01 08:00 +08:00"), 1788220800);
  assert.equal(common.parseBeijingTime("2026-09-01T00:00:00Z"), 1788220800);
  assert.equal(common.parseBeijingTime("2026-09-01 02:00 +02:00"), 1788220800);
  assert.throws(() => common.parseBeijingTime("yesterday"), /无法解析时间/u);
});

test("group ids are split, de-duplicated and validated", () => {
  assert.deepEqual(common.normalizeGroupIds(["1, 2；3", "2"]), ["1", "2", "3"]);
  assert.throws(() => common.normalizeGroupIds(["12a"]), /无效的 QQ 群号/u);
});

test("run ids keep the historical shape run_index parses", () => {
  const id = common.makeRunId(["1", "2"], "time", "last-24h", new Date(2026, 8, 24, 7, 5, 9));
  assert.match(id, /^qq-time-last-24h-[0-9a-f]{12}-20260924-070509$/u);
});

test("summary schema v3 keeps new things and Q&A, drops incomplete items instead of failing", () => {
  const summary = normalizeLlmSummary({
    summary: "今天在聊新模型",
    topics: [],
    newThings: [
      { kind: "model", name: "Flux 2", detail: "新底模", link: "https://example.com", speaker: "A", hkt: "08:00" },
      { kind: "weird", name: "工具", detail: "好用", link: "not a url" },
      { kind: "tool", name: "", detail: "missing name" },
    ],
    qa: [
      { question: "怎么装?", answer: "看教程", asker: "B", answerer: "A" },
      { question: "有人知道吗", answer: null, asker: "C" },
      { question: "" },
    ],
  }, { model: "m" });
  assert.equal(summary.schemaVersion, 3);
  assert.deepEqual(summary.newThings.map((item) => [item.kind, item.name, item.link]), [["model", "Flux 2", "https://example.com"], ["other", "工具", null]]);
  assert.deepEqual(summary.qa.map((item) => [item.question, item.resolved]), [["怎么装?", true], ["有人知道吗", false]]);
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(summary.risks, []);
});

test("only http(s) links survive normalization", () => {
  const summary = normalizeLlmSummary({
    summary: "s",
    links: [
      { title: "ok", url: "https://example.com/a", why: "w" },
      { title: "bad", url: "javascript:alert(1)", why: "w" },
      { title: "data", url: "data:text/html,x", why: "w" },
    ],
  }, {});
  assert.deepEqual(summary.links.map((link) => link.title), ["ok"]);
});

test("deterministic merge lets a later answer resolve an earlier open question", () => {
  const merged = deterministicMerge([
    { summary: "a", qa: [{ question: "怎么装插件", answer: null, asker: "B" }], newThings: [{ name: "X", detail: "d", link: "https://x.dev" }] },
    { summary: "b", qa: [{ question: "怎么装插件", answer: "用管理器", asker: "B", answerer: "A" }], newThings: [{ name: "X 新版", detail: "d", link: "https://x.dev" }] },
  ]);
  assert.equal(merged.qa.length, 1);
  assert.equal(merged.qa[0].answer, "用管理器");
  assert.equal(merged.newThings.length, 1);
  assert.doesNotThrow(() => normalizeLlmSummary(merged, {}));
});

test("deterministic merge keeps the summary short: the first sentence of each part, not every part in full", () => {
  const merged = deterministicMerge([
    { summary: "先吵了一架。然后讲了很多技术细节，细节一，细节二。" },
    { summary: "后来发了新模型！大家都去试了。" },
  ]);
  assert.equal(merged.summary, "先吵了一架。 后来发了新模型！");
});

test("desktop entries quote paths with spaces and mark autostart entries", () => {
  const app = desktopEntry({ background: false });
  assert.match(app, /^Exec=".+" ".+launcher\.js"$/mu);
  assert.doesNotMatch(app, /--background/u);
  assert.match(desktopEntry({ background: true }), /--background\nPath=/u);
});

test("notification text is single-line and bounded", () => {
  assert.equal(clip("a\n\nb   c", 10), "a b c");
  assert.equal(clip("x".repeat(20), 10), `${"x".repeat(9)}…`);
});

test("safe absolute dir check follows the current OS rules", () => {
  if (platform.isWindows) {
    assert.equal(platform.isSafeAbsoluteDir("L:\\Tencent Files\\123\\nt_qq\\nt_db"), true);
    assert.equal(platform.isSafeAbsoluteDir("relative\\dir"), false);
    assert.equal(platform.isSafeAbsoluteDir('C:\\bad"quote'), false);
  } else {
    assert.equal(platform.isSafeAbsoluteDir("/home/me/.config/QQ/nt_qq_abc/nt_db"), true);
    assert.equal(platform.isSafeAbsoluteDir("relative/dir"), false);
    assert.equal(platform.isSafeAbsoluteDir("/home/$(rm)/x"), false);
  }
});

test("secrets round-trip through the platform backend without leaking to other names", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlens-secrets-"));
  const previous = process.env.CHATLENS_SECRET_DIR;
  process.env.CHATLENS_SECRET_DIR = dir;
  try {
    const secrets = require("../src/secrets");
    assert.equal(secrets.hasSecret("llmKey"), false);
    await assert.rejects(() => secrets.saveSecret("llmKey", "short"), /长度不合理/u);
    await secrets.saveSecret("llmKey", "  sk-test-1234567890  ");
    assert.equal(secrets.hasSecret("llmKey"), true);
    assert.equal(secrets.hasSecret("ntqqKey"), false);
    assert.equal((await secrets.readSecret("llmKey")).trim(), "sk-test-1234567890");
    assert.equal(secrets.readSecretSync("llmKey").trim(), "sk-test-1234567890");
    if (!platform.isWindows) {
      assert.equal(fs.statSync(secrets.secretFilePath("llmKey")).mode & 0o777, 0o600);
    } else {
      // DPAPI output, not the plain value, is what lands on disk.
      assert.doesNotMatch(fs.readFileSync(secrets.secretFilePath("llmKey"), "utf8"), /sk-test/u);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.CHATLENS_SECRET_DIR;
    } else {
      process.env.CHATLENS_SECRET_DIR = previous;
    }
  }
});

test("a summary with one incomplete list item keeps the rest instead of being thrown away", () => {
  // Seen live: a whole detailed Grok answer was re-asked on DeepSeek because
  // one uncategorized item had no speaker.
  const summary = normalizeLlmSummary({
    summary: "群里在聊显卡。",
    topics: [
      { title: "显卡", summary: "3090 够用", importance: "urgent", messageCountEstimate: "12", details: "显存 24G", evidence: "3090 显存够跑 Flux 吗" },
      { title: "", summary: "没有标题的话题" },
    ],
    timeline: [{ start: "10:00", title: "开始", summary: "有人问显卡" }, { start: "10:05" }],
    uncategorized: [{ hkt: "10:01", note: "发了个表情" }, { hkt: "10:02", speaker: "阿杰", note: "谢啦" }, { speaker: "小雨" }],
    links: [{ url: "https://example.com/a" }, { url: "javascript:alert(1)", title: "x", why: "y" }],
  }, {});
  assert.deepEqual(summary.topics.map((topic) => [topic.title, topic.importance, topic.messageCountEstimate, topic.details, topic.evidence]),
    [["显卡", "medium", 0, [], []]]);
  assert.deepEqual(summary.timeline.map((item) => item.title), ["开始"]);
  assert.deepEqual(summary.uncategorized, [{ hkt: "10:01", speaker: "", note: "发了个表情" }, { hkt: "10:02", speaker: "阿杰", note: "谢啦" }]);
  assert.deepEqual(summary.links.map((link) => [link.url, link.title]), [["https://example.com/a", "https://example.com/a"]]);

  assert.throws(() => normalizeLlmSummary({ topics: [] }, {}), /Required string is missing: summary/u);
});

test("an answer without the summary's structure is unusable, even with a summary sentence", () => {
  const { validateSummary } = require("../src/llm_summarizer");
  // A refusal dressed as JSON must not replace a good summary (detailed redo).
  assert.throws(() => validateSummary({ summary: "抱歉，我无法总结这段内容。" }), /topics/u);
  assert.throws(() => validateSummary({ summary: "群里在聊显卡。", topics: [], qa: "没有" }), /qa/u);
  // Structure present: incomplete items are simply dropped.
  assert.doesNotThrow(() => validateSummary({ summary: "群里在聊显卡。", topics: [{ title: "", summary: "" }], newThings: [], qa: [] }));
  // A quiet chunk may have nothing to list.
  assert.doesNotThrow(() => validateSummary({ summary: "没什么新鲜事。", topics: [] }));
});

test("a well-formed refusal with nothing listed is not a summary", () => {
  const { validateSummary, shouldFallBack } = require("../src/llm_summarizer");
  // Stored as summaries on 2026-09-30 (3 chunks, 456 messages).
  const refusals = [
    "这批消息里有涉及未成年人的性化内容，我不能整理、摘录或复述。",
    "这段群聊包含对未成年人的性化讨论和色情生成内容，无法总结。",
    "这段群聊无法按要求做完整摘要：消息里包含对未成年人的性内容，不能整理、摘录或复述。",
    "I can't help summarize this conversation.",
  ];
  for (const summary of refusals) {
    let error = null;
    try {
      validateSummary({ summary, topics: [], newThings: [], qa: [], timeline: [] });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error !== null, summary);
    // The answer's problem, not the provider being down: only this call goes elsewhere.
    assert.equal(shouldFallBack(error), false);
  }
  // A quiet chunk is fine, and so is a refusal-ish sentence next to real content.
  assert.doesNotThrow(() => validateSummary({ summary: "这段消息很少，主要是群友之间的互相调侃和玩梗。", topics: [] }));
  assert.doesNotThrow(() => validateSummary({
    summary: "部分内容无法总结，其余在聊显卡。",
    topics: [{ title: "显卡", summary: "3090 够用", importance: "low", messageCountEstimate: 3, details: [], evidence: [] }],
  }));
});
