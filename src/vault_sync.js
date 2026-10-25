"use strict";

// 笔记库 (Obsidian): writes the knowledge from the store into one folder of
// an Obsidian vault -- a note per topic, per day and per group, an overview
// and a table view -- and reads back what the user decided there (aliases,
// ignore: true, deleted notes). Called after each background refresh and by
// 立即同步; never calls the LLM (src/vault_ai.js does that part).

const fs = require("node:fs");
const path = require("node:path");
const { loadConsensus, consensusOf, MIN_GROUPS } = require("./things_consensus");
const { readList, readFlag, composeNote, safeFileName, userSectionOf } = require("./vault_note_io");
const { renderTopic, renderRetired } = require("./vault_render");
const { renderDay, renderGroup, renderOverview, baseFile, BASE_MARKER } = require("./vault_pages");
const { loadKnowledge, buildDays, buildGroups, coverageOf } = require("./vault_data");
const { readPins, aliasesFor } = require("./vault_identity");
const { isNotable, isHeavy, consensusKey } = require("./things_topics");
const { OWN_KEYS, topicId, intoTopic, plannedIds, retiredNotes, trashUntouched, retireOldBase, legacyPins, stableTopics } = require("./vault_retire");
const { isLlmConfigured } = require("./llm_route");
const files = require("./vault_files");

const DEFAULTS = { enabled: false, vaultPath: "", folder: "ChatLens", language: "zh-Hans", autoSync: true, consensus: true };
const LANGUAGES = new Set(["zh-Hans", "zh-Hant"]);
const MAX_REPORTED_ERRORS = 5;
// Until the AI has placed nearly every thing once, the notes are not
// rearranged: half-sorted topics would be written and moved again an hour later.
const MAX_UNPLACED_SHARE = 0.05;

const notesSettings = (config) => ({ ...DEFAULTS, ...(config?.notes ?? {}) });

let toTraditional = null;
// Prose in the vault's script; the store is Simplified.
const createProse = (language) => {
  if (language !== "zh-Hant") {
    return (text) => String(text ?? "");
  }
  if (toTraditional === null) {
    let opencc;
    try {
      opencc = require("opencc-js/cn2t");
    } catch (error) {
      // A source install updated in place before its launcher installed it.
      if (error.code === "MODULE_NOT_FOUND") {
        throw new Error("写繁体笔记要用到 opencc-js，这台电脑上还没装：在 ChatLens 文件夹里运行一次 npm install，或重开一次 ChatLens。");
      }
      throw error;
    }
    toTraditional = opencc.Converter({ from: "cn", to: "tw" });
  }
  return (text) => toTraditional(String(text ?? ""));
};

/* ---------- planning the files ---------- */

const readVaultState = ({ storeDir, root, settings, nowUnix }) => {
  // A missing folder is a fresh start: nothing in it can have been deleted by hand.
  const folderExists = fs.existsSync(root);
  const loaded = folderExists ? files.loadManifest(storeDir, root) : files.emptyManifest(root);
  const notes = folderExists ? files.scanNotes(root, loaded.written) : new Map();
  // Deleted: written before and gone now, unless the user brought it back.
  // Notes from before topics (thing:...) are never written again anyway.
  const deleted = new Set([...loaded.deleted, ...Object.keys(loaded.written)].filter((id) => !notes.has(id) && !id.startsWith("thing:")));
  const { map: vaultNotes, manifest } = files.vaultUrls(settings.vaultPath, root, loaded, nowUnix);
  return { manifest, notes, deleted, vaultNotes };
};

// Where every note goes and how notes link to each other. Existing notes keep
// their path (the user may have renamed them); new ones get a free name.
const planNotes = ({ root, settings, p, notes, deleted, days, groups, topics }) => {
  const dirs = { topics: p("主题"), days: p("日报"), groups: p("群") };
  const taken = new Set([...notes.values()].map((note) => note.relPath.toLowerCase()));
  const pathOf = (id, dir, stem) => notes.get(id)?.relPath ?? files.freePath(root, dir, safeFileName(stem), taken);
  const target = (relPath) => `${settings.folder}/${relPath.replace(/\.md$/u, "")}`;
  const links = { topic: new Map(), group: new Map(), day: new Map() };
  const plan = [];
  const add = (kind, id, relPath, key, item) => {
    links[kind].set(key, target(relPath));
    plan.push({ kind, id, relPath, item });
  };
  for (const topic of topics.filter((entry) => isNotable(entry) && !deleted.has(topicId(entry)))) {
    add("topic", topicId(topic), pathOf(topicId(topic), dirs.topics, p(topic.name)), topic.key, topic);
  }
  for (const group of groups.filter((entry) => !deleted.has(`group:${entry.groupId}`))) {
    add("group", `group:${group.groupId}`, pathOf(`group:${group.groupId}`, dirs.groups, group.name), group.groupId, group);
  }
  for (const entry of days.filter((day) => !deleted.has(`day:${day.day}`))) {
    add("day", `day:${entry.day}`, pathOf(`day:${entry.day}`, dirs.days, entry.day), entry.day, entry);
  }
  return {
    plan,
    links,
    overviewPath: deleted.has("overview") ? null : pathOf("overview", ".", p("ChatLens 总览")).replace(/^\.\//u, ""),
    basePath: `${dirs.topics}.base`,
    topicsFolder: `${settings.folder}/${dirs.topics}`,
  };
};

/* ---------- writing ---------- */

// Writes one note from what is on disk right now (not the scan from the start
// of the sync: the user may have typed since). Returns written / same / kept /
// failed (also kept in statuses by id); a note the user took over (no 我的笔记
// heading, or another id) is kept.
const createWriter = ({ root, heading, counts, errors, statuses = new Map() }) => (id, relPath, rendered) => {
  let status;
  try {
    const target = files.insideRoot(root, relPath);
    const current = fs.existsSync(target) ? files.readNote(root, relPath) : null;
    if (current !== null && (current.id !== id || userSectionOf(current.text) === null)) {
      status = "kept";
    } else {
      const text = composeNote({ managed: rendered.managed, body: rendered.body, heading, existingText: current?.text ?? null, drop: rendered.drop });
      status = files.writeIfChanged(root, relPath, text);
    }
  } catch (error) {
    status = "failed";
    reportError(errors, relPath, error);
  }
  counts[status] += 1;
  statuses.set(id, status);
  return status;
};

const reportError = (errors, relPath, error) => {
  if (errors.length < MAX_REPORTED_ERRORS) {
    errors.push(`${relPath}：${error.message}`);
  }
};

// The aliases each planned topic note gets, before anything is written: the
// user's own are those on the note that ChatLens did not write there.
const plannedAliases = ({ plan, notes, manifest, ctx }) => Object.fromEntries(plan.filter((item) => item.kind === "topic").map(({ id, item }) => {
  const current = notes.has(id) ? readList(notes.get(id).blocks, "aliases") ?? [] : [];
  const ours = new Set(manifest.topics[id]?.aliases ?? []);
  return [id, aliasesFor(item, ctx.p(item.name), current.filter((alias) => !ours.has(alias)))];
}));

// Renders and writes every planned note; returns the manifest records of the
// topics whose note now holds what ChatLens wrote.
const writePlan = ({ ctx, plan, aliases, knowledge, consensusByKey, vaultNotes, write, counts, isIgnored, nowUnix }) => {
  const records = {};
  for (const { kind, id, relPath, item } of plan) {
    if (isIgnored(id)) {
      counts.ignored += 1;
    } else if (kind === "group") {
      write(id, relPath, renderGroup(ctx, { id, entry: item }));
    } else if (kind === "day") {
      write(id, relPath, renderDay(ctx, { id, entry: item }));
    } else {
      const status = write(id, relPath, renderTopic(ctx, {
        id, topic: item, consensus: consensusOf(consensusByKey, { keys: [consensusKey(item)] }), answers: knowledge.answersOf(item), aliases: aliases[id], vaultNotes, nowUnix,
      }));
      if (status === "written" || status === "same") {
        records[id] = { name: item.name, aliases: aliases[id] };
      }
    }
  }
  return records;
};

// The table view is the user's to change in Obsidian: written again only
// while it is still exactly what ChatLens wrote last time. Returns its hash.
const isOurBase = (current, text, lastHash) => current === null || current === text || files.sha1(current) === lastHash
  || (lastHash === undefined && current.startsWith(BASE_MARKER));

const writeBase = ({ root, basePath, text, lastHash, counts }) => {
  let current = null;
  try {
    current = fs.readFileSync(files.insideRoot(root, basePath), "utf8");
  } catch {
    current = null;
  }
  if (!isOurBase(current, text, lastHash)) {
    counts.kept += 1;
    return lastHash;
  }
  counts[files.writeIfChanged(root, basePath, text)] += 1;
  return files.sha1(text);
};

const buildContext = ({ p, serverUrl, knowledge, layout, isIgnored, consensusByKey }) => ({
  p,
  serverUrl,
  groupNames: knowledge.groupNames,
  groupIdByName: new Map([...knowledge.groupNames].map(([groupId, name]) => [name, groupId])),
  groupTarget: layout.links.group,
  topicTarget: layout.links.topic,
  dayTarget: layout.links.day,
  isIgnored: (topic) => isIgnored(topicId(topic)),
  consensusOf: (topic) => consensusOf(consensusByKey, { keys: [consensusKey(topic)] }),
  consensusMinGroups: MIN_GROUPS,
});

/* ---------- the whole sync ---------- */

// The AI places things into topics for these notes.
const aiForNotes = (settings, config) => settings.consensus && isLlmConfigured(config);

// Whether the notes can be arranged by topic yet: the first time, not before
// the AI has asked about nearly every thing (see MAX_UNPLACED_SHARE). A thing
// it could not answer about counts as asked: a refusal must not hold the notes
// back for good. Without AI for the notes there is nothing to wait for.
const topicsWaiting = ({ settings, config, manifest, knowledge }) => aiForNotes(settings, config) && !manifest.topicsBuilt
  && (knowledge.unplaced.some(isHeavy) || knowledge.unplaced.length > knowledge.things.length * MAX_UNPLACED_SHARE);

// The things arranged into topics with the user's decisions: those made on
// topic notes, and those carried over from the notes from before topics.
const knowledgeWithDecisions = ({ db, notes, manifest }) => {
  const topicPins = readPins(notes, manifest);
  const knowledge = loadKnowledge(db, { pins: new Map(Object.entries(topicPins)) });
  const carried = legacyPins({ notes, manifest, topics: knowledge.topics, pins: topicPins });
  if (Object.keys(carried).length === 0) {
    return { knowledge, topicPins };
  }
  const allPins = { ...topicPins, ...carried };
  return { knowledge: loadKnowledge(db, { pins: new Map(Object.entries(allPins)) }), topicPins: allPins };
};

const syncLocked = ({ db, config, settings, root, storeDir, nowUnix, serverUrl }) => {
  const p = createProse(settings.language);
  const { manifest, notes, deleted, vaultNotes } = readVaultState({ storeDir, root, settings, nowUnix });
  const decided = knowledgeWithDecisions({ db, notes, manifest });
  const { topicPins } = decided;
  if (topicsWaiting({ settings, config, manifest, knowledge: decided.knowledge })) {
    const { things, unplaced } = decided.knowledge;
    return { skipped: "topics-pending", at: nowUnix, placed: things.length - unplaced.length, total: things.length };
  }
  const knownIds = new Set([...notes.keys(), ...Object.keys(manifest.written), ...deleted]);
  const knowledge = { ...decided.knowledge, topics: stableTopics(decided.knowledge.topics, knownIds) };
  const days = buildDays(db, knowledge);
  const groups = buildGroups(db, knowledge, days);
  const counts = { written: 0, same: 0, kept: 0, failed: 0, ignored: 0, retired: 0, deleted: deleted.size };
  const errors = [];
  const retired = retiredNotes(notes, plannedIds({ topics: knowledge.topics, groups, days, deleted }), manifest);
  const trashed = trashUntouched({ retired, notes, manifest, settings, root, counts, errors, maxErrors: MAX_REPORTED_ERRORS });
  const remaining = new Map([...notes].filter(([id]) => !trashed.has(id)));
  const layout = planNotes({ root, settings, p, notes: remaining, deleted, days, groups, topics: knowledge.topics });
  const isIgnored = (id) => remaining.has(id) && readFlag(remaining.get(id).blocks, "ignore");
  const consensusByKey = loadConsensus(db);
  const ctx = buildContext({ p, serverUrl, knowledge, layout, isIgnored, consensusByKey });
  const aliases = plannedAliases({ plan: layout.plan, notes: remaining, manifest, ctx });
  // Written first: a sync stopped half way must not read its own alias writes
  // as the user's edits next time, nor move back what it put in .trash.
  files.saveManifest(storeDir, { ...manifest, topicPins, pending: aliases, trashed: [...new Set([...(manifest.trashed ?? []), ...trashed])] });
  const statuses = new Map();
  const write = createWriter({ root, heading: p("## 我的笔记"), counts, errors, statuses });
  const records = writePlan({ ctx, plan: layout.plan, aliases, knowledge, consensusByKey, vaultNotes, write, counts, isIgnored, nowUnix });
  // A retired note with the user's words keeps them and points at the topic.
  // Its old properties go: its aliases would still catch [[links]] meant for the topic.
  retired.filter(([id]) => !trashed.has(id)).forEach(([id, note]) =>
    write(id, note.relPath, { ...renderRetired(ctx, { id, into: intoTopic(id, knowledge.topics) }), drop: [...OWN_KEYS] }));
  const listed = knowledge.topics.filter(isNotable);
  if (layout.overviewPath !== null) {
    write("overview", layout.overviewPath, renderOverview(ctx, {
      id: "overview",
      topics: listed,
      days: days.map((entry) => entry.day).filter((day) => layout.links.day.has(day)),
      groupCount: groups.length,
      coverage: coverageOf(db),
      nowUnix,
      baseTarget: `${settings.folder}/${layout.basePath}`,
      pendingTopics: settings.consensus ? knowledge.unplaced.length : 0,
    }));
  }
  retireOldBase({ settings, root, manifest, basePath: layout.basePath, p, counts, errors, maxErrors: MAX_REPORTED_ERRORS });
  const baseHash = writeBase({ root, basePath: layout.basePath, text: baseFile(ctx, layout.topicsFolder), lastHash: manifest.basePath === layout.basePath ? manifest.baseHash : undefined, counts });
  files.saveManifest(storeDir, nextManifest({
    manifest, layout, records, statuses, notes: remaining, deleted, trashed, topicPins, baseHash, built: manifest.topicsBuilt || aiForNotes(settings, config),
  }));
  return {
    at: nowUnix,
    folder: root,
    overview: layout.overviewPath === null ? null : path.join(root, layout.overviewPath),
    topics: listed.length,
    things: knowledge.things.length,
    unplaced: knowledge.unplaced.length,
    days: days.length,
    groups: groups.length,
    errors,
    ...counts,
  };
};

// What the next sync needs to know: each topic note's name and the aliases
// ChatLens wrote there (a note not written this time keeps its record), the
// user's decisions, deleted and trashed notes, and where every note is. A note
// whose write failed is not "written": it was never there, so the next sync
// must try again rather than take it for one the user deleted.
const nextManifest = ({ manifest, layout, records, statuses, notes, deleted, trashed, topicPins, baseHash, built }) => {
  const topics = {};
  for (const { id, item } of layout.plan.filter((entry) => entry.kind === "topic")) {
    topics[id] = records[id] ?? manifest.topics[id] ?? { name: item.name, aliases: [] };
  }
  const there = (id) => statuses.get(id) !== "failed" || notes.has(id);
  const planned = new Set(layout.plan.map((item) => item.id));
  const kept = [...notes.keys()].filter((id) => !planned.has(id) && id !== "overview").map((id) => [id, notes.get(id).relPath]);
  const written = Object.fromEntries([
    ...layout.plan.filter((item) => there(item.id)).map((item) => [item.id, item.relPath]),
    ...kept,
    ...(layout.overviewPath === null || !there("overview") ? [] : [["overview", layout.overviewPath]]),
  ]);
  return {
    version: manifest.version,
    root: manifest.root,
    topics,
    topicPins,
    topicsBuilt: built,
    deleted: [...deleted],
    trashed: [...new Set([...(manifest.trashed ?? []), ...trashed])],
    written,
    pending: {},
    vaultUrls: manifest.vaultUrls,
    baseHash,
    basePath: layout.basePath,
  };
};

const vaultRoot = (settings) => {
  if (String(settings.vaultPath).trim() === "") {
    throw new Error("还没有选笔记库。");
  }
  let stat;
  try {
    stat = fs.statSync(settings.vaultPath);
  } catch {
    throw new Error(`找不到笔记库文件夹：${settings.vaultPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`笔记库不是文件夹：${settings.vaultPath}`);
  }
  return files.folderRoot(settings.vaultPath, settings.folder);
};

// The whole sync. Throws with a plain reason when the vault folder is missing.
const syncNotes = ({ db, config, storeDir, nowUnix, serverUrl = "" }) => {
  const settings = notesSettings(config);
  if (!settings.enabled || String(settings.vaultPath).trim() === "") {
    return { skipped: "off" };
  }
  if (!LANGUAGES.has(settings.language)) {
    throw new Error("笔记文字只能是简体或繁体。");
  }
  const root = vaultRoot(settings);
  const release = files.takeLock(storeDir);
  if (release === null) {
    return { skipped: "busy" };
  }
  try {
    // The console's own URL ends in "/"; "8321//?chat=" was not a page.
    return syncLocked({ db, config, settings, root, storeDir, nowUnix, serverUrl: String(serverUrl).replace(/\/+$/u, "") });
  } finally {
    release();
  }
};

// Clears the "you deleted it" marks so those notes are written again.
const restoreDeleted = ({ config, storeDir }) => {
  const root = vaultRoot(notesSettings(config));
  const release = files.takeLock(storeDir);
  if (release === null) {
    throw new Error("正在同步，等它好了再点。");
  }
  try {
    const manifest = files.loadManifest(storeDir, root);
    const back = new Set([...manifest.deleted, ...Object.keys(manifest.written)]);
    const notes = fs.existsSync(root) ? files.scanNotes(root, manifest.written) : new Map();
    const restored = [...back].filter((id) => !notes.has(id));
    const written = Object.fromEntries(Object.entries(manifest.written).filter(([id]) => notes.has(id)));
    files.saveManifest(storeDir, { ...manifest, deleted: [], written });
    return { restored: restored.length };
  } finally {
    release();
  }
};

module.exports = { DEFAULTS, LANGUAGES, notesSettings, createProse, createWriter, syncNotes, restoreDeleted };
