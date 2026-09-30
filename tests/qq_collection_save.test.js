"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { savePicture, fileStem } = require("../src/qq_collection_save");

// A PNG header (IHDR) of the given size, then some bytes.
const png = (width, height, body = "picture bytes") => {
  const ihdr = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write("IHDR", 12, "latin1");
  ihdr.writeUInt32BE(width, 16);
  ihdr.writeUInt32BE(height, 20);
  return Buffer.concat([ihdr, Buffer.from(body)]);
};
// A JPEG with one SOF0 segment of the given size.
const jpg = (width, height, body = "jpeg bytes") => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from(body)]);
};
const PNG = png(800, 600);
const JPG = jpg(120, 60, "hotlink placeholder");
const md5 = (buffer) => crypto.createHash("md5").update(buffer).digest("hex");
// 2026-09-15 20:09:12 Beijing.
const COLLECTED_AT = Date.parse("2026-09-15T20:09:12+08:00");

const picture = (extra = {}) => ({ md5: md5(PNG), uin: "10001", uuid: "11111111-2222-3333-4444-555555555555", collectedAt: COLLECTED_AT, width: 800, height: 600, localFiles: [], ...extra });

const withDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-collection-save-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const fakeFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return new Response(next.body ?? null, { status: next.status });
  };
  return { fetchImpl, calls };
};

test("downloads the original (size 0), checks its md5 and names it by collection time", async () => {
  await withDir(async (dir) => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: PNG }]);
    const result = await savePicture(picture(), path.join(dir, "undid"), { fetchImpl });
    assert.equal(result.status, "saved");
    assert.equal(result.source, "download");
    assert.equal(path.basename(result.file), `QQ收藏_20260915-200912_${md5(PNG)}.png`);
    assert.equal(result.recompressed, false);
    assert.deepEqual(fs.readFileSync(result.file), PNG);
    assert.equal(calls[0], "https://shp.qpic.cn/collector/10001/11111111-2222-3333-4444-555555555555/0");
  });
});

test("keeps QQ's re-compressed JPEG when the original is gone: other bytes, same pixel size", async () => {
  await withDir(async (dir) => {
    const recompressed = jpg(800, 600);
    const result = await savePicture(picture(), dir, fakeFetch([{ status: 200, body: recompressed }]));
    assert.equal(result.status, "saved");
    assert.equal(result.recompressed, true);
    assert.equal(path.basename(result.file), `QQ收藏_20260915-200912_${md5(PNG)}.jpg`);
    assert.deepEqual(fs.readFileSync(result.file), recompressed);
    // The folder index must learn the bytes' md5, not the original's.
    assert.equal(result.bytesMd5, md5(recompressed));
  });
});

test("a download bigger than the limit is dropped, not read into memory", async () => {
  await withDir(async (dir) => {
    const big = png(800, 600, "x".repeat(4096));
    const result = await savePicture(picture({ md5: md5(big) }), dir, { ...fakeFetch([{ status: 200, body: big }]), maxBytes: 1024 });
    assert.equal(result.status, "too-big");
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("a write that fails half way (disk full) leaves no cut-off file behind", async () => {
  await withDir(async (dir) => {
    const writeFile = (file, buffer, options) => {
      fs.writeFileSync(file, buffer.subarray(0, 10), options);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    await assert.rejects(savePicture(picture(), dir, { ...fakeFetch([{ status: 200, body: PNG }]), writeFile }), /ENOSPC/u);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("never saves something that is not the recorded picture (a hotlink placeholder)", async () => {
  await withDir(async (dir) => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: JPG }, { status: 200, body: JPG }]);
    const result = await savePicture(picture(), dir, { fetchImpl });
    assert.deepEqual(result, { md5: md5(PNG), status: "mismatch" });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("uses QQ's local original when its md5 matches, without downloading", async () => {
  await withDir(async (dir) => {
    const local = path.join(dir, "cache.png");
    fs.writeFileSync(local, PNG);
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await savePicture(picture({ localFiles: [path.join(dir, "missing.png"), local] }), path.join(dir, "out"), { fetchImpl });
    assert.equal(result.source, "local");
    assert.equal(calls.length, 0);
  });
});

test("gone, network trouble, and a second save of the same picture next to the first", async () => {
  await withDir(async (dir) => {
    assert.equal((await savePicture(picture(), dir, fakeFetch([{ status: 404 }, { status: 404 }]))).status, "gone");
    assert.equal((await savePicture(picture(), dir, fakeFetch([new Error("reset"), { status: 503 }]))).status, "unavailable");
    const first = await savePicture(picture(), dir, fakeFetch([{ status: 200, body: PNG }]));
    const second = await savePicture(picture(), dir, fakeFetch([{ status: 200, body: PNG }]));
    assert.notEqual(first.file, second.file);
    assert.match(path.basename(second.file), / \(2\)\.png$/u);
  });
});

test("file stems use Beijing time", () => {
  assert.equal(fileStem({ md5: "abcdef0123456789abcdef0123456789", collectedAt: Date.parse("2026-01-01T00:30:00+08:00") }), "QQ收藏_20260101-003000_abcdef0123456789abcdef0123456789");
});
