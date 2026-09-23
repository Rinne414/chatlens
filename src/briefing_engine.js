"use strict";

// The always-ready briefing. Runs inside the background refresh after new
// messages were ingested:
//   1. close chunks  — a group's unsummarized messages become an immutable
//                      chunk once there are ~400 of them (one LLM input's
//                      worth) or the oldest has waited an hour;
//   2. map           — each closed chunk is summarized exactly once (cached);
//   3. reduce        — per group, the chunks inside the briefing window are
//                      merged into one brief (re-done only when that set of
//                      chunks changes).
// So opening the app shows a finished briefing, and each message costs one
// LLM pass no matter how often the refresh runs.

const store = require("./briefing_store");
const { formatHkt } = require("./unviewed_range");
const { formatMessageLine, normalizeLlmSummary, summarizeLines, reducePartials } = require("./llm_summarizer");

const HOUR = 3600;
const DEFAULTS = {
  maxMessages: 400,
  maxChars: 50000,
  tailMinMessages: 5,
  tailMaxAgeSeconds: HOUR,
  tailForceAgeSeconds: 6 * HOUR,
  // Messages this fresh stay pending: late-arriving rows (QQ syncs out of
  // order) can still land in the same chunk.
  settleSeconds: 300,
  firstWindowSeconds: 24 * HOUR,
  maxLookbackSeconds: 7 * 24 * HOUR,
  maxReduceChunks: 24,
  mapConcurrency: 3,
  maxMapPerRun: 40,
  dailyLlmCallLimit: 400,
};

const BRIEFING_SINCE_KEY = "briefing_since";
const BUDGET_KEY = "llm_budget";

const toLine = (message) => formatMessageLine({ ...message, hkt: formatHkt(message.sentAt) });

// Pure: decides which consecutive slices of `pending` (oldest first) to close.
// Returns [{ from, to }] index ranges (to exclusive).
const planChunks = (pending, { now, force = false, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const settled = force ? pending : pending.filter((message) => message.sentAt <= now - options.settleSeconds);
  const plans = [];
  let from = 0;
  let chars = 0;
  for (let index = 0; index < settled.length; index += 1) {
    const length = toLine(settled[index]).length + 1;
    const count = index - from;
    if (count > 0 && (count >= options.maxMessages || chars + length > options.maxChars)) {
      plans.push({ from, to: index });
      from = index;
      chars = 0;
    }
    chars += length;
  }
  const tail = settled.length - from;
  if (tail > 0) {
    const age = now - settled[from].sentAt;
    const ripe = force
      || tail >= options.maxMessages
      || (age >= options.tailMaxAgeSeconds && tail >= options.tailMinMessages)
      || age >= options.tailForceAgeSeconds;
    if (ripe) {
      plans.push({ from, to: settled.length });
    }
  }
  return plans;
};

const briefingSince = (db, now) => {
  const saved = Number(store.getState(db, BRIEFING_SINCE_KEY, null));
  if (Number.isFinite(saved) && saved > 0) {
    return saved;
  }
  const initial = now - DEFAULTS.firstWindowSeconds;
  store.setState(db, BRIEFING_SINCE_KEY, initial);
  return initial;
};

const markBriefingSeen = (db, seenUnix) => {
  store.setState(db, BRIEFING_SINCE_KEY, seenUnix);
};

const closeChunks = (db, groupIds, { now, force = false, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const since = briefingSince(db, now);
  const fromUnix = Math.max(since, now - options.maxLookbackSeconds);
  let created = 0;
  for (const groupId of groupIds) {
    const pending = store.pendingMessages(db, groupId, { after: store.lastChunkBoundary(db, groupId), fromUnix });
    const plans = planChunks(pending, { now, force, ...overrides });
    db.transaction(() => {
      for (const plan of plans) {
        const slice = pending.slice(plan.from, plan.to);
        store.insertChunk(db, {
          groupId: String(groupId),
          startSentAt: slice[0].sentAt,
          endSentAt: slice.at(-1).sentAt,
          firstRowId: slice[0].rowId,
          lastRowId: slice.at(-1).rowId,
          messageCount: slice.length,
          createdAt: now,
        });
        created += 1;
      }
    })();
  }
  return created;
};

/* ---------- LLM budget: a hard daily ceiling so a bug can't burn money ---------- */

const beijingDay = (now) => formatHkt(now).slice(0, 10);

// IMMEDIATE transaction: the read-check-write is atomic even if a second
// process (a manual run, or a stray second console) shares the store.
const takeBudget = (db, now, limit) =>
  db.transaction(() => {
    const day = beijingDay(now);
    const budget = store.getState(db, BUDGET_KEY, null);
    const used = budget?.day === day ? Number(budget.used) || 0 : 0;
    if (used >= limit) {
      return false;
    }
    store.setState(db, BUDGET_KEY, { day, used: used + 1 });
    return true;
  }).immediate();

const budgetStatus = (db, now, limit = DEFAULTS.dailyLlmCallLimit) => {
  const budget = store.getState(db, BUDGET_KEY, null);
  const used = budget?.day === beijingDay(now) ? Number(budget.used) || 0 : 0;
  return { used, limit, exhausted: used >= limit };
};

const runLimited = async (items, concurrency, worker) => {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
};

const mapPendingChunks = async (db, client, { now, log = () => {}, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const chunks = store.chunksToSummarize(db, options.maxMapPerRun);
  const outcome = { done: 0, failed: 0, skippedForBudget: 0 };
  await runLimited(chunks, options.mapConcurrency, async (chunk) => {
    if (!takeBudget(db, now, options.dailyLlmCallLimit)) {
      outcome.skippedForBudget += 1;
      return;
    }
    const messages = store.chunkMessages(db, chunk);
    if (messages.length === 0) {
      store.saveChunkResult(db, chunk.chunkId, { error: "chunk has no messages" });
      outcome.failed += 1;
      return;
    }
    const context = {
      firstMessageHkt: formatHkt(messages[0].sentAt),
      lastMessageHkt: formatHkt(messages.at(-1).sentAt),
      parsedTextMessages: messages.length,
    };
    try {
      // Validate at map time: a malformed partial is a failed (retried)
      // chunk, never a landmine for the later reduce.
      const partial = normalizeLlmSummary(await summarizeLines(client, context, messages.map(toLine)), { model: client.model });
      store.saveChunkResult(db, chunk.chunkId, { partial });
      outcome.done += 1;
      log(`briefing map ok group=${chunk.groupId} messages=${messages.length}`);
    } catch (error) {
      store.saveChunkResult(db, chunk.chunkId, { error: error.message });
      outcome.failed += 1;
      log(`briefing map failed group=${chunk.groupId}: ${error.message.slice(0, 200)}`);
    }
  });
  return outcome;
};

const reduceBriefs = async (db, client, groupIds, { now, log = () => {}, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const windowStart = briefingSince(db, now);
  const outcome = { updated: 0, unchanged: 0, cleared: 0, skippedForBudget: 0 };
  for (const groupId of groupIds) {
    const all = store.doneChunksInWindow(db, groupId, windowStart);
    if (all.length === 0) {
      if (store.getGroupBrief(db, groupId) !== null) {
        store.deleteGroupBrief(db, groupId);
        outcome.cleared += 1;
      }
      continue;
    }
    const chunks = all.slice(-options.maxReduceChunks);
    const chunkKey = chunks.map((chunk) => chunk.chunkId).join(",");
    const existing = store.getGroupBrief(db, groupId);
    if (existing !== null && existing.windowStart === windowStart && existing.chunkKey === chunkKey) {
      outcome.unchanged += 1;
      continue;
    }
    if (chunks.length > 1 && !takeBudget(db, now, options.dailyLlmCallLimit)) {
      outcome.skippedForBudget += 1;
      continue;
    }
    const partials = chunks.map((chunk) => JSON.parse(chunk.partialJson));
    const messages = chunks.reduce((total, chunk) => total + chunk.messageCount, 0);
    const context = {
      firstMessageHkt: formatHkt(chunks[0].startSentAt),
      lastMessageHkt: formatHkt(chunks.at(-1).endSentAt),
      parsedTextMessages: messages,
    };
    let reduced;
    try {
      reduced = await reducePartials(client, context, partials, { model: client.model });
    } catch (error) {
      // One group's bad data must not stop the other groups' briefs.
      log(`briefing reduce failed group=${groupId}: ${error.message.slice(0, 200)}`);
      continue;
    }
    const { summary, mode } = reduced;
    store.saveGroupBrief(db, groupId, {
      windowStart,
      chunkKey,
      summary: {
        ...summary,
        coverage: {
          chunks: chunks.length,
          droppedChunks: all.length - chunks.length,
          summarizedMessages: messages,
          firstSentAt: chunks[0].startSentAt,
          lastSentAt: chunks.at(-1).endSentAt,
          mode,
        },
      },
    });
    outcome.updated += 1;
    log(`briefing reduce group=${groupId} chunks=${chunks.length} mode=${mode}`);
  }
  return outcome;
};

module.exports = {
  DEFAULTS,
  planChunks,
  briefingSince,
  markBriefingSeen,
  closeChunks,
  mapPendingChunks,
  reduceBriefs,
  budgetStatus,
};
