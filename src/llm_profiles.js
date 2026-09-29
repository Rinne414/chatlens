"use strict";

// Detail levels for everything the AI writes (config.llm.detail).
//
// "standard" is the cost-conscious behaviour every earlier version had: short
// prompts, small output caps, a cheap brief merge that lets the model write
// only the overview, merges at most every 2 hours.
// "detailed" is for plans where tokens are not the constraint (a Grok
// subscription): finer chunks, a full model merge with per-topic details and
// quotes, fuller lists, merges as soon as a chunk lands, and a much higher
// runaway guard. It is chosen per call from the client that actually answers,
// so a fallback to a paid API key always runs at the standard level.

const MINUTE = 60;
const HOUR = 3600;

const STANDARD = {
  name: "standard",
  requestTimeoutMs: 120000,
  map: { maxTokens: 6144, singleMaxTokens: 6144 },
  // Trims each chunk summary before a merge and caps the merged output.
  reduce: {
    maxTokens: 8192,
    // Trimmed further (halving the per-chunk caps) until the input fits.
    inputChars: 100000,
    trim: { topics: 8, details: 2, evidence: 1, newThings: 10, qa: 8, timeline: 8, uncategorized: 8, links: 8 },
    caps: { topics: 8, details: 3, evidence: 2, newThings: 12, qa: 10, timeline: 12, uncategorized: 10, links: 12 },
    summarySentences: "2-4",
  },
  // The background brief: only overview + ranked topics come from the model.
  briefMerge: "overview-only",
  // Briefing engine knobs (src/briefing_engine.js DEFAULTS are the same).
  engine: {
    maxMessages: 400,
    tailMaxAgeSeconds: HOUR,
    reduceIntervalSeconds: 2 * HOUR,
    maxReduceChunks: 24,
    maxMapPerRun: 40,
    mapConcurrency: 3,
    dailyLlmCallLimit: 400,
  },
  quick: { maxMessages: 600, maxTokens: 2048, points: "3-8" },
  // 每日总览 / 周报 / 月报 (src/digest_engine.js): what each chunk or day
  // contributes to the input, the input budget, and the output caps.
  digest: {
    day: {
      maxTokens: 4096,
      inputChars: 120000,
      perChunk: { topics: 4, details: 0, newThings: 4, qa: 3 },
      caps: { highlights: 8, crossGroup: 5, newThings: 10, openQuestions: 6 },
      summarySentences: "3-5",
    },
    period: {
      maxTokens: 6144,
      inputChars: 150000,
      caps: { trends: 6, highlights: 10, newThings: 12, bestQa: 8 },
      summarySentences: "4-6",
    },
    // Today's overview is written on request only.
    autoToday: false,
    maxScheduledCalls: 3,
  },
  ask: { hitsPerKeyword: 200, maxHits: 40, context: 3, inputChars: 40000, maxTokens: 3072, summaryHits: 12 },
  // The user's own 合并频率 / 等待 settings apply at this level only.
  userTunable: true,
};

const DETAILED = {
  name: "detailed",
  // A big detailed merge on Grok streams for many minutes.
  requestTimeoutMs: 900000,
  map: { maxTokens: 16384, singleMaxTokens: 16384 },
  reduce: {
    maxTokens: 32768,
    inputChars: 240000,
    trim: { topics: 20, details: 8, evidence: 4, newThings: 30, qa: 30, timeline: 20, uncategorized: 20, links: 30 },
    caps: { topics: 25, details: 10, evidence: 5, newThings: 40, qa: 40, timeline: 40, uncategorized: 30, links: 40 },
    summarySentences: "5-10",
  },
  briefMerge: "full",
  engine: {
    maxMessages: 250,
    tailMaxAgeSeconds: 15 * MINUTE,
    reduceIntervalSeconds: 0,
    maxReduceChunks: 40,
    maxMapPerRun: 120,
    mapConcurrency: 4,
    dailyLlmCallLimit: 3000,
  },
  quick: { maxMessages: 400, maxTokens: 8192, points: "5-20" },
  digest: {
    day: {
      maxTokens: 16384,
      inputChars: 400000,
      perChunk: { topics: 10, details: 3, newThings: 10, qa: 8 },
      caps: { highlights: 20, crossGroup: 10, newThings: 25, openQuestions: 15 },
      summarySentences: "6-12",
    },
    period: {
      maxTokens: 24576,
      inputChars: 500000,
      caps: { trends: 12, highlights: 25, newThings: 30, bestQa: 20 },
      summarySentences: "8-15",
    },
    // Today's overview keeps itself current (at most hourly).
    autoToday: true,
    maxScheduledCalls: 12,
  },
  ask: { hitsPerKeyword: 600, maxHits: 150, context: 5, inputChars: 200000, maxTokens: 12288, summaryHits: 40 },
  userTunable: false,
};

const PROFILES = { standard: STANDARD, detailed: DETAILED };

const profileFor = (detail) => PROFILES[detail] ?? STANDARD;

// Map-step rules. Standard keeps the long-standing wording; detailed asks for
// everything with substance, each point attributed to who said it.
const MAP_RULES = {
  standard: [
    "summary 用 2-4 句话说清这段时间群里最值得知道的事，像朋友转述一样具体，不要空话套话。",
    "topics 是大家集中讨论过的话题：title 必须来自这批消息的真实内容；每个话题需要 summary、details、evidence。只保留真的有多人参与或反复出现的，不要把一两句闲聊当话题。",
    "newThings 列出这批消息里新出现或被分享的东西：新模型/新版本、工具或插件、教程、资源、网站、活动或比赛、新闻。kind 取 model|tool|tutorial|resource|news|event|other；name 写名称；detail 一句话说明它是什么、有什么用或大家怎么评价；有链接就把原链接写进 link，否则 link 用 null；speaker、hkt 写是谁在什么时候分享的。同一个东西只列一次。只有消息里确实出现时才列。",
    "qa 列出有人提问并得到有用回答的问题（尤其是技术和使用问题，值得当知识保存）：question 概括问题，answer 概括最有用的回答，asker/answerer 写发言人，resolved 用 true。没人回答但值得注意的问题也可以列：answer 和 answerer 用 null，resolved 用 false。寒暄、求表情、纯玩笑不要列。",
    "timeline 按时间段归纳：群聊通常集中在几个时间段，每段给出起止时间和这段时间主要在聊什么。用 localTimeBlocks 提示的分段作参考，可合并或拆分。",
    "uncategorized 只列不属于上面任何一类、但确实值得注意的零散消息（群通知、规则变化、约定、提醒），逐条注明时间、发言人和为什么值得注意。纯闲聊不要列。",
    "links 只保留值得保存或回看、且没有出现在 newThings 里的链接。",
  ],
  detailed: [
    "这是详细模式：读者想不爬楼也知道群里发生过的每件有内容的事，宁可多写也不要漏。",
    "summary 用 5-10 句话完整概述这段时间：主要讨论了什么、得出了什么结论、还有什么没解决，具体到人和事，不要空话套话。",
    "topics 列出所有有实际内容的讨论（两人以上参与，或一个人给出了有用信息），不要只挑最热的。title 必须来自消息的真实内容。每个 topic：summary 用 3-6 句讲清起因、各方观点（谁说了什么）、结论或分歧；details 列出所有有信息量的要点（通常 3-10 条，每条写明是谁说的）；evidence 摘录 2-5 句有代表性的原话，格式为「发言人：原话」。",
    "newThings 列出这批消息里新出现或被分享的所有东西：新模型/新版本、工具或插件、教程、资源、网站、活动或比赛、新闻。kind 取 model|tool|tutorial|resource|news|event|other；name 写名称；detail 用 2-3 句说明它是什么、怎么用、大家的评价或争议；有链接就把原链接写进 link，否则 link 用 null；speaker、hkt 写是谁在什么时候分享的。同一个东西只列一次。",
    "qa 列出所有提问：有回答的写完整的回答要点（不是一句话），asker/answerer 写发言人，resolved 用 true；没人回答的也要列，answer 和 answerer 用 null，resolved 用 false。只有寒暄、求表情、纯玩笑不列。",
    "timeline 按 15-30 分钟的粒度划分时间段，每段给出起止时间、标题和这段时间具体聊了什么。用 localTimeBlocks 作参考。",
    "uncategorized 列出所有不属于上面各类、但有信息量的消息（群通知、规则变化、约定、提醒、个人近况、有意思的观点），逐条注明时间、发言人和内容要点。",
    "links 列出所有不是纯闲聊的链接（没有出现在 newThings 里的），说明是什么、为什么被分享。",
  ],
};

const mapRulesFor = (detail) => MAP_RULES[profileFor(detail).name];

module.exports = { PROFILES, profileFor, mapRulesFor };
