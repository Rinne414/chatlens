"use strict";

// Server glue for 回顾: the calendar, one day's review, 补齐 (backfill a day's
// AI summaries through the background briefing) and topic search.

const state = require("./toolkit_state");
const background = require("./background");
const secrets = require("../secrets");
const engine = require("../briefing_engine");
const review = require("../review_store");
const { summarizeUsage } = require("../llm_usage");
const { priceTable } = require("../llm_pricing");

const MAX_CALENDAR_DAYS = 400;
const MAX_QUERY_LENGTH = 80;
const DAY_SECONDS = 86400;

const nowUnix = () => Math.floor(Date.now() / 1000);

const llmConfigured = (config) =>
  String(config.llm?.baseUrl ?? "").trim().length > 0
  && String(config.llm?.model ?? "").trim().length > 0
  && secrets.hasSecret("llmKey");

const getCalendar = ({ from, to }) => {
  const db = state.getStore();
  const { start: fromStart } = review.dayBounds(from);
  const { start: toStart } = review.dayBounds(to);
  if (toStart < fromStart || (toStart - fromStart) / DAY_SECONDS > MAX_CALENDAR_DAYS) {
    throw new Error(`日期范围应在 ${MAX_CALENDAR_DAYS} 天以内。`);
  }
  return review.calendar(db, { fromDay: from, toDay: to });
};

const getDay = ({ day }) => {
  const config = state.loadConfig();
  const db = state.getStore();
  const now = nowUnix();
  const usage = summarizeUsage(db, { nowUnix: now, days: 30, prices: priceTable(config) });
  return {
    ...review.dayReview(db, { day, now }),
    status: {
      backfillChunks: review.planBackfill(db, { day, now }).length,
      llmConfigured: llmConfigured(config),
      pause: engine.pauseStatus(db, now),
      backgroundRunning: background.getStatus().running,
      // What summarizing 1000 of this user's messages has cost (no merge):
      // the basis of the 补齐 estimate.
      perThousandCost: usage.perThousandMessages?.mapCost ?? null,
    },
  };
};

// Queues the day's unsummarized messages as briefing chunks, then nudges the
// background refresh so the map step picks them up now rather than in 15 min.
const backfill = ({ day }) => {
  const config = state.loadConfig();
  if (!llmConfigured(config)) {
    throw new Error("还没有配置 AI 服务，无法补齐总结。");
  }
  const db = state.getStore();
  const result = review.backfillDay(db, { day, now: nowUnix() });
  const tick = result.chunks > 0 ? background.runNow({ force: false }) : { started: false, reason: "nothing-to-do" };
  return { ...result, started: tick.started, reason: tick.reason ?? null };
};

const search = ({ q, messageOffset = 0 }) => {
  const query = String(q ?? "").slice(0, MAX_QUERY_LENGTH);
  return review.search(state.getStore(), { query, messageOffset });
};

module.exports = { getCalendar, getDay, backfill, search };
