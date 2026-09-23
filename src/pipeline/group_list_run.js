"use strict";

// Refreshes the group directory from the mirrored group_info database.
// Replaces list_groups.ps1.

const path = require("node:path");
const { loadConfig } = require("../server/toolkit_state");
const { readSecretSync } = require("../secrets");
const common = require("./common");

const main = async () => {
  const config = loadConfig();
  const outputPath = path.join(config.reportsDir, `group-list-${common.localStamp()}.txt`);
  const env = { NTQQ_DB_KEY: readSecretSync("ntqqKey") };
  common.progress("copy-start");
  await common.withFreshMirror(config, "group-list", async (mirror) => {
    common.progress("list-start");
    await common.runNodeScriptOrThrow("list_groups.js", [mirror.groupDb, outputPath], { env }, "读取群列表失败");
  });
  common.result("groupListPath", outputPath);
};

if (require.main === module) {
  common.runMain(main);
}
