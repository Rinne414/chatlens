"use strict";

// 笔记库: every model, tool, resource, piece of news ... the AI noticed in the
// cached chunk summaries ("newThings"), merged across chunks, groups and
// spellings into one thing each, with the answered questions that mention it.
// Reads the store only; nothing here calls the LLM. Pure functions below the
// first section, so the merge rules are tested without a database.

const { hktToUnix } = require("./review_store");

/* ---------- reading the store ---------- */

const parsePartial = (json) => {
  try {
    const value = JSON.parse(json);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

// Every summarized chunk, oldest first, with its parsed summary.
const readChunks = (db) => db.prepare(`
  SELECT chunk_id AS chunkId, group_id AS groupId, start_sent_at AS startAt, end_sent_at AS endAt,
         message_count AS messageCount, partial_json AS json
  FROM summary_chunks WHERE status = 'done' AND partial_json IS NOT NULL
  ORDER BY start_sent_at, chunk_id
`).all()
  .map(({ json, ...chunk }) => ({ ...chunk, partial: parsePartial(json) }))
  .filter((chunk) => chunk.partial !== null);

const readGroupNames = (db) => new Map(db.prepare("SELECT group_id AS groupId, name FROM group_names").all()
  .map((row) => [row.groupId, row.name || row.groupId]));

/* ---------- names and links ---------- */

// Separators and punctuation do not make a different name ("Krea 2" = "krea2");
// + and # stay, or C++ and C# would collapse into C.
const NAME_NOISE = /[\s\-_.·・,，、/\\|:：;；'"“”‘’()（）[\]【】{}<>《》!！?？~～`^*&@$%=]+/gu;

const nameKey = (name) => String(name ?? "").normalize("NFKC").toLowerCase().replace(NAME_NOISE, "");

// How many path segments identify one thing on a site: github.com/owner/repo,
// huggingface.co/owner/model, civitai.com/models/123 ... Elsewhere the whole path.
const SITE_SEGMENTS = new Map([
  ["github.com", 2],
  ["huggingface.co", 2],
  ["modelscope.cn", 3],
  ["civitai.com", 2],
  ["civitai.red", 2],
  ["bilibili.com", 2],
  ["x.com", 3],
  ["twitter.com", 3],
]);
const HF_NESTED = new Set(["spaces", "datasets"]);
// Only where one link is one project does a shared link mean the same thing:
// a video or post often covers several things at once (one Bilibili news video
// was the "link" of Gemini 4 Argon, Claude Fable 5.5 and a desktop app).
// And only a full project address: github.com/kijai (a person) or
// huggingface.co/Qwen (an organisation) joined everything they made.
const GITHUB_RESERVED = new Set(["topics", "orgs", "features", "marketplace", "settings", "sponsors", "collections", "trending",
  "explore", "search", "apps", "login", "about", "pricing", "enterprise", "issues", "pulls", "notifications", "users", "site", "events"]);
const HF_RESERVED = new Set(["models", "datasets", "spaces", "docs", "papers", "blog", "collections", "organizations", "tasks",
  "settings", "learn", "pricing", "posts", "chat", "join", "login"]);
const isProjectLink = (key) => {
  const [host, ...parts] = key.split("/");
  if (host === "github.com") {
    return parts.length === 2 && !GITHUB_RESERVED.has(parts[0]);
  }
  if (host === "huggingface.co") {
    return (parts.length === 2 && !HF_RESERVED.has(parts[0])) || (parts.length === 3 && HF_NESTED.has(parts[0]));
  }
  if (host === "modelscope.cn") {
    return parts.length === 3 && parts[0] === "models";
  }
  if (host === "civitai.com" || host === "civitai.red") {
    return parts.length === 2 && parts[0] === "models" && /^\d+$/u.test(parts[1]);
  }
  return false;
};

// A link the AI put on several different names in one stretch of chat is the
// source they were all mentioned with, not the name of one of them.
const mergingLinks = (mentions) => {
  const byLink = new Map();
  for (const mention of mentions.filter((item) => item.linkKey !== "" && isProjectLink(item.linkKey))) {
    const chunks = byLink.get(mention.linkKey) ?? new Map();
    chunks.set(mention.chunkId, (chunks.get(mention.chunkId) ?? new Set()).add(mention.key));
    byLink.set(mention.linkKey, chunks);
  }
  return new Set([...byLink].filter(([, chunks]) => [...chunks.values()].every((keys) => keys.size === 1)).map(([link]) => link));
};

// host/path for telling links apart, or "" when the link names no single thing
// (a bare site, an unparseable string).
const linkKey = (url) => {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return "";
  }
  if (!/^https?:$/u.test(parsed.protocol)) {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./u, "");
  let segments = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponentSafe(part).toLowerCase());
  const limit = SITE_SEGMENTS.get(host);
  if (limit !== undefined) {
    const nested = host === "huggingface.co" && HF_NESTED.has(segments[0]) ? 1 : 0;
    segments = segments.slice(0, limit + nested);
  }
  const video = host.endsWith("youtube.com") ? parsed.searchParams.get("v") : null;
  if (video) {
    segments = ["watch", video];
  }
  return segments.length === 0 ? "" : `${host}/${segments.join("/")}`;
};

function decodeURIComponentSafe(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/* ---------- mentions and answers ---------- */

const KINDS = ["model", "tool", "resource", "news", "tutorial", "event", "other"];
const KIND_SET = new Set(KINDS);
const TIME_SLACK_SECONDS = 3600;

// The item's own time when the AI gave a believable one, else the chunk start.
const itemTime = (text, chunk) => {
  const at = hktToUnix(text);
  return at !== null && at >= chunk.startAt - TIME_SLACK_SECONDS && at <= chunk.endAt + TIME_SLACK_SECONDS ? at : chunk.startAt;
};

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

// At most `limit` characters on one line, cut between characters, never inside
// one: half an emoji (a lone surrogate) made a provider reject the whole
// request ("unexpected end of hex escape").
const clipText = (value, limit) => {
  const chars = Array.from(String(value ?? "").replace(/\s+/gu, " ").trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
};

const collectMentions = (chunks) => chunks.flatMap((chunk) => (Array.isArray(chunk.partial.newThings) ? chunk.partial.newThings : [])
  .map((item, index) => {
    const name = cleanText(item?.name);
    const link = cleanText(item?.link);
    return {
      chunkId: chunk.chunkId,
      index,
      groupId: chunk.groupId,
      sentAt: itemTime(item?.hkt, chunk),
      kind: KIND_SET.has(item?.kind) ? item.kind : "other",
      name,
      key: nameKey(name),
      detail: cleanText(item?.detail),
      link,
      linkKey: linkKey(link),
      speaker: cleanText(item?.speaker),
    };
  })
  .filter((mention) => mention.key.length > 0));

// Answered questions only: an open question is not knowledge yet.
const collectAnswers = (chunks) => chunks.flatMap((chunk) => (Array.isArray(chunk.partial.qa) ? chunk.partial.qa : [])
  .map((item, index) => ({
    chunkId: chunk.chunkId,
    index,
    groupId: chunk.groupId,
    sentAt: itemTime(item?.hkt, chunk),
    question: cleanText(item?.question),
    answer: cleanText(item?.answer),
    asker: cleanText(item?.asker),
    answerer: cleanText(item?.answerer),
    resolved: item?.resolved !== false,
  }))
  .filter((item) => item.resolved && item.question.length > 0 && item.answer.length > 0));

/* ---------- merging into things ---------- */

const createSets = () => {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root);
    }
    let node = key;
    while (node !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    if (!parent.has(root)) {
      parent.set(root, root);
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      parent.set(b, a);
    }
    return a;
  };
  return { find, union };
};

// pinned: name key -> the user's own group for it (from the notes' aliases in
// Obsidian). Two different user groups are never joined, whatever the AI or a
// shared link says; a name the user took out of a note is its own group.
const groupKeys = (mentions, { aliasEdges = [], userGroups = [] } = {}) => {
  const sets = createSets();
  const pinned = new Map();
  userGroups.forEach((keys, groupIndex) => {
    const [first, ...rest] = keys;
    for (const key of keys) {
      pinned.set(key, groupIndex);
    }
    rest.forEach((key) => sets.union(first, key));
  });
  const pinsOf = new Map();
  const pinOfRoot = (root) => pinsOf.get(root);
  for (const [key, groupIndex] of pinned) {
    pinsOf.set(sets.find(key), groupIndex);
  }
  const join = (left, right) => {
    const a = sets.find(left);
    const b = sets.find(right);
    if (a === b) {
      return;
    }
    const pinA = pinOfRoot(a);
    const pinB = pinOfRoot(b);
    if (pinA !== undefined && pinB !== undefined && pinA !== pinB) {
      return;
    }
    const root = sets.union(a, b);
    const pin = pinA ?? pinB;
    if (pin !== undefined) {
      pinsOf.set(root, pin);
    }
  };
  for (const mention of mentions) {
    sets.find(mention.key);
  }
  const byLink = new Map();
  const usable = mergingLinks(mentions);
  for (const mention of mentions) {
    if (usable.has(mention.linkKey)) {
      const seen = byLink.get(mention.linkKey);
      if (seen === undefined) {
        byLink.set(mention.linkKey, mention.key);
      } else {
        join(seen, mention.key);
      }
    }
  }
  for (const [left, right] of aliasEdges) {
    join(left, right);
  }
  return sets.find;
};

const countInto = (map, key, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount);

const ranked = (map) => [...map].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));

// The thing's kind: what most mentions say, "other" only when nothing else.
const mainKind = (kinds) => (ranked(kinds).find(([kind]) => kind !== "other") ?? ["other"])[0];

// Chat is typed in lower case ("moss", "krea2"); the written-out form
// ("Moss", "Krea2") names the thing when a fair share of people use it.
const STYLED_SHARE = 4;
const displayName = (rankedNames, anchor) => {
  const spellings = rankedNames.filter(([name]) => nameKey(name) === anchor);
  const top = spellings[0] ?? rankedNames[0];
  const styled = spellings.find(([name, count]) => /\p{Lu}/u.test(name) && count * STYLED_SHARE >= top[1]);
  return (styled ?? top)[0];
};

// The most telling of the latest mentions: the longest of the newest few
// with the thing's own kind (the newest alone is often "someone named it").
const RECENT_FOR_DETAIL = 10;
const bestDetail = (thing) => {
  const recent = thing.mentions.slice(0, RECENT_FOR_DETAIL);
  const sameKind = recent.filter((mention) => mention.kind === thing.kind && mention.detail !== "");
  return [...(sameKind.length > 0 ? sameKind : recent)].sort((left, right) => right.detail.length - left.detail.length)[0] ?? thing.mentions[0];
};

const toThing = (mentions) => {
  const names = new Map();
  const keys = new Map();
  const kinds = new Map();
  const groups = new Map();
  const people = new Map();
  const links = new Map();
  const chunkIds = new Set();
  for (const mention of mentions) {
    countInto(names, mention.name);
    countInto(keys, mention.key);
    countInto(kinds, mention.kind);
    countInto(groups, mention.groupId);
    if (mention.speaker !== "") {
      countInto(people, mention.speaker);
    }
    if (mention.linkKey !== "") {
      const entry = links.get(mention.linkKey) ?? { url: mention.link, count: 0 };
      links.set(mention.linkKey, { ...entry, count: entry.count + 1 });
    }
    chunkIds.add(mention.chunkId);
  }
  const newestFirst = [...mentions].sort((left, right) => right.sentAt - left.sentAt || right.chunkId - left.chunkId || right.index - left.index);
  const anchor = ranked(keys)[0][0];
  return {
    // The most used name key identifies the thing; its written-out spelling names it.
    anchor,
    name: displayName(ranked(names), anchor),
    names: ranked(names).map(([name]) => name),
    keys: ranked(keys).map(([key]) => key),
    kind: mainKind(kinds),
    mentions: newestFirst,
    chunkCount: chunkIds.size,
    groups: ranked(groups).map(([groupId, count]) => ({ groupId, count })),
    people: ranked(people).map(([name, count]) => ({ name, count })),
    links: [...links].sort((left, right) => right[1].count - left[1].count).map(([key, entry]) => ({ key, url: entry.url, count: entry.count })),
    firstAt: newestFirst.at(-1).sentAt,
    lastAt: newestFirst[0].sentAt,
  };
};

const buildThings = (mentions, options = {}) => {
  const rootOf = groupKeys(mentions, options);
  const byRoot = new Map();
  for (const mention of mentions) {
    const root = rootOf(mention.key);
    byRoot.set(root, [...(byRoot.get(root) ?? []), mention]);
  }
  return [...byRoot.values()].map(toThing)
    .sort((left, right) => right.chunkCount - left.chunkCount || right.lastAt - left.lastAt || left.anchor.localeCompare(right.anchor));
};

// Worth its own note: it has a source, or more than one stretch of chat
// brought it up. A lone "other" needs a little more than that.
const isNoteworthy = (thing) => {
  if (thing.links.length > 0) {
    return true;
  }
  return thing.kind === "other" ? thing.chunkCount >= 3 : thing.chunkCount >= 2;
};

/* ---------- answers that mention a thing ---------- */

const ASCII_WORD = /[a-z0-9]/u;
const MIN_KEY_LENGTH = 2;

// A key matches where it is not the middle of a longer latin word or number
// ("h3" in "h3 怎么跑", not in "minimaxh3"). Names made only of digits are too
// ambiguous to match in free text.
const matchableKey = (key) => key.length >= MIN_KEY_LENGTH && !/^\d+$/u.test(key);

const createMatcher = (things) => {
  const byFirst = new Map();
  things.forEach((thing, thingIndex) => {
    for (const key of thing.keys.filter(matchableKey)) {
      const list = byFirst.get(key[0]) ?? [];
      list.push({ key, thingIndex });
      byFirst.set(key[0], list);
    }
  });
  return (text) => {
    const { compact, origin, written } = compactText(text);
    const found = new Set();
    for (let position = 0; position < compact.length; position += 1) {
      for (const { key, thingIndex } of byFirst.get(compact[position]) ?? []) {
        if (!compact.startsWith(key, position)) {
          continue;
        }
        // Word edges are judged on the text as written: "Flux is great" names
        // flux, "fluxdev" does not.
        const before = written[origin[position] - 1] ?? "";
        const after = written[origin[position + key.length - 1] + 1] ?? "";
        const latinEdge = (char, edgeChar) => ASCII_WORD.test(edgeChar) && ASCII_WORD.test(char);
        if (!latinEdge(before, key[0]) && !latinEdge(after, key.at(-1))) {
          found.add(thingIndex);
        }
      }
    }
    return found;
  };
};

const NOISE_CHAR = new RegExp(`^${NAME_NOISE.source.replace(/\+$/u, "")}$`, "u");

// The text as name keys see it (compact), and where each of its characters
// stands in the written text.
const compactText = (text) => {
  const written = Array.from(String(text ?? "").normalize("NFKC").toLowerCase());
  const compact = [];
  const origin = [];
  written.forEach((char, index) => {
    if (!NOISE_CHAR.test(char)) {
      compact.push(char);
      // One entry per UTF-16 unit, as the compact string is indexed by them.
      for (let unit = 0; unit < char.length; unit += 1) {
        origin.push(index);
      }
    }
  });
  return { compact: compact.join(""), origin, written };
};

// thing index -> its answers, newest first.
const answersByThing = (things, answers) => {
  const match = createMatcher(things);
  const result = new Map();
  for (const answer of answers) {
    for (const thingIndex of match(`${answer.question}\n${answer.answer}`)) {
      result.set(thingIndex, [...(result.get(thingIndex) ?? []), answer]);
    }
  }
  for (const [thingIndex, list] of result) {
    result.set(thingIndex, list.sort((left, right) => right.sentAt - left.sentAt));
  }
  return result;
};

module.exports = {
  KINDS,
  readChunks,
  readGroupNames,
  nameKey,
  linkKey,
  clipText,
  collectMentions,
  collectAnswers,
  buildThings,
  isNoteworthy,
  bestDetail,
  createMatcher,
  answersByThing,
};
