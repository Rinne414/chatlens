const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { readSecretSync } = require("./secrets");
const { createStoreRecorder } = require("./llm_usage");
const { parseJsonContent, providerExtras } = require("./llm_summarizer");

const MAX_MESSAGES = 600;
const MAX_CHARS = 60000;
const REQUEST_TIMEOUT_MS = 120000;

const parseArgs = (argv) => {
  if (argv.length !== 7) {
    throw new Error("Usage: node llm_quick_summary.js <inputJson> <outputJson> <baseUrl> <model> <apiKeyEnv>");
  }
  return { inputJson: argv[2], outputJson: argv[3], baseUrl: argv[4], model: argv[5], apiKeyEnv: argv[6] };
};

const getChatCompletionsUrl = (rawBaseUrl) => {
  const url = new URL(rawBaseUrl);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return url;
};

const requestJson = (url, apiKey, payload) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = url.protocol === "http:" ? http : https;
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
            reject(new Error(`LLM request failed. StatusCode=${response.statusCode} Body=${responseBody.slice(0, 1000)}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`LLM response was not valid JSON: ${error.message}`));
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS} ms`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });

const messageLine = (message) => `[${message.hkt}] ${message.speaker}: ${message.text}`;

// Consecutive parts of at most MAX_MESSAGES messages / MAX_CHARS characters,
// covering every selected message: a long selection is summarized part by
// part and then merged, instead of keeping only its tail.
const splitParts = (messages) => {
  const parts = [];
  let current = [];
  let chars = 0;
  for (const message of messages) {
    const length = messageLine(message).length;
    if (current.length > 0 && (current.length >= MAX_MESSAGES || chars + length > MAX_CHARS)) {
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

const buildPrompt = (input, part = null) => {
  const lines = input.messages.map(messageLine);
  const where = part === null ? "" : `（这是整段选择的第 ${part.index}/${part.total} 部分）`;
  return [
    `以下是 QQ 群「${input.groupName || input.groupId}」中用户手动选取的一段连续消息（共 ${lines.length} 条）${where}。`,
    "请只针对这段消息输出 JSON（简体中文）：",
    '{"summary": "两三句话概括这段对话", "points": ["要点1", "要点2"], "actions": [{"text": "待办或提问", "status": "open 或 resolved", "resolution": "若已解决，说明谁如何解决"}]}',
    "规则：points 3-8 条，按时间顺序；actions 只列明确请求某人执行、明确承诺执行、或带责任/截止时间的事项。普通提问、求购、求推荐和征询意见不算 action。检查后文，明确完成的标 resolved；没有则给空数组。",
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
  const fromEnv = String(process.env[args.apiKeyEnv] ?? "").trim();
  const apiKey = fromEnv.length > 0 ? fromEnv : readSecretSync("llmKey").trim();

  const input = JSON.parse(fs.readFileSync(args.inputJson, "utf8"));
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("Input has no messages to summarize");
  }

  const url = getChatCompletionsUrl(args.baseUrl);
  const record = createStoreRecorder(path.resolve(__dirname, ".."));
  const ask = async (prompt, messageCount) => {
    const response = await requestJson(url, apiKey, {
      model: args.model,
      messages: [
        { role: "system", content: "你是精炼的群聊摘要助手，只输出合法 JSON。" },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 2048,
      ...providerExtras(url),
    });
    if (response.usage !== undefined) {
      record({ at: Math.floor(Date.now() / 1000), purpose: "quick", model: args.model, host: url.host, usage: response.usage, messages: messageCount });
    }
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LLM response missing message content");
    }
    return normalizeResult(parseJsonContent(content));
  };

  const parts = splitParts(input.messages);
  let result;
  if (parts.length === 1) {
    result = await ask(buildPrompt(input), input.messages.length);
  } else {
    const partials = [];
    for (const [index, messages] of parts.entries()) {
      console.log(`quick summary part ${index + 1}/${parts.length}`);
      partials.push(await ask(buildPrompt({ ...input, messages }, { index: index + 1, total: parts.length }), messages.length));
    }
    try {
      result = await ask(buildMergePrompt(input, partials), 0);
    } catch (error) {
      console.log(`quick summary merge failed, keeping the parts side by side: ${error.message}`);
      result = mergeLocally(partials);
    }
  }
  result.model = args.model;
  result.messageCount = input.messages.length;
  result.parts = parts.length;
  fs.writeFileSync(args.outputJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`quickSummaryPath=${args.outputJson}`);
};

main().catch((error) => {
  console.error(`llm_quick_summary failed: ${error.message}`);
  process.exit(1);
});
