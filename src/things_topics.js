"use strict";

// 笔记库 → 主题: the things arranged the way a reader looks them up. A model
// line is one topic with its versions, the LoRAs, plugins and workflows made
// for it; a tool with a name of its own is its own topic. The AI places every
// thing once (cached per name key, so a renamed thing keeps its place); a new
// thing joins a topic that exists or starts one. Names the user put into a
// topic note's aliases outrank the AI (pins).

const { clipText, nameKey, bestDetail } = require("./things_index");
const { shouldFallBack } = require("./llm_summarizer");

const TOPICS_SCHEMA = `CREATE TABLE IF NOT EXISTS kb_topics (
  topic_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  what TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  made_at INTEGER NOT NULL
)`;

// topic_key '' = the AI placed it under no topic (small talk, a joke ...).
const MEMBERS_SCHEMA = `CREATE TABLE IF NOT EXISTS kb_topic_members (
  thing_key TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  role TEXT NOT NULL,
  what TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL
)`;

const CATEGORIES = ["image", "video", "llm", "coding", "creative", "app", "site", "news", "other"];
const ROLES = ["main", "version", "derived", "tool", "guide", "work", "other"];
const CATEGORY_SET = new Set(CATEGORIES);
const ROLE_SET = new Set(ROLES);
// The category of a thing nobody placed, from what the chat called it.
const CATEGORY_OF_KIND = { model: "other", tool: "app", resource: "site", news: "news", event: "news", tutorial: "other", other: "other" };

const ITEMS_PER_CALL = 80;
const MAX_TOKENS = 8000;
const DETAIL_CHARS = 70;
const WHAT_CHARS = 30;
const TOPIC_WHAT_CHARS = 100;
const MAX_LISTED_TOPICS = 400;
// As many at once as the detailed level maps chunks (one Grok call took ~4 min).
const CONCURRENCY = 4;
// A batch the AI could not answer (a refusal, broken JSON) is stored as "in
// no topic" with this model, asked again a day later in smaller batches, so
// one bad item does not keep the other things of its batch out for good.
const FAILED_MODEL = "failed";
const RETRY_FAILED_SECONDS = 24 * 3600;
const RETRY_BATCH = 20;

// A thing heavy enough to stand as a topic of its own when the AI placed it
// nowhere (or has not been asked yet).
const isHeavy = (thing) => thing.groups.length >= 3 || thing.chunkCount >= 6;

const SYSTEM_PROMPT = "你帮一个 AI 群聊知识库整理目录：把群里提到的东西归到读者会去查的主题下。只输出合法 JSON。";

const ensureTopicSchema = (db) => {
  db.prepare(TOPICS_SCHEMA).run();
  db.prepare(MEMBERS_SCHEMA).run();
  return db;
};

const loadTopics = (db) => {
  ensureTopicSchema(db);
  const topics = new Map(db.prepare("SELECT topic_key AS key, name, category, what FROM kb_topics").all()
    .map((row) => [row.key, row]));
  const members = new Map(db.prepare("SELECT thing_key AS key, topic_key AS topicKey, role, what, model, checked_at AS checkedAt FROM kb_topic_members").all()
    .map((row) => [row.key, { topicKey: row.topicKey, role: row.role, what: row.what, failed: row.model === FAILED_MODEL, checkedAt: row.checkedAt }]));
  return { topics, members };
};

/* ---------- where each thing goes ---------- */

const keyCounts = (thing) => {
  const counts = new Map();
  for (const mention of thing.mentions) {
    counts.set(mention.key, (counts.get(mention.key) ?? 0) + 1);
  }
  return counts;
};

// The place most of the thing's mentions vote for, through the keys that have
// one; null when none of its names was placed yet.
const votedPlace = (thing, placeOf) => {
  const votes = new Map();
  const counts = keyCounts(thing);
  for (const key of thing.keys) {
    const place = placeOf(key);
    if (place !== undefined) {
      const entry = votes.get(place.topicKey) ?? { weight: 0, best: place, bestWeight: -1 };
      const weight = counts.get(key) ?? 0;
      votes.set(place.topicKey, {
        weight: entry.weight + weight,
        best: weight > entry.bestWeight ? place : entry.best,
        bestWeight: Math.max(weight, entry.bestWeight),
      });
    }
  }
  const winner = [...votes].sort((left, right) => right[1].weight - left[1].weight || left[0].localeCompare(right[0]))[0];
  return winner === undefined ? null : { topicKey: winner[0], role: winner[1].best.role, what: winner[1].best.what };
};

// thing -> { topicKey ('' none), role, what } or null (not asked yet). pins:
// key -> topic key the user chose ('' = in no topic); a pinned name decides.
const placeThings = (things, members, pins = new Map()) => new Map(things.map((thing) => {
  const pinned = votedPlace(thing, (key) => (pins.has(key) ? { topicKey: pins.get(key), role: "main", what: "" } : undefined));
  if (pinned !== null) {
    const stored = votedPlace(thing, (key) => members.get(key));
    return [thing, { ...pinned, what: stored?.what ?? "", role: stored?.topicKey === pinned.topicKey ? stored.role : "main" }];
  }
  return [thing, votedPlace(thing, (key) => members.get(key))];
}));

const ranked = (map) => [...map].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));

const weightOf = (entry) => entry.groups.length * 1000 + entry.chunkCount;

// The topics with their members, heaviest first. A heavy thing placed nowhere
// is a topic of its own; light ones stay out (the day notes still list them).
const buildTopics = (things, placement, storedTopics) => {
  const byKey = new Map();
  const topicOf = (key, fallback) => {
    if (!byKey.has(key)) {
      const stored = storedTopics.get(key);
      byKey.set(key, {
        key,
        name: stored?.name ?? fallback.name,
        category: stored?.category ?? fallback.category,
        what: stored?.what ?? "",
        members: [],
      });
    }
    return byKey.get(key);
  };
  for (const thing of things) {
    const place = placement.get(thing) ?? null;
    if (place !== null && place.topicKey !== "") {
      topicOf(place.topicKey, { name: thing.name, category: CATEGORY_OF_KIND[thing.kind] ?? "other" })
        .members.push({ thing, role: ROLE_SET.has(place.role) ? place.role : "other", what: place.what ?? "" });
    } else if (isHeavy(thing)) {
      const key = storedTopics.has(thing.anchor) ? thing.anchor : `thing:${thing.anchor}`;
      topicOf(key, { name: thing.name, category: CATEGORY_OF_KIND[thing.kind] ?? "other" })
        .members.push({ thing, role: "main", what: place?.what ?? "" });
    }
  }
  return [...byKey.values()].map(summarizeTopic).sort((left, right) => weightOf(right) - weightOf(left) || left.key.localeCompare(right.key));
};

const CORE_ROLES = new Set(["main", "version"]);

// Totals over the members; the topic's own names and links are those of its
// main things (versions when it has none).
const summarizeTopic = (topic) => {
  const members = [...topic.members].sort((left, right) => weightOf(right.thing) - weightOf(left.thing)
    || right.thing.lastAt - left.thing.lastAt);
  const groups = new Map();
  const chunkIds = new Set();
  for (const { thing } of members) {
    thing.groups.forEach((group) => groups.set(group.groupId, (groups.get(group.groupId) ?? 0) + group.count));
    thing.mentions.forEach((mention) => chunkIds.add(mention.chunkId));
  }
  const mentions = members.flatMap(({ thing }) => thing.mentions.map((mention) => ({ ...mention, thing })))
    .sort((left, right) => right.sentAt - left.sentAt || right.chunkId - left.chunkId || right.index - left.index);
  const mains = members.filter((member) => member.role === "main");
  const core = mains.length > 0 ? mains : members.filter((member) => CORE_ROLES.has(member.role));
  return {
    ...topic,
    members,
    core: core.map((member) => member.thing),
    names: [...new Set([topic.name, ...core.flatMap((member) => member.thing.names)])],
    keys: [...new Set(members.flatMap((member) => member.thing.keys))],
    mentions,
    groups: ranked(groups).map(([groupId, count]) => ({ groupId, count })),
    chunkCount: chunkIds.size,
    links: core.flatMap((member) => member.thing.links),
    firstAt: Math.min(...members.map((member) => member.thing.firstAt)),
    lastAt: Math.max(...members.map((member) => member.thing.lastAt)),
  };
};

// Worth a note: talked about again and again -- 3+ stretches of chat over 2+
// groups, or 5+ in one. Smaller topics are still in the day notes. (2+ groups
// alone made 234 notes on a real store, 92 of them mentioned 2-3 times: too
// many one-off notes. This rule: 173, 37.)
const isNotable = (topic) => (topic.groups.length >= 2 && topic.chunkCount >= 3) || topic.chunkCount >= 5;

/* ---------- 群里的共识 of a topic ---------- */

// Where a topic's consensus is stored (src/things_consensus.js keys).
const consensusKey = (topic) => `topic:${topic.key}`;

const MAX_MEMBER_NAMES = 20;

// The topic in the shape the consensus pass takes: its own mentions (and its
// versions') first, so a busy topic is not summed up from its LoRAs.
const consensusSubject = (topic, answers) => {
  const core = new Set(topic.core);
  const own = topic.mentions.filter((mention) => core.has(mention.thing));
  const rest = topic.mentions.filter((mention) => !core.has(mention.thing));
  return {
    anchor: consensusKey(topic),
    keys: [consensusKey(topic)],
    names: topic.names,
    kind: topic.category,
    mentions: [...own, ...rest],
    groups: topic.groups,
    chunkCount: topic.chunkCount,
    memberNames: topic.members.filter((member) => !core.has(member.thing)).slice(0, MAX_MEMBER_NAMES).map((member) => member.thing.name),
    answers,
  };
};

/* ---------- the call ---------- */

const itemLine = (thing, index) => [
  index + 1,
  thing.names.slice(0, 3).join(" / "),
  thing.kind,
  `${thing.groups.length}群${thing.chunkCount}次`,
  clipText(bestDetail(thing)?.detail, DETAIL_CHARS) || "没有说明",
].join(" | ");

const buildTopicPrompt = (batch, topicList) => [
  "下面是群聊里提到的东西（编号 | 名字 | 群里叫它什么 | 几个群提到几次 | 群里的一句说明）。把每个东西归到一个主题下。",
  "",
  "主题怎么分：",
  "- 一个模型系列是一个主题：同一家、同一条产品线的版本、尺寸、加速版、量化版都在里面（MOSS-Image 的 Base/SFT/Edit/8 步蒸馏版都归 MOSS-Image；Opus 5.5、Sonnet 5.5 都归 Claude）。",
  "- 专门给某个模型做的 LoRA、微调、融合模型、插件、节点、工作流、提示词工具，归到那个模型的主题。",
  "- 有自己名字、被单独讨论的软件或服务是自己的主题（ComfyUI、Codex、Claude Code），即使和别的主题是同一家公司做的。",
  "- 不同公司、不同产品线绝不放进同一个主题；一个简称可能指好几个东西时不要猜。拿不准、闲聊、梗、和 AI/软件/资源无关的，topic 写 \"\"。",
  "",
  ...(topicList.length > 0
    ? ["已有主题（能用就用，名字照抄）：", ...topicList.map((topic) => `${topic.name}（${topic.category}）`), ""]
    : []),
  "没有合适的已有主题时新建一个：用最常见、最正式的写法命名（「MOSS-Image」而不是「moss」），在 topics 里给出它的 category 和一句 what。",
  "",
  "每个东西给：",
  "- topic：主题名，或 \"\"",
  "- role：main（就是这个主题本身，只是别名、简称或写法不同）、version（官方的版本/变体/量化/加速版）、derived（别人做的 LoRA/微调/融合模型）、tool（插件/节点/软件/脚本）、guide（工作流/教程/提示词/参数）、work（作品/视频/文章/新闻/活动）、other",
  `- what：不超过 20 个字，说它是什么（不要写谁分享的）`,
  `category 只能是：image（图像模型）、video（视频/语音/3D 模型）、llm（语言模型）、coding（AI 编程和 Agent 工具）、creative（生图/训练/打标工具和整合包）、app（其他软件和服务）、site（网站和社区）、news（新闻和活动）、other。`,
  "用简体中文。输出：{\"items\": [{\"i\": 1, \"topic\": \"MOSS-Image\", \"role\": \"derived\", \"what\": \"平涂画风 LoRA\"}], \"topics\": [{\"name\": \"新主题名\", \"category\": \"image\", \"what\": \"一句话说它是什么\"}]}",
  "",
  ...batch.map(itemLine),
].join("\n");

const validateTopics = (raw) => {
  if (!Array.isArray(raw?.items)) {
    throw new Error("Invalid LLM JSON. Required array is missing: items");
  }
};

const text = (value, limit) => clipText(typeof value === "string" ? value : "", limit);

// The answer as rows to store: { topics: [{ key, name, category, what }],
// places: [{ thing, topicKey, role, what }] }. A topic named without being
// defined is defined from its first member; an item left out is "in no topic".
const readAnswer = (raw, batch, known) => {
  const topics = new Map();
  for (const entry of Array.isArray(raw?.topics) ? raw.topics : []) {
    const name = text(entry?.name, 60);
    const key = nameKey(name);
    if (key !== "" && !known.has(key) && !topics.has(key)) {
      topics.set(key, { key, name, category: CATEGORY_SET.has(entry?.category) ? entry.category : "other", what: text(entry?.what, TOPIC_WHAT_CHARS) });
    }
  }
  const answered = new Map();
  for (const item of raw.items) {
    const index = Number(item?.i) - 1;
    if (Number.isInteger(index) && index >= 0 && index < batch.length && !answered.has(index)) {
      answered.set(index, item);
    }
  }
  const places = batch.map((thing, index) => {
    const item = answered.get(index);
    const name = text(item?.topic, 60);
    const topicKey = nameKey(name);
    if (topicKey !== "" && !known.has(topicKey) && !topics.has(topicKey)) {
      topics.set(topicKey, { key: topicKey, name, category: CATEGORY_OF_KIND[thing.kind] ?? "other", what: "" });
    }
    return { thing, topicKey, role: ROLE_SET.has(item?.role) ? item.role : "other", what: text(item?.what, WHAT_CHARS) };
  });
  return { topics: [...topics.values()], places };
};

const saveAnswer = (db, { topics, places, model, nowUnix }) => {
  const insertTopic = db.prepare("INSERT OR IGNORE INTO kb_topics (topic_key, name, category, what, model, made_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insertMember = db.prepare("INSERT OR REPLACE INTO kb_topic_members (thing_key, topic_key, role, what, model, checked_at) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    topics.forEach((topic) => insertTopic.run(topic.key, topic.name, topic.category, topic.what, model, nowUnix));
    for (const place of places) {
      place.thing.keys.forEach((key) => insertMember.run(key, place.topicKey, place.role, place.what, model, nowUnix));
    }
  })();
};

// Topics in the prompt, those with the most members first.
const listedTopics = (topics, memberCount) => [...topics.values()]
  .sort((left, right) => (memberCount.get(right.key) ?? 0) - (memberCount.get(left.key) ?? 0) || left.name.localeCompare(right.name))
  .slice(0, MAX_LISTED_TOPICS);

const inBatches = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));

// Never asked (no name of it has a row), or only failed answers older than a day.
const askAgain = (thing, members, nowUnix) => {
  const rows = thing.keys.map((key) => members.get(key)).filter(Boolean);
  if (rows.length === 0) {
    return "new";
  }
  return rows.every((row) => row.failed && nowUnix - row.checkedAt >= RETRY_FAILED_SECONDS) ? "retry" : null;
};

// Places every thing not placed yet, ITEMS_PER_CALL at a time, heaviest first;
// the first batch alone while there are no topics, so the main topics are
// named once. gate() as in things_aliases; onProgress(outcome) after each call.
const runTopicPass = async (db, { things, callLlm, client, model, gate, nowUnix, onProgress = () => {} }) => {
  const { topics, members } = loadTopics(db);
  const heaviestFirst = [...things].sort((left, right) => weightOf(right) - weightOf(left));
  const fresh = heaviestFirst.filter((thing) => askAgain(thing, members, nowUnix) === "new");
  const retry = heaviestFirst.filter((thing) => askAgain(thing, members, nowUnix) === "retry");
  const batches = [...inBatches(fresh, ITEMS_PER_CALL), ...inBatches(retry, RETRY_BATCH)];
  const todo = [...fresh, ...retry];
  const memberCount = new Map();
  for (const place of members.values()) {
    memberCount.set(place.topicKey, (memberCount.get(place.topicKey) ?? 0) + 1);
  }
  const outcome = { calls: 0, placed: 0, topics: 0, failed: 0, pending: batches.length, todo: todo.length, done: 0, stoppedBy: null };
  const runBatch = async (batch) => {
    try {
      const raw = await callLlm(
        client,
        () => ({ system: SYSTEM_PROMPT, user: buildTopicPrompt(batch, listedTopics(topics, memberCount)), maxTokens: MAX_TOKENS, temperature: 0 }),
        { purpose: "notes-topics", messages: 0, validate: validateTopics },
      );
      const answer = readAnswer(raw, batch, topics);
      saveAnswer(db, { ...answer, model: model(), nowUnix });
      answer.topics.forEach((topic) => topics.set(topic.key, topic));
      answer.places.forEach((place) => memberCount.set(place.topicKey, (memberCount.get(place.topicKey) ?? 0) + 1));
      outcome.calls += 1;
      outcome.placed += answer.places.filter((place) => place.topicKey !== "").length;
      outcome.topics += answer.topics.length;
    } catch (error) {
      outcome.failed += 1;
      outcome.error = String(error.message).slice(0, 200);
      if (shouldFallBack(error)) {
        // The provider is down: the rest would fail the same way.
        outcome.stoppedBy = outcome.stoppedBy ?? "provider-down";
        return;
      }
      // An answer the AI cannot give counts as "in no topic", so the batch is
      // not asked first again on every refresh; the user can place it by hand.
      saveAnswer(db, { topics: [], places: batch.map((thing) => ({ thing, topicKey: "", role: "other", what: "" })), model: FAILED_MODEL, nowUnix });
    }
    outcome.pending -= 1;
    outcome.done += batch.length;
    try {
      onProgress({ ...outcome });
    } catch {
      // Only the card's progress line; the pass goes on.
    }
  };
  let next = 0;
  const takeOne = async () => {
    const blocked = gate();
    if (blocked) {
      outcome.stoppedBy = blocked;
      return;
    }
    const batch = batches[next];
    next += 1;
    await runBatch(batch);
  };
  const lane = async () => {
    while (next < batches.length && outcome.stoppedBy === null) {
      await takeOne();
    }
  };
  if (topics.size === 0 && batches.length > 0) {
    await takeOne();
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, lane));
  return outcome;
};

module.exports = {
  CATEGORIES,
  ROLES,
  ITEMS_PER_CALL,
  ensureTopicSchema,
  loadTopics,
  placeThings,
  buildTopics,
  isNotable,
  isHeavy,
  consensusKey,
  consensusSubject,
  buildTopicPrompt,
  readAnswer,
  runTopicPass,
};
