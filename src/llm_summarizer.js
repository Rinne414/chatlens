"use strict";

// LLM summarization library shared by the manual run CLI (llm_adapter.js)
// and the background briefing (briefing_engine.js).
//
// Output schema (v3, tuned for hobby/interest groups rather than work chats):
//   summary, topics (热门讨论), newThings (新东西), qa (问答), timeline,
//   uncategorized, links. `actions`/`risks` are no longer requested — they
//   produced mostly noise in hobby groups — but older partials that still
//   carry them are accepted.

const http = require("node:http");
const https = require("node:https");

const { profileFor, mapRulesFor } = require("./llm_profiles");

const DEFAULT_TIMEOUT_MS = 120000;

// Runaway guard for map-reduce over one window. Override via LLM_MAX_CHUNKS.
const MAX_CHUNKS = (() => {
  const raw = Number.parseInt(process.env.LLM_MAX_CHUNKS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 40;
})();

const NEW_THING_KINDS = new Set(["model", "tool", "tutorial", "resource", "news", "event", "other"]);

/* ---------- transport ---------- */

const getChatCompletionsUrl = (rawBaseUrl) => {
  const url = new URL(rawBaseUrl);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return url;
};

// Grok answers are streamed: xAI's edge drops a non-streamed request that is
// still thinking after 60 s (measured). The stream is collected and put back
// into the shape of a normal response; one that ends without a finish reason
// (cut off mid-answer) is an error.
const STREAM_IDLE_MS = 120000;
const STREAM_CUT = "LLM stream ended before the answer finished";

const assembleStream = (text) => {
  let content = "";
  let finishReason = null;
  let usage;
  for (const line of text.split(/\r?\n/u)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (data === "" || data === "[DONE]") {
      continue;
    }
    const event = JSON.parse(data);
    const choice = event.choices?.[0];
    content += choice?.delta?.content ?? "";
    finishReason = choice?.finish_reason ?? finishReason;
    usage = event.usage ?? usage;
  }
  if (finishReason === null) {
    throw new Error(STREAM_CUT);
  }
  return { choices: [{ finish_reason: finishReason, message: { content } }], usage };
};

const requestJson = (url, apiKey, payload, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = url.protocol === "http:" ? http : https;
    const streamed = payload.stream === true;
    // Streamed: the idle limit applies between chunks, the level's limit to the whole answer.
    const deadline = streamed
      ? setTimeout(() => request.destroy(new Error(`LLM request timed out after ${timeoutMs} ms. Url=${url.toString()}`)), timeoutMs)
      : null;
    const settle = (fn, value) => {
      clearTimeout(deadline);
      fn(value);
    };
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            settle(reject, Object.assign(
              new Error(`LLM request failed. StatusCode=${response.statusCode} Body=${responseBody.slice(0, 2000)}`),
              { status: response.statusCode },
            ));
            return;
          }
          try {
            settle(resolve, streamed ? assembleStream(responseBody) : JSON.parse(responseBody));
          } catch (error) {
            settle(reject, error.message === STREAM_CUT
              ? error
              : new Error(`LLM response was not valid JSON. Body=${responseBody.slice(0, 2000)} Error=${error.message}`));
          }
        });
      },
    );
    const idleMs = streamed ? Math.min(timeoutMs, STREAM_IDLE_MS) : timeoutMs;
    request.setTimeout(idleMs, () => {
      request.destroy(new Error(`LLM request timed out after ${idleMs} ms. Url=${url.toString()}`));
    });
    request.on("error", (error) => settle(reject, error));
    request.write(body);
    request.end();
  });

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

// A bad request or a refused credential fails the same way every time.
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

// A timed-out request is not repeated either: a long detailed call that hit
// its limit would only block the run for another full timeout.
const TIMED_OUT = /timed out after/u;

const requestJsonWithRetry = async (url, apiKey, payload, timeoutMs) => {
  const delays = [0, 1200, 3000];
  let lastError = null;
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) {
      await sleep(delays[index]);
    }
    try {
      return await requestJson(url, apiKey, payload, timeoutMs);
    } catch (error) {
      lastError = error;
      console.warn(JSON.stringify({ level: "warn", event: "llm_request_failed", attempt: index + 1, maxAttempts: delays.length, message: error.message }));
      if (NON_RETRYABLE_STATUSES.has(error.status) || TIMED_OUT.test(error.message) || error.message === STREAM_CUT) {
        break;
      }
    }
  }
  throw lastError;
};

// Every call's reported token usage goes to this hook (llm_usage.js). Set by
// the entry script; absent in tests.
let usageRecorder = null;
const setUsageRecorder = (recorder) => {
  usageRecorder = typeof recorder === "function" ? recorder : null;
};

const reportUsage = (client, responseBody, meta) => {
  if (usageRecorder === null || responseBody?.usage === undefined) {
    return;
  }
  usageRecorder({
    at: Math.floor(Date.now() / 1000),
    purpose: meta.purpose,
    model: client.model,
    host: client.url.host,
    usage: responseBody.usage,
    messages: meta.messages ?? 0,
    billing: client.provider === "grok-subscription" ? "subscription" : "api",
    groupId: meta.groupId ?? null,
    day: meta.day ?? null,
  });
};

// Provider quirks. DeepSeek's thinking switch is its own extension; Gemini's
// OpenAI layer takes reasoning_effort (unknown fields are ignored there, but
// other providers may reject them, so each extra goes only where it belongs).
// xAI: Grok reasons by default, and on a 397-message chunk at the detailed
// level its default took 466 s for barely more than "medium" (185 s; "low"
// 121 s, half the topics). Reasoning tokens do not count against max_tokens.
const providerExtras = (url, detail = "standard") => {
  if (/(^|\.)deepseek\.com$/iu.test(url.hostname)) {
    return { thinking: { type: "disabled" } };
  }
  if (url.hostname === "generativelanguage.googleapis.com") {
    return { reasoning_effort: "minimal" };
  }
  if (url.hostname === "api.x.ai") {
    return { reasoning_effort: detail === "detailed" ? "medium" : "low" };
  }
  return {};
};

// The primary provider is down for us right now (credential refused, quota
// used up, outage, network): the rest of the process switches to the
// fallback and the failure is remembered. Anything else — an empty or
// malformed answer, a cut-off stream, one very long call timing out, a
// refused request (Grok silently returns empty summaries for some adult
// chat) — is retried on the fallback for that one call only.
const UNUSABLE_ANSWER = /truncated|not valid JSON|did not contain|Invalid LLM JSON|stream ended before|timed out after/u;
const shouldFallBack = (error) => {
  const status = Number(error?.status);
  if (!Number.isFinite(status)) {
    return !UNUSABLE_ANSWER.test(String(error?.message));
  }
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
};

// Some OpenAI-compatible providers ignore response_format and wrap the JSON
// in a Markdown fence or add a sentence around it.
const parseJsonContent = (content) => {
  try {
    return JSON.parse(content);
  } catch (firstError) {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    const candidate = fenced !== null ? fenced[1] : content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      throw firstError;
    }
  }
};

const extractAssistantContent = (responseBody) => {
  const finishReason = responseBody?.choices?.[0]?.finish_reason;
  if (finishReason === "length") {
    throw new Error(`LLM response was truncated. Body=${JSON.stringify(responseBody).slice(0, 2000)}`);
  }
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`LLM response did not contain choices[0].message.content. Body=${JSON.stringify(responseBody).slice(0, 2000)}`);
  }
  return content;
};

const callOnce = async (client, { system, user, maxTokens, temperature = 0.2 }, meta) => {
  const { url, apiKey, model } = client;
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    temperature,
    ...(url.hostname === "api.x.ai" ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
    ...providerExtras(url, client.detail),
  };
  const responseBody = await requestJsonWithRetry(url, apiKey, payload, profileFor(client.detail).requestTimeoutMs);
  // Billed even when the answer is unusable (e.g. truncated), so record first.
  reportUsage(client, responseBody, meta);
  return parseJsonContent(extractAssistantContent(responseBody));
};

const activeClient = (client) => (client.state.usingFallback ? client.fallback : client);

// The model answering right now (the fallback's once the primary failed),
// and the detail level it works at.
const currentModel = (client) => activeClient(client).model;
const currentDetail = (client) => activeClient(client).detail;

// build(detail) returns { system, user, maxTokens }: the request is rebuilt
// for the fallback because it runs at its own (standard) detail level.
// meta.validate(raw) throws when an answer is unusable (e.g. an empty
// summary), which sends that call to the fallback too. When the primary is
// down (shouldFallBack), the rest of this process uses the fallback.
// meta.allowFallback = false: this call must come from the primary (detailed
// redo work) — its failure is thrown, though a primary that is down is still
// switched away from for the process's other calls. meta.onAnswered(endpoint)
// learns which endpoint (model, detail) produced the accepted answer.
const callLlm = async (client, build, meta = { purpose: "other" }) => {
  const { validate = () => {}, allowFallback = true, onAnswered = () => {}, ...usageMeta } = meta;
  const ask = async (endpoint) => {
    const raw = await callOnce(endpoint, build(endpoint.detail), usageMeta);
    validate(raw);
    onAnswered(endpoint);
    return raw;
  };
  const active = activeClient(client);
  try {
    return await ask(active);
  } catch (error) {
    if (active !== client || client.fallback === null) {
      throw error;
    }
    const reason = String(error.message).slice(0, 200);
    const down = shouldFallBack(error);
    if (down) {
      client.state.usingFallback = true;
      console.warn(`llm ${client.model} unavailable, using ${client.fallback.model}: ${reason}`);
      client.onFallback(error);
    }
    if (!allowFallback) {
      throw error;
    }
    if (!down) {
      client.state.answeredByFallback += 1;
      console.warn(`llm ${client.model} gave no usable answer, asking ${client.fallback.model} for this one: ${reason}`);
    }
    return ask(client.fallback);
  }
};

/* ---------- prompts ---------- */

const groupLabel = (message) => message.groupName || message.groupId || "unknown-group";

const formatMessageLine = (message) =>
  `[${message.hkt}] [${groupLabel(message)}] ${message.speaker}: ${String(message.text).replace(/\s+/gu, " ").trim()}`;

// Splits EVERY message into consecutive time-ordered chunks that each fit the
// model budget (≤ maxMessages lines and ≤ maxChars), so a busy group's window
// is covered 100%. MAX_CHUNKS is a runaway guard only.
const buildChunks = (messages, maxMessages, maxChars) => {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const message of messages) {
    const line = formatMessageLine(message);
    const full = current.length >= maxMessages || (current.length > 0 && currentChars + line.length + 1 > maxChars);
    if (full) {
      chunks.push(current);
      current = [];
      currentChars = 0;
      if (chunks.length >= MAX_CHUNKS) {
        break;
      }
    }
    current.push(line);
    currentChars += line.length + 1;
  }
  if (current.length > 0 && chunks.length < MAX_CHUNKS) {
    chunks.push(current);
  }
  const covered = chunks.reduce((total, chunk) => total + chunk.length, 0);
  return { chunks, covered, capped: covered < messages.length };
};

const OUTPUT_SCHEMA = {
  summary: "string",
  topics: [
    {
      title: "string",
      summary: "string",
      importance: "high | medium | low",
      messageCountEstimate: "number",
      details: ["string"],
      evidence: ["string"],
    },
  ],
  newThings: [
    {
      kind: "model | tool | tutorial | resource | news | event | other",
      name: "string",
      detail: "string",
      link: "string | null",
      speaker: "string",
      hkt: "string, message time",
    },
  ],
  qa: [
    {
      question: "string",
      answer: "string | null",
      asker: "string",
      answerer: "string | null",
      hkt: "string, time of the question",
      resolved: "boolean",
    },
  ],
  timeline: [
    {
      start: "string, e.g. 2026-07-05 09:10",
      end: "string",
      title: "string",
      summary: "string",
      messageCountEstimate: "number",
    },
  ],
  uncategorized: [
    {
      hkt: "string, message time",
      speaker: "string",
      note: "string, what it says and why it may matter",
    },
  ],
  links: [
    {
      title: "string",
      url: "string",
      why: "string",
    },
  ],
};

// Rules every detail level shares (the level's own rules come first).
const COMMON_RULES = [
  "不要输出 actions 或 risks 字段。",
  "如果没有某类内容，用空数组或 null。",
];

const SYSTEM_PROMPT = [
  "你是一个 QQ 群聊摘要分析器，读者是忙碌、不想爬楼的群成员。",
  "你必须根据当前输入的消息动态归纳主题，不能使用预设行业分类。",
  "不要因为字段名或示例而默认群聊在讨论 AI、模型、账号、订单或编程，除非消息内容确实在讨论这些。",
  "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
].join("\n");

const buildLocalTopicContext = (analysis) =>
  (analysis?.topics ?? [])
    .filter((topic) => topic.count > 0)
    .slice(0, 12)
    .map((topic) => ({
      name: topic.name,
      count: topic.count,
      keywords: (topic.keywords ?? []).slice(0, 6).map((item) => item.token ?? item.name ?? String(item)),
    }));

// Prompt over an explicit set of already-formatted message lines.
// `analysis` is optional context (the manual pipeline has one; the background
// briefing passes a light { firstMessageHkt, lastMessageHkt } object).
const buildMapPrompt = (analysis, messageLines, partMeta, detail = "standard") => ({
  system: SYSTEM_PROMPT,
  user: JSON.stringify(
    {
      task: "请动态总结这些 QQ 群消息。",
      ...(partMeta === undefined
        ? {}
        : {
            partContext: {
              part: partMeta.part,
              totalParts: partMeta.total,
              hint: `这是同一个群按时间先后切分的第 ${partMeta.part}/${partMeta.total} 段消息，请客观提取本段内容，稍后会与其它段合并成完整摘要。`,
            },
          }),
      rules: [...mapRulesFor(detail), ...COMMON_RULES],
      outputSchema: OUTPUT_SCHEMA,
      context: {
        groups: analysis?.byGroup,
        timeRange: {
          firstMessageHkt: analysis?.firstMessageHkt ?? null,
          lastMessageHkt: analysis?.lastMessageHkt ?? null,
        },
        parsedTextMessages: analysis?.parsedTextMessages ?? messageLines.length,
        parsedMediaMessages: analysis?.parsedMediaMessages,
        localDynamicTopicHints: buildLocalTopicContext(analysis),
        localTimeBlocks: (analysis?.timeBlocks ?? []).slice(0, 24).map((block) => ({
          start: block.startHkt,
          end: block.endHkt,
          messages: block.count,
        })),
      },
      messages: messageLines,
    },
    null,
    2,
  ),
});

const arrayOf = (value) => (Array.isArray(value) ? value : []);

// Per-chunk caps keep the merge input (and therefore the merge OUTPUT) small
// enough to fit max_tokens — an untrimmed 7-chunk merge once overflowed.
const trimPartialForReduce = (partial, trim = profileFor("standard").reduce.trim) => ({
  summary: typeof partial.summary === "string" ? partial.summary : "",
  topics: arrayOf(partial.topics).slice(0, trim.topics).map((topic) => ({
    title: topic?.title,
    summary: topic?.summary,
    importance: topic?.importance,
    messageCountEstimate: topic?.messageCountEstimate,
    details: arrayOf(topic?.details).slice(0, trim.details),
    evidence: arrayOf(topic?.evidence).slice(0, trim.evidence),
  })),
  newThings: arrayOf(partial.newThings).slice(0, trim.newThings),
  qa: arrayOf(partial.qa).slice(0, trim.qa),
  timeline: arrayOf(partial.timeline).slice(0, trim.timeline),
  uncategorized: arrayOf(partial.uncategorized).slice(0, trim.uncategorized),
  links: arrayOf(partial.links).slice(0, trim.links),
});

const REDUCE_TONE = {
  standard: "输出必须精简，宁缺毋滥——这是给忙碌的人快速扫读的。严格遵守下列数量上限：",
  detailed: "这是详细模式：保留各段所有有内容的信息，只合并真正重复的，不要为了简短而丢掉细节。下列数量是上限，不是目标：",
};

const REDUCE_TRIM_ROUNDS = 4;

// Each chunk's summary trimmed to the level's caps, then halved until all of
// them fit the level's input budget (a detailed Grok chunk summary alone can
// run to 20k characters, and a brief merges up to 40 of them).
const fitPartials = (partials, { trim, inputChars }) => {
  let caps = trim;
  let fitted = partials.map((partial) => trimPartialForReduce(partial, caps));
  for (let round = 0; round < REDUCE_TRIM_ROUNDS && JSON.stringify(fitted).length > inputChars; round += 1) {
    caps = Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, Math.max(1, Math.floor(value / 2))]));
    fitted = partials.map((partial) => trimPartialForReduce(partial, caps));
  }
  return fitted;
};

const buildReducePrompt = (analysis, partials, detail = "standard") => {
  const profile = profileFor(detail);
  const { caps, summarySentences } = profile.reduce;
  return {
    system: [
      "你是一个 QQ 群聊摘要合并器。",
      "输入是同一个群、按时间先后切分的多段局部摘要（JSON），请合并成一份完整、不重复的总摘要。",
      "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
    ].join("\n"),
    user: JSON.stringify(
      {
        task: "把下面同一个群的多段局部摘要合并成一份覆盖整个时间范围的总摘要。",
        rules: [
          "同一话题在多段出现时必须合并成一个 topic：summary 综合各段，details/evidence 取有代表性的，不要堆叠重复。",
          REDUCE_TONE[profile.name],
          "topics 最多 " + caps.topics + " 个，按热度和重要性排序，messageCountEstimate 汇总各段；每个 topic 的 details 最多 " + caps.details + " 条、evidence 最多 " + caps.evidence + " 条，evidence 引用要短。",
          "newThings 最多 " + caps.newThings + " 个，同一个东西（同名或同链接）只保留一条，detail 合并各段信息。",
          "qa 最多 " + caps.qa + " 个；同一问题合并；某段没人回答、后段有人回答的，改成有回答并 resolved=true。",
          "timeline 最多 " + caps.timeline + " 段，按时间顺序合并，相邻同话题可合并成一段。",
          "uncategorized 最多 " + caps.uncategorized + " 条、links 最多 " + caps.links + " 条，去重合并。",
          "summary 用 " + summarySentences + " 句概括这一整个时间范围最值得知道的内容。",
          "不要输出 actions 或 risks 字段。如果没有某类内容，用空数组或 null。",
        ],
        outputSchema: OUTPUT_SCHEMA,
        context: {
          timeRange: {
            firstMessageHkt: analysis?.firstMessageHkt ?? null,
            lastMessageHkt: analysis?.lastMessageHkt ?? null,
          },
          parsedTextMessages: analysis?.parsedTextMessages ?? null,
          totalParts: partials.length,
        },
        partials: fitPartials(partials, profile.reduce),
      },
      null,
      2,
    ),
  };
};

/* ---------- validation ---------- */

const requiredString = (value, pathName) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid LLM JSON. Required string is missing: ${pathName}`);
  }
  return value.trim();
};

const optionalString = (value, pathName) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid LLM JSON. Expected string or null: ${pathName}`);
  }
  return value.trim();
};

const requiredArray = (value, pathName) => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid LLM JSON. Expected array: ${pathName}`);
  }
  return value;
};

const requiredNumber = (value, pathName) => {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid LLM JSON. Expected finite number: ${pathName}`);
  }
  return value;
};

const normalizeImportance = (value, pathName) => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new Error(`Invalid LLM JSON. Expected high, medium, or low: ${pathName}`);
};

const normalizeTopic = (topic, index) => ({
  title: requiredString(topic.title, `topics[${index}].title`),
  summary: requiredString(topic.summary, `topics[${index}].summary`),
  importance: normalizeImportance(topic.importance, `topics[${index}].importance`),
  messageCountEstimate: requiredNumber(topic.messageCountEstimate, `topics[${index}].messageCountEstimate`),
  details: requiredArray(topic.details, `topics[${index}].details`).map((detail, detailIndex) =>
    requiredString(detail, `topics[${index}].details[${detailIndex}]`)),
  evidence: requiredArray(topic.evidence, `topics[${index}].evidence`).map((evidence, evidenceIndex) =>
    requiredString(evidence, `topics[${index}].evidence[${evidenceIndex}]`)),
});

const normalizeActionStatus = (value) => (value === "resolved" ? "resolved" : "open");

const normalizeAction = (action, index) => ({
  owner: optionalString(action.owner, `actions[${index}].owner`),
  task: requiredString(action.task, `actions[${index}].task`),
  status: normalizeActionStatus(action.status),
  resolution: typeof action.resolution === "string" && action.resolution.trim().length > 0 ? action.resolution.trim() : null,
  evidence: requiredString(action.evidence, `actions[${index}].evidence`),
});

const normalizeTimelineItem = (item, index) => ({
  start: requiredString(item.start, `timeline[${index}].start`),
  end: optionalString(item.end ?? null, `timeline[${index}].end`),
  title: requiredString(item.title, `timeline[${index}].title`),
  summary: requiredString(item.summary, `timeline[${index}].summary`),
  messageCountEstimate: Number.isFinite(item.messageCountEstimate) ? item.messageCountEstimate : 0,
});

const normalizeUncategorizedItem = (item, index) => ({
  hkt: requiredString(item.hkt, `uncategorized[${index}].hkt`),
  speaker: requiredString(item.speaker, `uncategorized[${index}].speaker`),
  note: requiredString(item.note, `uncategorized[${index}].note`),
});

const normalizeRisk = (risk, index) => ({
  severity: normalizeImportance(risk.severity, `risks[${index}].severity`),
  risk: requiredString(risk.risk, `risks[${index}].risk`),
  evidence: requiredString(risk.evidence, `risks[${index}].evidence`),
});

const normalizeLink = (link, index) => ({
  title: requiredString(link.title, `links[${index}].title`),
  url: requiredString(link.url, `links[${index}].url`),
  why: requiredString(link.why, `links[${index}].why`),
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const nonEmpty = (value) => text(value).length > 0;
const URL_PATTERN = /^https?:\/\/\S+$/iu;

// New lists are lenient: an incomplete item is dropped rather than failing
// the whole summary (the old lists keep their strict validation).
const normalizeNewThings = (items) =>
  arrayOf(items)
    .filter((item) => item && nonEmpty(item.name) && nonEmpty(item.detail))
    .map((item) => ({
      kind: NEW_THING_KINDS.has(item.kind) ? item.kind : "other",
      name: text(item.name),
      detail: text(item.detail),
      link: URL_PATTERN.test(text(item.link)) ? text(item.link) : null,
      speaker: text(item.speaker),
      hkt: text(item.hkt),
    }));

const normalizeQa = (items) =>
  arrayOf(items)
    .filter((item) => item && nonEmpty(item.question))
    .map((item) => {
      const answer = nonEmpty(item.answer) ? text(item.answer) : null;
      return {
        question: text(item.question),
        answer,
        asker: text(item.asker),
        answerer: nonEmpty(item.answerer) ? text(item.answerer) : null,
        hkt: text(item.hkt),
        resolved: answer !== null && item.resolved !== false,
      };
    });

const normalizeLlmSummary = (rawSummary, provider) => ({
  provider,
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  summary: requiredString(rawSummary.summary, "summary"),
  topics: requiredArray(rawSummary.topics ?? [], "topics").map(normalizeTopic),
  newThings: normalizeNewThings(rawSummary.newThings),
  qa: normalizeQa(rawSummary.qa),
  // Every list except topics is optional: tolerate models that omit fields.
  timeline: requiredArray(rawSummary.timeline ?? [], "timeline").map(normalizeTimelineItem),
  uncategorized: requiredArray(rawSummary.uncategorized ?? [], "uncategorized").map(normalizeUncategorizedItem),
  actions: requiredArray(rawSummary.actions ?? [], "actions").map(normalizeAction),
  risks: requiredArray(rawSummary.risks ?? [], "risks").map(normalizeRisk),
  // Links come from chat text via the model: only http(s) may become an href.
  links: requiredArray(rawSummary.links ?? [], "links")
    .filter((link) => URL_PATTERN.test(text(link?.url)))
    .map(normalizeLink),
  announcementDraft: optionalString(rawSummary.announcementDraft ?? null, "announcementDraft"),
});

/* ---------- deterministic merge (fallback when the reduce call fails) ---------- */

const mergeKey = (value) => String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

const dedupeAcross = (partials, getItems, keyOf) => {
  const seen = new Set();
  const out = [];
  for (const partial of partials) {
    for (const item of getItems(partial)) {
      const key = keyOf(item);
      if (key === null || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
  }
  return out;
};

const mergeTopics = (partials) => {
  const rank = { high: 3, medium: 2, low: 1 };
  const byTitle = new Map();
  for (const topic of partials.flatMap((partial) => arrayOf(partial.topics))) {
    if (!topic || !nonEmpty(topic.title)) {
      continue;
    }
    const key = mergeKey(topic.title);
    const details = arrayOf(topic.details).filter(nonEmpty);
    const evidence = arrayOf(topic.evidence).filter(nonEmpty);
    const count = Number.isFinite(topic.messageCountEstimate) ? topic.messageCountEstimate : 0;
    const importance = ["high", "medium", "low"].includes(topic.importance) ? topic.importance : "medium";
    const existing = byTitle.get(key);
    if (existing === undefined) {
      byTitle.set(key, {
        title: text(topic.title),
        summary: nonEmpty(topic.summary) ? text(topic.summary) : text(topic.title),
        importance,
        messageCountEstimate: count,
        details: [...details],
        evidence: [...evidence],
      });
    } else {
      byTitle.set(key, {
        ...existing,
        messageCountEstimate: existing.messageCountEstimate + count,
        details: [...existing.details, ...details],
        evidence: [...existing.evidence, ...evidence],
        importance: rank[importance] > rank[existing.importance] ? importance : existing.importance,
      });
    }
  }
  return [...byTitle.values()]
    .map((topic) => ({ ...topic, details: [...new Set(topic.details)].slice(0, 5), evidence: [...new Set(topic.evidence)].slice(0, 4) }))
    .sort((left, right) => right.messageCountEstimate - left.messageCountEstimate)
    .slice(0, 8);
};

// Q&A: a later partial that answers an earlier open question wins.
const mergeQa = (partials) => {
  const byQuestion = new Map();
  for (const item of normalizeQa(partials.flatMap((partial) => arrayOf(partial.qa)))) {
    const key = mergeKey(item.question);
    const existing = byQuestion.get(key);
    if (existing === undefined || (existing.answer === null && item.answer !== null)) {
      byQuestion.set(key, item);
    }
  }
  return [...byQuestion.values()].slice(0, 10);
};

const deterministicMerge = (partials) => {
  const summaries = partials.map((partial) => text(partial.summary)).filter((value) => value.length > 0);
  return {
    summary: summaries.slice(0, 4).join(" ") || "本时间段消息较多，已按话题合并汇总。",
    topics: mergeTopics(partials),
    newThings: dedupeAcross(
      partials,
      (partial) => normalizeNewThings(partial.newThings),
      (item) => mergeKey(item.link ?? item.name),
    ).slice(0, 12),
    qa: mergeQa(partials),
    timeline: partials
      .flatMap((partial) => arrayOf(partial.timeline))
      .filter((item) => item && nonEmpty(item.start) && nonEmpty(item.title) && nonEmpty(item.summary))
      .map((item) => ({
        start: item.start,
        end: nonEmpty(item.end) ? item.end : null,
        title: item.title,
        summary: item.summary,
        messageCountEstimate: Number.isFinite(item.messageCountEstimate) ? item.messageCountEstimate : 0,
      }))
      .slice(0, 12),
    uncategorized: dedupeAcross(
      partials,
      (partial) => arrayOf(partial.uncategorized),
      (item) => (item && nonEmpty(item.note) ? `${item.hkt ?? ""}|${mergeKey(item.note)}` : null),
    )
      .filter((item) => nonEmpty(item.hkt) && nonEmpty(item.speaker) && nonEmpty(item.note))
      .slice(0, 10),
    actions: [],
    risks: [],
    links: dedupeAcross(
      partials,
      (partial) => arrayOf(partial.links),
      (item) => (item && nonEmpty(item.url) ? mergeKey(item.url) : null),
    )
      .filter((item) => nonEmpty(item.title) && nonEmpty(item.url) && nonEmpty(item.why))
      .slice(0, 12),
    announcementDraft: null,
  };
};

/* ---------- orchestration ---------- */

// callLlm validators: an answer that fails them is asked again elsewhere.
const validateSummary = (raw) => {
  normalizeLlmSummary(raw, {});
};
const requireSummaryText = (raw) => {
  requiredString(raw?.summary, "summary");
};

// Summarize one chunk of formatted lines (the "map" step).
// callMeta: { groupId, day } for the usage record, allowFallback for redo work.
const summarizeLines = async (client, analysis, lines, partMeta, purpose = "map", callMeta = {}) =>
  callLlm(client, (detail) => ({
    ...buildMapPrompt(analysis, lines, partMeta, detail),
    maxTokens: partMeta === undefined ? profileFor(detail).map.singleMaxTokens : profileFor(detail).map.maxTokens,
  }), { purpose, messages: lines.length, validate: validateSummary, ...callMeta });

// Merge already-produced partials. Validated HERE so a reduce that returns
// malformed JSON also falls back to the deterministic merge.
const reducePartials = async (client, analysis, partials, provider, purpose = "reduce", callMeta = {}) => {
  if (partials.length === 1) {
    return { summary: normalizeLlmSummary(partials[0], provider), mode: "single" };
  }
  try {
    const raw = await callLlm(client, (detail) => ({ ...buildReducePrompt(analysis, partials, detail), maxTokens: profileFor(detail).reduce.maxTokens }), { purpose, validate: validateSummary, ...callMeta });
    return { summary: normalizeLlmSummary(raw, provider), mode: "mapreduce" };
  } catch (error) {
    console.warn(`llm reduce failed, using deterministic merge: ${error.message}`);
    return { summary: normalizeLlmSummary(deterministicMerge(partials), provider), mode: "mapreduce-local-merge" };
  }
};

/* ---------- the background briefing's merge ---------- */

const BRIEF_MERGE_MAX_TOKENS = 1500;
const BRIEF_MERGE_TOPICS = 6;
const BRIEF_NEW_THINGS = 20;

const BRIEF_MERGE_SCHEMA = {
  summary: "string",
  topics: [{ title: "string", summary: "string", importance: "high | medium | low", messageCountEstimate: "number" }],
};

const buildBriefMergePrompt = (analysis, partials) => ({
  system: [
    "你是一个 QQ 群聊摘要合并器。",
    "输入是同一个群按时间先后切分的多段摘要，请写出这一整段时间的总览。",
    "输出必须是合法 JSON，不要使用 Markdown，不要输出额外解释。",
  ].join("\n"),
  user: JSON.stringify(
    {
      task: `把同一个群的多段摘要合并成总览：一段 summary 和最多 ${BRIEF_MERGE_TOPICS} 个话题。`,
      rules: [
        "summary 用 2-4 句概括整段时间最值得知道的内容，不要逐段复述。",
        `topics 最多 ${BRIEF_MERGE_TOPICS} 个：同一话题在多段出现时合并成一个，按热度和重要性排序；每个 topic 的 summary 1-2 句。`,
        "messageCountEstimate 汇总各段的估计值。",
      ],
      outputSchema: BRIEF_MERGE_SCHEMA,
      context: {
        timeRange: { firstMessageHkt: analysis?.firstMessageHkt ?? null, lastMessageHkt: analysis?.lastMessageHkt ?? null },
        parsedTextMessages: analysis?.parsedTextMessages ?? null,
        totalParts: partials.length,
      },
      partials: partials.map((partial) => ({
        summary: text(partial.summary),
        topics: arrayOf(partial.topics).slice(0, 8).map((topic) => ({
          title: topic?.title,
          summary: topic?.summary,
          importance: topic?.importance,
          messageCountEstimate: topic?.messageCountEstimate,
        })),
      })),
    },
    null,
    2,
  ),
});

// The always-on briefing re-merges every group through the day. At the
// standard level that merge must be cheap: only the prose (overview + ranked
// topics) comes from the model; new things, Q&A, timeline and links are
// merged locally from the already-paid-for chunk summaries (measured: ~5k
// output tokens -> under 1k). The detailed level runs the full model merge,
// so topics keep their details and quotes and Q&A is resolved across chunks.
const mergeBriefPartials = async (client, analysis, partials, provider, purpose = "reduce", callMeta = {}) => {
  if (partials.length === 1) {
    return { summary: normalizeLlmSummary(partials[0], provider), mode: "single" };
  }
  if (profileFor(currentDetail(client)).briefMerge === "full") {
    return reducePartials(client, analysis, partials, provider, purpose, callMeta);
  }
  const local = {
    ...deterministicMerge(partials),
    // Newest first: in a long window the latest finds matter most.
    newThings: dedupeAcross([...partials].reverse(), (partial) => normalizeNewThings(partial.newThings), (item) => mergeKey(item.link ?? item.name))
      .slice(0, BRIEF_NEW_THINGS),
  };
  try {
    const raw = await callLlm(client, () => ({ ...buildBriefMergePrompt(analysis, partials), maxTokens: BRIEF_MERGE_MAX_TOKENS }), { purpose, validate: requireSummaryText, ...callMeta });
    const topics = arrayOf(raw.topics).slice(0, BRIEF_MERGE_TOPICS).map((topic) => ({ ...topic, details: [], evidence: [] }));
    return { summary: normalizeLlmSummary({ ...local, summary: raw.summary, topics }, provider), mode: "brief-merge" };
  } catch (error) {
    console.warn(`llm brief merge failed, using deterministic merge: ${error.message}`);
    return { summary: normalizeLlmSummary(local, provider), mode: "mapreduce-local-merge" };
  }
};

// Whole-window summary used by the manual run: map every chunk, then reduce.
// The detailed level cuts finer chunks, so each message gets more attention.
const summarizeMessages = async (client, analysis, messages, { maxMessages, maxChars }, provider) => {
  const profile = profileFor(currentDetail(client));
  const chunkMessages = profile.userTunable ? maxMessages : Math.min(maxMessages, profile.engine.maxMessages);
  const { chunks, capped } = buildChunks(messages, chunkMessages, maxChars);
  if (chunks.length <= 1) {
    const lines = chunks[0] ?? [];
    const raw = await summarizeLines(client, analysis, lines, undefined, "manual");
    const summary = normalizeLlmSummary(raw, { ...provider, messageLines: lines.length });
    return { summary, coverage: { totalTextMessages: messages.length, includedTextMessages: lines.length, chunks: 1, mode: "single", capped } };
  }

  console.log(`llm map-reduce: ${messages.length} messages -> ${chunks.length} chunks${capped ? " (capped)" : ""}`);
  const partials = [];
  let includedMessages = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      partials.push(await summarizeLines(client, analysis, chunks[index], { part: index + 1, total: chunks.length }, "manual"));
      includedMessages += chunks[index].length;
      console.log(`llm map chunk ${index + 1}/${chunks.length} ok`);
    } catch (error) {
      console.warn(`llm map chunk ${index + 1}/${chunks.length} failed: ${error.message}`);
    }
  }
  if (partials.length === 0) {
    throw new Error("All map chunks failed; no partial summary was produced.");
  }
  const { summary, mode } = await reducePartials(client, analysis, partials, { ...provider, messageLines: includedMessages }, "manual");
  return {
    summary,
    coverage: {
      totalTextMessages: messages.length,
      includedTextMessages: includedMessages,
      chunks: chunks.length,
      summarizedChunks: partials.length,
      mode: partials.length === 1 ? "mapreduce" : mode,
      capped: capped || partials.length < chunks.length,
    },
  };
};

const makeEndpoint = ({ baseUrl, apiKey, model, provider = "api", detail = "standard" }) =>
  ({ url: getChatCompletionsUrl(baseUrl), apiKey, model, provider, detail });

// fallback (same option shape) takes over when the primary is unavailable;
// onFallback(error) lets the caller remember that (src/llm_route.js).
const createClient = (options, { fallback = null, onFallback = () => {} } = {}) => ({
  ...makeEndpoint(options),
  fallback: fallback === null ? null : makeEndpoint(fallback),
  onFallback,
  state: { usingFallback: false, answeredByFallback: 0 },
});

module.exports = {
  MAX_CHUNKS,
  setUsageRecorder,
  providerExtras,
  parseJsonContent,
  OUTPUT_SCHEMA,
  createClient,
  callLlm,
  currentModel,
  currentDetail,
  shouldFallBack,
  getChatCompletionsUrl,
  assembleStream,
  formatMessageLine,
  buildChunks,
  buildMapPrompt,
  buildReducePrompt,
  trimPartialForReduce,
  normalizeLlmSummary,
  normalizeNewThings,
  normalizeQa,
  deterministicMerge,
  summarizeLines,
  reducePartials,
  mergeBriefPartials,
  summarizeMessages,
};
