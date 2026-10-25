"use strict";

// 笔记库 → 群里的共识: for a thing several groups talk about, one AI call
// turns every mention and answered question into what is known about it
// (versions, setup, results, pitfalls) and what is still unsettled. Cached in
// the store; written again only when new mentions came in and the last one is
// a week old, so a busy thing costs about one call a week.

const crypto = require("node:crypto");
const { clipText } = require("./things_index");
const { shouldFallBack } = require("./llm_summarizer");

const FAILURES_SCHEMA = `CREATE TABLE IF NOT EXISTS kb_consensus_failures (
  anchor TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_at INTEGER NOT NULL
)`;

const SCHEMA = `CREATE TABLE IF NOT EXISTS kb_consensus (
  anchor TEXT PRIMARY KEY,
  keys_json TEXT NOT NULL,
  input_key TEXT NOT NULL,
  mention_count INTEGER NOT NULL,
  answer_count INTEGER NOT NULL,
  used_mentions INTEGER NOT NULL,
  used_answers INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL,
  made_at INTEGER NOT NULL
)`;

const MIN_GROUPS = 3;
const REFRESH_SECONDS = 7 * 24 * 3600;
const MAX_INPUT_CHARS = 24000;
const MAX_TOKENS = 3000;
const MAX_POINTS = 8;
const MAX_UNSURE = 4;
const MAX_LINE_CHARS = 300;

const SYSTEM_PROMPT = "你是群聊知识库的编辑，把很多人零散的说法整理成可以直接用的知识。只输出合法 JSON。";

const ensureConsensusSchema = (db) => {
  db.prepare(SCHEMA).run();
  db.prepare(FAILURES_SCHEMA).run();
  return db;
};

// A thing whose call failed twice in a row (a malformed answer, not the
// provider being down) waits a week, so it is not retried first on every
// refresh while the others wait behind it.
const MAX_FAILURES = 2;
const recentFailures = (db, nowUnix) => new Set(ensureConsensusSchema(db)
  .prepare("SELECT anchor FROM kb_consensus_failures WHERE failures >= ? AND last_at > ?").all(MAX_FAILURES, nowUnix - REFRESH_SECONDS)
  .map((row) => row.anchor));

const noteFailure = (db, anchor, nowUnix) => db.prepare(`
  INSERT INTO kb_consensus_failures (anchor, failures, last_at) VALUES (?, 1, ?)
  ON CONFLICT(anchor) DO UPDATE SET failures = failures + 1, last_at = excluded.last_at
`).run(anchor, nowUnix);

const parseResult = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// anchor key -> stored row; a thing finds its row through any of its keys, so
// a thing whose most used spelling changed keeps its consensus.
const loadConsensus = (db) => {
  const byKey = new Map();
  for (const row of ensureConsensusSchema(db).prepare("SELECT * FROM kb_consensus").all()) {
    const result = parseResult(row.result_json);
    if (result === null) {
      continue;
    }
    const entry = {
      anchor: row.anchor,
      mentionCount: row.mention_count,
      answerCount: row.answer_count,
      usedMentions: row.used_mentions,
      usedAnswers: row.used_answers,
      model: row.model,
      madeAt: row.made_at,
      keys: parseResult(row.keys_json) ?? [row.anchor],
      result,
    };
    for (const key of entry.keys) {
      if (!byKey.has(key) || byKey.get(key).madeAt < entry.madeAt) {
        byKey.set(key, entry);
      }
    }
  }
  return byKey;
};

// The newest consensus written for this thing or a part of it: one written
// for a bigger thing the user has since split is not this thing's.
const consensusOf = (byKey, thing) => thing.keys.map((key) => byKey.get(key))
  .filter((entry) => entry !== undefined && entry.keys.every((key) => thing.keys.includes(key)))
  .sort((left, right) => right.madeAt - left.madeAt)[0] ?? null;

const isEligible = (thing) => thing.groups.length >= MIN_GROUPS;

// What to write this run, most needed first: things that never had one (most
// groups first), then those with the most new mentions since theirs.
const planConsensus = (things, byKey, nowUnix, failing = new Set()) => {
  const fresh = [];
  const stale = [];
  for (const thing of things.filter((entry) => isEligible(entry) && !entry.keys.some((key) => failing.has(key)))) {
    const current = consensusOf(byKey, thing);
    if (current === null) {
      fresh.push(thing);
    } else if (thing.mentions.length > current.mentionCount && nowUnix - current.madeAt >= REFRESH_SECONDS) {
      stale.push({ thing, added: thing.mentions.length - current.mentionCount });
    }
  }
  return [
    ...fresh.sort((left, right) => right.groups.length - left.groups.length || right.chunkCount - left.chunkCount),
    ...stale.sort((left, right) => right.added - left.added).map((entry) => entry.thing),
  ];
};

const day = (unix) => new Date((unix + 8 * 3600) * 1000).toISOString().slice(0, 10);
const clip = (text) => clipText(text, MAX_LINE_CHARS);

// Newest first until the input is full; returns how many of each went in.
const fillLines = (thing, answers, groupNames) => {
  const lines = { mentions: [], answers: [] };
  let used = 0;
  const take = (target, text) => {
    if (used + text.length > MAX_INPUT_CHARS) {
      return false;
    }
    used += text.length + 1;
    target.push(text);
    return true;
  };
  const mentionLines = thing.mentions.map((mention) => `${day(mention.sentAt)} · ${groupNames.get(mention.groupId) ?? mention.groupId} · ${clip(mention.detail)}`);
  const answerLines = answers.map((answer) => `${day(answer.sentAt)} · 问：${clip(answer.question)} 答：${clip(answer.answer)}`);
  // Alternate, so neither list crowds the other out of a full input.
  const longest = Math.max(mentionLines.length, answerLines.length);
  for (let index = 0; index < longest; index += 1) {
    if (index < mentionLines.length && !take(lines.mentions, mentionLines[index])) {
      break;
    }
    if (index < answerLines.length && !take(lines.answers, answerLines[index])) {
      break;
    }
  }
  return lines;
};

const buildConsensusPrompt = ({ thing, lines }) => [
  `东西：${thing.names.slice(0, 4).join(" / ")}（${thing.kind}）`,
  // A topic: the LoRAs, plugins ... under it are mentioned below as well.
  ...(thing.memberNames?.length > 0 ? [`它下面还有（LoRA、插件、教程等）：${thing.memberNames.join("、")}`] : []),
  `一共 ${thing.mentions.length} 次提到，${thing.groups.length} 个群；下面是最近的 ${lines.mentions.length} 次提到和 ${lines.answers.length} 个有答案的问答（先是它本身，再是它下面的东西）。`,
  "",
  "把群里知道的整理成知识，写给想用它的人看：",
  `- what：一句话说它是什么（谁做的、做什么用），输入里没有就写「群里没说清楚」。`,
  `- points：最多 ${MAX_POINTS} 条已经有共识或有人实测过的要点（版本区别、配置/显存、效果、和别的东西比、坑和解决办法），每条一句，具体到数字；不要写「某某说」，除非是只有一个人说的实测，就写「有人实测」。`,
  `- unsure：最多 ${MAX_UNSURE} 条还没定论、互相矛盾或没人确认的地方。`,
  "只根据下面的内容，不要补充你自己知道的信息，不要编链接。用简体中文。",
  "输出：{\"what\": \"...\", \"points\": [\"...\"], \"unsure\": [\"...\"]}",
  "",
  "提到：",
  ...lines.mentions,
  ...(lines.answers.length > 0 ? ["", "问答：", ...lines.answers] : []),
].join("\n");

const validateConsensus = (raw) => {
  if (typeof raw?.what !== "string" || !Array.isArray(raw?.points)) {
    throw new Error("Invalid LLM JSON. Required fields are missing: what, points");
  }
};

const textList = (value, limit) => (Array.isArray(value) ? value : [])
  .filter((item) => typeof item === "string" && item.trim() !== "")
  .map((item) => item.trim())
  .slice(0, limit);

const normalizeConsensus = (raw) => ({
  what: String(raw.what ?? "").trim(),
  points: textList(raw.points, MAX_POINTS),
  unsure: textList(raw.unsure, MAX_UNSURE),
});

const inputKey = (thing, answers) => crypto.createHash("sha1")
  .update(JSON.stringify([thing.mentions.map((mention) => `${mention.chunkId}:${mention.index}`), answers.map((answer) => `${answer.chunkId}:${answer.index}`)]))
  .digest("hex");

const saveConsensus = (db, { thing, answers, lines, result, model, nowUnix }) => {
  db.prepare(`
    INSERT OR REPLACE INTO kb_consensus
      (anchor, keys_json, input_key, mention_count, answer_count, used_mentions, used_answers, model, result_json, made_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(thing.anchor, JSON.stringify(thing.keys), inputKey(thing, answers), thing.mentions.length, answers.length,
    lines.mentions.length, lines.answers.length, model, JSON.stringify(result), nowUnix);
};

const CONCURRENCY = 3;

// answersOf(thing) -> its answered questions, newest first. gate() as in
// things_aliases; up to CONCURRENCY calls at once. Stops taking new work at
// the first refusal reason; one thing failing does not stop the others.
const runConsensusPass = async (db, { things, answersOf, groupNames, callLlm, client, model, gate, nowUnix }) => {
  const plan = planConsensus(things, loadConsensus(db), nowUnix, recentFailures(db, nowUnix));
  const outcome = { made: 0, failed: 0, pending: plan.length, stoppedBy: null };
  let next = 0;
  const lane = async () => {
    while (next < plan.length && outcome.stoppedBy === null) {
      const blocked = gate();
      if (blocked) {
        outcome.stoppedBy = blocked;
        return;
      }
      const thing = plan[next];
      next += 1;
      await writeOne(db, { thing, answersOf, groupNames, callLlm, client, model, nowUnix, outcome });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, lane));
  return outcome;
};

// One thing's call; counts into the pass's own outcome.
const writeOne = async (db, { thing, answersOf, groupNames, callLlm, client, model, nowUnix, outcome }) => {
  const answers = answersOf(thing);
  const lines = fillLines(thing, answers, groupNames);
  try {
    const raw = await callLlm(
      client,
      () => ({ system: SYSTEM_PROMPT, user: buildConsensusPrompt({ thing, lines }), maxTokens: MAX_TOKENS, temperature: 0.2 }),
      { purpose: "notes-consensus", messages: lines.mentions.length + lines.answers.length, validate: validateConsensus },
    );
    saveConsensus(db, { thing, answers, lines, result: normalizeConsensus(raw), model: model(), nowUnix });
    db.prepare("DELETE FROM kb_consensus_failures WHERE anchor = ?").run(thing.anchor);
    outcome.made += 1;
  } catch (error) {
    outcome.failed += 1;
    outcome.error = String(error.message).slice(0, 200);
    if (!shouldFallBack(error)) {
      noteFailure(db, thing.anchor, nowUnix);
    }
  }
  outcome.pending -= 1;
};

module.exports = {
  MIN_GROUPS,
  ensureConsensusSchema,
  loadConsensus,
  consensusOf,
  isEligible,
  planConsensus,
  fillLines,
  buildConsensusPrompt,
  normalizeConsensus,
  runConsensusPass,
};
