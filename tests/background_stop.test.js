"use strict";

// 「停下这一轮」 ends the running refresh's process, is not recorded as a
// failure, and the console knows which step the refresh was at.

const assert = require("node:assert/strict");
const test = require("node:test");
const childProcess = require("node:child_process");

// A stand-in refresh: says which step it is at, then stays busy.
const realSpawn = childProcess.spawn;
const spawned = [];
childProcess.spawn = (command, args, options) => {
  // Only the refresh is replaced: stopping it runs the real process killer.
  if (!String(args?.[0] ?? "").endsWith("refresh_run.js")) {
    return realSpawn(command, args, options);
  }
  const child = realSpawn(command, ["-e", "console.log('progress=phase:ingest'); setInterval(() => {}, 1000);"], options);
  spawned.push(child);
  return child;
};

const state = require("../src/server/toolkit_state");
const secrets = require("../src/secrets");
const realLoadConfig = state.loadConfig;
state.loadConfig = () => ({ ...realLoadConfig(), ntDbDir: "somewhere", watchlist: ["1"] });
secrets.hasSecret = () => true;

const background = require("../src/server/background");

const until = async (check, what) => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("a running refresh can be stopped: its process ends and it is not a failure", async (t) => {
  t.after(() => background.stop());
  assert.deepEqual(background.runNow({ force: false }), { started: true });
  await until(() => background.getStatus().phase === "ingest", "the step line");
  assert.equal(background.getStatus().running, true);
  assert.equal(background.getStatus().log.some((line) => line.includes("phase:")), false, "step lines are not log lines");

  assert.deepEqual(background.stopRun(), { stopped: true });
  await until(() => background.getStatus().running === false, "the refresh to end");
  const after = background.getStatus();
  assert.equal(after.phase, null);
  assert.equal(after.lastError, null);
  assert.ok(Date.parse(after.lastStoppedAt) > Date.now() - 60_000);
  assert.equal(spawned.length, 1);
  assert.notEqual(spawned[0].exitCode ?? spawned[0].signalCode, null, "the process is gone");
  assert.deepEqual(background.stopRun(), { stopped: false, reason: "not-running" });
});
