"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildCoverageRepairArgs,
  buildRangeArgs,
  jobCleanupFailureMessage,
  safeCleanupPaths,
} = require("../src/server/run_jobs");
const { toolRoot } = require("../src/server/toolkit_state");

const storeDir = path.join(toolRoot, "store");
const coverageRepairRoot = path.join(storeDir, "coverage-repairs");

test("coverage repair runs only the dedicated scan pipeline", () => {
  const planPath = path.resolve("store", "coverage-repairs", "0123456789abcdef01234567.json");
  const args = buildCoverageRepairArgs(planPath);

  assert.equal(path.basename(args[0]), "coverage_repair_run.js");
  assert.equal(args[1], planPath);
  assert.equal(args.length, 2);
  assert.doesNotMatch(args.join(" "), /summary_run|llm|media|report/u);
});

test("coverage repair requires an absolute plan path", () => {
  assert.throws(() => buildCoverageRepairArgs("relative-plan.json"), /must be absolute/u);
  assert.throws(() => buildCoverageRepairArgs(""), /must be absolute/u);
});

test("range args are plain argv entries with Beijing time stamped explicitly", () => {
  assert.deepEqual(buildRangeArgs({ type: "hours", hours: "24" }), ["--since-hours", "24"]);
  assert.deepEqual(buildRangeArgs({ type: "days", days: 7 }), ["--days", "7"]);
  assert.deepEqual(
    buildRangeArgs({ type: "custom", start: "2026-09-01 08:00", end: "2026-09-02 08:00" }),
    ["--start", "2026-09-01 08:00 +08:00", "--end", "2026-09-02 08:00 +08:00"],
  );
  assert.throws(() => buildRangeArgs({ type: "custom", start: "yesterday; rm -rf" }), /无效的开始时间/u);
  assert.throws(() => buildRangeArgs({ type: "hours", hours: "0" }), /无效的小时数/u);
});

test("safeCleanupPaths deletes unviewed group-starts json without treating it as coverage-repair work", () => {
  fs.mkdirSync(storeDir, { recursive: true });
  const startsPath = path.join(storeDir, `group-starts-${Date.now()}000.json`);
  fs.writeFileSync(startsPath, "{}\n", "utf8");
  try {
    safeCleanupPaths([startsPath]);
    assert.equal(fs.existsSync(startsPath), false);
  } finally {
    fs.rmSync(startsPath, { force: true });
  }
});

test("safeCleanupPaths deletes a coverage-repair .work directory", () => {
  fs.mkdirSync(coverageRepairRoot, { recursive: true });
  const workDir = path.join(coverageRepairRoot, `test-${Date.now()}.work`);
  fs.mkdirSync(path.join(workDir, "clean-db"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "clean-db", "nt_msg.clean.db"), "x");
  try {
    safeCleanupPaths([workDir]);
    assert.equal(fs.existsSync(workDir), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("safeCleanupPaths refuses the message store, config, and coverage plan json", () => {
  assert.throws(
    () => safeCleanupPaths([path.join(storeDir, "messages.db")]),
    /Refusing to clean/u,
  );
  assert.throws(
    () => safeCleanupPaths([path.join(toolRoot, "config", "defaults.json")]),
    /Refusing to clean/u,
  );
  assert.throws(
    () => safeCleanupPaths([path.join(coverageRepairRoot, "plan.json")]),
    /Refusing to clean/u,
  );
  assert.throws(
    () => safeCleanupPaths([path.join(storeDir, "group-starts-not-a-timestamp.json")]),
    /Refusing to clean/u,
  );
});

test("cleanup failure copy names the job that actually finished", () => {
  const error = new Error("Refusing to clean a path outside job temp roots. path=X");
  assert.match(jobCleanupFailureMessage("coverage-repair", error), /^补扫完成，但临时文件清理失败:/u);
  assert.match(jobCleanupFailureMessage("summary", error), /^任务完成，但临时文件清理失败:/u);
  assert.doesNotMatch(jobCleanupFailureMessage("summary", error), /补扫完成/u);
});
