"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pictureAi = require("../src/picture_ai");
const pictureElements = require("../src/picture_elements");
const pictureFetch = require("../src/picture_fetch");
const pictureStore = require("../src/picture_store");
const knowledgeStore = require("../src/knowledge_store");

const MD5 = "ab".repeat(16);
const SENT_AT = 1_700_000_000;

const writeVarint = (value) => {
  const bytes = [];
  let rest = value;
  do {
    const piece = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? piece | 0x80 : piece);
  } while (rest > 0);
  return Buffer.from(bytes);
};

const fieldVarint = (field, value) => Buffer.concat([writeVarint(field * 8), writeVarint(value)]);
const fieldBytes = (field, payload) => Buffer.concat([
  writeVarint(field * 8 + 2),
  writeVarint(payload.length),
  payload,
]);

const pictureElement = ({ subType = null, url, size = 800000, expiresAt = SENT_AT + 100 } = {}) => {
  const parts = [
    fieldVarint(45002, 2),
    fieldBytes(45406, Buffer.from(MD5, "hex")),
    fieldVarint(45405, size),
    fieldVarint(45411, 640),
    fieldVarint(45412, 480),
    fieldVarint(45416, 1001),
    fieldVarint(45505, expiresAt),
    fieldBytes(45804, Buffer.from(url)),
  ];
  if (subType !== null) {
    parts.push(fieldVarint(45003, subType));
  }
  return Buffer.concat(parts);
};

const asResponse = (status, bytes, headers = {}) => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body: {
    getReader() {
      let pending = bytes;
      return {
        async read() {
          if (pending === null) {
            return { done: true, value: undefined };
          }
          const value = pending;
          pending = null;
          return { done: false, value };
        },
        async cancel() {},
      };
    },
  },
});

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qq-pictures-"));

test("extractPictures reads an NT picture, a legacy path, and ignores a quoted picture", () => {
  const nt = pictureElement({ url: "/download?appid=1407&fileid=abc-DEF_1" });
  const wrapped = fieldBytes(1, nt);
  const [picture] = pictureElements.extractPictures(wrapped);
  assert.equal(picture.md5, MD5);
  assert.equal(picture.fileId, "abc-DEF_1");
  assert.equal(picture.legacyPath, "");
  assert.equal(picture.width, 640);
  assert.equal(picture.subType, null);
  assert.equal(pictureElements.isSticker(picture), false);

  const legacyUrl = `/gchatpic_new/0/0-0-${MD5.toUpperCase()}/0?term=255`;
  const [legacy] = pictureElements.extractPictures(pictureElement({ url: legacyUrl }).toString("hex"));
  assert.equal(legacy.fileId, "");
  assert.equal(legacy.legacyPath, `/gchatpic_new/0/0-0-${MD5.toUpperCase()}`);

  const sticker = pictureElements.extractPictures(pictureElement({ url: legacyUrl, subType: 7 }))[0];
  assert.equal(pictureElements.isSticker(sticker), true);

  const quoted = Buffer.concat([
    fieldVarint(45002, 1),
    fieldBytes(8, pictureElement({ url: "/download?appid=1407&fileid=quoted" })),
  ]);
  assert.deepEqual(pictureElements.extractPictures(quoted), []);
  assert.deepEqual(pictureElements.extractPictures("not-hex"), []);
  assert.deepEqual(pictureElements.extractPictures(Buffer.from([0x01])), []);
});

test("picture store records files, prefers the newest upload, and skips dead candidates", () => {
  const dir = tempDir();
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    const base = {
      groupId: "7",
      rowId: "m1",
      md5: MD5,
      fileId: "fid",
      legacyPath: "",
      size: 1000,
      width: 10,
      height: 10,
      format: 1001,
      sentAt: SENT_AT,
    };
    assert.equal(pictureStore.ingestPictures(db, [
      { ...base, seq: 0, expiresAt: 0 },
      { ...base, rowId: "m2", seq: 0, fileId: "newer", expiresAt: SENT_AT + pictureStore.REMOTE_LIFETIME_SECONDS + 10, sentAt: SENT_AT + 10 },
    ]), 2);
    assert.equal(pictureStore.ingestPictures(db, [{ ...base, seq: 0, expiresAt: 0 }]), 0);

    const located = pictureStore.locate(db, MD5);
    assert.equal(located.fileId, "newer");
    assert.equal(located.expiresAt, SENT_AT + pictureStore.REMOTE_LIFETIME_SECONDS + 10);
    const first = db.prepare("SELECT expires_at FROM pictures WHERE row_id = 'm1'").get();
    assert.equal(first.expires_at, SENT_AT + pictureStore.REMOTE_LIFETIME_SECONDS);

    assert.equal(pictureStore.needingThumbs(db, { now: SENT_AT, limit: 10 }).length, 1);
    assert.equal(pictureStore.needingProbe(db, { now: SENT_AT, limit: 10 }).length, 0);
    pictureStore.ingestPictures(db, [{ ...base, rowId: "m3", seq: 0, size: 262144, expiresAt: SENT_AT + 50 }]);
    assert.equal(pictureStore.needingProbe(db, { now: SENT_AT, limit: 10 })[0].rowId, "m3");
    assert.deepEqual(
      pictureStore.needingKeep(db, { now: SENT_AT, limit: 10, groupIds: [] }),
      [],
    );
    assert.equal(pictureStore.needingKeep(db, { now: SENT_AT, limit: 10, groupIds: ["7"] }).length, 1);

    pictureStore.updateFile(db, MD5, { thumb: `${MD5}.jpg`, thumb_bytes: 40, ignored: 1 });
    assert.equal(pictureStore.fileRow(db, MD5).thumb_bytes, 40);
    assert.equal(pictureStore.needingThumbs(db, { now: SENT_AT, limit: 10 }).length, 0);
    pictureStore.updateFile(db, MD5, { failures: 3 });
    assert.equal(pictureStore.pendingCounts(db, SENT_AT).thumbs, 0);

    const byRow = pictureStore.picturesForRows(db, "7", ["m2"]);
    assert.equal(byRow.get("m2")[0].md5, MD5);
    assert.equal(byRow.get("m2")[0].hasThumb, 1);

    const target = pictureStore.picturePath(dir, "thumb", MD5, "jpg");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "thumb");
    pictureStore.removeFile(dir, "thumb", MD5, `${MD5}.jpg`);
    assert.equal(fs.existsSync(target), false);
    assert.throws(() => pictureStore.picturePath(dir, "thumb", "nope", "jpg"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ingesting a media export stores the picture on the media row", () => {
  const dir = tempDir();
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    messageStore.ingestExport(db, {
      messages: [],
      mediaMessages: [{
        groupId: "7",
        rowId: "9",
        sentAt: SENT_AT,
        senderName: "Ann",
        senderUin: "42",
        mediaRefs: [],
        pictures: [{ md5: MD5, fileId: "fid", size: 10, width: 1, height: 1, format: 1000, expiresAt: SENT_AT + 9 }],
      }],
    }, "run-1");
    const message = db.prepare("SELECT row_id, is_media, media_kinds FROM messages").get();
    assert.equal(message.row_id, "m9");
    assert.equal(message.is_media, 1);
    assert.equal(message.media_kinds, "image");
    assert.equal(pictureStore.picturesForRows(db, "7", ["m9"]).get("m9")[0].md5, MD5);
    assert.equal(db.prepare("SELECT file_id FROM pictures").get().file_id, "fid");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch routes, classifies Tencent errors, and checks an original's md5", async () => {
  const picture = { md5: MD5, fileId: "file-1", legacyPath: "/gchatpic_new/0/0-0-ABCDEF" };
  const urls = pictureFetch.urlsFor(picture, "thumb", "rkey-1").map((item) => item.via);
  assert.deepEqual(urls, ["nt", "legacy", "md5"]);
  assert.deepEqual(pictureFetch.urlsFor({ ...picture, fileId: "../x" }, "thumb", "rkey-1").map((item) => item.via), ["legacy", "md5"]);
  assert.equal(pictureFetch.urlsFor(picture, "thumb", "bad key").some((item) => item.via === "nt"), false);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const good = crypto.createHash("md5").update(jpeg).digest("hex");
  const calls = [];
  const fetched = await pictureFetch.fetchPicture(
    { md5: good, fileId: "file-1", legacyPath: "" },
    "original",
    {
      rkey: "rkey-1",
      fetchImpl: async (url) => {
        calls.push(url);
        return asResponse(200, jpeg);
      },
    },
  );
  assert.equal(fetched.outcome, "ok");
  assert.equal(fetched.ext, "jpg");
  assert.equal(calls.length, 1);

  const mismatch = await pictureFetch.fetchPicture(
    { md5: MD5, fileId: "file-1", legacyPath: "" },
    "original",
    { rkey: "rkey-1", fetchImpl: async () => asResponse(200, jpeg) },
  );
  assert.equal(mismatch.outcome, "missing");

  const seen = [];
  const gone = await pictureFetch.fetchHead(
    { md5: MD5, fileId: "file-1", legacyPath: "/gchatpic_new/0/0-0-AB" },
    {
      rkey: "rkey-1",
      fetchImpl: async (url, options) => {
        seen.push(options.headers.Range);
        return asResponse(200, Buffer.from('{"retcode":-5503042}'));
      },
    },
  );
  assert.equal(gone.outcome, "gone");
  assert.deepEqual(seen, [`bytes=0-${pictureFetch.PROBE_BYTES - 1}`]);

  const refused = pictureFetch.classify({ status: 200, bytes: Buffer.from('{"retcode":-5503007}') });
  assert.equal(refused, "rkey");

  const oversized = await pictureFetch.download("https://example.test/a", {
    maxBytes: 10,
    fetchImpl: async () => asResponse(200, Buffer.alloc(0), { "content-length": "11" }),
  });
  assert.equal(oversized.tooLarge, true);
});

test("a 128 KB head recognizes PNG and JPEG metadata", () => {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const withPrompt = Buffer.concat([
    signature,
    pngChunk("tEXt", Buffer.from("parameters\0Steps: 20", "latin1")),
    pngChunk("IDAT", Buffer.from([1])),
  ]);
  assert.equal(pictureFetch.headLooksGenerated(withPrompt), true);
  assert.equal(pictureFetch.headLooksGenerated(Buffer.concat([signature, pngChunk("IDAT", Buffer.from([1]))])), false);
  assert.equal(pictureFetch.headLooksGenerated(Buffer.from("Steps: 20 and a sampler", "latin1")), true);
  assert.equal(pictureFetch.headIsComplete(withPrompt), true);

  const unfinished = Buffer.concat([signature, Buffer.alloc(24)]);
  unfinished.writeUInt32BE(5_000_000, 8);
  assert.equal(pictureFetch.headIsComplete(unfinished, 16), false);
});

test("generated pictures keep an untruncated workflow and do not replace a real parse", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "knowledge.db");
  const md5 = "cd".repeat(16);
  const other = "ef".repeat(16);
  const workflow = "w".repeat(100_000);
  const parsed = {
    container: "png",
    generator: "comfyui",
    prompt: "a cat, long hair",
    negativePrompt: "",
    checkpoint: "model",
    modelHash: "",
    params: { steps: 20 },
    rawChunks: {},
    parserVersion: 3,
    loras: [],
    width: 512,
    height: 768,
  };
  try {
    const existing = knowledgeStore.openKnowledgeStore(dbPath);
    knowledgeStore.upsertImage(existing, {
      ...parsed,
      hash: other,
      generator: "novelai",
      prompt: "keep me",
      filePath: "",
      fileSize: 1,
      fileMtime: 0,
      parsedAt: 1,
    });
    knowledgeStore.upsertImage(existing, {
      ...parsed,
      hash: md5,
      generator: "stripped",
      prompt: "",
      filePath: "",
      fileSize: 1,
      fileMtime: 0,
      parsedAt: 1,
    });
    existing.close();

    const picture = { md5, size: 900000, width: 512, height: 768 };
    pictureAi.recordGenerated({
      knowledgeDbPath: dbPath,
      picture,
      parsed,
      chunks: { workflow, prompt: parsed.prompt },
      occurrences: [{ groupId: "9", rowId: "m15", sentAt: 10, speaker: "Ann", speakerUin: "1", groupName: "G" }],
    });
    pictureAi.recordGenerated({
      knowledgeDbPath: dbPath,
      picture: { ...picture, md5: other },
      parsed: { ...parsed, prompt: "replaced" },
      chunks: { workflow: "short" },
      occurrences: [],
    });

    const db = knowledgeStore.openKnowledgeStore(dbPath);
    try {
      assert.equal(db.prepare("SELECT generator, prompt FROM images WHERE hash = ?").get(md5).generator, "comfyui");
      assert.equal(db.prepare("SELECT prompt FROM images WHERE hash = ?").get(other).prompt, "keep me");
      assert.equal(db.prepare("SELECT row_id, speaker FROM sightings WHERE hash = ?").get(md5).row_id, "15");
      assert.equal(pictureAi.readChunks({ knowledgeDbPath: dbPath, md5 }).workflow.length, 100_000);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the page wires chat thumbnails, the viewer, settings, and the expiring list", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
  const messages = fs.readFileSync(path.join(root, "web", "messages.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "web", "settings.js"), "utf8");
  const backup = fs.readFileSync(path.join(root, "web", "backup.js"), "utf8");
  const knowledge = fs.readFileSync(path.join(root, "web", "knowledge.js"), "utf8");
  assert.match(html, /<script src="\/pictures\.js"><\/script>/u);
  assert.match(messages, /pictureUrl\(picture\.md5, "thumb"\)/u);
  assert.match(messages, /openPictureViewer\(picture\)/u);
  assert.match(settings, /renderPictureSettingsCard\(\)/u);
  assert.match(backup, /renderExpiringPictures\(\)/u);
  assert.match(knowledge, /downloadPictureWorkflow\(item\.hash\)/u);
  assert.equal(fs.existsSync(path.join(root, "web", "pictures.js")), true);
});

test("budget eviction clears ordinary pictures first, then the oldest AI previews, and cleared files are not refetched", () => {
  const dir = tempDir();
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    const md5 = (digit) => digit.repeat(32);
    const picture = (digit, sentAt) => ({
      groupId: "7", rowId: `m${digit}`, seq: 0, md5: md5(digit), fileId: "fid", legacyPath: "",
      size: 2_000_000, width: 1024, height: 1024, format: 1001, sentAt, expiresAt: sentAt + 1000,
    });
    // a: old plain, b: old AI, c: new AI, d: new plain
    pictureStore.ingestPictures(db, [picture("a", SENT_AT), picture("b", SENT_AT + 1), picture("c", SENT_AT + 2), picture("d", SENT_AT + 3)]);
    for (const digit of ["a", "b", "c", "d"]) {
      pictureStore.updateFile(db, md5(digit), { thumb: `${md5(digit)}.png`, thumb_bytes: 100 });
    }
    for (const digit of ["b", "c"]) {
      pictureStore.updateFile(db, md5(digit), { probe: "ai" });
    }

    // Previews: newest AI picture first; plain pictures never get one automatically.
    assert.deepEqual(pictureStore.needingPreviews(db, { now: SENT_AT, limit: 10 }).map((row) => row.md5), [md5("c"), md5("b")]);
    assert.equal(pictureStore.pendingCounts(db, SENT_AT).previews, 2);
    for (const digit of ["b", "c"]) {
      pictureStore.updateFile(db, md5(digit), { preview: `${md5(digit)}.png`, preview_bytes: 1000 });
    }

    const order = (tier) => pictureStore.evictionCandidates(db, tier, 10).map((row) => `${row.kind}:${row.md5[0]}`);
    assert.deepEqual(order("plain-thumb"), ["thumb:a", "thumb:d"]);
    assert.deepEqual(order("plain-preview"), []);
    assert.deepEqual(order("ai-preview"), ["preview:b", "preview:c"]);
    assert.equal(pictureStore.evictionCandidates(db, "ai-preview", 1)[0].bytes, 1000);

    // A cleared thumbnail is not fetched again by the pass...
    pictureStore.updateFile(db, md5("a"), { thumb: "", thumb_bytes: 0, evicted: 1 });
    assert.equal(pictureStore.needingThumbs(db, { now: SENT_AT, limit: 10 }).some((row) => row.md5 === md5("a")), false);
    assert.equal(pictureStore.pendingCounts(db, SENT_AT).thumbs, 0);
    // ...and a cleared AI preview is not either.
    pictureStore.updateFile(db, md5("b"), { preview: "", preview_bytes: 0, evicted: 1 });
    assert.deepEqual(pictureStore.needingPreviews(db, { now: SENT_AT, limit: 10 }), []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a picture_files table from before the evicted column gets it on open", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "messages.db");
  const Database = require("better-sqlite3-multiple-ciphers");
  const old = new Database(dbPath);
  old.prepare("CREATE TABLE picture_files (md5 TEXT PRIMARY KEY, thumb TEXT NOT NULL DEFAULT '', last_used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)").run();
  old.close();
  const db = messageStore.openStore(dbPath);
  try {
    const columns = db.prepare("PRAGMA table_info(picture_files)").all().map((column) => column.name);
    assert.equal(columns.includes("evicted"), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the expiring AI count is not capped by the list and skips saved or deleted pictures", () => {
  const dir = tempDir();
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    const DAY = 86400;
    const rows = [["1", 2 * DAY], ["2", 5 * DAY], ["3", 20 * DAY], ["4", 3 * DAY], ["5", 4 * DAY]].map(([digit, left]) => ({
      groupId: "7", rowId: `m${digit}`, seq: 0, md5: digit.repeat(32), fileId: "fid", legacyPath: "",
      size: 2_000_000, width: 1, height: 1, format: 1001, sentAt: SENT_AT, expiresAt: SENT_AT + left,
    }));
    pictureStore.ingestPictures(db, rows);
    for (const row of rows) {
      pictureStore.updateFile(db, row.md5, { probe: "ai" });
    }
    pictureStore.updateFile(db, "4".repeat(32), { kept: 1 });
    pictureStore.updateFile(db, "5".repeat(32), { gone: 1 });

    assert.equal(pictureStore.expiringAi(db, { now: SENT_AT, limit: 1 }).length, 1);
    assert.equal(pictureStore.countExpiringAi(db, { now: SENT_AT }), 3);
    assert.equal(pictureStore.countExpiringAi(db, { now: SENT_AT, withinSeconds: 7 * DAY }), 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("background workers stop starting items after the deadline or a stop", async () => {
  const { runLimited } = require("../src/server/picture_pass");
  const started = [];
  const slowWork = (item) => new Promise((resolve) => {
    started.push(item);
    setTimeout(resolve, 20);
  });
  await runLimited([1, 2, 3, 4, 5, 6], 2, slowWork, { deadline: Date.now() + 5, stopped: () => false });
  assert.deepEqual(started, [1, 2]);

  started.length = 0;
  let stop = false;
  await runLimited([1, 2, 3, 4], 1, async (item) => {
    started.push(item);
    stop = item === 2;
  }, { stopped: () => stop });
  assert.deepEqual(started, [1, 2]);
});

test("download key candidates are parsed, found in memory text, and the first that works is chosen", async () => {
  const rkey = require("../src/rkey");
  const good = "G".repeat(50);
  const other = "B".repeat(50);
  assert.deepEqual(
    rkey.parseCandidates(`2\t${other}\r\n5\t${good}\nnot a line\n3\tshort\n`).map((item) => item.key),
    [good, other],
  );

  const found = new Map();
  const text = `xx rkey=${good}&spec=0 yy rkey=tooShort zz rkey=${good}`;
  rkey.collectFromBuffer(Buffer.from(text, "ascii"), text.length, found);
  assert.deepEqual([...found], [[good, 2]]);

  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24)]);
  const refused = Buffer.from('{"retcode":-5503007}');
  const tried = [];
  const fetchImpl = async (url) => {
    const key = new URL(url).searchParams.get("rkey");
    tried.push(key);
    return asResponse(key === good ? 200 : 400, key === good ? png : refused);
  };
  const picked = await rkey.pickWorking([{ key: other }, { key: good }], { md5: MD5, fileId: "fid", legacyPath: "" }, { fetchImpl });
  assert.equal(picked.key, good);
  assert.deepEqual(tried, [other, good]);
});
