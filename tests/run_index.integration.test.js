"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { collectRun, diskStatsPath, readExportCoverageMeta } = require("../src/run_index");

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
};

test("run index keeps scan coverage separate from AI input coverage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-index-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");
  const reportsDir = path.join(tempDir, "reports");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      groupNames: { "1001": "Test group" },
      byGroup: [["Test group", 80]],
      parsedTextMessages: 80,
      parsedMediaMessages: 20,
      firstMessageHkt: "2026-07-19 10:15:00",
      lastMessageHkt: "2026-07-19 11:45:00",
      llmSummary: {
        summary: "Summary",
        coverage: { totalTextMessages: 80, includedTextMessages: 60, chunks: 2, mode: "map-reduce" },
      },
    });
    writeJson(path.join(runDir, "exports", "groups_test_100000_101000.json"), {
      groupIds: ["1001"],
      startUnix: 100000,
      endUnix: 101000,
      coveredFromUnix: 100200,
    });

    const run = collectRun(runDir, reportsDir);

    assert.equal(run.scanCoverage.status, "partial");
    assert.equal(run.scanCoverage.coverageRatio, 0.8);
    assert.equal(run.scanCoverage.missingSeconds, 200);
    assert.equal(run.scanCoverage.requestedStartUnix, 100000);
    assert.equal(run.scanCoverage.requestedEndUnix, 101000);
    assert.equal(run.aiCoverage.status, "partial");
    assert.equal(run.aiCoverage.coverageRatio, 0.75);
    assert.equal(run.aiCoverage.includedMessages, 60);
    assert.equal(run.aiCoverage.totalMessages, 80);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run index reports failed AI coverage when llm-error.json exists and no summary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-llm-fail-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["单群", 12]],
      parsedTextMessages: 12,
      parsedMediaMessages: 0,
    });
    writeJson(path.join(runDir, "analysis", "llm-error.json"), {
      failed: true,
      message: "upstream 502",
    });

    const run = collectRun(runDir, path.join(tempDir, "reports"));

    assert.equal(run.aiCoverage.status, "failed");
    assert.equal(run.aiCoverage.totalMessages, 12);
    assert.equal(run.llmStatus, "failed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy run reports unknown scan coverage instead of claiming completeness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-legacy-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["1001", 0]],
      parsedTextMessages: 0,
      parsedMediaMessages: 0,
    });

    const run = collectRun(runDir, path.join(tempDir, "reports"));

    assert.equal(run.scanCoverage.status, "unknown");
    assert.equal(run.scanCoverage.coverageRatio, null);
    assert.equal(run.aiCoverage.status, "indeterminate");
    assert.equal(run.llmStatus, "unknown");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("unused sidecar reports not-used instead of indeterminate", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-unused-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["单群", 12]],
      parsedTextMessages: 12,
      parsedMediaMessages: 0,
    });
    writeJson(path.join(runDir, "analysis", "llm-unused.json"), { unused: true });

    const run = collectRun(runDir, path.join(tempDir, "reports"));

    assert.equal(run.aiCoverage.status, "not-used");
    assert.equal(run.llmStatus, "not-used");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("scan coverage reads export headers without parsing message bodies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-prefix-"));
  const compactJson = path.join(tempDir, "compact.json");
  const prettyJson = path.join(tempDir, "pretty.json");
  const bulky = "x".repeat(300_000);
  const header = {
    groupIds: ["1001"],
    groupNames: { "1001": "Test" },
    startUnix: 100000,
    endUnix: 101000,
    coveredFromUnix: 100400,
  };

  try {
    fs.writeFileSync(compactJson, `${JSON.stringify(header).slice(0, -1)},"messages":[{"text":"${bulky}"}]}`);
    const compact = readExportCoverageMeta(compactJson);
    assert.deepEqual(compact.groupIds, ["1001"]);
    assert.equal(compact.startUnix, 100000);
    assert.equal(compact.coveredFromUnix, 100400);
    assert.equal(compact.messages, undefined);

    fs.writeFileSync(prettyJson, JSON.stringify({ ...header, messages: [{ text: bulky }] }, null, 2));
    const pretty = readExportCoverageMeta(prettyJson);
    assert.equal(pretty.startUnix, 100000);
    assert.equal(pretty.coveredFromUnix, 100400);
    assert.equal(pretty.messages, undefined, "pretty-printed bodies must stay unread");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("collectRun caches disk totals and reuses them until the fingerprint changes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-cache-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");
  const reportsDir = path.join(tempDir, "reports");
  const mediaFile = path.join(runDir, "media", "pic.bin");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["Test", 1]],
      parsedTextMessages: 1,
      parsedMediaMessages: 0,
    });
    writeJson(path.join(runDir, "exports", "groups_test.json"), {
      groupIds: ["1001"],
      startUnix: 10,
      endUnix: 20,
      coveredFromUnix: 10,
    });
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, Buffer.alloc(1024));
    writeJson(path.join(runDir, "media", "media-manifest.json"), [{ copiedPath: mediaFile }]);

    const first = collectRun(runDir, reportsDir);
    const cachePath = diskStatsPath(runDir);
    assert.equal(fs.existsSync(cachePath), true);
    assert.ok(first.runBytes >= 1024);
    assert.equal(first.copiedMedia, 1);
    assert.equal(first.scanCoverage.status, "complete");

    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cached.runBytes = 7;
    cached.mediaBytes = 7;
    fs.writeFileSync(cachePath, JSON.stringify(cached));

    const second = collectRun(runDir, reportsDir);
    assert.equal(second.runBytes, 7, "unchanged fingerprint must reuse the sidecar");
    assert.equal(second.mediaBytes, 7);

    writeJson(path.join(runDir, "media", "media-manifest.json"), [
      { copiedPath: mediaFile },
      { copiedPath: null, url: null },
    ]);
    const third = collectRun(runDir, reportsDir);
    assert.equal(third.copiedMedia, 1);
    assert.equal(third.missingMedia, 1, "a rewritten manifest must invalidate the sidecar");
    assert.notEqual(third.runBytes, 7);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listing can skip recursive disk totals when the sidecar is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-summary-run-nodisk-"));
  const runDir = path.join(tempDir, "runs", "qq-time-custom-test-20260719-120000");
  const reportsDir = path.join(tempDir, "reports");

  try {
    writeJson(path.join(runDir, "analysis", "analysis.json"), {
      groupIds: ["1001"],
      byGroup: [["Test", 1]],
      parsedTextMessages: 1,
      parsedMediaMessages: 0,
    });
    writeJson(path.join(runDir, "exports", "groups_test.json"), {
      groupIds: ["1001"],
      startUnix: 10,
      endUnix: 20,
      coveredFromUnix: 10,
    });
    fs.mkdirSync(path.join(runDir, "media"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "media", "pic.bin"), Buffer.alloc(2048));
    writeJson(path.join(runDir, "media", "media-manifest.json"), [
      { copiedPath: path.join(runDir, "media", "pic.bin") },
    ]);

    const run = collectRun(runDir, reportsDir, { includeDisk: false });
    assert.equal(run.runBytes, 0);
    assert.equal(run.mediaBytes, 0);
    assert.equal(run.copiedMedia, 1);
    assert.equal(run.scanCoverage.status, "complete");
    assert.equal(fs.existsSync(diskStatsPath(runDir)), false);

    const measured = collectRun(runDir, reportsDir);
    assert.ok(measured.runBytes >= 2048);
    const reused = collectRun(runDir, reportsDir, { includeDisk: false });
    assert.equal(reused.runBytes, measured.runBytes, "a complete sidecar is reused even when listing skips disk walks");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
