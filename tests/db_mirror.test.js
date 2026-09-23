"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BLOCK_BYTES, detectPrefixBytes, syncMirror, withMirrorLock } = require("../src/db_mirror");

const FAKE_HEADER = Buffer.concat([Buffer.from("SQLite header 3\0", "latin1"), Buffer.alloc(1024 - 16, 7)]);

const makeSourceDir = (bodyBytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-src-"));
  const body = crypto.randomBytes(bodyBytes);
  fs.writeFileSync(path.join(dir, "nt_msg.db"), Buffer.concat([FAKE_HEADER, body]));
  fs.writeFileSync(path.join(dir, "nt_msg.db-wal"), Buffer.from("wal-v1"));
  fs.writeFileSync(path.join(dir, "group_info.db"), Buffer.concat([FAKE_HEADER, Buffer.from("group-body")]));
  return { dir, body };
};

const mirrorBody = (mirrorDir) => fs.readFileSync(path.join(mirrorDir, "nt_msg.clean.db"));

test("detects the QQ fake header and leaves plain files alone", () => {
  const { dir } = makeSourceDir(10);
  assert.equal(detectPrefixBytes(path.join(dir, "nt_msg.db")), 1024);
  const plain = path.join(dir, "plain.db");
  fs.writeFileSync(plain, crypto.randomBytes(64));
  assert.equal(detectPrefixBytes(plain), 0);
});

test("first sync strips the prefix and copies sidecars", () => {
  const { dir, body } = makeSourceDir(BLOCK_BYTES * 3 + 123);
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-dst-"));
  const result = syncMirror({ ntDbDir: dir, mirrorDir });
  assert.ok(mirrorBody(mirrorDir).equals(body));
  assert.equal(result.stats["nt_msg.db"].fullRewrite, true);
  assert.equal(result.stats["nt_msg.db"].changedBlocks, 4);
  assert.equal(fs.readFileSync(path.join(mirrorDir, "nt_msg.clean.db-wal"), "utf8"), "wal-v1");
  assert.equal(fs.readFileSync(path.join(mirrorDir, "group_info.clean.db"), "utf8"), "group-body");
});

test("second sync rewrites only the changed block and tracks growth and removed sidecars", () => {
  const { dir, body } = makeSourceDir(BLOCK_BYTES * 3 + 123);
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-dst-"));
  syncMirror({ ntDbDir: dir, mirrorDir });

  const changed = Buffer.from(body);
  changed[BLOCK_BYTES + 10] ^= 0xff;
  const grown = Buffer.concat([changed, crypto.randomBytes(50)]);
  fs.writeFileSync(path.join(dir, "nt_msg.db"), Buffer.concat([FAKE_HEADER, grown]));
  fs.rmSync(path.join(dir, "nt_msg.db-wal"));

  const result = syncMirror({ ntDbDir: dir, mirrorDir });
  assert.ok(mirrorBody(mirrorDir).equals(grown));
  assert.equal(result.stats["nt_msg.db"].fullRewrite, false);
  // The flipped block plus the (grown) last block.
  assert.equal(result.stats["nt_msg.db"].changedBlocks, 2);
  assert.equal(fs.existsSync(path.join(mirrorDir, "nt_msg.clean.db-wal")), false);
});

test("a mirror modified behind the sync's back is fully rewritten", () => {
  const { dir, body } = makeSourceDir(BLOCK_BYTES * 2);
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-dst-"));
  syncMirror({ ntDbDir: dir, mirrorDir });
  const mirrorPath = path.join(mirrorDir, "nt_msg.clean.db");
  const tampered = mirrorBody(mirrorDir);
  tampered[5] ^= 0xff;
  fs.writeFileSync(mirrorPath, tampered);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(mirrorPath, future, future);

  const result = syncMirror({ ntDbDir: dir, mirrorDir });
  assert.equal(result.stats["nt_msg.db"].fullRewrite, true);
  assert.ok(mirrorBody(mirrorDir).equals(body));
});

test("shrinking source truncates the mirror", () => {
  const { dir, body } = makeSourceDir(BLOCK_BYTES * 2 + 5);
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-dst-"));
  syncMirror({ ntDbDir: dir, mirrorDir });
  const shorter = body.subarray(0, BLOCK_BYTES + 1);
  fs.writeFileSync(path.join(dir, "nt_msg.db"), Buffer.concat([FAKE_HEADER, shorter]));
  syncMirror({ ntDbDir: dir, mirrorDir });
  assert.ok(mirrorBody(mirrorDir).equals(shorter));
});

test("mirror lock is exclusive and recovers from a dead holder", async () => {
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-lock-"));
  const outer = await withMirrorLock(mirrorDir, "outer", async () => {
    const inner = await withMirrorLock(mirrorDir, "inner", () => "should not run");
    assert.equal(inner.acquired, false);
    assert.equal(inner.holder.owner, "outer");
    return "ran";
  });
  assert.deepEqual(outer, { acquired: true, value: "ran" });

  // A lock left by a process that no longer exists is stale.
  fs.writeFileSync(path.join(mirrorDir, "mirror.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, owner: "ghost" }));
  const recovered = await withMirrorLock(mirrorDir, "next", () => "ok");
  assert.deepEqual(recovered, { acquired: true, value: "ok" });
});

test("rejects a relative QQ directory", () => {
  assert.throws(() => syncMirror({ ntDbDir: "relative/dir", mirrorDir: os.tmpdir() }), /绝对路径/u);
});
