"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const jpeg = require("jpeg-js");
const messageStore = require("../src/message_store");
const { decodeGray, UnsupportedImage } = require("../src/image_pixels");
const { hashOfGray, distance } = require("../src/picture_hash");
const similar = require("../src/picture_similar");
const gallery = require("../src/gallery_store");

/* ---------- pictures made for the tests ---------- */

// A drawing with large shapes: seed moves them, so different seeds are different pictures.
const drawing = (width, height, seed) => {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const wave = Math.sin((u * (2 + seed % 3) + seed) * Math.PI) * Math.cos((v * (1 + seed % 4) + seed * 0.7) * Math.PI);
      const disc = Math.hypot(u - (0.3 + (seed % 5) * 0.1), v - (0.4 + (seed % 3) * 0.15)) < 0.22 ? 90 : 0;
      const value = Math.max(0, Math.min(255, 128 + wave * 100 + disc));
      rgba.set([value, 255 - value, (value * 0.5 + seed * 20) % 256, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
};

const crc = (buffer) => {
  let value = ~0;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (~value) >>> 0;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
};

// colorType 6 (RGBA) or 2 (RGB); `filter` is applied to every row so the reader's un-filtering is exercised.
const pngOf = ({ width, height, rgba }, { colorType = 6, filter = 0, interlace = 0 } = {}) => {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      rgba.copy(row, x * channels, (y * width + x) * 4, (y * width + x) * 4 + channels);
    }
    raw[y * (stride + 1)] = filter;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? row[index - channels] : 0;
      raw[y * (stride + 1) + 1 + index] = filter === 1 ? (row[index] - left) & 0xff : row[index];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, colorType, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
};

const jpegOf = ({ width, height, rgba }, quality = 80) => jpeg.encode({ width, height, data: rgba }, quality).data;

const hashOf = (bytes) => hashOfGray(decodeGray(bytes));

/* ---------- reading and fingerprinting ---------- */

test("a PNG reads the same whatever its row filter or colour layout", () => {
  const picture = drawing(64, 48, 3);
  const plain = decodeGray(pngOf(picture));
  assert.deepEqual([plain.width, plain.height, plain.gray.length], [64, 48, 64 * 48]);
  assert.deepEqual([...decodeGray(pngOf(picture, { filter: 1 })).gray], [...plain.gray]);
  assert.deepEqual([...decodeGray(pngOf(picture, { colorType: 2 })).gray], [...plain.gray]);
});

test("what cannot be read says so instead of giving a wrong picture", () => {
  assert.throws(() => decodeGray(Buffer.from("GIF89a....")), UnsupportedImage);
  assert.throws(() => decodeGray(pngOf(drawing(16, 16, 1), { interlace: 1 })), UnsupportedImage);
  assert.equal(similar.fingerprintOf(Buffer.from("GIF89a....")).state, "unsupported");
  assert.equal(similar.fingerprintOf(Buffer.from([0xff, 0xd8, 1, 2, 3])).state, "unreadable");
});

test("the same picture as another file keeps its fingerprint; a different picture does not", () => {
  const original = hashOf(pngOf(drawing(400, 300, 2)));
  assert.match(original, /^[0-9a-f]{16}$/u);
  // Smaller, and as a lossy JPEG: still the same picture.
  assert.ok(distance(original, hashOf(pngOf(drawing(198, 148, 2)))) <= similar.SAME_BITS);
  assert.ok(distance(original, hashOf(jpegOf(drawing(400, 300, 2), 50))) <= similar.SAME_BITS);
  assert.ok(distance(original, hashOf(jpegOf(drawing(120, 90, 2), 60))) <= similar.CLOSE_BITS);
  for (const seed of [1, 3, 4, 7]) {
    assert.ok(distance(original, hashOf(pngOf(drawing(400, 300, seed)))) > similar.SEARCH_BITS, `seed ${seed} is a different picture`);
  }
});

test("a picture of one flat colour has no fingerprint", () => {
  const flat = { width: 80, height: 80, rgba: Buffer.alloc(80 * 80 * 4, 200) };
  assert.equal(hashOf(pngOf(flat)), null);
  assert.equal(similar.fingerprintOf(pngOf(flat)).state, "flat");
});

test("the page's 32x32 grey sample gives the fingerprint of the picture it was made from", () => {
  const picture = drawing(320, 240, 5);
  const { width, height, gray } = decodeGray(pngOf(picture));
  // The same area average the page makes (web/gallery_similar.js).
  const sums = new Float64Array(1024);
  const counts = new Uint32Array(1024);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = Math.floor((y * 32) / height) * 32 + Math.floor((x * 32) / width);
      sums[cell] += gray[y * width + x];
      counts[cell] += 1;
    }
  }
  const sample = Buffer.from(sums.map((sum, cell) => Math.round(sum / counts[cell])));
  const answer = similar.fingerprintOfSmallGray(sample.toString("base64"));
  assert.ok(distance(answer.hash, hashOf(pngOf(picture))) <= similar.SAME_BITS);
  assert.equal(similar.fingerprintOfSmallGray("AAAA").state, "unreadable");
  assert.equal(similar.fingerprintOfSmallGray(Buffer.alloc(1024, 255).toString("base64")).state, "flat");
});

/* ---------- the store ---------- */

const md5 = (letter) => letter.repeat(32);
const NOW = 1_790_000_000;

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "similar-"));
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  const put = (hash, kind, name, bytes) => {
    const folder = path.join(dir, "pictures", kind, hash.slice(0, 2));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), bytes);
  };
  try {
    work(db, dir, put);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// a and b are one picture as two files, c is another picture, d an animation,
// e has a thumbnail on record whose file is gone.
const seed = (db, put) => {
  const file = db.prepare("INSERT INTO picture_files (md5, thumb, preview, updated_at) VALUES (?, ?, ?, ?)");
  const posting = db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at)
    VALUES (?, ?, 0, ?, 400, 300, 1000, 1001, ?, ?)`);
  const message = db.prepare("INSERT INTO messages (group_id, row_id, sent_at, speaker, speaker_uin, text, is_media) VALUES (?, ?, ?, ?, ?, '', 1)");
  db.prepare("INSERT INTO group_names (group_id, name) VALUES ('1', '一群'), ('2', '二群')").run();
  const add = (letter, thumb, bytes, postings) => {
    file.run(md5(letter), thumb, "", NOW - 100);
    if (bytes !== null) {
      put(md5(letter), "thumb", thumb, bytes);
    }
    for (const [groupId, rowId, sentAt, speaker] of postings) {
      message.run(groupId, rowId, sentAt, speaker, "1000");
      posting.run(groupId, rowId, md5(letter), sentAt, sentAt + 86400 * 31);
    }
  };
  add("a", `${md5("a")}.png`, pngOf(drawing(198, 148, 2)), [["1", "m1", NOW - 5000, "Alice"]]);
  add("b", `${md5("b")}.jpg`, jpegOf(drawing(198, 148, 2), 92), [["2", "m2", NOW - 3000, "Bob"], ["1", "m3", NOW - 1000, "Carol"]]);
  add("c", `${md5("c")}.png`, pngOf(drawing(198, 148, 7)), [["1", "m4", NOW - 500, "Alice"]]);
  add("d", `${md5("d")}.gif`, Buffer.from("GIF89a...."), [["1", "m5", NOW - 400, "Alice"]]);
  add("e", `${md5("e")}.png`, null, [["1", "m6", NOW - 300, "Alice"]]);
};

test("every picture with a file gets its answer once; one whose file was absent is looked at again when its files change", () => {
  withStore((db, dir, put) => {
    seed(db, put);
    const first = similar.hashPending(db, dir, { limit: 100, nowUnix: NOW });
    assert.deepEqual(first, { hashed: 3, flat: 0, unsupported: 1, unreadable: 0, missing: 1, skipped: 0, left: 0 });
    assert.deepEqual(similar.coverage(db), { hashed: 3, left: 0 });
    // Nothing is pending: a second pass does nothing (the absent one does not block the queue).
    assert.equal(similar.hashPending(db, dir, { limit: 100, nowUnix: NOW + 10 }).hashed, 0);
    put(md5("e"), "thumb", `${md5("e")}.png`, pngOf(drawing(198, 148, 4)));
    db.prepare("UPDATE picture_files SET updated_at = ? WHERE md5 = ?").run(NOW + 20, md5("e"));
    assert.equal(similar.coverage(db).left, 1);
    assert.equal(similar.hashPending(db, dir, { limit: 100, nowUnix: NOW + 30 }).hashed, 1);
  });
});

test("the pass stops when its time is up and carries on next time", () => {
  withStore((db, dir, put) => {
    seed(db, put);
    let asked = 0;
    const cut = similar.hashPending(db, dir, { limit: 100, nowUnix: NOW, deadline: () => { asked += 1; return asked > 2; } });
    assert.equal(cut.hashed + cut.unsupported + cut.missing, 2);
    assert.equal(cut.left, 3);
    assert.equal(similar.hashPending(db, dir, { limit: 100, nowUnix: NOW }).left, 0);
  });
});

test("the same picture is found as another file, closest first, and its story joins every posting", () => {
  withStore((db, dir, put) => {
    seed(db, put);
    similar.hashPending(db, dir, { limit: 100, nowUnix: NOW });
    const index = similar.loadIndex(db);
    const own = similar.hashOfMd5(db, md5("a"));
    const found = similar.nearest(index, own.hash);
    assert.deepEqual(found.map((item) => item.md5), [md5("a"), md5("b")]);
    assert.equal(found[0].bits, 0);
    assert.equal(similar.closeness(found[1].bits), "same");
    assert.deepEqual(similar.nearest(index, own.hash, { excludeMd5: md5("a") }).map((item) => item.md5), [md5("b")]);
    assert.deepEqual(similar.nearest(index, "not-a-hash"), []);
    assert.deepEqual([similar.hashOfMd5(db, md5("d")).state, similar.hashOfMd5(db, md5("z"))], ["unsupported", null]);
    // Wall items in the order asked for, and the postings of both files together.
    const items = gallery.picturesByMd5(db, [md5("b"), md5("a"), md5("z")]);
    assert.deepEqual(items.map((item) => [item.md5, item.posts, item.groups, item.origin.speaker]), [[md5("b"), 2, 2, "Bob"], [md5("a"), 1, 1, "Alice"]]);
    assert.deepEqual(gallery.postingsOf(db, [md5("a"), md5("b")]).map((row) => [row.speaker, row.md5 === md5("a")]), [["Alice", true], ["Bob", false], ["Carol", false]]);
  });
});

test("a store that has no fingerprints yet answers with nothing instead of failing", () => {
  withStore((db) => {
    assert.deepEqual(similar.coverage(db), { hashed: 0, left: 0 });
    assert.equal(similar.loadIndex(db).md5s.length, 0);
    assert.equal(similar.hashOfMd5(db, md5("a")), null);
    assert.equal(similar.indexStamp(db), "none");
  });
});
