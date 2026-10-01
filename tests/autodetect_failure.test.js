"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const platform = require("../src/platform");
const { autoDetectFailure } = require("../src/server/settings_ops");

test("windows powershell env drops an inherited PowerShell 7 module path", () => {
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules";
  try {
    const env = platform.windowsPowershellEnv({ CHATLENS_SECRET_FILE: "x" });
    assert.equal(Object.hasOwn(env, "PSModulePath"), false);
    assert.equal(env.CHATLENS_SECRET_FILE, "x");
    assert.equal(process.env.PSModulePath.includes("PowerShell\\7"), true);
  } finally {
    if (previous === undefined) {
      delete process.env.PSModulePath;
    } else {
      process.env.PSModulePath = previous;
    }
  }
});

test("a verifier crash is not reported as zero key candidates", () => {
  const error = autoDetectFailure({
    code: 1,
    stdout: "",
    stderr: "保存密钥失败：ConvertTo-SecureString 无法加载。\n",
  });
  assert.match(error.message, /保存密钥失败/u);
  assert.doesNotMatch(error.message, /0 个候选/u);
});

test("zero candidates and no matching candidate stay distinct", () => {
  const none = autoDetectFailure({
    code: 2,
    stdout: JSON.stringify({ saved: false, candidateCount: 0, tested: 0 }),
    stderr: "",
  });
  assert.match(none.message, /没有从正在运行的 QQ 里读到密钥候选/u);
  const missed = autoDetectFailure({
    code: 2,
    stdout: JSON.stringify({ saved: false, candidateCount: 12, tested: 12 }),
    stderr: "",
  });
  assert.match(missed.message, /扫描到 12 个候选/u);
  assert.equal(autoDetectFailure({
    code: 0,
    stdout: JSON.stringify({ saved: true, candidateCount: 3, tested: 1 }),
    stderr: "",
  }), null);
});
