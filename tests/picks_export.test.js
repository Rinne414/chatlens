"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LEDGER_SCHEMA,
  groupFolderName,
  listPicks,
  savePicks,
  sanitizeStem,
} = require("../src/picks_export");

const makeWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picks-"));
  fs.mkdirSync(path.join(root, "store"), { recursive: true });
  fs.mkdirSync(path.join(root, "runs", "sample"), { recursive: true });
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  return root;
};

const writeSource = (root, name, bytes) => {
  const filePath = path.join(root, "runs", "sample", name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

const item = (root, name, bytes, overrides = {}) => ({
  sourcePath: writeSource(root, name, bytes),
  webPath: `/runs/sample/${name}`,
  groupId: "900001",
  groupName: "测试群甲",
  speaker: "翕然",
  hkt: "2026-09-01 12:34:56",
  kind: "image",
  ...overrides,
});

test("strips characters Windows forbids in folder and file stems", () => {
  assert.equal(sanitizeStem('a<b>c:d"e/f\\g|h?i*j', "fallback"), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitizeStem("CON", "safe"), "safe");
  assert.equal(sanitizeStem("name.", "safe"), "name");
  assert.equal(sanitizeStem("", "safe"), "safe");
});

test("group folders stay inside picks and keep the numeric group id", () => {
  assert.equal(groupFolderName({ groupId: "900001", groupName: "测试群甲" }), "测试群甲-900001");
  assert.equal(groupFolderName({ groupId: "900001", groupName: "../escape" }), "_escape-900001");
  assert.equal(groupFolderName({ groupId: "900002", groupName: "" }), "900002");
  assert.throws(() => groupFolderName({ groupId: "../x", groupName: "A" }), /numeric group id/u);
});

test("saves originals into a stable per-group album instead of a timestamped dump", () => {
  const root = makeWorkspace();
  const source = item(root, "photo.png", "png-bytes-one");

  const result = savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [source] });

  assert.equal(result.saved, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.folders.length, 1);
  assert.match(result.folders[0], /picks[\\/]测试群甲-900001$/u);
  const files = fs.readdirSync(result.folders[0]);
  assert.equal(files.length, 1);
  assert.match(files[0], /^20260901_翕然_[0-9a-f]{8}\.png$/u);
  assert.equal(fs.readFileSync(path.join(result.folders[0], files[0]), "utf8"), "png-bytes-one");
});

test("a second save of the same bytes is a no-op even from another group", () => {
  const root = makeWorkspace();
  const first = item(root, "a.png", "same-bytes");
  savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [first] });
  const second = item(root, "b.png", "same-bytes", {
    groupId: "900002",
    groupName: "测试群乙.anima",
    speaker: "someone",
  });

  const result = savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [second] });

  assert.equal(result.saved, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedHashes.length, 1);
  assert.equal(fs.readdirSync(path.join(root, "reports", "picks")).length, 1);
});

test("mixed groups land in their own albums in one call", () => {
  const root = makeWorkspace();
  const items = [
    item(root, "one.png", "bytes-one"),
    item(root, "two.jpg", "bytes-two", { groupId: "900002", groupName: "测试群乙.anima", speaker: "Bo" }),
  ];

  const result = savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items });

  assert.equal(result.saved, 2);
  assert.equal(result.folders.length, 2);
  assert.ok(fs.existsSync(path.join(root, "reports", "picks", "测试群甲-900001")));
  assert.ok(fs.existsSync(path.join(root, "reports", "picks", "测试群乙.anima-900002")));
});

test("missing source files are reported as failed and do not abort the rest", () => {
  const root = makeWorkspace();
  const ok = item(root, "ok.png", "ok-bytes");
  const missing = {
    sourcePath: path.join(root, "runs", "sample", "gone.png"),
    webPath: "/runs/sample/gone.png",
    groupId: "900001",
    groupName: "测试群甲",
    speaker: "x",
    hkt: "2026-09-01 00:00:00",
  };

  const result = savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [missing, ok] });

  assert.equal(result.saved, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].webPath, "/runs/sample/gone.png");
  assert.match(result.failed[0].reason, /不存在/u);
});

test("empty selection is rejected", () => {
  const root = makeWorkspace();
  assert.throws(
    () => savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [] }),
    /没有选中/u,
  );
});

test("refuses an unrecognised ledger file instead of overwriting it", () => {
  const root = makeWorkspace();
  const ledgerFile = path.join(root, "store", "picks-ledger.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ schema: "someone.else", picks: {} }));

  assert.throws(
    () => savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [item(root, "x.png", "x")] }),
    /不是本工具的精选记录/u,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).schema, "someone.else");
});

test("listPicks returns saved hashes so the gallery can mark already-kept files", () => {
  const root = makeWorkspace();
  const saved = savePicks({
    toolRoot: root,
    reportsDir: path.join(root, "reports"),
    items: [item(root, "mark.png", "mark-bytes")],
  });

  const listed = listPicks(root);

  assert.equal(listed.count, 1);
  assert.equal(listed.items[0].hash, saved.hashes[0]);
  assert.equal(listed.items[0].groupId, "900001");
  assert.equal(listed.schema, LEDGER_SCHEMA);
});

test("listPicks keeps the gallery content key so thumbs stay marked after reload", () => {
  const root = makeWorkspace();
  const qqHash = "e".repeat(32);
  const webPath = `/runs/sample/Thumb/${qqHash}_0.jpg`;

  savePicks({
    toolRoot: root,
    reportsDir: path.join(root, "reports"),
    items: [item(root, "thumb.jpg", "thumb-bytes-not-matching-qq-hash", { contentKey: qqHash, webPath })],
  });

  const listed = listPicks(root);

  assert.equal(listed.items[0].contentKey, qqHash);
  assert.equal(listed.items[0].webPath, webPath);
  assert.notEqual(listed.items[0].hash, qqHash);
});

test("a later save of the same thumb backfills identity onto an older ledger row", () => {
  const root = makeWorkspace();
  const first = item(root, "thumb.jpg", "same-thumb-bytes", { webPath: "", contentKey: "" });
  savePicks({ toolRoot: root, reportsDir: path.join(root, "reports"), items: [first] });
  const qqHash = "f".repeat(32);
  const webPath = `/runs/sample/Thumb/${qqHash}_0.jpg`;

  savePicks({
    toolRoot: root,
    reportsDir: path.join(root, "reports"),
    items: [item(root, "thumb-again.jpg", "same-thumb-bytes", { contentKey: qqHash, webPath })],
  });

  const listed = listPicks(root);
  assert.equal(listed.count, 1);
  assert.equal(listed.items[0].contentKey, qqHash);
  assert.equal(listed.items[0].webPath, webPath);
});
