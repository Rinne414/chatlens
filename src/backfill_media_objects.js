"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { backfillHarvestedMediaObjects, backfillMissingMediaObjects } = require("./media_object_store");

const parseArgs = (argv) => {
  if (argv.length !== 3) {
    throw new Error("Usage: node backfill_media_objects.js <toolkitRoot>");
  }
  const toolRoot = path.resolve(argv[2]);
  let ntDataDir = "";
  try {
    const config = JSON.parse(fs.readFileSync(path.join(toolRoot, "config", "defaults.json"), "utf8"));
    if (typeof config.ntDataDir === "string") {
      ntDataDir = config.ntDataDir;
    }
  } catch {
    // file_path on harvested rows is enough when the config cannot be read.
  }
  return {
    toolRoot,
    runsDir: path.join(toolRoot, "runs"),
    objectDir: path.join(toolRoot, "store", "media-objects"),
    knowledgeStorePath: path.join(toolRoot, "store", "knowledge.db"),
    ntDataDir,
  };
};

const main = () => {
  const args = parseArgs(process.argv);
  let lastLogged = 0;
  const harvested = backfillHarvestedMediaObjects({
    knowledgeStorePath: args.knowledgeStorePath,
    objectDir: args.objectDir,
    ntDataDir: args.ntDataDir,
    onProgress: (stats) => {
      const done = stats.durableStored + stats.durableReused + stats.durableFailed;
      if (done - lastLogged < 50) {
        return;
      }
      lastLogged = done;
      process.stderr.write(
        `長期副本進度：新存 ${stats.durableStored}，既有 ${stats.durableReused}，失敗 ${stats.durableFailed}\n`,
      );
    },
  });
  const fromRuns = backfillMissingMediaObjects({
    toolRoot: args.toolRoot,
    runsDir: args.runsDir,
    objectDir: args.objectDir,
    knowledgeStorePath: args.knowledgeStorePath,
  });
  process.stdout.write(`${JSON.stringify({ harvested, fromRuns }, null, 2)}\n`);
};

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
