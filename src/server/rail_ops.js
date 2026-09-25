"use strict";

// HTTP side of the left rail (src/rail_status.js), plus the background status
// it shows. Cached briefly: every open page polls it.

const state = require("./toolkit_state");
const background = require("./background");
const briefingOps = require("./briefing_ops");
const engine = require("../briefing_engine");
const briefingStore = require("../briefing_store");
const messageStore = require("../message_store");
const { railStatus, inboxExtras } = require("../rail_status");

const CACHE_MS = 15 * 1000;
let cached = null;

const isoToUnix = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const compute = () => {
  const config = state.loadConfig();
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const nowUnix = Math.floor(Date.now() / 1000);
  const identity = messageStore.getSelfIdentity(db, briefingOps.uinFromPath(config.ntDbDir));
  const status = background.getStatus();
  return {
    ...railStatus(db, { watchlist: briefingOps.watchlistOf(config), identity, nowUnix }),
    // The scheduler keeps ISO strings; the rail works in unix seconds.
    background: {
      enabled: status.settings?.enabled !== false,
      running: status.running,
      lastFinishedAt: isoToUnix(status.lastFinishedAt),
      nextRunAt: isoToUnix(status.nextRunAt),
      lastError: status.lastError,
      readinessProblem: status.readinessProblem,
    },
    pause: engine.pauseStatus(db, nowUnix),
  };
};

const getRail = () => {
  if (cached !== null && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }
  cached = { at: Date.now(), value: compute() };
  return cached.value;
};

const MAX_INBOX_GROUPS = 200;

const getInboxExtras = (groupIdsParam) => {
  const groupIds = [...new Set(String(groupIdsParam ?? "").split(",").filter((id) => /^\d+$/u.test(id)))].slice(0, MAX_INBOX_GROUPS);
  const config = state.loadConfig();
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const identity = messageStore.getSelfIdentity(db, briefingOps.uinFromPath(config.ntDbDir));
  return inboxExtras(db, { groupIds, identity, nowUnix: Math.floor(Date.now() / 1000) });
};

// Reading a group moves its read mark; the next poll should show that.
const invalidateRail = () => {
  cached = null;
};

module.exports = { getRail, getInboxExtras, invalidateRail };
