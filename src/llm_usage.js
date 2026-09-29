"use strict";

// Records the token usage the LLM API reports for every call, so the user can
// see what the background briefing actually costs and budget for it. Lives in
// store/messages.db; written by whichever process made the call (background
// refresh, manual run, quick summary). Recording never breaks an LLM call.

const path = require("node:path");
const { costOf } = require("./llm_pricing");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const DAY_SECONDS = 86400;
const BRIEFING_PURPOSES = new Set(["map", "reduce"]);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at)",
];

// Columns added after the table first shipped. billing = 'subscription' marks
// calls a Grok subscription paid for (no money spent); list_cost_usd is the
// provider-reported price those tokens would have cost (xAI cost_in_usd_ticks).
// reasoning_tokens: xAI reports reasoning apart from completion_tokens (its
// total = prompt + completion + reasoning), so it is kept in its own column.
// group_id / chunk_day: which group and Beijing day a summary call was for.
const ADDED_COLUMNS = [
  ["billing", "TEXT NOT NULL DEFAULT 'api'"],
  ["list_cost_usd", "REAL"],
  ["reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["group_id", "TEXT"],
  ["chunk_day", "TEXT"],
];

const ensureUsageSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  const existing = new Set(db.prepare("PRAGMA table_info(llm_usage)").all().map((column) => column.name));
  for (const [name, definition] of ADDED_COLUMNS) {
    if (!existing.has(name)) {
      db.prepare(`ALTER TABLE llm_usage ADD COLUMN ${name} ${definition}`).run();
    }
  }
  return db;
};

const USD_TICKS = 1e10;

// OpenAI-style usage, including DeepSeek's cache-hit field and the
// prompt_tokens_details.cached_tokens used by OpenAI / Gemini.
const usageFromResponse = (usage) => ({
  promptTokens: Number(usage?.prompt_tokens) || 0,
  cachedTokens: Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens) || 0,
  completionTokens: Number(usage?.completion_tokens) || 0,
  reasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens) || 0,
});

const recordUsage = (db, { at, purpose, model, host, usage, messages = 0, billing = "api", groupId = null, day = null }) => {
  const tokens = usageFromResponse(usage);
  const ticks = Number(usage?.cost_in_usd_ticks);
  db.prepare(`
    INSERT INTO llm_usage (at, purpose, model, host, prompt_tokens, cached_tokens, completion_tokens, messages, billing, list_cost_usd,
      reasoning_tokens, group_id, chunk_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    at, purpose, String(model ?? ""), String(host ?? ""), tokens.promptTokens, tokens.cachedTokens, tokens.completionTokens, messages,
    billing === "subscription" ? "subscription" : "api",
    Number.isFinite(ticks) && ticks >= 0 ? ticks / USD_TICKS : null,
    tokens.reasoningTokens,
    groupId === null ? null : String(groupId),
    day,
  );
};

// A recorder for processes that do not already hold a store handle: opens
// store/messages.db lazily, swallows (but logs) failures.
const createStoreRecorder = (toolRoot) => {
  let db = null;
  return (entry) => {
    try {
      if (db === null) {
        db = ensureUsageSchema(require("./message_store").openStore(path.join(toolRoot, "store", "messages.db")));
      }
      recordUsage(db, entry);
    } catch (error) {
      console.warn(`llm usage not recorded: ${error.message}`);
    }
  };
};

const beijingDay = (unix) => new Date((unix + BEIJING_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
const startOfBeijingDay = (unix) => unix - ((unix + BEIJING_OFFSET_SECONDS) % DAY_SECONDS);

const addCost = (bucket, cost) => {
  if (cost === null) {
    bucket.unpricedCalls += 1;
    return;
  }
  bucket.cost[cost.currency] = (bucket.cost[cost.currency] ?? 0) + cost.amount;
};

const emptyBucket = () => ({
  calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, messages: 0, cost: {}, unpricedCalls: 0,
  subscriptionCalls: 0, subscriptionListUsd: 0,
});

// Subscription-paid calls cost no money: they are counted apart, with the
// list price the provider reported, and never enter `cost` (or the budget).
const accumulate = (bucket, row, cost) => {
  bucket.calls += 1;
  bucket.promptTokens += row.promptTokens;
  bucket.cachedTokens += row.cachedTokens;
  bucket.completionTokens += row.completionTokens;
  bucket.reasoningTokens += row.reasoningTokens ?? 0;
  bucket.messages += row.messages;
  if (row.billing === "subscription") {
    bucket.subscriptionCalls += 1;
    bucket.subscriptionListUsd += Number(row.listCostUsd) || 0;
    return;
  }
  addCost(bucket, cost);
};

const roundCost = (bucket) => ({
  ...bucket,
  cost: Object.fromEntries(Object.entries(bucket.cost).map(([currency, amount]) => [currency, Math.round(amount * 10000) / 10000])),
  subscriptionListUsd: Math.round(bucket.subscriptionListUsd * 10000) / 10000,
});

// Totals for today / 7 / 30 days, a per-day series, and splits by purpose and
// model. `perThousandMessages` is what the background briefing (chunk
// summaries plus merges) costs per 1000 chat messages on this user's own data,
// the most honest basis for a budget.
const summarizeUsage = (db, { nowUnix, days = 30, prices }) => {
  ensureUsageSchema(db);
  const todayStart = startOfBeijingDay(nowUnix);
  const from = todayStart - (days - 1) * DAY_SECONDS;
  const rows = db.prepare(`
    SELECT at, purpose, model, prompt_tokens AS promptTokens, cached_tokens AS cachedTokens,
           completion_tokens AS completionTokens, reasoning_tokens AS reasoningTokens, messages, billing, list_cost_usd AS listCostUsd
    FROM llm_usage WHERE at >= ? ORDER BY at
  `).all(from);

  const today = emptyBucket();
  const week = emptyBucket();
  const month = emptyBucket();
  const briefingCalls = emptyBucket();
  const mapCalls = emptyBucket();
  const byDay = new Map();
  const byPurpose = new Map();
  const byModel = new Map();
  for (let day = 0; day < days; day += 1) {
    byDay.set(beijingDay(from + day * DAY_SECONDS), emptyBucket());
  }
  for (const row of rows) {
    const cost = costOf({ model: row.model, at: row.at, promptTokens: row.promptTokens, cachedTokens: row.cachedTokens, completionTokens: row.completionTokens }, prices);
    accumulate(month, row, cost);
    if (row.at >= todayStart - 6 * DAY_SECONDS) {
      accumulate(week, row, cost);
    }
    if (row.at >= todayStart) {
      accumulate(today, row, cost);
    }
    if (BRIEFING_PURPOSES.has(row.purpose)) {
      accumulate(briefingCalls, row, cost);
    }
    if (row.purpose === "map") {
      accumulate(mapCalls, row, cost);
    }
    const dayKey = beijingDay(row.at);
    accumulate(byDay.get(dayKey) ?? byDay.set(dayKey, emptyBucket()).get(dayKey), row, cost);
    accumulate(byPurpose.get(row.purpose) ?? byPurpose.set(row.purpose, emptyBucket()).get(row.purpose), row, cost);
    accumulate(byModel.get(row.model) ?? byModel.set(row.model, emptyBucket()).get(row.model), row, cost);
  }

  const firstUsage = rows.length > 0 ? rows[0].at : null;
  const observedDays = firstUsage === null ? 0 : Math.min(7, Math.max(1, Math.ceil((nowUnix - Math.max(firstUsage, todayStart - 6 * DAY_SECONDS)) / DAY_SECONDS)));
  const projectedMonth = Object.fromEntries(
    Object.entries(week.cost).map(([currency, amount]) => [currency, Math.round((amount / Math.max(1, observedDays)) * 30 * 100) / 100]),
  );
  // Map calls carry the message counts; merges are part of the same cost.
  // mapCost alone prices summarizing old messages (补齐), which never merges.
  const summarized = briefingCalls.messages;
  const perThousand = (costs) => Object.fromEntries(Object.entries(costs).map(([currency, amount]) => [currency, Math.round((amount / summarized) * 1000 * 10000) / 10000]));
  const perThousandMessages = summarized > 0
    ? {
        promptTokens: Math.round((briefingCalls.promptTokens / summarized) * 1000),
        completionTokens: Math.round((briefingCalls.completionTokens / summarized) * 1000),
        cost: perThousand(briefingCalls.cost),
        mapCost: perThousand(mapCalls.cost),
      }
    : null;

  return {
    today: roundCost(today),
    week: roundCost(week),
    month: roundCost(month),
    observedDays,
    projectedMonth,
    perThousandMessages,
    byDay: [...byDay.entries()].map(([day, bucket]) => ({ day, ...roundCost(bucket) })),
    byPurpose: Object.fromEntries([...byPurpose.entries()].map(([purpose, bucket]) => [purpose, roundCost(bucket)])),
    byModel: Object.fromEntries([...byModel.entries()].map(([model, bucket]) => [model, roundCost(bucket)])),
  };
};

// Summary calls for chunks of Beijing days fromDay..toDay made at or after
// sinceUnix, per day and group (the detailed redo report).
const usageByGroupDay = (db, { sinceUnix, fromDay, toDay, prices }) => {
  ensureUsageSchema(db);
  const rows = db.prepare(`
    SELECT at, purpose, model, prompt_tokens AS promptTokens, cached_tokens AS cachedTokens, completion_tokens AS completionTokens,
           reasoning_tokens AS reasoningTokens, messages, billing, list_cost_usd AS listCostUsd, group_id AS groupId, chunk_day AS day
    FROM llm_usage
    WHERE at >= ? AND chunk_day IS NOT NULL AND chunk_day >= ? AND chunk_day <= ? AND purpose IN ('map', 'redo')
  `).all(sinceUnix, fromDay, toDay);
  const buckets = new Map();
  for (const row of rows) {
    const key = `${row.day}|${row.groupId}`;
    const bucket = buckets.get(key) ?? { day: row.day, groupId: row.groupId, ...emptyBucket() };
    accumulate(bucket, row, costOf(row, prices));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(roundCost);
};

// Today's estimated spend in one currency (for the daily money budget).
const todaySpend = (db, { nowUnix, prices, currency }) => {
  ensureUsageSchema(db);
  const rows = db.prepare(`
    SELECT at, model, prompt_tokens AS promptTokens, cached_tokens AS cachedTokens, completion_tokens AS completionTokens
    FROM llm_usage WHERE at >= ? AND billing != 'subscription'
  `).all(startOfBeijingDay(nowUnix));
  return rows.reduce((total, row) => {
    const cost = costOf(row, prices);
    return cost !== null && cost.currency === currency ? total + cost.amount : total;
  }, 0);
};

module.exports = { ensureUsageSchema, usageFromResponse, recordUsage, createStoreRecorder, summarizeUsage, usageByGroupDay, todaySpend, beijingDay };
