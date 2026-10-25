"use strict";

// 简报 → 值得知道的事: one LLM call that merges the briefing window's hot topics
// of every followed group into things worth knowing (src/brief_things.js).
//
//   node src/brief_things_run.js

const path = require("node:path");
const messageStore = require("./message_store");
const { createStoreRecorder } = require("./llm_usage");
const { callLlm, createClient, currentModel, setUsageRecorder } = require("./llm_summarizer");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");
const { buildBriefThingsPrompt, followedGroups, normalizeThings, saveBriefThings, thingsToKeys, validateThings, windowStartOf, windowTopics, MERGE_LOCK, MERGE_LOCK_STALE_MS } = require("./brief_things");
const { takeLock } = require("./vault_files");

const SYSTEM_PROMPT = "你是群聊信息编辑，帮读者从几十个群的大量对话里挑出值得知道的事。只输出合法 JSON。";
// Room for 60+ things with a sentence each (small talk is not listed).
const MAX_TOKENS = 16000;

const main = async () => {
  const toolRoot = path.resolve(__dirname, "..");
  const storeDir = path.join(toolRoot, "store");
  // One merge at a time, even across a console restart (the server's own
  // record of a running merge does not survive one): a second would pay twice.
  const release = takeLock(storeDir, MERGE_LOCK, { staleMs: MERGE_LOCK_STALE_MS });
  if (release === null) {
    console.log(`briefThingsResult=${JSON.stringify({ skipped: "busy" })}`);
    return;
  }
  const config = loadConfig();
  const db = messageStore.openStore(path.join(storeDir, "messages.db"));
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const windowStart = windowStartOf(db, nowUnix);
    // Read exactly as the server reads it, or the stored keys would not match.
    const watchlist = followedGroups(config);
    const topics = windowTopics(db, watchlist, windowStart);
    if (topics.length === 0) {
      throw new Error("这段时间还没有整理好的群话题。");
    }
    const route = await resolveLlmRoute(config);
    const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
    setUsageRecorder(createStoreRecorder(toolRoot));
    const prompt = buildBriefThingsPrompt({ topics });
    const raw = await callLlm(
      client,
      () => ({ system: SYSTEM_PROMPT, user: prompt, maxTokens: MAX_TOKENS, temperature: 0.2 }),
      { purpose: "things", messages: topics.reduce((total, topic) => total + topic.messages, 0), validate: validateThings },
    );
    const things = normalizeThings(raw, topics.length);
    saveBriefThings(db, { windowStart, things: thingsToKeys(things, topics), model: currentModel(client), topicCount: topics.length, nowUnix });
    console.log(`briefThingsResult=${JSON.stringify({ things: things.length, topics: topics.length })}`);
  } finally {
    db.close();
    release();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
