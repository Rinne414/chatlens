"use strict";

// Token prices for cost estimates, and the provider presets shown in 设置.
//
// Defaults were copied from the official pricing pages on 2026-09-24:
//   DeepSeek  https://api-docs.deepseek.com/zh-cn/quick_start/pricing  (CNY, off-peak = 50%)
//   Gemini    https://ai.google.dev/gemini-api/docs/pricing            (USD, paid tier)
// Prices change; users can override any row in 设置 (config.llm.prices) and the
// UI always labels these as estimates.

const PRICE_SOURCE_DATE = "2026-09-24";

// First matching row wins, so specific ids come before generic prefixes.
const DEFAULT_PRICES = [
  { match: "deepseek-v4-pro", currency: "CNY", input: 9, cachedInput: 0.3, output: 27, offPeakHalf: true },
  { match: "deepseek", currency: "CNY", input: 2, cachedInput: 0.04, output: 8, offPeakHalf: true },
  { match: "gemini-3.1-flash-lite", currency: "USD", input: 0.25, cachedInput: 0.025, output: 1.5 },
  { match: "gemini-3.5-flash-lite", currency: "USD", input: 0.3, cachedInput: 0.03, output: 2.5 },
  { match: "gemini-3.8-flash", currency: "USD", input: 0.75, cachedInput: 0.075, output: 3.75 },
  { match: "gemini-3.7-flash", currency: "USD", input: 0.75, cachedInput: 0.075, output: 3.75 },
  { match: "gemini-3.1-pro", currency: "USD", input: 2, cachedInput: 0.2, output: 12 },
  { match: "gemini-2.5-pro", currency: "USD", input: 1.25, cachedInput: 0.125, output: 10 },
];

const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    recommended: true,
    notes: [
      "中文群聊理解好、价格低：flash 每百万 token 输入 ¥2 / 输出 ¥8，工作日 9-12、14-18 点以外半价。",
      "国内直连，不需要代理。推荐大多数人用这个。",
    ],
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.1-flash-lite", "gemini-3.8-flash"],
    notes: [
      "flash-lite 很便宜（每百万 token 输入 $0.25 / 输出 $1.5），还有免费额度。",
      "免费额度的输入可能被 Google 用于改进产品，介意隐私请开通付费档；国内网络需要代理。",
    ],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "dashscope",
    name: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    notes: ["国内直连。保存 key 后点「获取模型列表」挑一个便宜的 flash / turbo 档；价格请在下方价格表里填上。"],
    keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    notes: ["国内直连，长上下文。价格请按官网填到价格表。"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow（硅基流动）",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [],
    notes: ["一个 key 调用多家开源模型，部分小模型免费。"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    notes: ["海外聚合平台，一个 key 用各家模型；需要代理和海外付款方式。"],
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    name: "本地 Ollama（免费）",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    notes: [
      "完全本地、不花钱，消息不出电脑；但需要显卡，速度和总结质量取决于你下载的模型（建议 14B 以上的中文模型）。",
      "API key 随便填一串（例如 ollama），Ollama 不校验。",
    ],
    keyUrl: null,
  },
];

const BEIJING_OFFSET_SECONDS = 8 * 3600;

// DeepSeek peak: Beijing time Mon-Fri 09:00-12:00 and 14:00-18:00. Chinese
// public holidays are also off-peak; not modelled, so holiday estimates are
// slightly high rather than low.
const isDeepseekPeak = (unixSeconds) => {
  const date = new Date((unixSeconds + BEIJING_OFFSET_SECONDS) * 1000);
  const weekday = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const weekdayPeak = weekday >= 1 && weekday <= 5;
  return weekdayPeak && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080));
};

const validPriceRow = (row) =>
  row !== null
  && typeof row === "object"
  && typeof row.match === "string"
  && row.match.trim().length > 0
  && ["CNY", "USD"].includes(row.currency)
  && [row.input, row.cachedInput, row.output].every((value) => Number.isFinite(Number(value)) && Number(value) >= 0);

const priceTable = (config) => {
  const custom = Array.isArray(config?.llm?.prices) ? config.llm.prices.filter(validPriceRow) : [];
  return [
    ...custom.map((row) => ({ ...row, input: Number(row.input), cachedInput: Number(row.cachedInput), output: Number(row.output), custom: true })),
    ...DEFAULT_PRICES,
  ];
};

const priceFor = (model, prices) => {
  const id = String(model ?? "").toLowerCase();
  return prices.find((row) => id.includes(row.match.toLowerCase())) ?? null;
};

// Cost of one call: { currency, amount } or null when the model has no price.
const costOf = ({ model, at, promptTokens, cachedTokens, completionTokens }, prices) => {
  const price = priceFor(model, prices);
  if (price === null) {
    return null;
  }
  const cached = Math.min(Number(cachedTokens) || 0, Number(promptTokens) || 0);
  const uncached = Math.max(0, (Number(promptTokens) || 0) - cached);
  const base = (uncached * price.input + cached * price.cachedInput + (Number(completionTokens) || 0) * price.output) / 1_000_000;
  const factor = price.offPeakHalf && !isDeepseekPeak(at) ? 0.5 : 1;
  return { currency: price.currency, amount: base * factor };
};

module.exports = { PRICE_SOURCE_DATE, DEFAULT_PRICES, PROVIDER_PRESETS, isDeepseekPeak, priceTable, priceFor, costOf, validPriceRow };
