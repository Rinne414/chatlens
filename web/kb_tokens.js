"use strict";

// The 咒语库 search box as a list of removable conditions. Pure: no DOM, so it
// is tested directly in Node; loaded in the browser as window.KbTokens.
//
// Splitting matches src/knowledge_query.js (quoted runs stay together), so a
// chip always corresponds to exactly one term the server parsed, and removing
// the chip removes exactly that term.

const KB_TOKEN_PATTERN = /(?:[^\s"]+"[^"]*"|[^\s"]+|"[^"]*")+/gu;

const KB_FIELD_LABELS = {
  tag: "标签",
  tags: "标签",
  prompt: "咒语含",
  model: "模型",
  checkpoint: "模型",
  ckpt: "模型",
  lora: "LoRA",
  generator: "来源",
  gen: "来源",
  sender: "发图人",
  from: "发图人",
  group: "群",
  seed: "seed",
  aspect: "比例",
  date: "日期",
};

const KB_FLAG_LABELS = {
  prompt: ["有咒语", "没有咒语"],
  params: ["原图带参数", "原图不带参数"],
  request: ["有人求过", "没人求过"],
  answer: ["作者回了", "还没人回"],
  sender: ["对得上发图人", "不知道发图人"],
  file: ["有本地原图", "没有本地原图"],
  lora: ["用了 LoRA", "没用 LoRA"],
  negative: ["有负面咒语", "没有负面咒语"],
};

const KB_GENERATOR_LABELS = {
  webui: "A1111",
  forge: "Forge",
  reforge: "reForge",
  comfyui: "ComfyUI",
  nai: "NovelAI",
  stripped: "群里回的咒语",
};

const KB_ASPECT_LABELS = { square: "方图", landscape: "横图", portrait: "竖图" };

const tokenizeQuery = (text) => String(text ?? "").match(KB_TOKEN_PATTERN) ?? [];

const unquoteValue = (value) => value.replace(/^"|"$/gu, "");

const quoteValue = (value) => (/\s/u.test(value) ? `"${value}"` : value);

// A human label for one search term: { text, tone } with tone include /
// exclude / flag / free.
const tokenLabel = (token) => {
  const negated = token.startsWith("-");
  const body = negated ? token.slice(1) : token;
  const match = body.match(/^([A-Za-z一-鿿_]+)(>=|<=|>|<|[:=])([\s\S]+)$/u);
  if (match === null) {
    return { text: `“${unquoteValue(token)}”`, tone: "free" };
  }
  const key = match[1].toLowerCase();
  const operator = match[2];
  const value = unquoteValue(match[3]);
  if (key === "has" || key === "no") {
    const labels = KB_FLAG_LABELS[value.toLowerCase()];
    return labels === undefined
      ? { text: token, tone: "flag" }
      : { text: labels[key === "has" ? 0 : 1], tone: "flag" };
  }
  if (operator === ">=" || operator === ">" || operator === "<=" || operator === "<") {
    return { text: `${key} ${operator.startsWith(">") ? "≥" : "≤"} ${value}`, tone: "include" };
  }
  if (key === "generator" || key === "gen") {
    return { text: `来源：${KB_GENERATOR_LABELS[value.toLowerCase()] ?? value}`, tone: negated ? "exclude" : "include" };
  }
  if (key === "aspect") {
    return { text: KB_ASPECT_LABELS[value.toLowerCase()] ?? value, tone: "include" };
  }
  if (key === "date") {
    return { text: `日期 ${value.replace("..", " ~ ")}`, tone: "include" };
  }
  const label = KB_FIELD_LABELS[key] ?? key;
  const shown = /\.\./u.test(value) ? value.replace("..", " ~ ") : value;
  return { text: `${negated ? "排除" : ""}${label}：${shown}`, tone: negated ? "exclude" : "include" };
};

const removeToken = (query, token) => {
  const tokens = tokenizeQuery(query);
  const index = tokens.indexOf(token);
  return index === -1 ? query : [...tokens.slice(0, index), ...tokens.slice(index + 1)].join(" ");
};

const addToken = (query, token) => {
  const tokens = tokenizeQuery(query);
  return tokens.includes(token) ? tokens.join(" ") : [...tokens, token].join(" ");
};

const toggleToken = (query, token) =>
  (tokenizeQuery(query).includes(token) ? removeToken(query, token) : addToken(query, token));

const kbTokens = {
  KB_GENERATOR_LABELS,
  tokenizeQuery,
  tokenLabel,
  quoteValue,
  removeToken,
  addToken,
  toggleToken,
};

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = kbTokens;
}
if (typeof window !== "undefined") {
  window.KbTokens = kbTokens;
}
