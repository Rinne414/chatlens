"use strict";

// AI cost visibility and control for 设置: usage summary, provider presets,
// editable price table, and pausing the background AI work.

const state = require("./toolkit_state");
const background = require("./background");
const { ensureBriefingSchema } = require("../briefing_store");
const engine = require("../briefing_engine");
const { summarizeUsage } = require("../llm_usage");
const { PRICE_SOURCE_DATE, DEFAULT_PRICES, PROVIDER_PRESETS, priceTable, validPriceRow } = require("../llm_pricing");

const MAX_PRICE_ROWS = 30;
const MAX_PAUSE_MINUTES = 7 * 24 * 60;

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
    callCap: engine.budgetStatus(db, now),
    dailyBudget: config.background?.dailyBudget ?? null,
    reduceIntervalMinutes: Number(config.background?.reduceIntervalMinutes ?? background.DEFAULTS.reduceIntervalMinutes),
    tailWaitMinutes: Number(config.background?.tailWaitMinutes ?? background.DEFAULTS.tailWaitMinutes),
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

module.exports = { getUsage, getProviders, savePrices, setPause };
