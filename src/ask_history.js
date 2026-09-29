"use strict";

// 问群聊: answer a question from the group chat history.
//   node src/ask_history.js <inputJson> <outputJson>
// input: { question, fromDay?, toDay? }
//   1. plan   — the LLM turns the question into search keywords (and a time
//               range / groups when the question names them);
//   2. search — local, src/ask_retrieval.js;
//   3. answer — the LLM answers from those messages only, citing them by
//               number. The result is kept in ask_log.

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("./message_store");
const { ensureBriefingSchema } = require("./briefing_store");
const { ensureAskSchema, saveAsk } = require("./ask_store");
const { findEvidence } = require("./ask_retrieval");
const { periodBounds, isValidPeriod, dayOf } = require("./digest_periods");
const { formatHkt } = require("./unviewed_range");
const { callLlm, createClient, currentModel, currentDetail, setUsageRecorder } = require("./llm_summarizer");
const { ensureUsageSchema, recordUsage } = require("./llm_usage");
const { profileFor } = require("./llm_profiles");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");

const STORE_PATH = path.join(__dirname, "..", "store", "messages.db");
const MAX_QUESTION = 500;
const PLAN_MAX_TOKENS = 1024;
const MAX_FOLLOW_UPS = 3;
const CONFIDENCE = new Set(["high", "medium", "low"]);

const parseArgs = (argv) => {
  if (argv.length !== 4) {
    throw new Error("Usage: node ask_history.js <inputJson> <outputJson>");
  }
  return { inputJson: argv[2], outputJson: argv[3] };
};

const text = (value, max = 4000) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// callLlm validators: an empty plan or answer is asked again elsewhere.
const requireKeywords = (raw) => {
  if (!Array.isArray(raw?.keywords) || raw.keywords.length === 0) {
    throw new Error("Invalid LLM JSON. No search keywords");
  }
};
const requireAnswer = (raw) => {
  if (text(raw?.answer).length === 0) {
    throw new Error("Invalid LLM JSON. Required string is missing: answer");
  }
};
const validDay = (value) => (isValidPeriod("day", value) ? value : null);

const knownGroups = (db) => db.prepare(`
  SELECT n.group_id AS groupId, n.name FROM group_names n
  WHERE n.name <> '' AND EXISTS (SELECT 1 FROM messages m WHERE m.group_id = n.group_id)
`).all();

const planPrompt = (question, today, groups) => ({
  system: "你帮用户在自己的 QQ 群聊记录里查资料：把问题拆成用于全文搜索的关键词。输出必须是合法 JSON。",
  user: JSON.stringify({
    question,
    today,
    groups: groups.map((group) => group.name),
    rules: [
      "keywords：3-8 个最可能原样出现在聊天里的词——群友会用的说法、简称、英文名、型号、人名；按重要性排序；不要整句，也不要“怎么”“什么”这类虚词。",
      "如果问题指明了时间（例如“上周”“9 月”“昨天”），给出 fromDay/toDay（YYYY-MM-DD，北京时间，含首尾两天）；没有就用 null。",
      "如果问题指明了某个群，groups 填群名（必须来自给定列表）；没有就给空数组。",
    ],
    outputSchema: { keywords: ["string"], fromDay: "YYYY-MM-DD | null", toDay: "YYYY-MM-DD | null", groups: ["群名"] },
  }, null, 2),
  maxTokens: PLAN_MAX_TOKENS,
});

const messageLine = (message) =>
  `#${message.ref} [${formatHkt(message.sentAt).slice(0, 16)}] [${message.groupName}] ${message.speaker}: ${String(message.text).replace(/\s+/gu, " ").trim()}`;

const answerPrompt = (question, evidence, detail) => {
  const detailed = profileFor(detail).name === "detailed";
  return {
    system: [
      "你根据用户 QQ 群里的聊天记录回答问题。",
      "只能根据下面给出的聊天记录和摘要线索回答；记录里没有答案就明确说没找到，不要编造，也不要用常识补全群里没说过的事。",
      "输出必须是合法 JSON，不要使用 Markdown。",
    ].join("\n"),
    user: JSON.stringify({
      question,
      rules: [
        detailed
          ? "answer：详细回答，需要多详细就写多详细；分点说明，每点写清是谁、在什么时候、说了什么，有分歧就列出各方说法。"
          : "answer：直接回答问题，3-8 句，说明是谁在什么时候说的。",
        `citations：支持答案的消息编号（# 后面的数字），按重要性排序，最多 ${detailed ? 30 : 10} 个。`,
        "confidence：high（记录里有明确答案）| medium（有相关讨论，但不完全确定）| low（只有零星线索）。",
        "found：记录里是否找到了和问题相关的内容。",
        `followUps：用户可能想接着问的问题，0-${MAX_FOLLOW_UPS} 个。`,
      ],
      outputSchema: { answer: "string", citations: ["number"], confidence: "high | medium | low", found: "boolean", followUps: ["string"] },
      summaryClues: evidence.clues.map((clue) => ({ group: clue.groupName, day: dayOf(clue.sentAt), title: clue.title, text: clue.text })),
      messages: evidence.messages.map(messageLine),
    }, null, 2),
    maxTokens: profileFor(detail).ask.maxTokens,
  };
};

// Time range: the page's explicit days win, then the question's own.
const resolveScope = (input, plan, groups) => {
  const fromDay = validDay(input.fromDay) ?? validDay(plan.fromDay);
  const toDay = validDay(input.toDay) ?? validDay(plan.toDay);
  const wanted = new Set((Array.isArray(plan.groups) ? plan.groups : []).map(String));
  return {
    fromDay,
    toDay,
    fromUnix: fromDay === null ? 0 : periodBounds("day", fromDay).startUnix,
    toUnix: toDay === null ? Math.floor(Date.now() / 1000) + 86400 : periodBounds("day", toDay).endUnix,
    groups: groups.filter((group) => wanted.has(group.name)),
  };
};

const ask = async (db, client, input) => {
  const question = text(input.question, MAX_QUESTION);
  if (question.length === 0) {
    throw new Error("问题是空的。");
  }
  const groups = knownGroups(db);
  const today = dayOf(Math.floor(Date.now() / 1000));
  const plan = await callLlm(client, () => planPrompt(question, today, groups), { purpose: "ask", validate: requireKeywords });
  const scope = resolveScope(input, plan, groups);
  const limits = profileFor(currentDetail(client)).ask;
  const evidence = findEvidence(db, { keywords: plan.keywords, fromUnix: scope.fromUnix, toUnix: scope.toUnix, groupIds: scope.groups.map((group) => group.groupId) }, limits);
  const base = {
    question,
    keywords: evidence.keywords,
    scope: { fromDay: scope.fromDay, toDay: scope.toDay, groups: scope.groups.map((group) => group.name) },
    stats: evidence.stats,
  };
  if (evidence.messages.length === 0 && evidence.clues.length === 0) {
    return { ...base, answer: "在聊天记录里没有找到和这个问题相关的消息。可以换个说法，或者放宽时间范围再问。", confidence: "low", found: false, citations: [], followUps: [], model: currentModel(client), detail: currentDetail(client) };
  }
  const raw = await callLlm(client, (detail) => answerPrompt(question, evidence, detail), { purpose: "ask", messages: evidence.messages.length, validate: requireAnswer });
  const byRef = new Map(evidence.messages.map((message) => [message.ref, message]));
  const citations = [...new Set((Array.isArray(raw.citations) ? raw.citations : []).map(Number))]
    .filter((ref) => byRef.has(ref))
    .map((ref) => {
      const { groupId, groupName, rowId, sentAt, speaker, text: body } = byRef.get(ref);
      return { ref, groupId, groupName, rowId, sentAt, speaker, text: body };
    });
  return {
    ...base,
    answer: text(raw.answer, 20000) || "（AI 没有给出回答）",
    confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : "medium",
    found: raw.found !== false,
    citations,
    followUps: (Array.isArray(raw.followUps) ? raw.followUps : []).map((item) => text(item, 200)).filter(Boolean).slice(0, MAX_FOLLOW_UPS),
    model: currentModel(client),
    detail: currentDetail(client),
  };
};

const main = async () => {
  const args = parseArgs(process.argv);
  const input = JSON.parse(fs.readFileSync(args.inputJson, "utf8"));
  const route = await resolveLlmRoute(loadConfig());
  const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
  const db = ensureAskSchema(ensureUsageSchema(ensureBriefingSchema(messageStore.openStore(STORE_PATH))));
  setUsageRecorder((entry) => recordUsage(db, entry));
  try {
    const askedAt = Math.floor(Date.now() / 1000);
    const result = await ask(db, client, input);
    const id = saveAsk(db, { askedAt, question: result.question, result });
    fs.writeFileSync(args.outputJson, `${JSON.stringify({ id, askedAt, ...result })}\n`, "utf8");
    console.log(`ask done id=${id} citations=${result.citations.length}`);
  } finally {
    setUsageRecorder(null);
    db.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`ask_history failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ask, resolveScope };
