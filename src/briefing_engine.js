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
const { formatMessageLine, normalizeLlmSummary, summarizeLines, mergeBriefPartials, currentModel, currentDetail, shouldFallBack, probeClient } = require("./llm_summarizer");

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
  // A group's brief is re-merged at most this often (a new chunk otherwise
  // triggers a merge every time); "现在就总结" (force) and a missing brief
  // bypass it.
  reduceIntervalSeconds: 7200,
  mapConcurrency: 3,
  maxMapPerRun: 40,
  // Detailed-level job chunks (redo / backfill) per run; see mapPendingChunks.
  maxJobPerRun: 40,
  reduceConcurrency: 1,
  dailyLlmCallLimit: 400,
};

const BRIEFING_SINCE_KEY = "briefing_since";
const BUDGET_KEY = "llm_budget";
const PAUSE_KEY = "ai_paused_until";
// Why the last run stopped asking the AI (the account was refused), for the
// home page; cleared by the next summary that succeeds.
const ROUTE_DOWN_KEY = "llm_route_down";

/* ---------- AI failures a user can act on ---------- */

const NETWORK_ERROR = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/u;

// "LLM request failed. StatusCode=402 Body=..." -> 402 (stored errors are text).
const statusOfError = (text) => Number(/StatusCode=(\d{3})/u.exec(String(text ?? ""))?.[1]) || null;

// kind "other" is about this one answer (declined, malformed, too slow); every
// other kind is about the account or the connection and fixes itself only
// when the user or the provider acts.
const describeAiError = ({ status, message = "" }) => {
  const code = Number(status) || 0;
  if (code === 402) {
    return { kind: "balance", text: "AI 服务余额不足" };
  }
  if (code === 401 || code === 403) {
    return { kind: "key", text: "AI 服务拒绝了密钥（失效或没有权限）" };
  }
  if (code === 429) {
    return { kind: "rate-limit", text: "AI 服务限流或额度用完" };
  }
  if (code >= 500) {
    return { kind: "outage", text: "AI 服务暂时故障" };
  }
  if (code === 0 && NETWORK_ERROR.test(String(message))) {
    return { kind: "network", text: "连不上 AI 服务" };
  }
  return { kind: "other", text: "AI 没有给出可用的结果" };
};

// Nothing is left to try and the account itself was refused: the only
// provider, or the fallback after the primary was found down. Only errors
// that name such a cause count, so an unexpected error (a bug) still fails
// its chunk the usual way instead of stalling every chunk behind it.
const routeIsDown = (client, error) =>
  error?.lastResort === true
  && shouldFallBack(error)
  && describeAiError({ status: error.status, message: error.message }).kind !== "other"
  && (client.fallback === null || client.state.usingFallback);

const routeProblem = (db) => store.getState(db, ROUTE_DOWN_KEY, null);

// Given-up chunks grouped by what went wrong, most common first.
const failedChunkReasons = (db, fromUnix = 0) => {
  const reasons = new Map();
  for (const row of store.givenUpChunks(db, fromUnix)) {
    const status = statusOfError(row.error);
    const current = reasons.get(status) ?? { status, ...describeAiError({ status, message: row.error }), chunks: 0, messages: 0 };
    reasons.set(status, { ...current, chunks: current.chunks + 1, messages: current.messages + row.messageCount });
  }
  return [...reasons.values()].sort((left, right) => right.chunks - left.chunks);
};

// Given-up chunks back into the queue: all of them ("重试" on the home page),
// or only those the account refused (they deserve another go once it works).
const requeueFailedChunks = (db, { onlyAccountErrors = false, asJob = false, fromUnix = 0 } = {}) => {
  const chunkIds = store.givenUpChunks(db, fromUnix)
    .filter((row) => !onlyAccountErrors || describeAiError({ status: statusOfError(row.error), message: row.error }).kind !== "other")
    .map((row) => row.chunkId);
  return store.requeueChunks(db, chunkIds, { asJob });
};

// Pause state: 0/absent = running, -1 = paused until resumed, else unix time.
const pauseStatus = (db, now) => {
  const until = Number(store.getState(db, PAUSE_KEY, 0)) || 0;
  if (until === -1) {
    return { paused: true, until: null };
  }
  return until > now ? { paused: true, until } : { paused: false, until: null };
};

const setPause = (db, { now, minutes }) => {
  const value = minutes === -1 ? -1 : minutes > 0 ? now + Math.round(minutes * 60) : 0;
  store.setState(db, PAUSE_KEY, value);
  return pauseStatus(db, now);
};

// One gate for every LLM call the briefing makes: pause, the hard daily call
// cap, and the optional daily money budget (`spendCheck` from the caller).
const allowSpend = (db, now, options) => {
  if (pauseStatus(db, now).paused) {
    return "paused";
  }
  if (typeof options.spendCheck === "function") {
    const reason = options.spendCheck();
    if (reason) {
      return reason;
    }
  }
  return takeBudget(db, now, options.dailyLlmCallLimit) ? null : "call-limit";
};

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

// Detailed-level job work (redo = 1; see briefing_store) runs only while the
// client answers at the detailed level and never more than maxJobPerRun per
// run, so live chunks stay fresh. A redo never falls back to a paid provider:
// declined chat keeps its old summary, a provider that is down leaves it
// queued. A declined backfill (no summary yet) may use the fallback.
const handleJobFailure = (db, chunk, error, outcome, log) => {
  if (shouldFallBack(error)) {
    outcome.jobDeferred += 1;
    log(`briefing detailed job paused (provider down) group=${chunk.groupId}`);
    return true;
  }
  if (chunk.hasPartial) {
    store.giveUpRedo(db, chunk.chunkId, error.message);
    outcome.jobKeptOld += 1;
    log(`briefing redo kept the old summary group=${chunk.groupId}: ${error.message.slice(0, 120)}`);
    return true;
  }
  return false;
};

const mapPendingChunks = async (db, client, { now, log = () => {}, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const chunks = store.chunksToSummarize(db, options.maxMapPerRun);
  const outcome = { done: 0, failed: 0, skippedForBudget: 0, blockedBy: null, jobDone: 0, jobDeferred: 0, jobKeptOld: 0, routeDown: null };
  let jobTaken = 0;
  // Asked once per run, the first time a chunk's error looks like an account
  // refusal: does a tiny call fail the same way? Resolves to the probe's
  // error when the account really is refused, null when it answers.
  let routeCheck = null;
  const confirmRouteDown = () => {
    routeCheck ??= probeClient(client).then(() => null, (probeError) => (routeIsDown(client, probeError) ? probeError : null));
    return routeCheck;
  };
  await runLimited(chunks, options.mapConcurrency, async (chunk) => {
    // The account was refused: every other call would be refused too.
    if (outcome.routeDown !== null) {
      return;
    }
    const isJob = chunk.redo === 1;
    if (isJob && (currentDetail(client) !== "detailed" || jobTaken >= options.maxJobPerRun)) {
      outcome.jobDeferred += 1;
      return;
    }
    jobTaken += isJob ? 1 : 0;
    const blocked = allowSpend(db, now, options);
    if (blocked !== null) {
      outcome.skippedForBudget += 1;
      outcome.blockedBy = blocked;
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
    let answered = null;
    const callMeta = {
      groupId: chunk.groupId,
      day: formatHkt(chunk.endSentAt).slice(0, 10),
      onAnswered: (endpoint) => { answered = endpoint; },
      ...(isJob && chunk.hasPartial ? { allowFallback: false } : {}),
    };
    try {
      // Validate at map time: a malformed partial is a failed (retried)
      // chunk, never a landmine for the later reduce.
      const raw = await summarizeLines(client, context, messages.map(toLine), undefined, isJob ? "redo" : "map", callMeta);
      const partial = normalizeLlmSummary(raw, { model: answered.model });
      store.saveChunkResult(db, chunk.chunkId, { partial, detail: answered.detail });
      outcome.done += 1;
      outcome.jobDone += isJob ? 1 : 0;
      log(`briefing map ok group=${chunk.groupId} messages=${messages.length}${isJob ? " (detailed job)" : ""}`);
    } catch (error) {
      if (routeIsDown(client, error) && (await confirmRouteDown()) !== null) {
        // Not this chunk's fault: it keeps its attempts for when the account works.
        store.noteChunkError(db, chunk.chunkId, error.message);
        if (outcome.routeDown === null) {
          const status = Number(error.status) || null;
          outcome.routeDown = { status, ...describeAiError({ status, message: error.message }), model: currentModel(client) };
          log(`briefing map stopped, the AI account was refused (${outcome.routeDown.model}): ${error.message.slice(0, 200)}`);
        }
        return;
      }
      if (isJob && handleJobFailure(db, chunk, error, outcome, log)) {
        return;
      }
      store.saveChunkResult(db, chunk.chunkId, { error: error.message });
      outcome.failed += 1;
      log(`briefing map failed group=${chunk.groupId}: ${error.message.slice(0, 200)}`);
    }
  });
  if (outcome.routeDown !== null) {
    store.setState(db, ROUTE_DOWN_KEY, { ...outcome.routeDown, at: now });
  } else if (outcome.done > 0 && routeProblem(db) !== null) {
    store.setState(db, ROUTE_DOWN_KEY, null);
  }
  return outcome;
};

const UPGRADE_MERGE_INTERVAL_SECONDS = 3600;

// Chunk keys list chunk ids, a detailed one with a "d" suffix (see below).
const sameChunkSet = (left, right) => left.replace(/d/gu, "") === right.replace(/d/gu, "");

const reduceBriefs = async (db, client, groupIds, { now, force = false, log = () => {}, ...overrides } = {}) => {
  const options = { ...DEFAULTS, ...overrides };
  const windowStart = briefingSince(db, now);
  const outcome = { updated: 0, unchanged: 0, cleared: 0, deferred: 0, skippedForBudget: 0, blockedBy: null };
  // Groups merge independently; the detailed level runs a few at once
  // (its full merges take a minute or two each).
  const reduceGroup = async (groupId) => {
    const all = store.doneChunksInWindow(db, groupId, windowStart);
    if (all.length === 0) {
      if (store.getGroupBrief(db, groupId) !== null) {
        store.deleteGroupBrief(db, groupId);
        outcome.cleared += 1;
      }
      return;
    }
    const chunks = all.slice(-options.maxReduceChunks);
    // A chunk redone at the detailed level changes the key, so its group is
    // re-merged; standard chunks keep the key format older versions wrote.
    const chunkKey = chunks.map((chunk) => (chunk.detail === "detailed" ? `${chunk.chunkId}d` : String(chunk.chunkId))).join(",");
    const existing = store.getGroupBrief(db, groupId);
    if (existing !== null && existing.windowStart === windowStart && existing.chunkKey === chunkKey) {
      outcome.unchanged += 1;
      return;
    }
    const recentlyMerged = existing !== null && existing.windowStart === windowStart
      && now - existing.updatedAt < options.reduceIntervalSeconds;
    // The same chunks, only some now at the detailed level: the detailed job
    // upgrading old summaries. Re-merging after every upgrade kept each
    // refresh busy for many minutes; such changes merge at most hourly
    // (a new chunk still merges at once).
    const upgradeOnly = existing !== null && existing.windowStart === windowStart
      && sameChunkSet(existing.chunkKey, chunkKey)
      && now - existing.updatedAt < UPGRADE_MERGE_INTERVAL_SECONDS;
    if ((recentlyMerged || upgradeOnly) && !force) {
      outcome.deferred += 1;
      return;
    }
    if (chunks.length > 1) {
      const blocked = allowSpend(db, now, options);
      if (blocked !== null) {
        outcome.skippedForBudget += 1;
        outcome.blockedBy = blocked;
        return;
      }
    }
    const partials = chunks.map((chunk) => JSON.parse(chunk.partialJson));
    const messages = chunks.reduce((total, chunk) => total + chunk.messageCount, 0);
    const context = {
      firstMessageHkt: formatHkt(chunks[0].startSentAt),
      lastMessageHkt: formatHkt(chunks.at(-1).endSentAt),
      parsedTextMessages: messages,
    };
    let reduced;
    const callMeta = { groupId, day: formatHkt(chunks.at(-1).endSentAt).slice(0, 10) };
    try {
      reduced = await mergeBriefPartials(client, context, partials, { model: currentModel(client) }, "reduce", callMeta);
    } catch (error) {
      // One group's bad data must not stop the other groups' briefs.
      log(`briefing reduce failed group=${groupId}: ${error.message.slice(0, 200)}`);
      return;
    }
    const { summary, mode } = reduced;
    store.saveGroupBrief(db, groupId, {
      windowStart,
      chunkKey,
      updatedAt: now,
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
  };
  await runLimited(groupIds, options.reduceConcurrency, reduceGroup);
  return outcome;
};

module.exports = {
  DEFAULTS,
  allowSpend,
  pauseStatus,
  setPause,
  planChunks,
  briefingSince,
  markBriefingSeen,
  closeChunks,
  mapPendingChunks,
  reduceBriefs,
  budgetStatus,
  describeAiError,
  statusOfError,
  routeProblem,
  failedChunkReasons,
  requeueFailedChunks,
};
