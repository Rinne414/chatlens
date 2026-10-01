"use strict";

// A pasted QQ database key is tried on the user's own nt_msg.db before it is
// saved. Found in the field: an AI service key ("sk-...", 51 characters) saved
// in the QQ key box showed as 已保存 while every backup failed with
// SQLITE_NOTADB.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3-multiple-ciphers");

const { checkManualKey, DATABASE_CONFIGS } = require("../src/save_key_from_candidates");

const KEY = "aB3$dE5fG7hI9jK1";
const QQ_PREFIX = Buffer.concat([Buffer.from("SQLite header 3\0", "latin1"), Buffer.alloc(1024 - 16)]);

// An encrypted database laid out like QQ's: 1024-byte fake header, then SQLCipher.
const makeQqDatabase = () => {
  const ntDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "key-check-"));
  const plainPath = path.join(ntDbDir, "cipher.db");
  const db = new Database(plainPath);
  for (const pragma of DATABASE_CONFIGS[0].pragmas) {
    db.pragma(pragma);
  }
  db.pragma(`key='${KEY}'`);
  db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
  db.close();
  fs.writeFileSync(path.join(ntDbDir, "nt_msg.db"), Buffer.concat([QQ_PREFIX, fs.readFileSync(plainPath)]));
  fs.rmSync(plainPath);
  return ntDbDir;
};

test("the key that opens the user's database is accepted", (t) => {
  const ntDbDir = makeQqDatabase();
  t.after(() => fs.rmSync(ntDbDir, { recursive: true, force: true }));

  assert.doesNotThrow(() => checkManualKey(`  ${KEY}  `, ntDbDir));
});

test("an AI service key pasted into the QQ key box is refused", (t) => {
  const ntDbDir = makeQqDatabase();
  t.after(() => fs.rmSync(ntDbDir, { recursive: true, force: true }));

  assert.throws(() => checkManualKey(`sk-${"x".repeat(48)}`, ntDbDir), /解不开/u);
});

test("a wrong key of the right length is refused too", (t) => {
  const ntDbDir = makeQqDatabase();
  t.after(() => fs.rmSync(ntDbDir, { recursive: true, force: true }));

  assert.throws(() => checkManualKey("Zz9$yY8xXw7vV6uU", ntDbDir), /解不开/u);
});

test("without a database to try, only a 16 or 32 character key is accepted", () => {
  const missing = path.join(os.tmpdir(), "key-check-no-such-dir");

  assert.doesNotThrow(() => checkManualKey(KEY, missing));
  assert.doesNotThrow(() => checkManualKey(KEY, ""));
  assert.throws(() => checkManualKey(`sk-${"x".repeat(48)}`, ""), /16/u);
});
