"use strict";

// 群 → 重要的事: one LLM call that turns a group's day of timeline topics into
// things worth knowing (src/topic_things.js), saved in the store.
//
//   node src/topic_things_run.js <groupId> <YYYY-MM-DD>

const path = require("node:path");
const messageStore = require("./message_store");
const { createStoreRecorder } = require("./llm_usage");
const { callLlm, createClient, currentModel, setUsageRecorder } = require("./llm_summarizer");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");
const { groupName } = require("./group_insights");
const { buildThingsPrompt, dayTopics, normalizeThings, saveThings, thingsToKeys, validateThings } = require("./topic_things");

const SYSTEM_PROMPT = "你是群聊信息编辑，帮读者从大量对话里挑出值得知道的事。只输出合法 JSON。";
const MAX_TOKENS = 4000;

const main = async () => {
  const [groupId, day] = process.argv.slice(2);
  if (!/^\d+$/u.test(String(groupId)) || !/^\d{4}-\d{2}-\d{2}$/u.test(String(day))) {
    throw new Error("Usage: node topic_things_run.js <groupId> <YYYY-MM-DD>");
  }
  const toolRoot = path.resolve(__dirname, "..");
  const db = messageStore.openStore(path.join(toolRoot, "store", "messages.db"));
  try {
    const topics = dayTopics(db, groupId, day);
    if (topics.length === 0) {
      throw new Error("这一天还没有 AI 整理过的话题。");
    }
    const route = await resolveLlmRoute(loadConfig());
    const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
    setUsageRecorder(createStoreRecorder(toolRoot));
    const prompt = buildThingsPrompt({ groupName: groupName(db, groupId) || groupId, day, topics });
    const raw = await callLlm(
      client,
      () => ({ system: SYSTEM_PROMPT, user: prompt, maxTokens: MAX_TOKENS, temperature: 0.2 }),
      { purpose: "things", messages: topics.reduce((total, topic) => total + topic.stats.messages, 0), validate: validateThings },
    );
    const things = normalizeThings(raw, topics.length);
    saveThings(db, { groupId, day, things: thingsToKeys(things, topics), model: currentModel(client), topicCount: topics.length, nowUnix: Math.floor(Date.now() / 1000) });
    console.log(`thingsResult=${JSON.stringify({ things: things.length, topics: topics.length })}`);
  } finally {
    db.close();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
