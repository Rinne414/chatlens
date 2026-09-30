"use strict";

// Server-side glue for the home-page briefing: builds it from the store,
// marks it read, and feeds the post-refresh notifications.

const crypto = require("node:crypto");
const path = require("node:path");
const state = require("./toolkit_state");
const background = require("./background");
const knowledge = require("./knowledge_ops");
const { isLlmConfigured: llmConfigured, detailLevel } = require("../llm_route");
const { profileFor } = require("../llm_profiles");
const briefingStore = require("../briefing_store");
const engine = require("../briefing_engine");
const { buildBriefing } = require("../briefing_view");
const { MAX_WORDS, normalizeWords } = require("../watch_words");
const { summarizeUsage } = require("../llm_usage");
const { priceTable } = require("../llm_pricing");

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

// A hand-edited config with a bad list must not break the home page.
const watchWordsOf = (config) => {
  const words = Array.isArray(config.watchWords) ? config.watchWords : [];
  // Cut to the limit before the whole-list check, which throws past it.
  return normalizeWords(words.filter((word) => {
    try {
      return normalizeWords([word]).length === 1;
    } catch {
      return false;
    }
  }).slice(0, MAX_WORDS));
};

// 关注词 from the home page: validated, saved to the config, returned as stored.
const saveWatchWords = ({ words }) => {
  const normalized = normalizeWords(words);
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, watchWords: normalized });
  return { words: normalized };
};

const statusOf = (db, config, nowUnix) => ({
  llmConfigured: llmConfigured(config),
  background: background.getStatus(),
  budget: engine.budgetStatus(db, nowUnix, profileFor(detailLevel(config)).engine.dailyLlmCallLimit),
  pause: engine.pauseStatus(db, nowUnix),
  spendToday: summarizeUsage(db, { nowUnix, days: 1, prices: priceTable(config) }).today.cost,
  // The last refresh stopped asking the AI because the account was refused.
  aiProblem: llmConfigured(config) ? engine.routeProblem(db) : null,
});

const briefingNow = () => {
  const config = state.loadConfig();
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const nowUnix = Math.floor(Date.now() / 1000);
  const displayable = knowledge.openDisplayableCheck(state.toolRoot);
  try {
    return buildBriefing({
      db,
      knowledgeDbPath,
      watchlist: watchlistOf(config),
      watchWords: watchWordsOf(config),
      nowUnix,
      extraSelfUins: uinFromPath(config.ntDbDir),
      isImageAvailable: displayable.has,
      status: statusOf(db, config, nowUnix),
    });
  } finally {
    displayable.close();
  }
};

// A cheap fingerprint of everything the briefing is built from. The home page
// polls with it while the background works and gets { unchanged } instead of
// a full briefing (~1 s to build, ~180 KB) when nothing moved.
const briefingStamp = (db, config, nowUnix) => {
  const refresh = background.getStatus();
  const facts = [
    briefingStore.getState(db, "briefing_since", null),
    db.prepare("SELECT MAX(rowid) AS n FROM messages").get().n,
    db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS at, TOTAL(length(chunk_key)) AS keys FROM group_briefs").get(),
    db.prepare("SELECT status, redo, COUNT(*) AS n, MAX(summarized_at) AS at FROM summary_chunks GROUP BY status, redo").all(),
    engine.pauseStatus(db, nowUnix),
    engine.routeProblem(db),
    watchlistOf(config).map((item) => item.groupId),
    watchWordsOf(config),
    db.prepare("SELECT COUNT(*) AS n, TOTAL(length(name)) AS chars FROM group_names").get(),
    // Reading a chat moves its mark, which the group list shows as 看完了 / 没看 N 条.
    db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS at, TOTAL(sent_at) AS marks FROM read_marks").get(),
    // Settings the page reflects (AI set up or not, level, refresh cadence).
    [llmConfigured(config), detailLevel(config), refresh.settings.enabled, refresh.settings.intervalMinutes, refresh.settings.autoSummarize, refresh.settings.notifyWatchWords],
    [refresh.running, refresh.lastFinishedAt, refresh.lastError, refresh.readinessProblem],
  ];
  return crypto.createHash("sha1").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
};

// known = the stamp the page already shows.
const getBriefing = ({ known = null } = {}) => {
  const config = state.loadConfig();
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const stamp = briefingStamp(db, config, Math.floor(Date.now() / 1000));
  return known !== null && known === stamp ? { unchanged: true, stamp } : { ...briefingNow(), stamp };
};

// "重试": summaries that were given up on go back into the queue (at the
// detailed level as job work, so a big batch cannot crowd out new messages).
const retryFailed = () => {
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  // The ones the page counts: given up on, ending inside the briefing window.
  const fromUnix = Number(briefingStore.getState(db, "briefing_since", 0)) || 0;
  const requeued = engine.requeueFailedChunks(db, { asJob: detailLevel(state.loadConfig()) === "detailed", fromUnix });
  const tick = requeued > 0 ? background.runNow({ force: false }) : { started: false };
  return { requeued, started: tick.started === true };
};

// "看完了": the next briefing covers only what arrives after this moment.
const markSeen = ({ seenUnix }) => {
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const now = Math.floor(Date.now() / 1000);
  const value = Number.isFinite(Number(seenUnix)) ? Math.min(Number(seenUnix), now) : now;
  engine.markBriefingSeen(db, value);
  return { windowStart: value };
};

const afterTick = async ({ ok, result }) => {
  if (!ok) {
    return;
  }
  const briefing = briefingNow();
  await background.notifyAfterTick({
    db: state.getStore(),
    briefing,
    // Old replies added this tick (src/backfill_replies.js) are not news:
    // they are older than where each group's refresh window began.
    lateBefore: Number(result?.replyBackfill?.lastInserted) > 0 ? result.windowStarts ?? null : null,
    getState: briefingStore.getState,
    setState: briefingStore.setState,
  });
};

module.exports = { getBriefing, markSeen, retryFailed, saveWatchWords, afterTick, watchlistOf, uinFromPath };
