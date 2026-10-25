"use strict";

// 笔记库: the AI part, run inside a background refresh after the briefing
// (and by 立即同步) with the same client and the same gate (pause, daily call
// cap, money budget). First new things are placed into topics
// (src/things_topics.js), then the names not asked about yet are merged
// (src/things_aliases.js), then "群里的共识" is written for topics several
// groups talk about (src/things_consensus.js). Each has its own per-run cap,
// so a large backlog is spread over several refreshes instead of one long one.

const fs = require("node:fs");
const path = require("node:path");
const files = require("./vault_files");
const { notesSettings } = require("./vault_sync");
const { loadKnowledge } = require("./vault_data");
const { runAliasPass } = require("./things_aliases");
const { runTopicPass, consensusSubject, isNotable } = require("./things_topics");
const { runConsensusPass } = require("./things_consensus");

const MAX_ALIAS_CALLS_PER_RUN = 6;
// The first placing of ~1,700 things is ~22 calls: 立即同步 finishes it in
// one run; a background refresh also stops at its time budget (refresh_run.js).
const MAX_TOPIC_CALLS_PER_RUN = 30;
const MAX_CONSENSUS_PER_RUN = 12;
// A run that placed this many batches did enough for one refresh.
const BIG_PLACING_CALLS = 4;
const STATUS_FILE = "notes-status.json";
// The first placing into topics takes ~25 min and 立即同步 may run 45: a lock
// younger than this, held by a live process, is still that run's.
const AI_LOCK_STALE_MS = 2 * 3600 * 1000;

const cappedGate = (gate, cap) => {
  let used = 0;
  return () => {
    if (used >= cap) {
      return "notes-run-cap";
    }
    const blocked = gate();
    if (!blocked) {
      used += 1;
    }
    return blocked;
  };
};

const pinsOf = (storeDir, settings) => {
  const manifest = files.loadManifest(storeDir, files.folderRoot(settings.vaultPath, settings.folder));
  return new Map(Object.entries(manifest.topicPins ?? {}));
};

// manual: 立即同步, which waits for the result: only new things are placed
// into topics (the name merging and the consensus calls are left to the
// background refresh). onProgress({ stage, done, todo }).
const runNotesAi = async (db, { config, storeDir, client, callLlm, model, gate, nowUnix, manual = false, onProgress = () => {} }) => {
  const settings = notesSettings(config);
  if (!settings.enabled || !settings.consensus || String(settings.vaultPath).trim() === "") {
    return { skipped: "off" };
  }
  // One AI pass at a time: a manual sync during a background refresh would
  // ask about the same things twice.
  const release = files.takeLock(storeDir, "notes-ai", { staleMs: AI_LOCK_STALE_MS });
  if (release === null) {
    return { skipped: "busy" };
  }
  try {
    const pins = pinsOf(storeDir, settings);
    const ask = { callLlm, client, model, nowUnix };
    let knowledge = loadKnowledge(db, { pins });
    // Placing first: until the things are in topics the notes keep the old
    // layout, so the names merging and the consensus wait for the next refresh
    // after a big placing run (the first one is ~22 calls).
    const topics = await runTopicPass(db, {
      ...ask, things: knowledge.things, gate: cappedGate(gate, MAX_TOPIC_CALLS_PER_RUN), onProgress: (outcome) => onProgress({ stage: "topics", ...outcome }),
    });
    if (manual || topics.calls >= BIG_PLACING_CALLS) {
      return { aliases: { skipped: "later" }, topics, consensus: { skipped: manual ? "manual" : "later" } };
    }
    const aliases = await runAliasPass(db, { ...ask, things: knowledge.things, gate: cappedGate(gate, MAX_ALIAS_CALLS_PER_RUN) });
    if (aliases.edges > 0) {
      knowledge = loadKnowledge(db, { pins });
    }
    // A consensus written before the names are merged and placed would be written again.
    if (aliases.pending > 0 || topics.pending > 0) {
      return { aliases, topics, consensus: { skipped: "topics-first" } };
    }
    if (topics.calls > 0 && aliases.edges === 0) {
      knowledge = loadKnowledge(db, { pins });
    }
    onProgress({ stage: "consensus" });
    const subjects = knowledge.topics.filter(isNotable).map((topic) => consensusSubject(topic, knowledge.answersOf(topic)));
    const consensus = await runConsensusPass(db, {
      ...ask,
      things: subjects,
      answersOf: (subject) => subject.answers,
      groupNames: knowledge.groupNames,
      gate: cappedGate(gate, MAX_CONSENSUS_PER_RUN),
    });
    return { aliases, topics, consensus };
  } finally {
    release();
  }
};

/* ---------- the last outcome, for the settings card ---------- */

const statusPath = (storeDir) => path.join(storeDir, STATUS_FILE);

const readNotesStatus = (storeDir) => {
  try {
    return JSON.parse(fs.readFileSync(statusPath(storeDir), "utf8"));
  } catch {
    return null;
  }
};

// patch: { sync?, syncError?, waiting?, ai?, aiProgress? } merged into what is there.
const writeNotesStatus = (storeDir, patch) => {
  const next = { ...(readNotesStatus(storeDir) ?? {}), ...patch };
  const temp = `${statusPath(storeDir)}.tmp-${process.pid}`;
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, "utf8");
  fs.renameSync(temp, statusPath(storeDir));
  return next;
};

// A sync's outcome for the card: written, or still waiting for the topics.
const recordSync = (storeDir, result) => {
  if (result.skipped === undefined) {
    writeNotesStatus(storeDir, { sync: result, syncError: null, waiting: null });
  } else if (result.skipped === "topics-pending") {
    writeNotesStatus(storeDir, { waiting: result });
  }
  return result;
};

module.exports = { runNotesAi, cappedGate, readNotesStatus, writeNotesStatus, recordSync, MAX_ALIAS_CALLS_PER_RUN, MAX_TOPIC_CALLS_PER_RUN, MAX_CONSENSUS_PER_RUN };
