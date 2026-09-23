"use strict";

// Server-side glue for the home-page briefing: builds it from the store,
// marks it read, and feeds the post-refresh notifications.

const fs = require("node:fs");
const path = require("node:path");
const state = require("./toolkit_state");
const background = require("./background");
const knowledge = require("./knowledge_ops");
const secrets = require("../secrets");
const briefingStore = require("../briefing_store");
const engine = require("../briefing_engine");
const { buildBriefing } = require("../briefing_view");

const knowledgeDbPath = path.join(state.toolRoot, "store", "knowledge.db");

// On Windows the data path names the QQ account; used as a fallback identity
// until the store has seen one of the user's own messages.
const uinFromPath = (ntDbDir) => {
  const match = String(ntDbDir ?? "").match(/[\\/](\d{5,})[\\/]nt_qq[\\/]/u);
  return match === null ? [] : [match[1]];
};

const watchlistOf = (config) =>
  (config.watchlist ?? [])
    .map((item) => (typeof item === "string" ? { groupId: item.trim(), name: "" } : { groupId: String(item?.groupId ?? "").trim(), name: item?.name ?? "" }))
    .filter((item) => /^\d+$/u.test(item.groupId));

const llmConfigured = (config) =>
  String(config.llm?.baseUrl ?? "").trim().length > 0
  && String(config.llm?.model ?? "").trim().length > 0
  && secrets.hasSecret("llmKey");

const briefingNow = () => {
  const config = state.loadConfig();
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const nowUnix = Math.floor(Date.now() / 1000);
  return buildBriefing({
    db,
    knowledgeDbPath,
    watchlist: watchlistOf(config),
    nowUnix,
    extraSelfUins: uinFromPath(config.ntDbDir),
    isImageAvailable: (hash) => {
      const filePath = knowledge.thumbnailFilePath(state.toolRoot, hash) ?? knowledge.imageFilePath(state.toolRoot, hash);
      return filePath !== null && fs.existsSync(filePath);
    },
    status: {
      llmConfigured: llmConfigured(config),
      background: background.getStatus(),
      budget: engine.budgetStatus(db, nowUnix),
    },
  });
};

const getBriefing = () => briefingNow();

// "看完了": the next briefing covers only what arrives after this moment.
const markSeen = ({ seenUnix }) => {
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const now = Math.floor(Date.now() / 1000);
  const value = Number.isFinite(Number(seenUnix)) ? Math.min(Number(seenUnix), now) : now;
  engine.markBriefingSeen(db, value);
  return { windowStart: value };
};

const afterTick = async ({ ok }) => {
  if (!ok) {
    return;
  }
  const briefing = briefingNow();
  await background.notifyAfterTick({
    db: state.getStore(),
    briefing,
    getState: briefingStore.getState,
    setState: briefingStore.setState,
  });
};

module.exports = { getBriefing, markSeen, afterTick };
