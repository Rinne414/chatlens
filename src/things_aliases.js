"use strict";

// 笔记库: which differently written names are one thing ("k2" and "Krea2",
// "qwen2.1" and "Qwen Image 2.1", "H3" and "MiniMax H3"). Spelling noise is
// merged by the name key alone (src/things_index.js). Here, pairs of names
// whose spelling makes them possibly the same are found by rule, and the AI
// only judges those pairs, each once: asked to group hundreds of names freely,
// it merged different products (Claude Code with the Agent SDK). The user's
// own aliases in Obsidian always win over these (things_index groupKeys).

const { clipText } = require("./things_index");
const { shouldFallBack } = require("./llm_summarizer");

const SCHEMA = `CREATE TABLE IF NOT EXISTS kb_alias_pairs (
  left_key TEXT NOT NULL,
  right_key TEXT NOT NULL,
  same INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (left_key, right_key)
)`;

// Models with models, tools with tools ...: a model and a tool sharing a word
// are rarely the same thing.
const FAMILIES = [["model"], ["tool"], ["resource", "tutorial"], ["news", "event", "other"]];
const PAIRS_PER_CALL = 40;
const DETAIL_CHARS = 60;
const MAX_TOKENS = 1500;
const MIN_PREFIX = 3;
const MAX_ABBREVIATION = 6;
// Words that say what kind of thing it is, not which one.
const GENERIC_WORDS = new Set([
  "ai", "comfyui", "lora", "model", "image", "img", "video", "app", "api", "web", "pro", "plus", "max", "mini", "lite", "new",
  "turbo", "base", "agent", "v1", "v2", "v3", "github", "bilibili", "pixiv", "arxiv", "civitai", "huggingface", "x",
  "b站", "模型", "工具", "插件", "教程", "视频", "新版", "版本", "节点", "工作流", "作品", "的",
]);

const SYSTEM_PROMPT = "你帮一个群聊知识库判断两个名字是不是同一个东西。只输出合法 JSON。";

const ensureAliasSchema = (db) => {
  db.prepare(SCHEMA).run();
  return db;
};

const pairId = (left, right) => (left < right ? `${left}|${right}` : `${right}|${left}`);

const judgedPairs = (db) => new Map(ensureAliasSchema(db).prepare("SELECT left_key AS left, right_key AS right, same FROM kb_alias_pairs").all()
  .map((row) => [pairId(row.left, row.right), row.same === 1]));

// A name that is the only link between things judged the same as it is
// ambiguous: "k3" was judged both Kimi K3 and Krea 3, "Moss Image Turbo LoRA"
// the same as a dozen different LoRAs. Without it, its neighbours fall apart,
// so none of its edges are used. "krea2" stays: k2, kr2 and "Krea2 / K2" are
// linked to each other as well. A missed merge is a duplicate note the user
// can merge in Obsidian; a wrong one mixes two things' chat into one note.
const isBridge = (key, neighbors) => {
  const around = neighbors.get(key);
  if (around.length < 2) {
    return false;
  }
  const seen = new Set([key, around[0]]);
  const queue = [around[0]];
  while (queue.length > 0) {
    for (const next of neighbors.get(queue.shift())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return around.some((neighbor) => !seen.has(neighbor));
};

const aliasEdges = (db) => {
  const edges = [...judgedPairs(db)].filter(([, same]) => same).map(([id]) => id.split("|"));
  const neighbors = new Map();
  for (const [left, right] of edges) {
    neighbors.set(left, [...(neighbors.get(left) ?? []), right]);
    neighbors.set(right, [...(neighbors.get(right) ?? []), left]);
  }
  const bridges = new Set([...neighbors.keys()].filter((key) => isBridge(key, neighbors)));
  return edges.filter((edge) => !edge.some((key) => bridges.has(key)));
};

/* ---------- candidate pairs ---------- */

const familyOf = (kind) => FAMILIES.findIndex((family) => family.includes(kind));

const wordsOf = (name) => String(name ?? "").normalize("NFKC").toLowerCase()
  .split(/[\s\-_.·・,，、/\\|:：;；'"“”‘’()（）[\]【】{}<>《》!！?？~～`^*&@$%=]+|(?<=\p{Script=Han})(?=[a-z0-9])|(?<=[a-z0-9])(?=\p{Script=Han})/u)
  .filter((word) => word.length >= 2 && !/^\d+$/u.test(word) && !GENERIC_WORDS.has(word));

const isSubsequence = (short, long) => {
  let position = 0;
  for (const char of long) {
    if (char === short[position]) {
      position += 1;
    }
  }
  return position === short.length;
};

const trailingDigits = (key) => /\d+$/u.exec(key)?.[0] ?? "";

// A short form: a few letters (nai, dsh) or ending in its number (k2, n45);
// "moss" is a word, not a short form of "MiaoMiao Harem MOSS".
const MAX_LETTER_SHORT_FORM = 3;
const isShortForm = (key) => key.length <= MAX_ABBREVIATION && (key.length <= MAX_LETTER_SHORT_FORM || /\d$/u.test(key));

// Could two name keys be one thing? A short form of the other (k2 / krea2:
// same first and last character, in order), or the same start and the same
// version number (qwen21 / qwenimage21).
const keysMayMatch = (left, right) => {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short === long || short.length < 2) {
    return false;
  }
  if (isShortForm(short) && short[0] === long[0] && short.at(-1) === long.at(-1) && isSubsequence(short, long)) {
    return true;
  }
  const digits = trailingDigits(short);
  return digits !== "" && digits === trailingDigits(long) && short.slice(0, MIN_PREFIX) === long.slice(0, MIN_PREFIX);
};

// One name is the other plus at most one word ("MiniMax H3" holds "H3";
// "orangeo style moss" is not "Moss"). a, b: the two things' word sets.
const MAX_EXTRA_WORDS = 1;
const wordsContain = (a, b) => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return small.size > 0 && large.size - small.size <= MAX_EXTRA_WORDS && [...small].every((word) => large.has(word));
};

// Only a size or a version ("29b", "2.1") names nothing by itself.
const isBareNumber = (thing) => thing.keys.every((key) => /^\d+[a-z]?$/u.test(key));

const mayBeSame = (left, right, words) => !isBareNumber(left) && !isBareNumber(right)
  && (wordsContain(words.get(left), words.get(right)) || left.keys.some((a) => right.keys.some((b) => keysMayMatch(a, b))));

// Pairs of things not judged yet (by any of their keys) that could be one.
const candidatePairs = (things, judged) => {
  const isJudged = (left, right) => left.keys.some((a) => right.keys.some((b) => judged.has(pairId(a, b))));
  // Each thing's words once, not once per pair (1.5k things took seconds).
  const words = new Map(things.map((thing) => [thing, new Set(thing.names.flatMap(wordsOf))]));
  const pairs = [];
  FAMILIES.forEach((_, familyIndex) => {
    const family = things.filter((thing) => familyOf(thing.kind) === familyIndex);
    for (let i = 0; i < family.length; i += 1) {
      for (let j = i + 1; j < family.length; j += 1) {
        if (mayBeSame(family[i], family[j], words) && !isJudged(family[i], family[j])) {
          pairs.push([family[i], family[j]]);
        }
      }
    }
  });
  return pairs;
};

/* ---------- the call ---------- */

const side = (thing) => `${thing.names.slice(0, 3).join(" / ")}（${clipText(thing.mentions[0]?.detail, DETAIL_CHARS) || "没有说明"}）`;

const buildAliasPrompt = (pairs) => [
  "下面每行是一对名字，各带一句群里的说明。判断哪几对是同一个东西：",
  "- 算同一个：简称或昵称（K2 = Krea 2）、中英文名、写法不同、同一个模型的官方发布形式（Base/SFT、raw/turbo、fp8/int8 量化版）。",
  "- 不算：版本号不同（Qwen Image 2.0 和 2.1、Opus 5 和 Opus 5.5）；同一家公司或同一系列的不同产品（Claude Code 和 Claude Agent SDK）；",
  "  给某个模型做的 LoRA、插件、节点、工作流、微调版、整合包（「XX 风格 LoRA for Moss」不是 Moss）；两个不同的 LoRA 或作品；只是名字里有同一个词；",
  "  一个简称在群里可能指好几个不同的东西（K3 既可能是 Kimi K3 也可能是 Krea 3）。",
  "拿不准的不算。输出：{\"same\": [\"p3\", \"p7\"]}，没有就输出 {\"same\": []}。",
  "",
  ...pairs.map(([left, right], index) => `p${index + 1} | ${side(left)} | ${side(right)}`),
].join("\n");

const validateAliases = (raw) => {
  if (!Array.isArray(raw?.same)) {
    throw new Error("Invalid LLM JSON. Required array is missing: same");
  }
};

const sameIndexes = (raw, count) => new Set((Array.isArray(raw?.same) ? raw.same : [])
  .map((id) => Number(/^p(\d+)$/u.exec(String(id ?? "").trim())?.[1]) - 1)
  .filter((index) => Number.isInteger(index) && index >= 0 && index < count));

const saveJudgements = (db, { pairs, same, model, nowUnix }) => {
  const insert = db.prepare("INSERT OR REPLACE INTO kb_alias_pairs (left_key, right_key, same, model, checked_at) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => pairs.forEach(([left, right], index) => insert.run(left.anchor, right.anchor, same.has(index) ? 1 : 0, model, nowUnix)))();
};

// Judges every candidate pair not judged yet, PAIRS_PER_CALL at a time; gate()
// returns a reason to stop (pause, call cap, money budget, per-run cap) or null.
const runAliasPass = async (db, { things, callLlm, client, model, gate, nowUnix }) => {
  ensureAliasSchema(db);
  const pairs = candidatePairs(things, judgedPairs(db));
  const outcome = { calls: 0, edges: 0, pending: Math.ceil(pairs.length / PAIRS_PER_CALL), stoppedBy: null, failed: 0 };
  for (let start = 0; start < pairs.length; start += PAIRS_PER_CALL) {
    const blocked = gate();
    if (blocked) {
      outcome.stoppedBy = blocked;
      break;
    }
    const batch = pairs.slice(start, start + PAIRS_PER_CALL);
    try {
      const raw = await callLlm(
        client,
        () => ({ system: SYSTEM_PROMPT, user: buildAliasPrompt(batch), maxTokens: MAX_TOKENS, temperature: 0 }),
        { purpose: "notes-aliases", messages: 0, validate: validateAliases },
      );
      const same = sameIndexes(raw, batch.length);
      saveJudgements(db, { pairs: batch, same, model: model(), nowUnix });
      outcome.calls += 1;
      outcome.edges += same.size;
    } catch (error) {
      outcome.failed += 1;
      outcome.error = String(error.message).slice(0, 200);
      if (shouldFallBack(error)) {
        // The provider is down: the rest would fail the same way.
        break;
      }
      // A batch the AI cannot answer counts as "not the same", so it is not
      // asked first again on every refresh; a missed merge can be made by hand.
      saveJudgements(db, { pairs: batch, same: new Set(), model: "failed", nowUnix });
    }
    outcome.pending -= 1;
  }
  return outcome;
};

module.exports = {
  ensureAliasSchema,
  aliasEdges,
  judgedPairs,
  keysMayMatch,
  wordsOf,
  candidatePairs,
  buildAliasPrompt,
  sameIndexes,
  runAliasPass,
  PAIRS_PER_CALL,
};
