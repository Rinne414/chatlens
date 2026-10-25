"use strict";

// 笔记库: what the user decided in Obsidian about the topics. A topic note's
// aliases are its other names: a name the user adds there is put under that
// topic, and a name ChatLens wrote there that the user takes out leaves it --
// whatever the AI said. Kept in the manifest, so it holds on every later sync.

const { nameKey } = require("./things_index");
const { readList } = require("./vault_note_io");

// The most used names of the topic itself; more would fill Obsidian's link
// suggestions with every way someone once typed it.
const MAX_ALIASES = 6;

const sameSet = (left, right) => left.length === right.length && left.every((item) => right.includes(item));

const topicKeyOf = (id) => id.slice("topic:".length);

// name key -> topic key ('' = in no topic). A note whose aliases differ from
// what ChatLens last wrote -- or was about to write when a sync stopped half
// way (manifest.pending) -- was edited by the user.
const readPins = (notes, manifest) => {
  const pins = { ...manifest.topicPins };
  for (const [id, note] of notes) {
    const record = manifest.topics[id];
    if (!id.startsWith("topic:") || record === undefined) {
      continue;
    }
    const current = readList(note.blocks, "aliases") ?? [];
    const pending = manifest.pending?.[id];
    if (sameSet(current, record.aliases) || (Array.isArray(pending) && sameSet(current, pending))) {
      continue;
    }
    const written = new Set(record.aliases.map(nameKey).filter(Boolean));
    const now = new Set(current.map(nameKey).filter(Boolean));
    now.forEach((key) => {
      if (!written.has(key)) {
        pins[key] = topicKeyOf(id);
      }
    });
    written.forEach((key) => {
      if (!now.has(key) && key !== nameKey(record.name)) {
        pins[key] = "";
      }
    });
  }
  return pins;
};

// The topic's other names: the names of the things that are the topic itself
// (not its versions: taking one out of the aliases takes it out of the topic),
// busiest first, each written out ("Krea2", not "krea2"); a name that came up
// in one stretch of chat only ("Comfy-Org/MOSS-Image 模型下载页") is no name of
// it. Then the user's own extra aliases as they wrote them.
const MIN_ALIAS_CHUNKS = 2;
const aliasesFor = (topic, display, userAliases) => {
  const seen = new Set([nameKey(display), nameKey(topic.name)]);
  const aliases = [];
  for (const thing of topic.members.filter((member) => member.role === "main").map((member) => member.thing)
    .filter((thing) => thing.chunkCount >= MIN_ALIAS_CHUNKS)
    .sort((left, right) => right.mentions.length - left.mentions.length)) {
    const key = nameKey(thing.name);
    if (aliases.length < MAX_ALIASES && !seen.has(key)) {
      seen.add(key);
      aliases.push(thing.name);
    }
  }
  const ownName = topic.name !== display ? [topic.name] : [];
  return [...ownName, ...aliases, ...userAliases.filter((alias) => alias !== display && alias !== topic.name && !aliases.includes(alias))];
};

module.exports = { readPins, aliasesFor, topicKeyOf };
