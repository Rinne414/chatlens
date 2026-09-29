"use strict";

// Right-click "summarize this selection": one call for a short selection, or
// part-by-part plus a merge for a long one. Which LLM (and its credential)
// comes from the saved config (src/llm_route.js).

const fs = require("node:fs");
const path = require("node:path");
const { createStoreRecorder } = require("./llm_usage");
const { callLlm, createClient, currentModel, setUsageRecorder } = require("./llm_summarizer");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { profileFor } = require("./llm_profiles");
const { loadConfig } = require("./server/toolkit_state");

const MAX_CHARS = 60000;
const SYSTEM_PROMPT = "你是精炼的群聊摘要助手，只输出合法 JSON。";

const requireSummary = (raw) => {
  if (typeof raw?.summary !== "string" || raw.summary.trim().length === 0) {
    throw new Error("Invalid LLM JSON. Required string is missing: summary");
  }
};

const parseArgs = (argv) => {
  if (argv.length !== 4) {
    throw new Error("Usage: node llm_quick_summary.js <inputJson> <outputJson>");
  }
  return { inputJson: argv[2], outputJson: argv[3] };
};

const messageLine = (message) => `[${message.hkt}] ${message.speaker}: ${message.text}`;

// Consecutive parts of at most maxMessages messages / MAX_CHARS characters,
// covering every selected message: a long selection is summarized part by
// part and then merged, instead of keeping only its tail.
const splitParts = (messages, maxMessages) => {
  const parts = [];
  let current = [];
  let chars = 0;
  for (const message of messages) {
    const length = messageLine(message).length;
    if (current.length > 0 && (current.length >= maxMessages || chars + length > MAX_CHARS)) {
      parts.push(current);
      current = [];
      chars = 0;
    }
    current.push(message);
    chars += length;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
};

// The detailed level asks for more points, each attributed and concrete.
const pointRules = (detail) => (profileFor(detail).name === "detailed"
  ? `规则：summary 写 4-6 句；points ${profileFor(detail).quick.points} 条，按时间顺序，每条写明是谁说的，保留具体信息（名称、数字、结论、分歧）；`
  : `规则：points ${profileFor(detail).quick.points} 条，按时间顺序；`);

const buildPrompt = (input, part = null, detail = "standard") => {
  const lines = input.messages.map(messageLine);
  const where = part === null ? "" : `（这是整段选择的第 ${part.index}/${part.total} 部分）`;
  return [
    `以下是 QQ 群「${input.groupName || input.groupId}」中用户手动选取的一段连续消息（共 ${lines.length} 条）${where}。`,
    "请只针对这段消息输出 JSON（简体中文）：",
    '{"summary": "两三句话概括这段对话", "points": ["要点1", "要点2"], "actions": [{"text": "待办或提问", "status": "open 或 resolved", "resolution": "若已解决，说明谁如何解决"}]}',
    `${pointRules(detail)}actions 只列明确请求某人执行、明确承诺执行、或带责任/截止时间的事项。普通提问、求购、求推荐和征询意见不算 action。检查后文，明确完成的标 resolved；没有则给空数组。`,
    "",
    ...lines,
  ].join("\n");
};

const buildMergePrompt = (input, partials) => [
  `下面是 QQ 群「${input.groupName || input.groupId}」一段较长消息按时间顺序分成 ${partials.length} 部分后各自的摘要（共 ${input.messages.length} 条消息）。`,
  "请合并成一份，输出同样格式的 JSON（简体中文）：",
  '{"summary": "两三句话概括整段对话", "points": ["要点1", "要点2"], "actions": [{"text": "待办或提问", "status": "open 或 resolved", "resolution": "若已解决，说明谁如何解决"}]}',
  "规则：points 按时间顺序，合并重复，保留每部分的重要内容；前面部分的待办如果在后面部分被解决，标 resolved。",
  "",
  JSON.stringify(partials.map((partial, index) => ({ part: index + 1, ...partial }))),
].join("\n");

// Used when the merge call fails: the parts' results side by side, in order.
const mergeLocally = (partials) => ({
  summary: partials.map((partial) => partial.summary).filter(Boolean).join(" "),
  points: partials.flatMap((partial) => partial.points),
  actions: partials.flatMap((partial) => partial.actions),
});

const normalizeResult = (raw) => ({
  summary: typeof raw.summary === "string" ? raw.summary : "",
  points: (Array.isArray(raw.points) ? raw.points : []).map(String),
  actions: (Array.isArray(raw.actions) ? raw.actions : [])
    .map((action) => ({
      text: String(action?.text ?? ""),
      status: action?.status === "resolved" ? "resolved" : "open",
      resolution: typeof action?.resolution === "string" ? action.resolution : "",
    }))
    .filter((action) => action.text.length > 0),
});

const main = async () => {
  const args = parseArgs(process.argv);
  const input = JSON.parse(fs.readFileSync(args.inputJson, "utf8"));
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("Input has no messages to summarize");
  }

  const route = await resolveLlmRoute(loadConfig());
  const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
  setUsageRecorder(createStoreRecorder(path.resolve(__dirname, "..")));
  // makePrompt(detail) is rebuilt for a fallback, which answers at its own level.
  const ask = async (makePrompt, messageCount) => normalizeResult(await callLlm(
    client,
    (detail) => ({ system: SYSTEM_PROMPT, user: makePrompt(detail), maxTokens: profileFor(detail).quick.maxTokens, temperature: 0.3 }),
    { purpose: "quick", messages: messageCount, validate: requireSummary },
  ));

  const parts = splitParts(input.messages, profileFor(route.primary.detail).quick.maxMessages);
  let result;
  if (parts.length === 1) {
    result = await ask((detail) => buildPrompt(input, null, detail), input.messages.length);
  } else {
    const partials = [];
    for (const [index, messages] of parts.entries()) {
      console.log(`quick summary part ${index + 1}/${parts.length}`);
      const part = { index: index + 1, total: parts.length };
      partials.push(await ask((detail) => buildPrompt({ ...input, messages }, part, detail), messages.length));
    }
    try {
      result = await ask(() => buildMergePrompt(input, partials), 0);
    } catch (error) {
      console.log(`quick summary merge failed, keeping the parts side by side: ${error.message}`);
      result = mergeLocally(partials);
    }
  }
  const output = { ...result, model: currentModel(client), messageCount: input.messages.length, parts: parts.length };
  fs.writeFileSync(args.outputJson, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`quickSummaryPath=${args.outputJson}`);
};

main().catch((error) => {
  console.error(`llm_quick_summary failed: ${error.message}`);
  process.exit(1);
});
