"use strict";

// The background picture pass (run after each refresh) and what the settings
// page shows about it: budget, usage, the rkey, what is about to expire.

const fs = require("node:fs");
const state = require("./toolkit_state");
const service = require("./picture_service");
const jobs = require("./picture_jobs");
const store = require("../picture_store");
const pictureAi = require("../picture_ai");

const MD5 = /^[a-f0-9]{32}$/u;
const EVICT_BATCH = 500;
const EXPIRING_DAYS = 7;

const db = () => state.getStore();

const pass = { running: false, stopRequested: false, startedAt: null, finishedAt: null, done: null, error: null, note: null };

// A failure only counts against a picture when the rkey was usable: with QQ
// closed every NT fetch fails, and that says nothing about the picture.
const noteFailure = (picture) => {
  if (picture.fileId !== "" && !service.rkeyStatus().ready) {
    return;
  }
  const row = store.fileRow(db(), picture.md5);
  store.updateFile(db(), picture.md5, { failures: (row?.failures ?? 0) + 1 });
};

// `limit` workers take items in order; none starts a new item once the pass
// is stopped or the deadline has passed (one slow download still finishes).
const runLimited = async (items, limit, work, { deadline = Infinity, stopped = () => pass.stopRequested } = {}) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped() && Date.now() <= deadline) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

// Works through `nextBatch` until it is empty, time is up, or a whole batch
// made no progress (nothing left that can be fetched right now).
const drain = async (label, nextBatch, work, deadline) => {
  for (;;) {
    if (pass.stopRequested || Date.now() > deadline) {
      return;
    }
    const batch = nextBatch();
    if (batch.length === 0) {
      return;
    }
    let progressed = 0;
    await runLimited(batch, 3, async (picture) => {
      const outcome = await work(picture);
      pass.done[label][outcome] = (pass.done[label][outcome] ?? 0) + 1;
      if (outcome === "failed") {
        noteFailure(picture);
      } else {
        progressed += 1;
      }
    }, { deadline });
    if (progressed === 0) {
      return;
    }
  }
};

const keepWork = async (picture) => {
  const result = await jobs.keepOne(picture.md5);
  if (result.status === "kept") return "ok";
  if (result.status === "gone") return "gone";
  return "failed";
};

const USAGE_KEY = { thumb: "thumbBytes", preview: "previewBytes", cache: "cacheBytes" };

// Over the budget: cached originals first (also whenever they pass their own
// share), then store.EVICTION_TIERS in order, oldest picture first. A cleared
// thumbnail or preview is marked evicted so the pass does not fetch it again.
// Saved originals (media-objects) are never touched.
const enforceBudget = () => {
  const budget = service.settings().budgetGB * service.GB;
  let usage = store.usage(db());
  const total = () => usage.thumbBytes + usage.previewBytes + usage.cacheBytes;
  const evict = (tier, over) => {
    while (over()) {
      const victims = store.evictionCandidates(db(), tier, EVICT_BATCH);
      if (victims.length === 0) {
        return;
      }
      // Rows first, files after the commit: a rollback then leaves only an
      // unreferenced file, never a row pointing at a deleted one.
      const cleared = [];
      db().transaction(() => {
        for (const victim of victims) {
          if (!over()) {
            return;
          }
          store.updateFile(db(), victim.md5, {
            [victim.kind]: "",
            [`${victim.kind}_bytes`]: 0,
            ...(victim.kind === "cache" ? {} : { evicted: 1 }),
          });
          cleared.push(victim);
          usage = { ...usage, [USAGE_KEY[victim.kind]]: usage[USAGE_KEY[victim.kind]] - victim.bytes };
        }
      })();
      for (const victim of cleared) {
        store.removeFile(service.storeDir, victim.kind, victim.md5, victim.name);
      }
      usage = store.usage(db());
    }
  };
  evict("cache", () => usage.cacheBytes > budget * service.CACHE_SHARE || total() > budget);
  for (const tier of ["plain-preview", "plain-thumb", "ai-preview", "ai-thumb"]) {
    evict(tier, () => total() > budget);
  }
  return { budgetBytes: budget, usedBytes: total() };
};

const runPass = async ({ reason = "tick" } = {}) => {
  const current = service.settings();
  if (pass.running || !current.enabled) {
    return { started: false };
  }
  Object.assign(pass, { running: true, stopRequested: false, startedAt: new Date().toISOString(), done: { ai: {}, previews: {}, keep: {}, thumbs: {} }, error: null, note: null, reason });
  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    if ((await service.ensureRkey()) === null && process.platform === "win32") {
      pass.note = "no-rkey";
    }
    const now = service.unix;
    await drain("ai", () => store.needingProbe(db(), { now: now(), limit: 40 }), jobs.probeOne, deadline);
    await drain("previews", () => store.needingPreviews(db(), { now: now(), limit: 20 }), jobs.previewOne, deadline);
    await drain("keep", () => store.needingKeep(db(), { now: now(), limit: 10, groupIds: current.keepAllGroups }), keepWork, deadline);
    await drain("thumbs", () => store.needingThumbs(db(), { now: now(), limit: 60 }), jobs.thumbOne, deadline);
    enforceBudget();
  } catch (error) {
    pass.error = error.message;
    console.error(`picture pass failed: ${error.message}`);
  } finally {
    Object.assign(pass, { running: false, finishedAt: new Date().toISOString() });
  }
  return { started: true };
};

const stop = () => {
  pass.stopRequested = true;
};

const status = () => {
  const current = service.settings();
  const usage = store.usage(db());
  return {
    settings: current,
    budgets: [...service.BUDGETS_GB],
    rkey: service.rkeyStatus(),
    usage: { ...usage, keptBytes: store.keptBytes(db()), budgetBytes: current.budgetGB * service.GB },
    pending: store.pendingCounts(db(), service.unix()),
    trafficToday: service.trafficToday(),
    // "no-rkey" is only news while there is still no key.
    pass: {
      running: pass.running,
      startedAt: pass.startedAt,
      finishedAt: pass.finishedAt,
      done: pass.done,
      error: pass.error,
      note: pass.note === "no-rkey" && service.rkeyStatus().ready ? null : pass.note,
    },
    platform: process.platform,
  };
};

// AI pictures whose original is not saved, expiring within 7 days first.
const expiring = () => {
  const now = service.unix();
  // Every one of them (SQLite LIMIT -1): a capped list hid the ones a user
  // might be looking for.
  const items = store.expiringAi(db(), { now, limit: -1 });
  return {
    items: items.map((item) => ({ ...item, daysLeft: Math.max(0, Math.floor((item.expiresAt - now) / 86400)) })),
    total: store.countExpiringAi(db(), { now }),
    soon: store.countExpiringAi(db(), { now, withinSeconds: EXPIRING_DAYS * 86400 }),
  };
};

// The full text chunks of a generated picture; `workflow` is what ComfyUI
// loads when the .json is dropped onto it.
const workflow = (md5) => {
  if (!MD5.test(String(md5)) || !fs.existsSync(service.knowledgeDbPath)) {
    return null;
  }
  return pictureAi.readChunks({ knowledgeDbPath: service.knowledgeDbPath, md5 });
};

module.exports = { runPass, stop, status, expiring, workflow, enforceBudget, runLimited };
