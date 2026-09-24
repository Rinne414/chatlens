"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pricing = require("../src/llm_pricing");
const usage = require("../src/llm_usage");
const { parseJsonContent, providerExtras } = require("../src/llm_summarizer");

const DAY = 86400;
// Beijing wall clock -> unix seconds (Beijing is UTC+8, no DST).
const beijing = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;

const openTemp = () => usage.ensureUsageSchema(
  messageStore.openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-")), "messages.db")),
);

test("DeepSeek peak hours are Beijing weekdays 9-12 and 14-18", () => {
  // 2026-09-24 is a Thursday, 2026-09-26 a Saturday.
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 24, 8, 59)), false);
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 24, 9, 0)), true);
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 24, 12, 30)), false);
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 24, 17, 59)), true);
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 24, 18, 0)), false);
  assert.equal(pricing.isDeepseekPeak(beijing(2026, 9, 26, 10, 0)), false);
});

test("costOf prices cached input separately and halves DeepSeek off-peak", () => {
  const prices = pricing.priceTable({});
  const call = { model: "deepseek-v4-flash", promptTokens: 1_000_000, cachedTokens: 200_000, completionTokens: 100_000 };
  // 800k * ¥2 + 200k * ¥0.04 + 100k * ¥8 per million.
  const peak = pricing.costOf({ ...call, at: beijing(2026, 9, 24, 10) }, prices);
  assert.equal(peak.currency, "CNY");
  assert.ok(Math.abs(peak.amount - 2.408) < 1e-9);
  const offPeak = pricing.costOf({ ...call, at: beijing(2026, 9, 24, 20) }, prices);
  assert.ok(Math.abs(offPeak.amount - 1.204) < 1e-9);

  // The specific pro row wins over the generic "deepseek" prefix.
  assert.equal(pricing.costOf({ model: "deepseek-v4-pro", at: beijing(2026, 9, 24, 10), promptTokens: 1_000_000 }, prices).amount, 9);

  // Gemini has no off-peak discount.
  const gemini = pricing.costOf({ model: "gemini-3.1-flash-lite", at: beijing(2026, 9, 26, 3), promptTokens: 1_000_000, completionTokens: 1_000_000 }, prices);
  assert.deepEqual(gemini, { currency: "USD", amount: 1.75 });

  // More cached than prompt tokens (bad provider data) is clamped, not negative.
  const clamped = pricing.costOf({ model: "gemini-3.1-flash-lite", at: 0, promptTokens: 100, cachedTokens: 500 }, prices);
  assert.ok(clamped.amount > 0);

  assert.equal(pricing.costOf({ model: "mystery-model", at: 0, promptTokens: 1000 }, prices), null);
});

test("custom price rows come first and invalid ones are ignored", () => {
  const prices = pricing.priceTable({
    llm: {
      prices: [
        { match: "deepseek", currency: "USD", input: "1", cachedInput: "0", output: "1" },
        { match: "", currency: "CNY", input: 1, cachedInput: 1, output: 1 },
        { match: "broken", currency: "EUR", input: 1, cachedInput: 1, output: 1 },
        { match: "negative", currency: "CNY", input: -1, cachedInput: 0, output: 0 },
      ],
    },
  });
  assert.equal(prices.length, pricing.DEFAULT_PRICES.length + 1);
  const row = pricing.priceFor("DeepSeek-V4-Flash", prices);
  assert.equal(row.currency, "USD");
  assert.equal(row.input, 1);
  assert.equal(row.custom, true);
  assert.equal(pricing.priceFor("negative-model", prices), null);
});

test("usageFromResponse reads DeepSeek and OpenAI-style cache fields", () => {
  assert.deepEqual(usage.usageFromResponse({ prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 7 }),
    { promptTokens: 100, cachedTokens: 40, completionTokens: 7 });
  assert.deepEqual(usage.usageFromResponse({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 5 }),
    { promptTokens: 100, cachedTokens: 30, completionTokens: 5 });
  assert.deepEqual(usage.usageFromResponse(undefined), { promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
});

test("summarizeUsage totals by period, projects a month and prices 1000 messages", () => {
  const db = openTemp();
  const now = beijing(2026, 9, 24, 20);
  const prices = pricing.priceTable({});
  const record = (at, purpose, model, promptTokens, messages = 0) =>
    usage.recordUsage(db, { at, purpose, model, host: "api.example", usage: { prompt_tokens: promptTokens, completion_tokens: 0 }, messages });

  record(now - 3600, "map", "deepseek-v4-flash", 1_000_000, 400); // off-peak: ¥1.00
  record(now - 7200, "quick", "mystery-model", 5000); // unpriced
  record(now - 3 * DAY, "reduce", "deepseek-v4-flash", 500_000); // Monday 20:00, off-peak: ¥0.50
  record(now - 40 * DAY, "map", "deepseek-v4-flash", 9_000_000, 100); // outside 30 days

  const summary = usage.summarizeUsage(db, { nowUnix: now, days: 30, prices });
  assert.equal(summary.today.calls, 2);
  assert.deepEqual(summary.today.cost, { CNY: 1 });
  assert.equal(summary.today.unpricedCalls, 1);
  assert.equal(summary.week.calls, 3);
  assert.deepEqual(summary.week.cost, { CNY: 1.5 });
  assert.equal(summary.month.calls, 3);
  assert.equal(summary.observedDays, 3);
  assert.deepEqual(summary.projectedMonth, { CNY: 15 });
  // Chunk summary + merge (¥1.50, 1.5M tokens) over the 400 summarized messages.
  assert.deepEqual(summary.perThousandMessages, { promptTokens: 3_750_000, completionTokens: 0, cost: { CNY: 3.75 }, mapCost: { CNY: 2.5 } });

  assert.equal(summary.byDay.length, 30);
  assert.equal(summary.byDay.at(-1).day, "2026-09-24");
  assert.equal(summary.byDay.find((day) => day.day === "2026-09-21").calls, 1);
  assert.deepEqual(Object.keys(summary.byPurpose).sort(), ["map", "quick", "reduce"]);
  assert.equal(summary.byModel["mystery-model"].unpricedCalls, 1);

  assert.equal(usage.todaySpend(db, { nowUnix: now, prices, currency: "CNY" }), 1);
  assert.equal(usage.todaySpend(db, { nowUnix: now, prices, currency: "USD" }), 0);
  db.close();
});

test("an empty usage table summarizes to zeros without a projection", () => {
  const db = openTemp();
  const summary = usage.summarizeUsage(db, { nowUnix: beijing(2026, 9, 24, 20), prices: pricing.priceTable({}) });
  assert.equal(summary.month.calls, 0);
  assert.equal(summary.observedDays, 0);
  assert.deepEqual(summary.projectedMonth, {});
  assert.equal(summary.perThousandMessages, null);
  db.close();
});

test("parseJsonContent accepts fenced or wrapped JSON and rejects garbage", () => {
  assert.deepEqual(parseJsonContent('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonContent('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonContent('好的，结果如下：{"a":3} 希望有帮助'), { a: 3 });
  assert.throws(() => parseJsonContent("抱歉，我无法完成"), SyntaxError);
});

test("providerExtras turns off thinking only for known hosts", () => {
  assert.deepEqual(providerExtras(new URL("https://api.deepseek.com/chat/completions")), { thinking: { type: "disabled" } });
  assert.deepEqual(providerExtras(new URL("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")), { reasoning_effort: "minimal" });
  assert.deepEqual(providerExtras(new URL("https://notdeepseek.com/v1/chat/completions")), {});
  assert.deepEqual(providerExtras(new URL("http://127.0.0.1:11434/v1/chat/completions")), {});
});
