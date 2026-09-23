"use strict";

// Low-priority coverage repair over the shared database mirror (earlier
// versions copied a full 10 GB snapshot per repair plan). Only messages and
// coverage are written — no LLM, no reports, no media copies.
//
//   node src/pipeline/coverage_repair_run.js <planPath>

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../server/toolkit_state");
const { readSecretSync } = require("../secrets");
const { lowerOwnPriority } = require("../platform");
const common = require("./common");

const PLAN_ID_PATTERN = /^[a-f0-9]{24}$/u;

const main = async () => {
  const planPath = path.resolve(process.argv[2] ?? "");
  if (!fs.existsSync(planPath)) {
    throw new Error(`找不到覆盖补扫计划。PlanPath=${planPath}`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (!PLAN_ID_PATTERN.test(String(plan.planId ?? ""))) {
    throw new Error(`覆盖补扫计划 ID 无效。PlanPath=${planPath}`);
  }
  const config = loadConfig();
  const scanLimit = Number(config.defaultScanLimit);
  if (!Number.isInteger(scanLimit) || scanLimit <= 0) {
    throw new Error(`配置中的 defaultScanLimit 必须大于 0。Value=${config.defaultScanLimit}`);
  }
  lowerOwnPriority();
  const planRoot = path.dirname(planPath);
  const workDir = path.join(planRoot, `${plan.planId}.work`);
  const statePath = path.join(planRoot, `${plan.planId}.state.json`);
  const env = { NTQQ_DB_KEY: readSecretSync("ntqqKey") };

  common.progress("coverage-copy-start");
  await common.withFreshMirror(config, "coverage-repair", async (mirror) => {
    common.progress("coverage-copy-done");
    common.progress("coverage-repair-start");
    await common.runNodeScriptOrThrow(
      "coverage_repair.js",
      [planPath, statePath, mirror.messageDb, mirror.groupDb, common.storeDbPath, scanLimit, path.join(workDir, "chunks")],
      { env },
      "覆盖补扫失败，可再次点击同一缺口继续",
    );
  });
  common.progress("coverage-cleanup-start");
  fs.rmSync(workDir, { recursive: true, force: true });
  common.progress("coverage-cleanup-done");
};

if (require.main === module) {
  common.runMain(main);
}
