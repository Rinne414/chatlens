"use strict";

// The Windows updater must actually start. Node's detached:true launches
// PowerShell with DETACHED_PROCESS, which never runs a script at all (this
// broke one-click updates on Windows from v0.0.2 to v0.0.11). This starts a
// probe through the same cmd.exe command line the updater uses and checks it
// ran with every path intact.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { windowsUpdaterArgs } = require("../src/server/update_ops");

const PROBE = [
  "param([string]$ZipPath, [string]$InstallDir, [int]$ServerPid)",
  "$log = Join-Path (Split-Path -Parent $ZipPath) 'probe.log'",
  "\"$ZipPath|$InstallDir|$ServerPid\" | Out-File -FilePath $log -Encoding utf8",
].join("\r\n");

test("the Windows updater command really starts PowerShell with the paths intact", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "updater spawn 测试 "));
  const updateDir = path.join(root, "dist", "update");
  fs.mkdirSync(updateDir, { recursive: true });
  const scriptPath = path.join(updateDir, "apply_update.ps1");
  fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PROBE, "utf8")]));
  const archivePath = path.join(updateDir, "chatlens-v9.9.9-win-x64.zip");

  const args = windowsUpdaterArgs({ scriptPath, archivePath, installDir: root, serverPid: 4242 });
  assert.equal(args.join(" ").includes("start \"\" /min powershell.exe"), true);
  const child = spawn("cmd.exe", args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
  child.unref();

  const log = path.join(updateDir, "probe.log");
  for (let waited = 0; waited < 20000 && !fs.existsSync(log); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(fs.existsSync(log), "the updater never started");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.readFileSync(log, "utf8").replace(/^\uFEFF/u, "").trim(), `${archivePath}|${root}|4242`);
});
