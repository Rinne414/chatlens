"use strict";

// 角色卡: who a person is in the chats, written from their own words.
//
// 1. observe (one call per batch of material): what this stretch shows about
//    them, every point tied to the lines it came from (E12, M5);
// 2. compose (one call): the card, from all the observations with their lines;
// 3. blind test (two calls): with only the card, write replies to messages the
//    card's writer never saw; then a judge that has not seen the card is shown
//    each real reply beside the written one and picks the real one. A card that
//    resembles the person makes that hard: about half right is the best result.
//
// A point whose lines do not exist in the material is dropped, so the card
// cannot say something the chats do not show.

const { callLlm } = require("./llm_summarizer");
const { TEST_MAX_CHARS } = require("./persona_material");

const PURPOSE = "persona";
const OBSERVE_MAX_TOKENS = 3000;
const COMPOSE_MAX_TOKENS = 5000;
const TEST_MAX_TOKENS = 2500;
const MAX_POINTS = 12;
const MAX_EXAMPLES = 12;
// What the card's writer is handed, so its prompt stays a size any model
// takes: this many points of one kind (in turn from every batch), each with
// its first lines cut short.
const MAX_OBSERVED = 24;
const COMPOSE_LINES_PER_POINT = 2;
const COMPOSE_LINE_CHARS = 110;
// One field of a point (a view, a way of treating someone).
const POINT_CHARS = 160;
const KINDS = ["stances", "attitudes", "humor", "habits", "interests", "facts"];

const text = (value, max = 600) => {
  const chars = [...String(value ?? "").trim()];
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
};
const list = (value) => (Array.isArray(value) ? value : []);
const ID = /^[EM]\d+$/u;
const idsOf = (value, known) => [...new Set(list(value).map((id) => String(id).trim()).filter((id) => ID.test(id) && known.has(id)))];

const SYSTEM = [
  "你在帮用户整理他自己群聊记录里某一个群友的「角色卡」：这个人是怎样的人、怎么说话。材料全部是真实聊天，「TA」就是这个人。",
  "只写材料里看得出来的，不猜测，不评价好坏，不替 TA 圆场；脏话、玩笑、极端说法照实描述。",
  "输出必须是合法 JSON。",
].join("");

const observePrompt = (lines, names) => ({
  system: SYSTEM,
  user: JSON.stringify({
    person: { names },
    material: lines,
    format: "每行开头是编号。E 开头：别人说了一句 → TA 的回复；M 开头：TA 自己说的一段话。",
    task: "从这批材料里找出能说明 TA 是怎样的人的要点。每个要点必须在 ids 里列出依据的行编号（1-4 个）；找不到依据的不要写。",
    kinds: {
      stances: "TA 对某件事、某个东西、某类人的看法或立场（topic 写对象，view 写 TA 怎么看）",
      attitudes: "TA 对某个具体的人怎么说话（toward 写那个人的名字，how 写语气和相处方式：客气、互损、照顾、不耐烦……）",
      humor: "TA 怎么开玩笑、怎么吐槽（kind 写方式）",
      habits: "说话习惯：句子长短、标点、语气词、口头禅、中英夹杂、发语词、怎么开头怎么收尾（pattern）",
      interests: "TA 常聊、懂行的东西（what）",
      facts: "TA 提到过的关于自己的事：做什么、用什么、在哪、习惯（fact）",
    },
    outputSchema: {
      stances: [{ topic: "string", view: "string", ids: ["E1"] }],
      attitudes: [{ toward: "string", how: "string", ids: ["E2"] }],
      humor: [{ kind: "string", ids: ["E3"] }],
      habits: [{ pattern: "string", ids: ["M1"] }],
      interests: [{ what: "string", ids: ["M2"] }],
      facts: [{ fact: "string", ids: ["M3"] }],
    },
  }, null, 2),
  maxTokens: OBSERVE_MAX_TOKENS,
});

const FIELDS = { stances: ["topic", "view"], attitudes: ["toward", "how"], humor: ["kind"], habits: ["pattern"], interests: ["what"], facts: ["fact"] };

// Keeps only points that say something and point at lines that exist.
const cleanPoints = (raw, known) => Object.fromEntries(KINDS.map((kind) => [kind, list(raw?.[kind]).map((item) => {
  const fields = Object.fromEntries(FIELDS[kind].map((field) => [field, text(item?.[field], POINT_CHARS)]));
  return { ...fields, ids: idsOf(item?.ids, known) };
}).filter((item) => item.ids.length > 0 && FIELDS[kind].every((field) => item[field].length > 0)).slice(0, MAX_POINTS * 2)]));

const requireObject = (raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid LLM JSON. An object is required");
  }
};

// One point from each batch in turn, so a late batch is heard as much as the first.
const inTurn = (lists, limit) => {
  const picked = [];
  for (let round = 0; picked.length < limit && lists.some((items) => round < items.length); round += 1) {
    for (const items of lists) {
      if (round < items.length && picked.length < limit) {
        picked.push(items[round]);
      }
    }
  }
  return picked;
};

// perBatch: [{ stances: [...], ... }] -> the points the card's writer gets.
const pointsForCompose = (perBatch) => Object.fromEntries(KINDS.map((kind) => [kind, inTurn(perBatch.map((points) => points[kind]), MAX_OBSERVED)]));

const shortLine = (line) => {
  const chars = [...String(line ?? "")];
  return chars.length > COMPOSE_LINE_CHARS ? `${chars.slice(0, COMPOSE_LINE_CHARS).join("")}…` : chars.join("");
};

const composePrompt = (observations, lineOf, material) => ({
  system: SYSTEM,
  user: JSON.stringify({
    person: { names: material.names, groups: material.stats.groups, messagesRead: material.stats.exchanges + material.stats.monologues },
    observations: Object.fromEntries(KINDS.map((kind) => [kind, observations[kind].map((item) => ({ ...item, lines: item.ids.slice(0, COMPOSE_LINES_PER_POINT).map((id) => shortLine(lineOf.get(id))) }))])),
    task: [
      "把这些分批得到的要点合成一张角色卡。重复的合并，互相矛盾的两边都写（并说明各在什么场合），只出现一次、依据很弱的丢掉。",
      "每一条都保留 ids（依据的行编号，可以合并多条的编号）。",
      "portrait：150-300 字，写这个人给人的整体印象，要具体到能和别的群友区分开，不要写成谁都适用的套话。",
      "voice：照着写就能模仿出 TA 的说话方式：tone（语气）、sentences（句子怎么组织、长短、标点和语气词）、catchphrases（TA 真的常用的词句，最多 8 个）。",
      `examples：挑最能代表 TA 的 ${MAX_EXAMPLES} 行以内的编号（优先 E 开头的对话，要覆盖不同的人和不同的情绪）。`,
    ],
    outputSchema: {
      oneLine: "一句话说清 TA 是谁（30 字以内）",
      portrait: "string",
      voice: { tone: "string", sentences: "string", catchphrases: ["string"] },
      stances: [{ topic: "string", view: "string", ids: ["E1"] }],
      attitudes: [{ toward: "string", how: "string", ids: ["E2"] }],
      humor: [{ kind: "string", ids: ["E3"] }],
      interests: [{ what: "string", ids: ["M2"] }],
      facts: [{ fact: "string", ids: ["M3"] }],
      examples: ["E1"],
    },
  }),
  maxTokens: COMPOSE_MAX_TOKENS,
});

const requireCard = (raw) => {
  requireObject(raw);
  if (text(raw.portrait).length === 0) {
    throw new Error("Invalid LLM JSON. Required string is missing: portrait");
  }
};

const cleanCard = (raw, known) => {
  const points = cleanPoints(raw, known);
  return {
    oneLine: text(raw.oneLine, 80),
    portrait: text(raw.portrait, 1200),
    voice: {
      tone: text(raw.voice?.tone, 400),
      sentences: text(raw.voice?.sentences, 600),
      catchphrases: list(raw.voice?.catchphrases).map((item) => text(item, 40)).filter(Boolean).slice(0, 8),
    },
    stances: points.stances.slice(0, MAX_POINTS),
    attitudes: points.attitudes.slice(0, MAX_POINTS),
    humor: points.humor.slice(0, 6),
    interests: points.interests.slice(0, MAX_POINTS),
    facts: points.facts.slice(0, MAX_POINTS),
    examples: idsOf(raw.examples, known).slice(0, MAX_EXAMPLES),
  };
};

/* ---------- the card as a prompt someone can paste ---------- */

const cardText = (card, name, lineOf) => {
  const bullets = (items, render) => (items.length === 0 ? "（材料里看不出来）" : items.map((item) => `- ${render(item)}`).join("\n"));
  return [
    `# ${name}`,
    card.oneLine,
    "",
    "## 这个人",
    card.portrait,
    "",
    "## 说话方式",
    `语气：${card.voice.tone}`,
    `句子：${card.voice.sentences}`,
    card.voice.catchphrases.length > 0 ? `常用的词句：${card.voice.catchphrases.join("、")}` : "",
    "",
    "## 看法和立场",
    bullets(card.stances, (item) => `${item.topic}：${item.view}`),
    "",
    "## 对不同的人",
    bullets(card.attitudes, (item) => `对 ${item.toward}：${item.how}`),
    "",
    "## 怎么开玩笑",
    bullets(card.humor, (item) => item.kind),
    "",
    "## 常聊的东西",
    bullets(card.interests, (item) => item.what),
    "",
    "## 关于自己",
    bullets(card.facts, (item) => item.fact),
    "",
    "## 真实对话",
    card.examples.map((id) => lineOf.get(id)?.replace(/^[EM]\d+ /u, "")).filter(Boolean).join("\n"),
  ].filter((line) => line !== "").join("\n").replace(/\n(## )/gu, "\n\n$1");
};

/* ---------- blind test ---------- */

const replyPrompt = (cardAsText, heldOut) => ({
  system: "你要扮演下面角色卡里的人，在群里回复别人。只按卡里写的性格和说话方式来，写成这个人会发的那种消息：长度、标点、语气都照 TA 的习惯，不要解释，不要加引号。输出必须是合法 JSON。",
  user: JSON.stringify({
    card: cardAsText,
    messages: heldOut.map((item) => ({ n: item.n, group: item.groupName, from: item.partnerName, said: item.said })),
    task: `对每一条 said，写出这个人会怎么回：一行，不超过 ${TEST_MAX_CHARS} 个字，只用文字。`,
    outputSchema: { replies: [{ n: 1, reply: "string" }] },
  }, null, 2),
  maxTokens: TEST_MAX_TOKENS,
});

const requireReplies = (raw) => {
  if (list(raw?.replies).length === 0) {
    throw new Error("Invalid LLM JSON. No replies");
  }
};

// Which side (A or B) holds the real reply: fixed by the question's number, so
// a rerun asks the same thing, and balanced so "always A" scores half.
const realSide = (n) => ((n * 7 + 3) % 4 < 2 ? "A" : "B");

const judgePrompt = (pairs) => ({
  system: "下面每一题有一句群聊里别人说的话，和两条回复：一条是真人当时发的，一条是 AI 模仿这个人写的。判断哪一条是真人发的。输出必须是合法 JSON。",
  user: JSON.stringify({
    questions: pairs.map((pair) => ({ n: pair.n, said: pair.said, A: pair.A, B: pair.B })),
    outputSchema: { picks: [{ n: 1, real: "A | B", why: "一句话理由" }] },
  }, null, 2),
  maxTokens: TEST_MAX_TOKENS,
});

const requirePicks = (raw) => {
  if (list(raw?.picks).length === 0) {
    throw new Error("Invalid LLM JSON. No picks");
  }
};

// { questions: [{ n, groupName, partnerName, said, real, written, judgedReal, why }], asked, spotted }
// spotted: how many times the judge found the real reply.
// The real reply and the written one are put in the same shape (one line,
// the same longest length), so only the words can tell them apart.
const sameShape = (reply) => text(String(reply ?? "").replace(/\s+/gu, " "), TEST_MAX_CHARS);

const blindTest = async (client, cardAsText, heldOut) => {
  if (heldOut.length === 0) {
    return { questions: [], asked: 0, spotted: 0 };
  }
  const written = await callLlm(client, () => replyPrompt(cardAsText, heldOut), { purpose: PURPOSE, validate: requireReplies });
  const replyOf = new Map(list(written.replies).map((item) => [Number(item?.n), sameShape(item?.reply)]));
  const pairs = heldOut.filter((item) => (replyOf.get(item.n) ?? "").length > 0).map((item) => {
    const side = realSide(item.n);
    const real = sameShape(item.reply);
    return { n: item.n, said: item.said, A: side === "A" ? real : replyOf.get(item.n), B: side === "B" ? real : replyOf.get(item.n), side };
  });
  if (pairs.length === 0) {
    return { questions: [], asked: 0, spotted: 0 };
  }
  const judged = await callLlm(client, () => judgePrompt(pairs), { purpose: PURPOSE, validate: requirePicks });
  const pickOf = new Map(list(judged.picks).map((item) => [Number(item?.n), { real: String(item?.real ?? "").trim().toUpperCase().slice(0, 1), why: text(item?.why, 200) }]));
  const questions = pairs.filter((pair) => ["A", "B"].includes(pickOf.get(pair.n)?.real)).map((pair) => {
    const item = heldOut.find((held) => held.n === pair.n);
    const pick = pickOf.get(pair.n);
    return {
      n: pair.n, groupName: item.groupName, partnerName: item.partnerName, said: item.said,
      real: sameShape(item.reply), written: replyOf.get(pair.n), judgedReal: pick.real === pair.side, why: pick.why,
    };
  });
  return { questions, asked: questions.length, spotted: questions.filter((question) => question.judgedReal).length };
};

/* ---------- the whole card ---------- */

// progress(step, done, total): "observe" | "compose" | "test".
const buildCard = async (client, material, { progress = () => {} } = {}) => {
  const known = new Set([...material.exchanges, ...material.monologues].map((item) => item.id));
  const lineOf = new Map(material.batches.flat().map((line) => [line.slice(0, line.indexOf(" ")), line]));
  const perBatch = [];
  let failedBatches = 0;
  for (const [index, lines] of material.batches.entries()) {
    progress("observe", index, material.batches.length);
    const inBatch = new Set(lines.map((line) => line.slice(0, line.indexOf(" "))));
    try {
      const raw = await callLlm(client, () => observePrompt(lines, material.names), { purpose: PURPOSE, messages: lines.length, validate: requireObject });
      perBatch.push(cleanPoints(raw, inBatch));
    } catch (error) {
      // One refused or broken batch does not end the card; with none left it does.
      failedBatches += 1;
      if (failedBatches === material.batches.length) {
        throw error;
      }
    }
  }
  const observations = pointsForCompose(perBatch);
  if (KINDS.every((kind) => observations[kind].length === 0)) {
    throw new Error("AI 没有从这些聊天里看出可以写的内容。");
  }
  progress("compose", 0, 1);
  // The card may only rest on lines its writer was given.
  const given = new Set(KINDS.flatMap((kind) => observations[kind].flatMap((item) => item.ids)).filter((id) => known.has(id)));
  const card = cleanCard(await callLlm(client, () => composePrompt(observations, lineOf, material), { purpose: PURPOSE, validate: requireCard }), given);
  const name = material.names[0] ?? material.uin;
  const asText = cardText(card, name, lineOf);
  progress("test", 0, 1);
  let test = null;
  try {
    test = await blindTest(client, asText, material.heldOut);
  } catch (error) {
    // The card stands without its test; the page says the test did not run.
    test = { questions: [], asked: 0, spotted: 0, error: error.message };
  }
  const byId = new Map([...material.exchanges, ...material.monologues].map((item) => [item.id, item]));
  // Every line a point rests on, so the page can show it and jump to it.
  const evidence = Object.fromEntries([...new Set([...KINDS.flatMap((kind) => (card[kind] ?? []).flatMap((item) => item.ids)), ...card.examples])]
    .map((id) => [id, byId.get(id)]).filter(([, item]) => item !== undefined));
  return { card, text: asText, test, evidence, failedBatches };
};

module.exports = { buildCard, blindTest, cleanCard, cleanPoints, cardText, realSide, observePrompt, composePrompt, pointsForCompose, PURPOSE };
