"use strict";

// The automatic update check (rail + settings) must not hit GitHub on every
// page load or poll, while the 检查更新 button always asks right away.

const assert = require("node:assert/strict");
const https = require("node:https");
const { Readable } = require("node:stream");
const test = require("node:test");

const updateOps = require("../src/server/update_ops");

const LATEST = "https://api.github.com/repos/Rinne414/chatlens/releases/latest";
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Answers the latest-release URL with `release` (or HTTP 503 when null) and
// counts the requests.
const stubGithub = (release) => {
  const original = https.get;
  const calls = { count: 0 };
  https.get = (url, _options, callback) => {
    calls.count += 1;
    const body = String(url) === LATEST && release !== null ? JSON.stringify(release) : undefined;
    const response = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    response.statusCode = body === undefined ? 503 : 200;
    response.headers = {};
    process.nextTick(() => callback(response));
    return { setTimeout() {}, on() {} };
  };
  return { calls, restore: () => { https.get = original; } };
};

test("the automatic check asks GitHub at most once per 6 hours; 检查更新 always asks", async () => {
  const github = stubGithub({ tag_name: "v9.9.9", name: "v9.9.9", body: "notes", assets: [] });
  const cached = { maxAgeMs: updateOps.AUTO_CHECK_MAX_AGE_MS };
  const start = 1_000_000_000_000;
  try {
    const first = await updateOps.checkUpdate({ ...cached, now: start });
    assert.equal(first.latestVersion, "9.9.9");
    assert.equal(first.hasUpdate, true);
    assert.equal(github.calls.count, 1);

    await updateOps.checkUpdate({ ...cached, now: start + 5 * HOUR });
    assert.equal(github.calls.count, 1, "a page load within 6 hours reuses the answer");

    await updateOps.checkUpdate({ ...cached, now: start + 6 * HOUR });
    assert.equal(github.calls.count, 2, "after 6 hours it asks again");

    await updateOps.checkUpdate({ now: start + 6 * HOUR + 1 });
    assert.equal(github.calls.count, 3, "the button never uses the cache");
  } finally {
    github.restore();
  }
});

test("a failed automatic check is retried after 30 minutes, not on every poll", async () => {
  const github = stubGithub(null);
  const cached = { maxAgeMs: updateOps.AUTO_CHECK_MAX_AGE_MS };
  const start = 2_000_000_000_000;
  try {
    await assert.rejects(updateOps.checkUpdate({ ...cached, now: start }), /HTTP 503/u);
    assert.equal(github.calls.count, 1);

    await assert.rejects(updateOps.checkUpdate({ ...cached, now: start + 10 * MINUTE }), /HTTP 503/u);
    assert.equal(github.calls.count, 1, "polls within 30 minutes get the same failure");

    await assert.rejects(updateOps.checkUpdate({ ...cached, now: start + 30 * MINUTE }), /HTTP 503/u);
    assert.equal(github.calls.count, 2, "after 30 minutes it tries again");
  } finally {
    github.restore();
  }
});
