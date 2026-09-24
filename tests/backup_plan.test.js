"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const plan = require("../src/backup_plan");

const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const HASH_C = "c".repeat(32);

const message = (rowId, hkt, mediaRefs, extra = {}) => ({
  groupId: "1001",
  groupName: "画图:群/测试?",
  rowId,
  sentAt: Date.parse(`${hkt.replace(" ", "T")}+08:00`) / 1000,
  hkt,
  speaker: "Alice",
  mediaRefs,
  ...extra,
});

const image = (hash) => ({ source: "fileToken", kind: "image", hash, fileName: `${hash.toUpperCase()}.png`, localPath: null, url: null });

test("safeSegment makes any group or nickname a valid Windows path segment", () => {
  assert.equal(plan.safeSegment('画图:群/测试?', "群"), "画图_群_测试_");
  assert.equal(plan.safeSegment("  trailing dots... ", "x"), "trailing dots");
  assert.equal(plan.safeSegment("CON", "x"), "_CON");
  // Bidi overrides (seen in real nicknames) could disguise an extension.
  assert.equal(plan.safeSegment("Wenaka\u2067~喵\u2067\u202d\u202dgpj.exe", "x"), "Wenaka~喵gpj.exe");
  assert.equal(plan.safeSegment("", "某人"), "某人");
  assert.equal([...plan.safeSegment("长".repeat(100), "x", 10)].length, 10);
});

test("a video's preview picture and alternate refs become one entry", () => {
  const entries = plan.entriesOf({
    mediaRefs: [
      { kind: "video", source: "localPath", hash: null, fileName: "v.mp4", localPath: "C:\\v.mp4" },
      { kind: "image", source: "localPath", hash: HASH_A, fileName: `${HASH_A}_750.jpg`, localPath: "C:\\Thumb\\x.jpg" },
      { kind: "video", source: "fileToken", hash: "44d48996c5ac425bbac65abb787de7d7", fileName: "v.mp4", localPath: null },
    ],
  });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.refs.length]), [["video", 2]]);

  const pictures = plan.entriesOf({ mediaRefs: [image(HASH_A), { ...image(HASH_A), source: "url" }, image(HASH_B)] });
  assert.deepEqual(pictures.map((entry) => [entry.kind, entry.refs.length]), [["image", 2], ["image", 1]]);
});

test("planBackup classifies AI and asked pictures, dedupes per group and honours the ledger", () => {
  const knowledge = new Map([[HASH_A, { params: true, asks: 0 }], [HASH_B, { params: false, asks: 2 }]]);
  const messages = [
    message("3", "2026-09-23 10:00:05", [image(HASH_A)]),
    message("1", "2026-09-22 09:00:00", [image(HASH_B)]),
    message("2", "2026-09-22 09:30:00", [image(HASH_C)]),
    message("4", "2026-09-23 11:00:00", [image(HASH_A)]),
    message("5", "2026-09-23 12:00:00", [{ kind: "audio", source: "fileToken", hash: HASH_C, fileName: "v.amr", localPath: null }]),
  ];
  const ledger = { items: { [`1001|image|${HASH_C}`]: { path: "x", status: "original" }, [`1001|image|${HASH_B}`]: { path: "y", status: "thumb" } } };
  const result = plan.planBackup({ messages, knowledge, categories: {}, ledger });
  assert.equal(result.duplicates, 1);
  // A saved thumbnail is not "backed up": it is retried until an original turns up.
  assert.deepEqual(result.items.map((item) => [item.hash.slice(0, 1), item.category, item.alreadySaved, item.ledgerStatus]), [
    ["b", "askedImages", false, "thumb"],
    ["c", "images", true, "original"],
    ["a", "aiImages", false, null],
  ]);
  const first = result.items[0];
  assert.equal(first.relativeDir, "画图_群_测试__1001/2026-09");
  assert.equal(first.stem, `20260922-090000_Alice_${HASH_B.slice(0, 8)}`);

  // Only AI pictures wanted: the asked one and the plain one drop out.
  const onlyAi = plan.planBackup({ messages, knowledge, categories: { askedImages: false, images: false } });
  assert.deepEqual(onlyAi.items.map((item) => item.category), ["aiImages"]);
  // Voice is off by default, on when asked for.
  assert.equal(plan.planBackup({ messages, knowledge, categories: { voice: true } }).items.filter((item) => item.kind === "audio").length, 1);
});

test("sidecar carries parameters, prompts and the chat request history", () => {
  const text = plan.sidecarText(
    { groupId: "1001", groupName: "画图群", speaker: "Alice", hkt: "2026-09-23 10:00:05" },
    {
      generator: "comfyui",
      checkpoint: "anima-base",
      loras: [{ name: "style", weight: 0.8 }],
      params: { steps: 30, cfgScale: 4, seed: 42 },
      width: 832,
      height: 1216,
      prompt: "1girl, solo",
      negativePrompt: "lowres",
      requests: [{ asker: "Bob", askText: "求咒语", askHkt: "2026-09-23 10:01", answerBy: "Alice", answerText: "1girl, solo" }],
    },
  );
  assert.match(text, /来源：画图群（1001） · Alice · 2026-09-23 10:00:05/u);
  assert.match(text, /LoRA：style @0\.8/u);
  assert.match(text, /参数：steps 30 · CFG 4 · seed 42 · 832×1216/u);
  assert.match(text, /咒语：\r\n1girl, solo/u);
  assert.match(text, /- 2026-09-23 10:01 Bob：求咒语\r\n {2}Alice 回复：1girl, solo/u);
});

test("day log links saved media and the CSV escapes and opens in Excel", () => {
  const log = plan.renderDayLog([
    { hkt: "2026-09-23 10:00:05", speaker: "Alice", text: "看这张", isMedia: 0, rowId: "1" },
    { hkt: "2026-09-23 10:00:06", speaker: "Alice", text: "garbage", isMedia: 1, mediaKinds: "image", rowId: "m77" },
    { hkt: "2026-09-23 10:00:07", speaker: "Bob", text: "", isMedia: 1, mediaKinds: "video", rowId: "m78" },
  ], new Map([["77", ["../2026-09/a.png"]]]), { groupName: "画图群", groupId: "1001", day: "2026-09-23" });
  assert.match(log, /\[10:00:06\] Alice: \[图片\] \.\.\/2026-09\/a\.png/u);
  assert.match(log, /\[10:00:07\] Bob: \[视频\]\r\n/u);
  assert.doesNotMatch(log, /garbage/u);

  const csv = plan.indexCsv([{ groupName: 'a,"b"', groupId: "1", hkt: "t", sentAt: 1, speaker: "s", kind: "image", category: "aiImages", path: "p", bytes: 3, status: "original", hash: HASH_A }]);
  assert.ok(csv.startsWith("\uFEFF群,群号"));
  assert.match(csv, /"a,""b""",1,t,s,图片,AI 图,p,3,原文件,a{32}/u);
});

test("the verdict is safe only when every wanted file was saved as an original", () => {
  const item = (key, groupId, kind, status, extra = {}) => ({
    key, groupId, groupName: `g${groupId}`, kind, category: "images", hkt: "2026-09-23 10:00:00", speaker: "A",
    alreadySaved: false, resolution: { status, bytes: 10 }, ...extra,
  });
  const report = plan.summarizeBackup([
    item("1", "1", "image", "original"),
    item("2", "1", "image", "remote"),
    item("3", "1", "video", "original", { alreadySaved: true }),
    item("4", "2", "image", "thumb"),
    item("5", "2", "video", "missing"),
    item("6", "2", "image", "compressed", { keptPrevious: true }),
  ], { logs: new Map([["1", 3]]) });
  const [check, safe] = report.groups;
  assert.equal(check.groupId, "2");
  assert.equal(check.verdict, "check");
  assert.equal(check.gaps, 3);
  assert.deepEqual(check.missingSamples.map((sample) => sample.status), ["thumb", "missing", "compressed"]);
  assert.deepEqual(check.byKind.image, { total: 2, saved: 1, already: 1, compressed: 1, thumbOnly: 1, missing: 0, bytes: 20 });
  assert.equal(safe.verdict, "safe");
  assert.equal(safe.logDays, 3);
  assert.deepEqual(safe.byKind.image, { total: 2, saved: 2, already: 0, compressed: 0, thumbOnly: 0, missing: 0, bytes: 20 });
  assert.equal(report.safe, false);
  assert.equal(report.totals.total, 6);
});
