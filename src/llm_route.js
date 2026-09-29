"use strict";

// Which LLM the AI features call, and what happens when it is unavailable.
//
// Providers (config.llm.provider):
//   "grok-subscription" — api.x.ai with the Grok sign-in (src/grok_auth.js);
//   anything else       — the OpenAI-compatible endpoint + saved API key
//                         (DeepSeek by default; older configs say "deepseek").
// With Grok selected, the API-key provider (when configured) is the fallback:
// if Grok is not usable (sign-in rejected, weekly pool used up, outage) the
// work continues there at the standard detail level, and Grok is skipped for a
// while so every run does not hit the same failure first.
//
// Every process that calls the LLM (background refresh, manual run, quick
// summary) resolves its own route, so tokens never travel on a command line.

const fs = require("node:fs");
const path = require("node:path");
const secrets = require("./secrets");
const grokAuth = require("./grok_auth");

const GROK_PROVIDER = "grok-subscription";
const DEFAULT_KEY_ENV = "DEEPSEEK_API_KEY";
const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_CHARS = 50000;
const DEFAULT_STATE_PATH = path.join(__dirname, "..", "store", "llm-provider-state.json");

// How long Grok is skipped after it failed, by cause.
const SKIP_SECONDS = {
  quota: 3600,
  auth: 6 * 3600,
  other: 15 * 60,
};

const nowUnix = () => Math.floor(Date.now() / 1000);

const positiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const detailLevel = (config) => (config?.llm?.detail === "detailed" ? "detailed" : "standard");

const isGrokSelected = (config) => config?.llm?.provider === GROK_PROVIDER;

/* ---------- the API-key provider ---------- */

const apiKeyEnvName = (config) => String(config?.llm?.apiKeyEnv ?? "").trim() || DEFAULT_KEY_ENV;

const hasApiKeyProvider = (config) => {
  const llm = config?.llm ?? {};
  return String(llm.baseUrl ?? "").trim().length > 0
    && String(llm.model ?? "").trim().length > 0
    && (String(process.env[apiKeyEnvName(config)] ?? "").trim().length > 0 || secrets.hasSecret("llmKey"));
};

const apiKeyOptions = (config, detail) => {
  const llm = config?.llm;
  if (llm === null || typeof llm !== "object") {
    throw new Error("配置缺少 llm 设置。请在「设置」页填写 LLM API 地址和模型。");
  }
  const baseUrl = String(llm.baseUrl ?? "").trim();
  const model = String(llm.model ?? "").trim();
  if (baseUrl.length === 0 || model.length === 0) {
    throw new Error("LLM 的 API 地址或模型为空。请在「设置」页填写。");
  }
  const apiKeyEnv = apiKeyEnvName(config);
  let apiKey = String(process.env[apiKeyEnv] ?? "").trim();
  if (apiKey.length === 0) {
    if (!secrets.hasSecret("llmKey")) {
      throw new Error("还没有保存 LLM API key。请在「设置」页保存。");
    }
    apiKey = secrets.readSecretSync("llmKey").trim();
  }
  return {
    provider: "api",
    baseUrl,
    model,
    apiKey,
    detail,
    maxMessages: positiveInt(llm.maxMessages, DEFAULT_MAX_MESSAGES),
    maxChars: positiveInt(llm.maxChars, DEFAULT_MAX_CHARS),
  };
};

/* ---------- remembered Grok failures ---------- */

const readProviderState = (statePath = DEFAULT_STATE_PATH) => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
};

const writeProviderState = (statePath, value) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf8");
  fs.renameSync(tempPath, statePath);
};

const skipKindFor = (error) => {
  const status = Number(error?.status);
  if (status === 429 || status === 402) {
    return "quota";
  }
  if (status === 401 || status === 403 || error instanceof grokAuth.GrokAuthError) {
    return "auth";
  }
  return "other";
};

const markGrokUnavailable = (error, { statePath = DEFAULT_STATE_PATH, now = nowUnix() } = {}) => {
  const kind = skipKindFor(error);
  const entry = {
    grokSkippedUntil: now + SKIP_SECONDS[kind],
    kind,
    reason: String(error?.message ?? error).slice(0, 300),
    at: now,
  };
  try {
    writeProviderState(statePath, entry);
  } catch (writeError) {
    console.warn(`llm provider state not saved: ${writeError.message}`);
  }
  return entry;
};

const clearGrokUnavailable = ({ statePath = DEFAULT_STATE_PATH } = {}) => {
  fs.rmSync(statePath, { force: true });
};

const grokSkip = ({ statePath = DEFAULT_STATE_PATH, now = nowUnix() } = {}) => {
  const state = readProviderState(statePath);
  return Number(state.grokSkippedUntil) > now ? state : null;
};

/* ---------- the route ---------- */

const isLlmConfigured = (config) =>
  (isGrokSelected(config) && grokAuth.isLoggedIn()) || hasApiKeyProvider(config);

// { primary, fallback, grokSkipped } — primary is what to call first;
// fallback (API-key provider, standard level) is set only while Grok leads.
const resolveLlmRoute = async (config, { statePath = DEFAULT_STATE_PATH, now = nowUnix() } = {}) => {
  const detail = detailLevel(config);
  if (!isGrokSelected(config)) {
    return { primary: apiKeyOptions(config, detail), fallback: null, grokSkipped: null };
  }
  const fallback = hasApiKeyProvider(config) ? apiKeyOptions(config, "standard") : null;
  const useFallback = (reason) => {
    if (fallback === null) {
      throw new Error(`Grok 暂时不能用（${reason}），也没有配置备用的 API key。`);
    }
    return { primary: fallback, fallback: null, grokSkipped: reason };
  };
  const skipped = grokSkip({ statePath, now });
  if (skipped !== null) {
    return useFallback(skipped.reason);
  }
  let apiKey;
  try {
    apiKey = await grokAuth.getAccessToken();
  } catch (error) {
    if (error.code !== "not-logged-in") {
      markGrokUnavailable(error, { statePath, now });
    }
    return useFallback(error.message);
  }
  const llm = config.llm;
  return {
    primary: {
      provider: GROK_PROVIDER,
      baseUrl: grokAuth.GROK_BASE_URL,
      model: String(llm.grokModel ?? "").trim() || grokAuth.DEFAULT_GROK_MODEL,
      apiKey,
      detail,
      maxMessages: positiveInt(llm.maxMessages, DEFAULT_MAX_MESSAGES),
      maxChars: positiveInt(llm.maxChars, DEFAULT_MAX_CHARS),
    },
    fallback,
    grokSkipped: null,
  };
};

module.exports = {
  GROK_PROVIDER,
  DEFAULT_STATE_PATH,
  SKIP_SECONDS,
  detailLevel,
  isGrokSelected,
  hasApiKeyProvider,
  isLlmConfigured,
  resolveLlmRoute,
  markGrokUnavailable,
  clearGrokUnavailable,
  grokSkip,
  skipKindFor,
};
