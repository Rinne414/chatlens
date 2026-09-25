"use strict";

// The console's in-memory rkey. Rescanning QQ's memory reads every QQ
// process (~12 s, measured 2026-09-25), so a refusal from Tencent must not
// trigger a rescan when the key demonstrably still works.

const assert = require("node:assert/strict");
const test = require("node:test");
const { createKeyHolder, KEY_TRUST_MS, RESCAN_MIN_MS, MAX_REFUSALS } = require("../src/rkey");

const setup = (keys) => {
  const clock = { now: 1_000_000 };
  const scans = [];
  const queue = [...keys];
  const holder = createKeyHolder({
    now: () => clock.now,
    scan: async () => {
      scans.push(clock.now);
      const key = queue.shift() ?? null;
      return key === null ? { key: null, problem: "none-valid" } : { key, problem: null };
    },
  });
  return { clock, scans, holder };
};

test("the first request scans once and concurrent requests share that scan", async () => {
  const { scans, holder } = setup(["key-1"]);
  const [a, b] = await Promise.all([holder.ensure(), holder.ensure()]);
  assert.equal(a, "key-1");
  assert.equal(b, "key-1");
  assert.equal(scans.length, 1);
  assert.equal(holder.status().ready, true);
});

test("a refusal right after the key worked keeps the key and does not rescan", async () => {
  const { clock, scans, holder } = setup(["key-1", "key-2"]);
  await holder.ensure();
  clock.now += RESCAN_MIN_MS + 1000;
  holder.succeeded("key-1");
  clock.now += 1000;
  assert.equal(await holder.refused("key-1"), null);
  assert.equal(await holder.ensure(), "key-1");
  assert.equal(scans.length, 1);
});

test("repeated refusals of a key rescan and hand back the fresh key", async () => {
  const { clock, scans, holder } = setup(["key-1", "key-2"]);
  await holder.ensure();
  clock.now += RESCAN_MIN_MS + 1000;
  holder.succeeded("key-1");
  for (let i = 1; i < MAX_REFUSALS; i += 1) {
    assert.equal(await holder.refused("key-1"), null);
  }
  assert.equal(await holder.refused("key-1"), "key-2");
  assert.equal(scans.length, 2);
  assert.equal(await holder.ensure(), "key-2");
});

test("a key that has not worked for a while is rescanned on its first refusal", async () => {
  const { clock, scans, holder } = setup(["key-1", "key-2"]);
  await holder.ensure();
  clock.now += Math.max(KEY_TRUST_MS, RESCAN_MIN_MS) + 1000;
  assert.equal(await holder.refused("key-1"), "key-2");
  assert.equal(scans.length, 2);
});

test("refusals never rescan more than once per rescan interval", async () => {
  const { clock, scans, holder } = setup(["key-1", "key-2", "key-3"]);
  await holder.ensure();
  clock.now += KEY_TRUST_MS + 1000;
  for (let i = 0; i < 50; i += 1) {
    await holder.refused("key-1");
    clock.now += 100;
  }
  // Within RESCAN_MIN_MS of the first scan: the key is kept, nothing rescanned.
  assert.equal(scans.length, 1);
  assert.equal(await holder.ensure(), "key-1");
});

test("a success resets the refusal count", async () => {
  const { clock, scans, holder } = setup(["key-1", "key-2"]);
  await holder.ensure();
  clock.now += RESCAN_MIN_MS + 1000;
  holder.succeeded("key-1");
  for (let round = 0; round < 5; round += 1) {
    for (let i = 1; i < MAX_REFUSALS; i += 1) {
      assert.equal(await holder.refused("key-1"), null);
    }
    holder.succeeded("key-1");
  }
  assert.equal(scans.length, 1);
});

test("with no key and a failed scan, requests do not rescan until the interval passes", async () => {
  const { clock, scans, holder } = setup([]);
  assert.equal(await holder.ensure(), null);
  assert.equal(holder.status().problem, "none-valid");
  clock.now += 1000;
  assert.equal(await holder.ensure(), null);
  assert.equal(scans.length, 1);
  clock.now += RESCAN_MIN_MS;
  await holder.ensure();
  assert.equal(scans.length, 2);
});

test("a refusal of an outdated key retries with the key another request already found", async () => {
  const { clock, holder } = setup(["key-1", "key-2"]);
  await holder.ensure();
  clock.now += Math.max(KEY_TRUST_MS, RESCAN_MIN_MS) + 1000;
  assert.equal(await holder.refused("key-1"), "key-2");
  // A request that started with key-1 before the rescan finished.
  assert.equal(await holder.refused("key-1"), "key-2");
});
