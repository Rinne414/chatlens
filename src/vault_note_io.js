"use strict";

// Reading and rewriting one Obsidian note without touching what the user
// wrote. A ChatLens note has three parts:
//   1. frontmatter: the keys ChatLens manages are rewritten; every other key
//      the user added stays exactly as it was (kept line for line);
//   2. the body ChatLens writes, rewritten on every sync;
//   3. "## 我的笔记" (or 我的筆記) and everything after it, never touched.
// The same layout as the notes common GitHub-stars syncs write.

const USER_HEADINGS = ["## 我的筆記", "## 我的笔记"];
// A byte-order mark before the first --- (some editors write one) is allowed.
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
const TOP_LEVEL_KEY = /^([^\s#:-][^:]*?):(?:\s|$)/u;

/* ---------- frontmatter blocks ---------- */

// The frontmatter as top-level blocks { key, lines } (a key line plus its
// indented or "- " continuation lines), and the body after it. A note without
// frontmatter has no blocks.
const splitNote = (text) => {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return { blocks: [], body: text, hasFrontmatter: false };
  }
  const blocks = [];
  for (const line of match[1].split(/\r?\n/u)) {
    const key = TOP_LEVEL_KEY.exec(line);
    if (line.startsWith("#")) {
      // A comment is its own keyless block, so rewriting the key above it keeps it.
      blocks.push({ key: "", lines: [line] });
    } else if (key !== null) {
      blocks.push({ key: key[1].trim(), lines: [line] });
    } else if (blocks.length > 0) {
      blocks.at(-1).lines.push(line);
    } else {
      blocks.push({ key: "", lines: [line] });
    }
  }
  return { blocks, body: text.slice(match[0].length), hasFrontmatter: true };
};

const unquote = (value) => {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  return text;
};

const splitInline = (inner) => {
  const items = [];
  let current = "";
  let quote = null;
  for (const char of inner) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
    } else if (char === "\"" || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== "");
};

const blockOf = (blocks, key) => blocks.find((block) => block.key === key) ?? null;

// A list value in the forms Obsidian and people write: "- item" lines,
// [a, b], or a single scalar.
const readList = (blocks, key) => {
  const block = blockOf(blocks, key);
  if (block === null) {
    return null;
  }
  const inline = block.lines[0].slice(block.lines[0].indexOf(":") + 1).trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return splitInline(inline.slice(1, -1));
  }
  if (inline !== "") {
    return [unquote(inline)];
  }
  return block.lines.slice(1)
    .map((line) => /^\s*-\s+(.*)$/u.exec(line)?.[1])
    .filter((item) => item !== undefined)
    .map(unquote)
    .filter((item) => item !== "");
};

const readScalar = (blocks, key) => {
  const block = blockOf(blocks, key);
  return block === null ? null : unquote(block.lines[0].slice(block.lines[0].indexOf(":") + 1));
};

const readFlag = (blocks, key) => /^(true|yes|on|1)$/iu.test(String(readScalar(blocks, key) ?? ""));

/* ---------- writing frontmatter ---------- */

const PLAIN_SCALAR = /^[\p{L}\p{N}][\p{L}\p{N} ._+()（）·-]*$/u;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/iu;
const NUMBER_LIKE = /^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$/u;

const yamlString = (value) => {
  const text = String(value);
  return PLAIN_SCALAR.test(text) && !RESERVED.test(text) && !NUMBER_LIKE.test(text) && !/\s$/u.test(text)
    ? text
    : JSON.stringify(text);
};

const yamlLines = (key, value) => {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [`${key}:`, ...value.map((item) => `  - ${yamlString(item)}`)];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${key}: ${value}`];
  }
  return value === null || value === undefined || value === "" ? [] : [`${key}: ${yamlString(value)}`];
};

/* ---------- the whole note ---------- */

const userSectionOf = (text) => {
  const positions = USER_HEADINGS.map((heading) => {
    const match = new RegExp(`^${heading}[ \\t]*$`, "mu").exec(text);
    return match === null ? -1 : match.index;
  }).filter((index) => index >= 0);
  return positions.length === 0 ? null : text.slice(Math.min(...positions));
};

// managed: [[key, value]] in display order; body: the generated markdown;
// drop: keys ChatLens wrote in an earlier version and no longer does.
// existingText null = a new note. Returns the full note text.
const composeNote = ({ managed, body, heading, existingText = null, drop = [] }) => {
  const existing = existingText === null ? { blocks: [] } : splitNote(existingText);
  const managedKeys = new Set([...managed.map(([key]) => key), ...drop]);
  const kept = existing.blocks.filter((block) => block.key === "" || !managedKeys.has(block.key)).flatMap((block) => block.lines);
  const frontmatter = [...managed.flatMap(([key, value]) => yamlLines(key, value)), ...kept];
  const section = existingText === null ? null : userSectionOf(existingText);
  return `---\n${frontmatter.join("\n")}\n---\n${body.replace(/\s+$/u, "")}\n\n${section ?? `${heading}\n`}`;
};

/* ---------- text inside markdown ---------- */

// Chat text as plain inline markdown: no accidental tags (#), links ([[),
// math ($), comments (%%), html (<) or emphasis; one line.
const inlineText = (value) => String(value ?? "")
  .replace(/\s+/gu, " ")
  .trim()
  .replace(/[\\`*_[\]#$%<>~=^]/gu, (char) => `\\${char}`);

// Windows and Obsidian both refuse these in a file name; Obsidian also breaks
// links on # ^ [ ] |.
const BAD_FILE_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f]/gu;
const MAX_FILE_STEM = 80;

const safeFileName = (name) => {
  const cleaned = String(name ?? "").replace(BAD_FILE_CHARS, "-").replace(/\s+/gu, " ").replace(/^[-\s]+|[-\s.]+$/gu, "");
  const stem = [...cleaned].slice(0, MAX_FILE_STEM).join("").replace(/[-\s.]+$/u, "");
  return stem === "" ? "未命名" : stem;
};

module.exports = {
  USER_HEADINGS,
  splitNote,
  readList,
  readScalar,
  readFlag,
  yamlString,
  yamlLines,
  userSectionOf,
  composeNote,
  inlineText,
  safeFileName,
};
