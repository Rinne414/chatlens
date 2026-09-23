"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { discoverHarvestJobs, harvestExistingRuns } = require("../src/harvest_existing_runs");
const { openKnowledgeStore, upsertImage } = require("../src/knowledge_store");

const makeRuns = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-runs-"));
  const run = path.join(root, "qq-time-last-24h-aaaa-20260821-100635");
  fs.mkdirSync(path.join(run, "analysis"), { recursive: true });
  fs.mkdirSync(path.join(run, "exports"), { recursive: true });
  fs.writeFileSync(path.join(run, "analysis", "media-messages.json"), "[]");
  fs.writeFileSync(path.join(run, "exports", "groups_aaaa_1_2.json"), "{}");
  fs.mkdirSync(path.join(root, "not-a-run", "analysis"), { recursive: true });
  fs.writeFileSync(path.join(root, "not-a-run", "analysis", "media-messages.json"), "[]");
  return root;
};

test("discovers only qq-* runs that still have media-messages.json", () => {
  const root = makeRuns();
  const jobs = discoverHarvestJobs(root);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].runId, "qq-time-last-24h-aaaa-20260821-100635");
  assert.match(jobs[0].mediaMessagesJson, /media-messages\.json$/u);
  assert.match(jobs[0].exportJson, /groups_aaaa_1_2\.json$/u);
});

test("a run without media-messages is skipped, not thrown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-empty-"));
  fs.mkdirSync(path.join(root, "qq-time-last-24h-bbbb"), { recursive: true });
  assert.deepEqual(discoverHarvestJobs(root), []);
});

const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
};

const writePlainPng = (filePath) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
};

const placeOriByMd5 = (root, writer) => {
  const oriDir = path.join(root, "Pic", "2026-08", "Ori");
  fs.mkdirSync(oriDir, { recursive: true });
  const tempPath = path.join(oriDir, "tmp-place.png");
  writer(tempPath);
  const hash = crypto.createHash("md5").update(fs.readFileSync(tempPath)).digest("hex");
  const dest = path.join(oriDir, `${hash}.png`);
  fs.renameSync(tempPath, dest);
  return { hash, dest };
};

const harvestedRecord = (hash, filePath) => ({
  hash,
  filePath,
  fileSize: fs.statSync(filePath).size,
  fileMtime: 1,
  container: "png",
  width: 64,
  height: 64,
  generator: "forge",
  prompt: "1girl, solo",
  negativePrompt: "",
  checkpoint: "test",
  modelHash: "",
  params: {},
  rawChunks: {},
  loras: [],
  parserVersion: 2,
  parsedAt: 1,
});

test("copies Ori for already-harvested rows no remaining run still lists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-existing-"));
  const ntDataDir = path.join(root, "nt_data");
  const { hash, dest } = placeOriByMd5(ntDataDir, writePlainPng);
  const storePath = path.join(root, "store", "knowledge.db");
  const objectDir = path.join(root, "store", "media-objects");
  const db = openKnowledgeStore(storePath);
  upsertImage(db, harvestedRecord(hash, dest));
  db.close();

  const totals = harvestExistingRuns({
    runsDir: path.join(root, "runs"),
    ntDataDir,
    storePath,
    objectDir,
  });

  assert.equal(totals.runs, 0);
  assert.equal(totals.durableStored, 1);
  const check = openKnowledgeStore(storePath);
  const row = check.prepare("SELECT object_path AS objectPath FROM images WHERE hash = ?").get(hash);
  check.close();
  assert.equal(fs.existsSync(row.objectPath), true);
  assert.notEqual(path.resolve(row.objectPath), path.resolve(dest));
});

test("aggregates durable copies from a past run harvest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-existing-run-"));
  const ntDataDir = path.join(root, "nt_data");
  const { hash } = placeOriByMd5(ntDataDir, writePlainPng);
  const runDir = path.join(root, "runs", "qq-time-last-24h-cccc-20260821-100635");
  fs.mkdirSync(path.join(runDir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "analysis", "media-messages.json"), JSON.stringify([{
    groupId: "1001",
    groupName: "Test",
    rowId: "1",
    sentAt: 1700000000,
    speaker: "Alice",
    senderUin: "111",
    mediaRefs: [{ kind: "image", hash }],
  }]), "utf8");
  const storePath = path.join(root, "store", "knowledge.db");
  const objectDir = path.join(root, "store", "media-objects");

  const totals = harvestExistingRuns({
    runsDir: path.join(root, "runs"),
    ntDataDir,
    storePath,
    objectDir,
  });

  assert.equal(totals.runs, 1);
  assert.equal(totals.attributed, 1);
  assert.equal(totals.durableStored, 1);
  const check = openKnowledgeStore(storePath);
  const row = check.prepare("SELECT object_path AS objectPath FROM images WHERE hash = ?").get(hash);
  check.close();
  assert.equal(fs.existsSync(row.objectPath), true);
});
