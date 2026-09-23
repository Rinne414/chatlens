"use strict";

// Resolves the configured OpenAI-compatible LLM and makes its API key
// available to child scripts through an environment variable (never argv).

const { readSecretSync, hasSecret } = require("../secrets");

const DEFAULT_KEY_ENV = "DEEPSEEK_API_KEY";
const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_CHARS = 50000;

const positiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const resolveLlmOptions = (config) => {
  const llm = config.llm;
  if (llm === null || typeof llm !== "object") {
    throw new Error("配置缺少 llm 设置。请在「设置」页填写 LLM API 地址和模型。");
  }
  const baseUrl = String(llm.baseUrl ?? "").trim();
  const model = String(llm.model ?? "").trim();
  if (baseUrl.length === 0 || model.length === 0) {
    throw new Error("LLM 的 API 地址或模型为空。请在「设置」页填写。");
  }
  const apiKeyEnv = String(llm.apiKeyEnv ?? "").trim() || DEFAULT_KEY_ENV;
  const fromEnv = String(process.env[apiKeyEnv] ?? "").trim();
  let apiKey = fromEnv;
  if (apiKey.length === 0) {
    if (!hasSecret("llmKey")) {
      throw new Error("还没有保存 LLM API key。请在「设置」页保存。");
    }
    apiKey = readSecretSync("llmKey").trim();
  }
  return {
    provider: String(llm.provider ?? "deepseek"),
    baseUrl,
    model,
    apiKeyEnv,
    apiKey,
    maxMessages: positiveInt(llm.maxMessages, DEFAULT_MAX_MESSAGES),
    maxChars: positiveInt(llm.maxChars, DEFAULT_MAX_CHARS),
  };
};

// Env entries to hand to children that call the LLM.
const llmEnv = (options) => (options === null ? {} : { [options.apiKeyEnv]: options.apiKey });

module.exports = { resolveLlmOptions, llmEnv };
