"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  llmAbsentSummary,
  llmErrorPath,
  llmUnusedPath,
  readLlmError,
  readLlmUnused,
  writeLlmError,
  writeLlmUnused,
  clearLlmError,
  clearLlmUnused,
  normalizeLlmError,
} = require("../src/llm_status");

test("write/read/clear round-trip an LLM failure sidecar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-status-"));
  try {
    assert.equal(readLlmError(dir), null);
    const written = writeLlmError(dir, new Error("upstream 502"));
    assert.equal(written.failed, true);
    assert.equal(written.message, "upstream 502");
    assert.equal(fs.existsSync(llmErrorPath(dir)), true);

    const read = readLlmError(dir);
    assert.equal(read.failed, true);
    assert.equal(read.message, "upstream 502");

    clearLlmError(dir);
    assert.equal(readLlmError(dir), null);
    clearLlmError(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt llm-error.json still counts as a failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-status-bad-"));
  try {
    fs.writeFileSync(llmErrorPath(dir), "{not-json", "utf8");
    const read = readLlmError(dir);
    assert.equal(read.failed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("absent-summary copy distinguishes failed, unused, and unknown", () => {
  assert.equal(
    llmAbsentSummary(null),
    "无法判断这次是未使用 LLM 还是 LLM 失败；这里只包含本地动态分组和统计。",
  );
  assert.equal(
    llmAbsentSummary(null, { unused: true }),
    "未启用 LLM；这里只包含本地动态分组和统计。",
  );
  assert.equal(llmAbsentSummary({ failed: true }), "LLM 失败，已改用本地分组。");
  assert.equal(
    llmAbsentSummary({ failed: true }, { markdown: true }),
    "- LLM 失败，已改用本地分组。",
  );
});

test("unused and error sidecars clear each other", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-status-mutex-"));
  try {
    writeLlmUnused(dir);
    assert.equal(readLlmUnused(dir).unused, true);
    assert.equal(readLlmError(dir), null);

    writeLlmError(dir, new Error("timeout"));
    assert.equal(readLlmError(dir).failed, true);
    assert.equal(readLlmUnused(dir), null);
    assert.equal(fs.existsSync(llmUnusedPath(dir)), false);

    writeLlmUnused(dir);
    assert.equal(readLlmError(dir), null);
    assert.equal(fs.existsSync(llmErrorPath(dir)), false);

    clearLlmUnused(dir);
    assert.equal(readLlmUnused(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeLlmError strips unknown fields and caps the message", () => {
  assert.equal(normalizeLlmError(null), null);
  assert.deepEqual(normalizeLlmError({ failed: true, message: "x", stack: "nope" }), {
    failed: true,
    message: "x",
  });
  assert.equal(normalizeLlmError({ message: "n".repeat(800) }).message.length, 500);
});

test("llm adapter persists and clears the sidecar", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/llm_adapter.js"), "utf8");
  assert.match(source, /writeLlmError\(analysisDir, error\)/u);
  assert.match(source, /clearLlmError\(analysisDir\)/u);
  assert.match(source, /clearLlmUnused\(analysisDir\)/u);
});

test("generate_report says LLM failed instead of unused when the sidecar is present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-report-"));
  try {
    const analysisPath = path.join(dir, "analysis.json");
    const messagesPath = path.join(dir, "messages-clean.txt");
    const markdownPath = path.join(dir, "out.md");
    fs.writeFileSync(analysisPath, JSON.stringify({
      groupIds: ["1001"],
      groupNames: { "1001": "单群" },
      parsedTextMessages: 3,
      parsedMediaMessages: 0,
      matchedRaw: 3,
      scanned: 3,
      topics: [],
    }), "utf8");
    fs.writeFileSync(path.join(dir, "llm-error.json"), JSON.stringify({
      failed: true,
      message: "upstream 502",
    }), "utf8");
    fs.writeFileSync(messagesPath, "", "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "../src/generate_report.js"), analysisPath, messagesPath, markdownPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    const html = fs.readFileSync(markdownPath.replace(/\.md$/u, ".html"), "utf8");
    assert.match(markdown, /LLM 失败，已改用本地分组/u);
    assert.doesNotMatch(markdown, /未启用 LLM/u);
    assert.doesNotMatch(markdown, /无法判断/u);
    assert.match(html, /LLM 失败，已改用本地分组/u);
    assert.doesNotMatch(html, /未启用 LLM/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const writeMinimalAnalysis = (dir) => {
  fs.writeFileSync(path.join(dir, "analysis.json"), JSON.stringify({
    groupIds: ["1001"],
    groupNames: { "1001": "单群" },
    parsedTextMessages: 3,
    parsedMediaMessages: 0,
    matchedRaw: 3,
    scanned: 3,
    topics: [],
  }), "utf8");
  fs.writeFileSync(path.join(dir, "messages-clean.txt"), "", "utf8");
};

test("generate_report labels a missing sidecar as unknown instead of unused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-report-unknown-"));
  try {
    writeMinimalAnalysis(dir);
    const markdownPath = path.join(dir, "out.md");
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "../src/generate_report.js"), path.join(dir, "analysis.json"), path.join(dir, "messages-clean.txt"), markdownPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const markdown = fs.readFileSync(markdownPath, "utf8");
    const html = fs.readFileSync(markdownPath.replace(/\.md$/u, ".html"), "utf8");
    assert.match(markdown, /无法判断这次是未使用 LLM 还是 LLM 失败/u);
    assert.doesNotMatch(markdown, /未启用 LLM/u);
    assert.match(html, /无法判断这次是未使用 LLM 还是 LLM 失败/u);
    assert.doesNotMatch(html, /未启用 LLM/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generate_report says unused only when the unused sidecar is present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-llm-report-unused-"));
  try {
    writeMinimalAnalysis(dir);
    writeLlmUnused(dir);
    const markdownPath = path.join(dir, "out.md");
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "../src/generate_report.js"), path.join(dir, "analysis.json"), path.join(dir, "messages-clean.txt"), markdownPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const markdown = fs.readFileSync(markdownPath, "utf8");
    assert.match(markdown, /未启用 LLM；这里只包含本地动态分组和统计/u);
    assert.doesNotMatch(markdown, /无法判断/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single-group and digest reports read the sidecar", () => {
  const report = fs.readFileSync(path.join(__dirname, "../src/generate_report.js"), "utf8");
  const digest = fs.readFileSync(path.join(__dirname, "../src/generate_digest_report.js"), "utf8");
  const pipeline = fs.readFileSync(path.join(__dirname, "../src/pipeline/summary_run.js"), "utf8");
  assert.match(report, /attachLlmAbsence/u);
  assert.match(report, /unused: Boolean\(analysis\.llmUnused\)/u);
  assert.match(digest, /llmFailedGroups/u);
  assert.match(digest, /llmChipLabel/u);
  assert.match(digest, /无法判断/u);
  // The pipeline records both outcomes, so a report never has to guess.
  assert.match(pipeline, /markLlmFailure/u);
  assert.match(pipeline, /writeLlmUnused/u);
});
