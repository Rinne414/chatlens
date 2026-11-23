"use strict";

// 答应过的事: things I said I would do for someone, things someone asked me to
// do, and things someone said they would do for me, found in the group chat so
// none is forgotten. Candidates are cheap to pick (my own messages, and other
// people's messages that @ me or reply to me); the AI only decides which of
// them carry a commitment and says it in one line. Each stays until the user
// ticks it off or says it is not one.
//
// Which messages were already looked at is kept per message
// (commitment_looked), not as a point in time: QQ writes some messages hours
// late, and those still get their turn.

const messageStore = require("./message_store");

const KINDS = new Set(["promise", "asked", "owed"]);
const STATUSES = new Set(["open", "done", "dropped"]);
// Only messages old enough that what I said right after them is stored too:
// "asked" needs to see that I did not answer on the spot.
const SETTLE_SECONDS = 20 * 60;
// How far back a message can still get its turn (late-written ones included).
const LOOKBACK_SECONDS = 7 * 86400;
const LOOKED_KEPT_SECONDS = LOOKBACK_SECONDS + 3 * 86400;
const CANDIDATES_PER_CALL = 24;
const MAX_CALLS_PER_RUN = 6;
// A call is worth making for a handful of messages, or once the oldest has
// waited this long: not one call per refresh for every line I type.
const MIN_BATCH = 8;
const MAX_WAIT_SECONDS = 2 * 3600;
// A batch the AI could not answer (timeout, cut-off answer) is asked again on
// later refreshes, this many times in all.
const MAX_TRIES = 3;
const CONTEXT_BEFORE = 3;
const CONTEXT_BEFORE_SECONDS = 15 * 60;
const CONTEXT_AFTER = 2;
const CONTEXT_AFTER_SECONDS = 15 * 60;
const REPLY_LOOKBACK_SECONDS = 14 * 86400;
const MIN_OWN_CHARS = 4;
const MAX_TEXT_CHARS = 240;
const MAX_WHAT_CHARS = 60;
const MAX_NAME_CHARS = 40;
const MAX_TOKENS = 2500;
const DONE_KEPT_SECONDS = 90 * 86400;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS commitments (
    group_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    what TEXT NOT NULL,
    who TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT '',
    sent_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    status_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, row_id)
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status, sent_at)",
  // done = 1: answered, or given up after MAX_TRIES. done = 0: still to ask again.
  `CREATE TABLE IF NOT EXISTS commitment_looked (
    group_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, row_id)
  ) WITHOUT ROWID`,
];

const ensureCommitmentSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const clip = (text, limit = MAX_TEXT_CHARS) => {
  const chars = [...String(text ?? "").replace(/\s+/gu, " ").trim()];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.join("");
};

const nameOf = (speaker) => clip(speaker, MAX_NAME_CHARS) || "有人";

/* ---------- candidates ---------- */

// A short "好" only means something as a reply; on its own it is skipped.
const worthAsking = (row) => row.replyToSeq !== "" || [...row.text.trim()].length >= MIN_OWN_CHARS;

const ownMessages = (db, { fromUnix, toUnix }) => db.prepare(`
  SELECT m.group_id AS groupId, COALESCE(n.name, '') AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
         m.speaker, m.text, m.reply_to_seq AS replyToSeq
  FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
  WHERE m.is_self = 1 AND m.is_media = 0 AND m.sent_at >= @fromUnix AND m.sent_at < @toUnix AND m.text <> ''
`).all({ fromUnix, toUnix }).filter(worthAsking).map((row) => ({ ...row, mine: true }));

// Other people's messages that @ me or reply to me (not @all, not a bare name).
const toMeMessages = (db, { fromUnix, toUnix, identity }) =>
  messageStore.getMentions(db, { fromUnix, toUnix, identity })
    .filter((item) => (item.kind === "at" || item.kind === "reply") && item.text.trim() !== "")
    .map((item) => ({
      groupId: item.groupId,
      groupName: item.groupName,
      rowId: item.rowId,
      sentAt: item.sentAt,
      speaker: item.speaker,
      text: item.text,
      replyToSeq: "",
      quotedMine: item.quotedMine,
      mine: false,
    }));

const withContext = (db, candidate) => {
  const before = db.prepare(`
    SELECT speaker, text, is_self AS isSelf FROM messages
    WHERE group_id = @groupId AND is_media = 0 AND text <> ''
      AND sent_at >= @from AND (sent_at < @at OR (sent_at = @at AND row_id < @rowId))
    ORDER BY sent_at DESC, row_id DESC LIMIT ${CONTEXT_BEFORE}
  `).all({ groupId: candidate.groupId, from: candidate.sentAt - CONTEXT_BEFORE_SECONDS, at: candidate.sentAt, rowId: candidate.rowId }).reverse();
  const repliedTo = candidate.replyToSeq === ""
    ? null
    : db.prepare(`
      SELECT row_id AS rowId, speaker, text FROM messages
      WHERE group_id = @groupId AND sent_at >= @from AND sent_at <= @at AND msg_seq = @seq AND is_media = 0 LIMIT 1
    `).get({ groupId: candidate.groupId, from: candidate.sentAt - REPLY_LOOKBACK_SECONDS, at: candidate.sentAt, seq: candidate.replyToSeq }) ?? null;
  // What I said right after someone spoke to me: an answer given on the spot.
  const myNext = candidate.mine
    ? []
    : db.prepare(`
      SELECT text FROM messages
      WHERE group_id = @groupId AND is_self = 1 AND is_media = 0 AND text <> ''
        AND sent_at > @at AND sent_at <= @until
      ORDER BY sent_at, row_id LIMIT ${CONTEXT_AFTER}
    `).all({ groupId: candidate.groupId, at: candidate.sentAt, until: candidate.sentAt + CONTEXT_AFTER_SECONDS }).map((row) => row.text);
  return { ...candidate, before, repliedTo, myNext };
};

const keyOf = (row) => `${row.groupId}|${row.rowId}`;

// Every candidate in the lookback window that still needs asking, oldest
// first, without its context (cheap: used to decide whether to call at all).
const pendingRows = (db, { identity, nowUnix }) => {
  ensureCommitmentSchema(db);
  const fromUnix = nowUnix - LOOKBACK_SECONDS;
  const toUnix = nowUnix - SETTLE_SECONDS;
  const settled = new Set(db.prepare("SELECT group_id || '|' || row_id AS key FROM commitment_looked WHERE done = 1 AND sent_at >= ?").all(fromUnix).map((row) => row.key));
  return [...ownMessages(db, { fromUnix, toUnix }), ...toMeMessages(db, { fromUnix, toUnix, identity })]
    .filter((row) => !settled.has(keyOf(row)))
    .sort((left, right) => left.sentAt - right.sentAt || String(left.rowId).localeCompare(String(right.rowId)));
};

const pendingCandidates = (db, { identity, nowUnix, limit }) =>
  pendingRows(db, { identity, nowUnix }).slice(0, limit).map((row) => withContext(db, row));

/* ---------- the question ---------- */

const SYSTEM_PROMPT = [
  "你在帮「我」从群聊里找出答应过、还没做的事，免得忘记。下面每一段是一条候选消息和它前后的几句话。",
  "只挑出确实算数的，分三种：",
  "promise：我明确说了之后要为别人做一件具体的事（例如「晚点发你」「明天帮你看」「回头我整理一下」）。",
  "asked：别人明确请我做一件具体的事，而我在后面没有当场做完，也没有拒绝。",
  "owed：别人明确答应之后要为我做一件具体的事。",
  "不算的：闲聊、玩笑、吐槽、对机器人的指令、已经当场做完或回答完的、被拒绝的、没有具体内容的客套（「有空再说」「下次一定」）、只是表达想法或打算而没有答应谁。",
  "拿不准就不要列。宁可漏掉，也不要把普通聊天当成承诺。",
  "只输出 JSON：{\"items\":[{\"i\":候选编号,\"type\":\"promise|asked|owed\",\"what\":\"用一句话写清楚要做什么，不超过 30 个字，写成「帮某某看工作流」这样的事，不要抄原话\",\"who\":\"对方的名字\"}]}。没有就输出 {\"items\":[]}。",
].join("\n");

const candidateBlock = (candidate, index) => [
  `【${index + 1}】群：${clip(candidate.groupName || candidate.groupId, MAX_NAME_CHARS)}`,
  ...candidate.before.map((line) => `  之前 ${line.isSelf === 1 ? "我" : nameOf(line.speaker)}：${clip(line.text)}`),
  candidate.repliedTo ? `  被回复的那条 ${nameOf(candidate.repliedTo.speaker)}：${clip(candidate.repliedTo.text)}` : null,
  candidate.quotedMine ? `  被回复的那条 我：${clip(candidate.quotedMine)}` : null,
  candidate.mine ? `  这一条 我：${clip(candidate.text)}` : `  这一条 ${nameOf(candidate.speaker)}（对我说）：${clip(candidate.text)}`,
  ...candidate.myNext.map((text) => `  之后 我：${clip(text)}`),
].filter((line) => line !== null).join("\n");

const buildPrompt = (candidates) => candidates.map(candidateBlock).join("\n\n");

const validateAnswer = (raw) => {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) {
    throw new Error("Invalid LLM JSON. Required array is missing: items");
  }
};

// The answer's items that point at a real candidate, one per candidate. A
// kind that cannot be true of that message is dropped (only I can promise in
// my own message; only someone else can ask me or owe me).
const readAnswer = (raw, candidates) => {
  const found = new Map();
  for (const item of raw.items) {
    const index = Number(item?.i) - 1;
    const candidate = candidates[index];
    const kind = String(item?.type ?? "");
    const what = clip(item?.what, MAX_WHAT_CHARS);
    if (candidate === undefined || !KINDS.has(kind) || what === "" || found.has(index)) {
      continue;
    }
    if ((kind === "promise") !== candidate.mine) {
      continue;
    }
    found.set(index, {
      groupId: candidate.groupId,
      rowId: candidate.rowId,
      kind,
      what,
      // In a message someone else wrote, that person is the other side.
      who: candidate.mine ? clip(item?.who, MAX_NAME_CHARS) : clip(candidate.speaker, MAX_NAME_CHARS) || clip(item?.who, MAX_NAME_CHARS),
      quote: clip(candidate.text),
      sentAt: candidate.sentAt,
      // My promise given as a reply settles the request it answers.
      answers: kind === "promise" ? candidate.repliedTo?.rowId ?? null : null,
    });
  }
  return [...found.values()];
};

/* ---------- storing ---------- */

const saveFound = (db, items, { model, nowUnix }) => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO commitments (group_id, row_id, kind, what, who, quote, sent_at, status, status_at, created_at, model)
    VALUES (@groupId, @rowId, @kind, @what, @who, @quote, @sentAt, 'open', 0, @nowUnix, @model)
  `);
  // "帮我看下" and my "好，晚点看" are one thing to do: the promise stays,
  // the request it answers is taken off the list. After every insert, so the
  // order the AI listed them in does not matter.
  const settle = db.prepare(`
    UPDATE commitments SET status = 'dropped', status_at = ?
    WHERE group_id = ? AND row_id = ? AND kind = 'asked' AND status = 'open'
  `);
  db.transaction(() => {
    for (const { answers, ...item } of items) {
      insert.run({ ...item, nowUnix, model });
    }
    for (const item of items.filter((entry) => entry.answers !== null)) {
      settle.run(nowUnix, item.groupId, item.answers);
    }
  })();
};

// answered: the batch got its answer. Otherwise one more try is counted, and
// after MAX_TRIES the messages are let go so they stop being asked.
const markLooked = (db, batch, { answered }) => {
  const mark = db.prepare(`
    INSERT INTO commitment_looked (group_id, row_id, sent_at, tries, done) VALUES (@groupId, @rowId, @sentAt, 1, @done)
    ON CONFLICT(group_id, row_id) DO UPDATE SET
      done = CASE WHEN @done = 1 OR tries + 1 >= ${MAX_TRIES} THEN 1 ELSE 0 END,
      tries = tries + 1
  `);
  db.transaction(() => {
    for (const row of batch) {
      mark.run({ groupId: row.groupId, rowId: row.rowId, sentAt: row.sentAt, done: answered ? 1 : 0 });
    }
  })();
};

const forgetOldLooked = (db, nowUnix) =>
  db.prepare("DELETE FROM commitment_looked WHERE sent_at < ?").run(nowUnix - LOOKED_KEPT_SECONDS);

// Enough waiting messages for a call, or one that has waited long enough.
const worthCalling = (pending, nowUnix) =>
  pending.length >= MIN_BATCH || (pending.length > 0 && nowUnix - SETTLE_SECONDS - pending[0].sentAt >= MAX_WAIT_SECONDS);

// One refresh's worth: gate() returns a reason to stop (pause, daily cap,
// money budget) or null, and is asked before every call.
const runCommitmentPass = async (db, { identity, callLlm, client, model, gate, nowUnix, shouldFallBack = () => false }) => {
  ensureCommitmentSchema(db);
  const outcome = { calls: 0, looked: 0, found: 0, failed: 0, waiting: 0, stoppedBy: null };
  if ((identity?.uins ?? []).length === 0) {
    return { ...outcome, stoppedBy: "no-identity" };
  }
  forgetOldLooked(db, nowUnix);
  for (;;) {
    const pending = pendingRows(db, { identity, nowUnix });
    outcome.waiting = pending.length;
    if (!worthCalling(pending, nowUnix)) {
      break;
    }
    if (outcome.calls >= MAX_CALLS_PER_RUN) {
      outcome.stoppedBy = "run-cap";
      break;
    }
    const blocked = gate();
    if (blocked) {
      outcome.stoppedBy = blocked;
      break;
    }
    const batch = pending.slice(0, CANDIDATES_PER_CALL).map((row) => withContext(db, row));
    try {
      const raw = await callLlm(
        client,
        () => ({ system: SYSTEM_PROMPT, user: buildPrompt(batch), maxTokens: MAX_TOKENS, temperature: 0 }),
        { purpose: "commitments", messages: batch.length, validate: validateAnswer },
      );
      const items = readAnswer(raw, batch);
      saveFound(db, items, { model: model(), nowUnix });
      markLooked(db, batch, { answered: true });
      outcome.calls += 1;
      outcome.looked += batch.length;
      outcome.found += items.length;
    } catch (error) {
      outcome.failed += 1;
      outcome.error = String(error.message).slice(0, 200);
      if (shouldFallBack(error)) {
        // The account or the service is down: nothing is counted against
        // these messages, they are asked again when it is back.
        outcome.stoppedBy = "ai-down";
      } else {
        // A timeout or an answer that was cut off: the same messages are
        // asked again on a later refresh, a few times at most.
        markLooked(db, batch, { answered: false });
        outcome.stoppedBy = "failed";
      }
      break;
    }
  }
  return outcome;
};

/* ---------- reading and ticking off ---------- */

const rowToItem = (row) => ({
  groupId: row.groupId,
  groupName: row.groupName,
  rowId: row.rowId,
  kind: row.kind,
  what: row.what,
  who: row.who,
  quote: row.quote,
  sentAt: row.sentAt,
  status: row.status,
  statusAt: row.statusAt,
});

const LIST_COLUMNS = `c.group_id AS groupId, COALESCE(n.name, '') AS groupName, c.row_id AS rowId, c.kind, c.what, c.who, c.quote,
  c.sent_at AS sentAt, c.status, c.status_at AS statusAt`;

// Open ones newest first; finished ones (kept for the history) newest finished first.
const listCommitments = (db, { nowUnix }) => {
  ensureCommitmentSchema(db);
  const open = db.prepare(`
    SELECT ${LIST_COLUMNS} FROM commitments c LEFT JOIN group_names n ON n.group_id = c.group_id
    WHERE c.status = 'open' ORDER BY c.sent_at DESC, c.row_id DESC
  `).all().map(rowToItem);
  const done = db.prepare(`
    SELECT ${LIST_COLUMNS} FROM commitments c LEFT JOIN group_names n ON n.group_id = c.group_id
    WHERE c.status = 'done' AND c.status_at >= ? ORDER BY c.status_at DESC, c.row_id DESC
  `).all(nowUnix - DONE_KEPT_SECONDS).map(rowToItem);
  return { open, done };
};

const setStatus = (db, { groupId, rowId, status, nowUnix }) => {
  ensureCommitmentSchema(db);
  if (!STATUSES.has(String(status))) {
    throw new Error("不认识的状态。");
  }
  const changed = db.prepare("UPDATE commitments SET status = ?, status_at = ? WHERE group_id = ? AND row_id = ?")
    .run(status, status === "open" ? 0 : nowUnix, String(groupId), String(rowId)).changes;
  if (changed === 0) {
    throw new Error("没有这一条。");
  }
  return true;
};

module.exports = {
  ensureCommitmentSchema,
  pendingCandidates,
  buildPrompt,
  validateAnswer,
  readAnswer,
  runCommitmentPass,
  listCommitments,
  setStatus,
  SYSTEM_PROMPT,
  CANDIDATES_PER_CALL,
  MAX_CALLS_PER_RUN,
  MIN_BATCH,
  MAX_TRIES,
  MAX_WAIT_SECONDS,
  SETTLE_SECONDS,
  LOOKBACK_SECONDS,
};
