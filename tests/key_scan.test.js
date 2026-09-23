"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hasUsefulShape, scanBuffer } = require("../src/key_candidates");
const { parseMaps, scanProcess, findQqPids } = require("../src/linux_key_scan");

const KEY = "aB3$dE5fG7hI9jK1";

test("key shape filter keeps mixed keys and drops boring strings", () => {
  assert.equal(hasUsefulShape(KEY), true);
  assert.equal(hasUsefulShape("abcdefghijklmnop"), false);
  assert.equal(hasUsefulShape("aaaa1111aaaa1111"), false);
  assert.equal(hasUsefulShape("Kx9#Kx9#Kx9#Kx9#"), false);
});

test("finds 16/32-char keys stored as ASCII or UTF-16LE, not longer runs", () => {
  const long32 = "Qw3rTy7uI9oP1aS5dF7gH9jK2lZ4xC6v";
  const buffer = Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(KEY, "latin1"),
    // A non-printable byte right after the ASCII key: otherwise its last char
    // plus the NUL would read as one more UTF-16 character (same as the
    // Windows scanner, which the real key has never tripped over).
    Buffer.from([1, 0]),
    Buffer.from(long32, "utf16le"),
    Buffer.from([0, 0, 9]),
    Buffer.from(`${KEY}X`, "latin1"),
    Buffer.from([0]),
  ]);
  const candidates = new Set();
  scanBuffer(buffer, buffer.length, candidates);
  assert.ok(candidates.has(KEY));
  assert.ok(candidates.has(long32));
  assert.equal(candidates.has(`${KEY}X`), false);
});

test("parses /proc maps into readable anonymous regions only", () => {
  const maps = [
    "00400000-00452000 r-xp 00000000 08:02 173521 /opt/QQ/qq",
    "01000000-01021000 rw-p 00000000 00:00 0 [heap]",
    "7f0000000000-7f0000100000 rw-p 00000000 00:00 0 ",
    "7f0000200000-7f0000300000 ---p 00000000 00:00 0 ",
    "7f0000400000-7f0000500000 r--p 00000000 08:02 99 /usr/lib/libc.so.6",
    "7ffd00000000-7ffd00021000 rw-p 00000000 00:00 0 [stack]",
  ].join("\n");
  assert.deepEqual(parseMaps(maps), [
    { start: 0x01000000, end: 0x01021000 },
    { start: 0x7f0000000000, end: 0x7f0000100000 },
  ]);
});

test("scans a process's memory through a /proc-like tree", () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  const pidDir = path.join(procRoot, "4242");
  fs.mkdirSync(pidDir);
  fs.writeFileSync(path.join(pidDir, "comm"), "qq\n");
  fs.writeFileSync(path.join(pidDir, "maps"), "00001000-00005000 rw-p 00000000 00:00 0 [heap]\n");
  const mem = Buffer.alloc(0x5000);
  mem.write(KEY, 0x2ffa, "latin1");
  fs.writeFileSync(path.join(pidDir, "mem"), mem);

  assert.deepEqual(findQqPids(procRoot), [4242]);
  const candidates = new Set();
  const report = scanProcess(4242, candidates, procRoot);
  assert.equal(report.error, null);
  assert.equal(report.scannedBytes, 0x4000);
  assert.ok(candidates.has(KEY));
});
