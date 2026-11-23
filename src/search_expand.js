"use strict";

// 回顾 → 「换几种说法再搜」: the reader typed how they would say it; the chats
// may have said it some other way (an abbreviation, the English name, a
// nickname). The AI is asked for the other ways, and the search then looks
// for any of them. One call, started from the page (src/server/review_ops.js):
//   node src/search_expand.js <input.json> <output.json>      input { query }
// No model to download and nothing to index: it works on any computer that
// has an AI service set up.

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("./message_store");
const { ensureUsageSchema, recordUsage } = require("./llm_usage");
const { callLlm, createClient, setUsageRecorder } = require("./llm_summarizer");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");

const STORE_PATH = path.join(__dirname, "..", "store", "messages.db");
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 30;
const MAX_TOKENS = 400;

const expandPrompt = (query) => ({
  system: "你帮用户在自己的群聊记录里找东西。用户给出他会怎么说，你给出群友可能用的其他说法，用于全文搜索。输出必须是合法 JSON。",
  user: JSON.stringify({
    query,
    task: `列出最多 ${MAX_TERMS} 个可能原样出现在聊天里的其他说法：同义词、简称、英文名或中文名、常见的错别字写法、口语说法。每个 2-12 个字，不要整句，不要重复用户已经写的词，不要“怎么”“什么”这类虚词。`,
    outputSchema: { terms: ["string"] },
  }),
  maxTokens: MAX_TOKENS,
});

const requireTerms = (raw) => {
  if (!Array.isArray(raw?.terms)) {
    throw new Error("Invalid LLM JSON. Required array is missing: terms");
  }
};

// The other ways of saying it: short, lower case, none the reader already typed.
const cleanTerms = (raw, query) => {
  const typed = new Set(String(query ?? "").toLowerCase().split(/\s+/u).filter(Boolean));
  const terms = [];
  for (const value of raw.terms) {
    const term = String(value ?? "").trim().toLowerCase();
    if (term.length >= 2 && [...term].length <= MAX_TERM_CHARS && !typed.has(term) && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms.slice(0, MAX_TERMS);
};

const expand = async (client, query) =>
  cleanTerms(await callLlm(client, () => expandPrompt(query), { purpose: "expand", validate: requireTerms }), query);

const main = async () => {
  const [inputJson, outputJson] = process.argv.slice(2);
  const { query } = JSON.parse(fs.readFileSync(inputJson, "utf8"));
  const route = await resolveLlmRoute(loadConfig());
  const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
  const db = ensureUsageSchema(messageStore.openStore(STORE_PATH));
  setUsageRecorder((entry) => recordUsage(db, entry));
  try {
    fs.writeFileSync(outputJson, `${JSON.stringify({ query, terms: await expand(client, query) })}\n`, "utf8");
  } finally {
    setUsageRecorder(null);
    db.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`search_expand failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { expand, cleanTerms, expandPrompt };
