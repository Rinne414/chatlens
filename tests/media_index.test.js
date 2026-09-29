"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { finalizeMediaIndex } = require("../src/server/toolkit_state");

test("media index keeps every occurrence beyond the former item limits", () => {
  const source = Array.from({ length: 12001 }, (_, index) => ({
    runId: "run-large",
    groupId: "1001",
    groupName: "large-group",
    rowId: String(index),
    hkt: `2026-01-01 00:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
    speaker: "sender",
    kind: "image",
    bytes: index + 1,
    webPath: `/runs/large/${index}.jpg`,
    contentKey: `hash-${index}`,
    contentKeySource: "hash",
    dedupKey: `1001|hash-${index}`,
  }));
  const inputSnapshot = source.map((item) => ({ ...item }));

  const result = finalizeMediaIndex(source, source.length);

  assert.equal(result.truncated, false);
  assert.equal(result.scannedRefs, 12001);
  assert.equal(result.totalItems, 12001);
  assert.equal(result.items.length, 12001);
  assert.equal(result.items.some((item) => item.webPath === "/runs/large/12000.jpg"), true);
  assert.deepEqual(source, inputSnapshot);
});

test("media index retains duplicate occurrences while selecting the newest primary", () => {
  const source = [
    {
      dedupKey: "1001|same", hkt: "2026-01-01 10:00:00", webPath: "/runs/old.jpg", groupId: "1001",
    },
    {
      dedupKey: "1001|same", hkt: "2026-01-01 11:00:00", webPath: "/runs/new.jpg", groupId: "1001",
    },
  ];

  const result = finalizeMediaIndex(source, 2);

  assert.equal(result.totalItems, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find((item) => item.webPath === "/runs/new.jpg").dup, false);
  assert.equal(result.items.find((item) => item.webPath === "/runs/old.jpg").dup, true);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectMediaIndex, newMediaIndexCache, mediaIndexForGroup } = require("../src/server/toolkit_state");

const writeRun = (runsDir, runName, entries) => {
  const mediaDir = path.join(runsDir, runName, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const manifest = entries.map((entry) => {
    const copiedPath = path.join(mediaDir, entry.file);
    if (entry.exists !== false) {
      fs.writeFileSync(copiedPath, Buffer.alloc(entry.bytes ?? 10, 1));
    }
    return { groupId: entry.groupId, groupName: "g", rowId: entry.rowId, hkt: entry.hkt, speaker: "s", kind: "image", hash: entry.file, copiedPath };
  });
  fs.writeFileSync(path.join(mediaDir, "media-manifest.json"), JSON.stringify(manifest));
  return path.join(mediaDir, "media-manifest.json");
};

test("the media index reads each run's files once and serves one group on request", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-index-"));
  const manifestPath = writeRun(runsDir, "qq-run-1", [
    { file: "a.jpg", groupId: "1001", rowId: "1", hkt: "2026-01-01 10:00:00" },
    { file: "b.jpg", groupId: "2002", rowId: "2", hkt: "2026-01-01 11:00:00" },
    { file: "gone.jpg", groupId: "1001", rowId: "3", hkt: "2026-01-01 12:00:00", exists: false },
  ]);
  const cache = newMediaIndexCache();
  const first = await collectMediaIndex(runsDir, cache);
  assert.deepEqual(first.items.map((item) => item.rowId).sort(), ["1", "2"]);

  // Unchanged manifest: the same payload, without looking at the files again.
  fs.rmSync(path.join(runsDir, "qq-run-1", "media", "a.jpg"));
  assert.equal(await collectMediaIndex(runsDir, cache), first);

  // A changed manifest is read again.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(manifestPath, later, later);
  assert.deepEqual((await collectMediaIndex(runsDir, cache)).items.map((item) => item.rowId), ["2"]);

  const group = mediaIndexForGroup(first, "1001");
  assert.deepEqual(group.items.map((item) => item.rowId), ["1"]);
  assert.equal(group.totalItems, 1);
});
