"use strict";

// Replays harvest_run_media over every past run that still has
// analysis/media-messages.json. That is how group sightings and kkt answers
// land in the knowledge base without waiting for the next live summary.
// After the per-run pass, Ori files for already-harvested rows (including
// hashes no remaining run still lists) are copied into store/media-objects.
// Read-only with respect to QQ.

const fs = require("node:fs");
const path = require("node:path");
const { harvestRunMedia } = require("./harvest_run_media");
const { backfillHarvestedMediaObjects } = require("./media_object_store");

const defaultObjectDir = (storePath) => path.join(path.dirname(path.resolve(storePath)), "media-objects");

const discoverHarvestJobs = (runsDir) => {
  if (!fs.existsSync(runsDir)) {
    return [];
  }
  const jobs = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("qq-")) {
      continue;
    }
    const runDir = path.join(runsDir, entry.name);
    const mediaMessagesJson = path.join(runDir, "analysis", "media-messages.json");
    if (!fs.existsSync(mediaMessagesJson)) {
      continue;
    }
    let exportJson = "";
    const exportDir = path.join(runDir, "exports");
    if (fs.existsSync(exportDir)) {
      const names = fs.readdirSync(exportDir).filter((name) => name.endsWith(".json"));
      const preferred = names.find((name) => name.startsWith("groups_")) ?? names[0];
      if (preferred !== undefined) {
        exportJson = path.join(exportDir, preferred);
      }
    }
    jobs.push({ runId: entry.name, mediaMessagesJson, exportJson });
  }
  return jobs.sort((left, right) => left.runId.localeCompare(right.runId));
};

const harvestExistingRuns = ({ runsDir, ntDataDir, storePath, objectDir = "" }) => {
  const jobs = discoverHarvestJobs(runsDir);
  const resolvedObjectDir = objectDir === "" ? defaultObjectDir(storePath) : objectDir;
  const totals = {
    runs: jobs.length,
    imageRefs: 0,
    parsed: 0,
    stripped: 0,
    attributed: 0,
    originalMissing: 0,
    promptRequests: 0,
    answeredRequests: 0,
    failed: 0,
    durableStored: 0,
    durableReused: 0,
    durableFailed: 0,
  };
  for (const job of jobs) {
    try {
      const { stats } = harvestRunMedia({
        mediaMessagesJson: job.mediaMessagesJson,
        ntDataDir,
        storePath,
        exportJson: job.exportJson,
        objectDir: resolvedObjectDir,
      });
      totals.imageRefs += stats.imageRefs ?? 0;
      totals.parsed += stats.parsed ?? 0;
      totals.stripped += stats.stripped ?? 0;
      totals.attributed += stats.attributed ?? 0;
      totals.originalMissing += stats.originalMissing ?? 0;
      totals.promptRequests += stats.promptRequests ?? 0;
      totals.answeredRequests += stats.answeredRequests ?? 0;
      totals.durableStored += stats.durableStored ?? 0;
      totals.durableReused += stats.durableReused ?? 0;
      totals.durableFailed += stats.durableFailed ?? 0;
    } catch {
      totals.failed += 1;
    }
  }
  // Rows harvested before durable copies existed are not in any remaining
  // media-messages.json. Copy those Ori files once the per-run pass is done.
  if (fs.existsSync(storePath)) {
    const backfill = backfillHarvestedMediaObjects({
      knowledgeStorePath: storePath,
      objectDir: resolvedObjectDir,
      ntDataDir,
    });
    totals.durableStored += backfill.durableStored;
    totals.durableReused += backfill.durableReused;
    totals.durableFailed += backfill.durableFailed;
  }
  return totals;
};

const main = () => {
  if (process.argv.length < 5) {
    throw new Error("Usage: node harvest_existing_runs.js <runsDir> <ntDataDir> <knowledgeStorePath>");
  }
  const totals = harvestExistingRuns({
    runsDir: process.argv[2],
    ntDataDir: process.argv[3],
    storePath: process.argv[4],
  });
  process.stdout.write(`${JSON.stringify(totals)}\n`);
};

if (require.main === module) {
  main();
}

module.exports = { discoverHarvestJobs, harvestExistingRuns };
