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
