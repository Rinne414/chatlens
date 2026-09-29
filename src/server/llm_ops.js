"use strict";

// AI cost visibility and control for 设置: usage summary, provider presets,
// editable price table, pausing the background AI work, the detail level and
// redoing past summaries at the detailed level.

const state = require("./toolkit_state");
const background = require("./background");
const { ensureBriefingSchema, markChunksForRedo, redoStats, standardChunksSince, detailProgress, getState, setState } = require("../briefing_store");
const review = require("../review_store");
const { formatHkt } = require("../unviewed_range");
const { usageByGroupDay } = require("../llm_usage");
const engine = require("../briefing_engine");
const { detailLevel, isGrokSelected } = require("../llm_route");
const { profileFor } = require("../llm_profiles");
const { summarizeUsage } = require("../llm_usage");
const { PRICE_SOURCE_DATE, DEFAULT_PRICES, PROVIDER_PRESETS, priceTable, validPriceRow } = require("../llm_pricing");

const MAX_PRICE_ROWS = 30;
const MAX_PAUSE_MINUTES = 7 * 24 * 60;
const DAY_SECONDS = 86400;
const REDO_DAY_CHOICES = new Set([1, 3, 7, 14, 30]);
const DETAIL_JOB_KEY = "detail_job";
// Before the job has any calls of its own: measured on grok-4.7 at the
// detailed level (323 messages -> 39.3k tokens incl. reasoning, US$0.0587).
const DEFAULT_TOKENS_PER_MESSAGE = 122;
const DEFAULT_USD_PER_MESSAGE = 0.0587 / 323;

const nowUnix = () => Math.floor(Date.now() / 1000);

const getUsage = ({ days }) => {
  const config = state.loadConfig();
  const db = ensureBriefingSchema(state.getStore());
  const span = Math.max(1, Math.min(90, Number.parseInt(days ?? "30", 10) || 30));
  const now = nowUnix();
  return {
    ...summarizeUsage(db, { nowUnix: now, days: span, prices: priceTable(config) }),
    model: config.llm?.model ?? "",
    pause: engine.pauseStatus(db, now),
    callCap: engine.budgetStatus(db, now, profileFor(detailLevel(config)).engine.dailyLlmCallLimit),
    dailyBudget: config.background?.dailyBudget ?? null,
    reduceIntervalMinutes: Number(config.background?.reduceIntervalMinutes ?? background.DEFAULTS.reduceIntervalMinutes),
    tailWaitMinutes: Number(config.background?.tailWaitMinutes ?? background.DEFAULTS.tailWaitMinutes),
    detail: detailLevel(config),
    grokSelected: isGrokSelected(config),
    redo: {
      ...redoStats(db),
      standardByDays: Object.fromEntries([...REDO_DAY_CHOICES].map((span) => [span, standardChunksSince(db, now - span * DAY_SECONDS)])),
    },
  };
};

const setDetail = ({ detail }) => {
  if (detail !== "standard" && detail !== "detailed") {
    throw new Error("详细度只能是 standard 或 detailed。");
  }
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, llm: { ...(raw.llm ?? {}), detail } });
  return { detail };
};

// Beijing days: today and the span - 1 days before it, oldest first.
const recentDays = (now, span) =>
  Array.from({ length: span }, (_, index) => formatHkt(now - (span - 1 - index) * DAY_SECONDS).slice(0, 10));

// The detailed level over the last `days`: every standard-level summary is
// queued for a redo (the old one keeps showing until replaced) and every
// message no summary covers yet is backfilled as detailed-level job chunks.
// The background refresh then works through them (briefing_engine).
const queueRedo = ({ days }) => {
  const span = Number(days);
  if (!REDO_DAY_CHOICES.has(span)) {
    throw new Error("重做范围无效。");
  }
  if (detailLevel(state.loadConfig()) !== "detailed") {
    throw new Error("先切换到详细模式，再重做过去的总结。");
  }
  const db = ensureBriefingSchema(state.getStore());
  const now = nowUnix();
  const dayList = recentDays(now, span);
  const queued = markChunksForRedo(db, { fromUnix: review.dayBounds(dayList[0]).start });
  const backfilled = dayList.map((day) => review.backfillDay(db, {
    day, now, asDetailedJob: true, maxMessages: profileFor("detailed").engine.maxMessages,
  }));
  const job = {
    startedAt: now,
    fromDay: dayList[0],
    toDay: dayList.at(-1),
    redoChunks: queued,
    backfillChunks: backfilled.reduce((total, item) => total + item.chunks, 0),
    backfillMessages: backfilled.reduce((total, item) => total + item.messages, 0),
  };
  setState(db, DETAIL_JOB_KEY, job);
  const tick = queued + job.backfillChunks > 0 ? background.runNow({ force: false }) : { started: false };
  return { ...job, started: tick.started === true };
};

const sumOf = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

// The detailed job's progress and cost, per day and group, plus what the rest
// is likely to need (from the job's own calls so far, else a measured default).
const getRedoReport = () => {
  const config = state.loadConfig();
  const db = ensureBriefingSchema(state.getStore());
  const job = getState(db, DETAIL_JOB_KEY, null);
  if (job === null) {
    return { job: null };
  }
  const progress = detailProgress(db, review.dayBounds(job.fromDay).start);
  const usage = usageByGroupDay(db, { sinceUnix: job.startedAt, fromDay: job.fromDay, toDay: job.toDay, prices: priceTable(config) });
  const usageOf = new Map(usage.map((row) => [`${row.day}|${row.groupId}`, row]));
  const rows = progress.map((row) => ({ ...row, usage: usageOf.get(`${row.day}|${row.groupId}`) ?? null }));
  const spent = {
    calls: sumOf(usage, "calls"),
    messages: sumOf(usage, "messages"),
    promptTokens: sumOf(usage, "promptTokens"),
    completionTokens: sumOf(usage, "completionTokens"),
    reasoningTokens: sumOf(usage, "reasoningTokens"),
    subscriptionListUsd: Math.round(sumOf(usage, "subscriptionListUsd") * 10000) / 10000,
    cost: usage.reduce((totals, row) => {
      for (const [currency, amount] of Object.entries(row.cost)) {
        totals[currency] = Math.round(((totals[currency] ?? 0) + amount) * 10000) / 10000;
      }
      return totals;
    }, {}),
  };
  const tokens = spent.promptTokens + spent.completionTokens + spent.reasoningTokens;
  const measured = spent.messages >= 500;
  const perMessage = {
    tokens: measured ? tokens / spent.messages : DEFAULT_TOKENS_PER_MESSAGE,
    usd: measured ? spent.subscriptionListUsd / spent.messages : DEFAULT_USD_PER_MESSAGE,
    measured,
  };
  const remainingMessages = sumOf(progress, "queuedMessages");
  return {
    job,
    rows,
    spent,
    remaining: {
      chunks: sumOf(progress, "queuedChunks"),
      messages: remainingMessages,
      tokens: Math.round(remainingMessages * perMessage.tokens),
      listUsd: Math.round(remainingMessages * perMessage.usd * 100) / 100,
    },
    perMessage,
  };
};

const getProviders = () => {
  const config = state.loadConfig();
  return {
    presets: PROVIDER_PRESETS,
    defaultPrices: DEFAULT_PRICES,
    customPrices: priceTable(config).filter((row) => row.custom),
    priceSourceDate: PRICE_SOURCE_DATE,
  };
};

// Replaces the user's custom price rows (defaults stay as the fallback).
const savePrices = ({ prices }) => {
  if (!Array.isArray(prices) || prices.length > MAX_PRICE_ROWS) {
    throw new Error("价格表格式不对。");
  }
  const rows = prices.map((row) => ({
    match: String(row?.match ?? "").trim().slice(0, 64),
    currency: row?.currency,
    input: Number(row?.input),
    cachedInput: Number(row?.cachedInput ?? row?.input),
    output: Number(row?.output),
    offPeakHalf: row?.offPeakHalf === true,
  }));
  const invalid = rows.find((row) => !validPriceRow(row));
  if (invalid !== undefined) {
    throw new Error(`价格行无效：${invalid.match || "（空模型名）"}。模型名不能为空，价格须为非负数，币种为 CNY 或 USD。`);
  }
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, llm: { ...(raw.llm ?? {}), prices: rows } });
  return getProviders();
};

// minutes: 0 = resume, -1 = until resumed, otherwise a duration.
const setPause = ({ minutes }) => {
  const value = Number(minutes);
  if (!(value === 0 || value === -1 || (Number.isFinite(value) && value > 0 && value <= MAX_PAUSE_MINUTES))) {
    throw new Error("暂停时长无效。");
  }
  const db = ensureBriefingSchema(state.getStore());
  return engine.setPause(db, { now: nowUnix(), minutes: value });
};

module.exports = { getUsage, getProviders, savePrices, setPause, setDetail, queueRedo, getRedoReport };
