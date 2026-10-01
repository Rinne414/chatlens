"use strict";

// A failed job used to say only "进程退出码 1" while the real cause sat in the
// log. The message shown must name the cause and, for a wrong database key,
// what to do about it.

const assert = require("node:assert/strict");
const test = require("node:test");

const { describeJobFailure } = require("../src/server/job_failure");

// The shape Node prints for an uncaught SqliteError, followed by runMain's line.
const WRONG_KEY_LOG = [
  "progress=export-start",
  "L:\\tool\\node_modules\\better-sqlite3-multiple-ciphers\\lib\\methods\\wrappers.js:9",
  "SqliteError: file is not a database",
  "    at Database.pragma (L:\\tool\\node_modules\\better-sqlite3-multiple-ciphers\\lib\\methods\\pragma.js:11:44)",
  "  code: 'SQLITE_NOTADB'",
  "Node.js v25.2.1",
  "导出消息失败（退出码 1）",
];

test("a database the saved key cannot open says the key is wrong and how to fix it", () => {
  const message = describeJobFailure(WRONG_KEY_LOG, 1);

  assert.match(message, /密钥/u);
  assert.match(message, /自动获取密钥/u);
  assert.doesNotMatch(message, /进程退出码/u);
});

test("an unknown failure shows the step that failed together with the error behind it", () => {
  const log = [
    "progress=export-start",
    "RangeError: Invalid time value",
    "    at exportRange (L:\\tool\\src\\pipeline\\backup_run.js:80:11)",
    "导出消息失败（退出码 1）",
  ];

  assert.equal(describeJobFailure(log, 1), "导出消息失败（退出码 1）：RangeError: Invalid time value");
});

test("a failure whose last line already is the error shows just that line", () => {
  assert.equal(describeJobFailure(["progress=copy-start", "找不到 nt_msg.db"], 1), "找不到 nt_msg.db");
});

test("progress markers and stack frames are never shown as the reason", () => {
  assert.equal(describeJobFailure(["progress=export-start", "    at main (x.js:1:1)"], 3), "进程退出码 3");
});

test("an empty log falls back to the exit code", () => {
  assert.equal(describeJobFailure([], 1), "进程退出码 1");
});
