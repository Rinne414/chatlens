"use strict";

// 笔记库: notes ChatLens no longer writes -- the thing notes from before
// topics (thing:...), a topic folded into another, the old 事物.base. One the
// user never touched goes to the vault's .trash (Obsidian's trash folder, so
// it can be moved back); one with their words stays and points at the topic
// that has its content now. Also what the user decided in those old notes
// (aliases they edited) carried over to the topics, and stable ids for the
// topics that are a single thing nobody placed yet.

const path = require("node:path");
const fs = require("node:fs");
const { readList, readFlag, userSectionOf, USER_HEADINGS } = require("./vault_note_io");
const { nameKey } = require("./things_index");
const { isNotable } = require("./things_topics");
const { BASE_MARKER } = require("./vault_pages");
const files = require("./vault_files");

// Every frontmatter key ChatLens has written in any of its notes.
const OWN_KEYS = new Set(["chatlens", "type", "kind", "category", "summary", "aliases", "items", "mentions", "mentions_7d", "group_count",
  "groups", "first_seen", "last_seen", "source", "has_source", "consensus", "date", "messages", "thing_count", "topic_count", "first_day",
  "last_day", "updated"]);

// More than this share of the topic, day and group notes retiring at once is
// not a change in the chat but a store that came back empty or swapped.
const MAX_RETIRED_SHARE = 0.5;
const MIN_NOTES_FOR_GUARD = 20;

const topicId = (topic) => `topic:${topic.key}`;

const writtenAliasesOf = (manifest, id) => manifest.things?.[id]?.aliases ?? manifest.topics[id]?.aliases;

const sameAliases = (aliases, written) => aliases.length === written.length && aliases.every((alias) => written.includes(alias));

// Nothing of the user's in it: the 我的笔记 section is just the heading, no
// property of their own, the aliases are the ones ChatLens wrote.
const isUntouched = (note, writtenAliases) => {
  const section = userSectionOf(note.text);
  const ownWords = section === null ? null : USER_HEADINGS.reduce((text, heading) => text.replace(heading, ""), section).trim();
  const aliases = readList(note.blocks, "aliases") ?? [];
  return ownWords === "" && note.blocks.every((block) => block.key === "" || OWN_KEYS.has(block.key))
    && (writtenAliases === undefined || sameAliases(aliases, writtenAliases));
};

// The topic that now holds what a retired note was about.
const intoTopic = (id, topics) => {
  const key = id.replace(/^topic:/u, "").replace(/^thing:/u, "").replace(/~\d+$/u, "");
  return topics.find((topic) => topic.key === key || topic.key === `thing:${key}` || topic.keys.includes(key)) ?? null;
};

// The ids that get a note this time.
const plannedIds = ({ topics, groups, days, deleted }) => new Set([
  ...topics.filter(isNotable).map(topicId),
  ...groups.map((group) => `group:${group.groupId}`),
  ...days.map((entry) => `day:${entry.day}`),
].filter((id) => !deleted.has(id)));

// Notes not planned this time. Left as they are: ignore: true, taken over by
// the user (no 我的笔记 heading), and ones ChatLens moved to .trash that the
// user has moved back.
const retiredNotes = (notes, planned, manifest) => {
  const restored = new Set(manifest.trashed ?? []);
  return [...notes].filter(([id, note]) => !planned.has(id) && id !== "overview" && !restored.has(id)
    && !readFlag(note.blocks, "ignore") && userSectionOf(note.text) !== null);
};

// Whether so many of the topic, day and group notes would retire that the
// store, not the chat, has changed; then none of them is moved this time.
const tooManyRetiring = (notes, retired) => {
  const own = [...notes.keys()].filter((id) => /^(topic|day|group):/u.test(id)).length;
  const leaving = retired.filter(([id]) => /^(topic|day|group):/u.test(id)).length;
  return own >= MIN_NOTES_FOR_GUARD && leaving > own * MAX_RETIRED_SHARE;
};

const reportError = (errors, relPath, error, limit) => {
  if (errors.length < limit) {
    errors.push(`${relPath}：${error.message}`);
  }
};

// The retired notes the user never touched go to .trash -- judged on the file
// as it is right before the move, not on the scan from the start of the sync.
// Run before the new notes get paths (a topic may take its old file name).
// Returns the ids moved.
const trashUntouched = ({ retired, notes, manifest, settings, root, counts, errors, maxErrors }) => {
  const trashed = new Set();
  if (tooManyRetiring(notes, retired)) {
    errors.push(`这次有 ${retired.length} 则笔记不再生成，比平常多太多，先没有移动；如果是换了数据，下次同步会照常处理。`);
    return trashed;
  }
  for (const [id, scanned] of retired) {
    try {
      const note = files.readNote(root, scanned.relPath);
      if (note.id !== id || !isUntouched(note, writtenAliasesOf(manifest, id))) {
        continue;
      }
      files.moveToTrash(settings.vaultPath, root, note.relPath);
      trashed.add(id);
      counts.retired += 1;
    } catch (error) {
      counts.failed += 1;
      reportError(errors, scanned.relPath, error, maxErrors);
    }
  }
  files.removeEmptyDirs(root, retired.filter(([id]) => trashed.has(id)).map(([, note]) => path.posix.dirname(note.relPath)).filter((dir) => dir !== "."));
  return trashed;
};

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// The table of the things from before topics, to .trash while it is still
// ChatLens's -- or still shows the old things folder: Obsidian rewrites a
// .base (dropping the marker) as soon as a column is resized, and a table of
// a folder that is now empty is only clutter.
const retireOldBase = ({ settings, root, manifest, basePath, p, counts, errors, maxErrors }) => {
  const oldPath = manifest.basePath ?? (manifest.baseHash === undefined ? null : `${p("事物")}.base`);
  if (oldPath === null || oldPath === basePath) {
    return;
  }
  const current = readText(files.insideRoot(root, oldPath));
  const oldFolder = `file.inFolder(${JSON.stringify(`${settings.folder}/${p("事物")}`)})`;
  if (current !== null && (files.sha1(current) === manifest.baseHash || current.startsWith(BASE_MARKER) || current.includes(oldFolder))) {
    try {
      files.moveToTrash(settings.vaultPath, root, oldPath);
      counts.retired += 1;
    } catch (error) {
      counts.failed += 1;
      reportError(errors, oldPath, error, maxErrors);
    }
  }
};

/* ---------- decisions made in the notes from before topics ---------- */

// Names the user added to a thing note's aliases, and the groups of names
// they merged there (manifest.userGroups), go to the topic that holds that
// thing now -- as if added to the topic note. Only names not pinned already.
const legacyPins = ({ notes, manifest, topics, pins }) => {
  const extra = {};
  const pin = (keys, topic) => keys.filter((key) => key !== "" && pins[key] === undefined && extra[key] === undefined)
    .forEach((key) => {
      extra[key] = topic.key;
    });
  for (const [id, note] of notes) {
    const record = manifest.things?.[id];
    const topic = record === undefined ? null : intoTopic(id, topics);
    if (topic !== null) {
      const current = readList(note.blocks, "aliases") ?? [];
      pin(current.filter((alias) => !record.aliases.includes(alias)).map(nameKey), topic);
    }
  }
  for (const decision of Object.values(manifest.userGroups ?? {})) {
    const topic = topics.find((entry) => decision.keys.some((key) => entry.keys.includes(key))) ?? null;
    if (topic !== null) {
      pin(decision.keys, topic);
    }
  }
  return extra;
};

/* ---------- stable notes for single things ---------- */

// A heavy thing nobody placed yet is a topic of its own, keyed by its most
// used name -- which changes as people type it differently. It keeps the note
// one of its names already has instead of moving to a new file each time.
const stableTopics = (topics, knownIds) => {
  const used = new Set();
  return topics.map((topic) => {
    if (!topic.key.startsWith("thing:")) {
      return topic;
    }
    const kept = topic.keys.map((key) => `thing:${key}`).find((key) => knownIds.has(`topic:${key}`) && !used.has(key)) ?? topic.key;
    used.add(kept);
    return kept === topic.key ? topic : { ...topic, key: kept };
  });
};

module.exports = {
  OWN_KEYS,
  topicId,
  isUntouched,
  intoTopic,
  plannedIds,
  retiredNotes,
  tooManyRetiring,
  trashUntouched,
  retireOldBase,
  legacyPins,
  stableTopics,
};
