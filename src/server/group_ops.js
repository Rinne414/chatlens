"use strict";

// HTTP side of the 群 page (src/group_insights.js): the store's own connection
// for messages and summaries, a read-only one for the prompt library.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const state = require("./toolkit_state");
const briefingStore = require("../briefing_store");
const { groupInsights, timelineBetween } = require("../group_insights");
const { personProfile, personMessages } = require("../group_person");
const { personAcross } = require("../person_across");

const knowledgePath = () => path.join(state.toolRoot, "store", "knowledge.db");

const getGroupInsights = (params) => {
  const db = briefingStore.ensureBriefingSchema(state.getStore());
  const kb = fs.existsSync(knowledgePath()) ? new Database(knowledgePath(), { readonly: true, fileMustExist: true }) : null;
  try {
    return groupInsights(db, kb, {
      groupId: params.get("groupId") ?? "",
      nowUnix: Math.floor(Date.now() / 1000),
      fromUnix: Number(params.get("fromUnix")),
      toUnix: Number(params.get("toUnix")),
    });
  } finally {
    kb?.close();
  }
};

// The same on connections of its own, for the read worker (read_worker.js):
// 30 days of a busy group took 1.4 s on the server's thread.
const getGroupInsightsReadOnly = ({ groupId, fromUnix, toUnix }) => {
  const db = new Database(path.join(state.toolRoot, "store", "messages.db"), { readonly: true, fileMustExist: true });
  const kb = fs.existsSync(knowledgePath()) ? new Database(knowledgePath(), { readonly: true, fileMustExist: true }) : null;
  try {
    return groupInsights(db, kb, { groupId: String(groupId ?? ""), nowUnix: Math.floor(Date.now() / 1000), fromUnix: Number(fromUnix), toUnix: Number(toUnix) });
  } finally {
    kb?.close();
    db.close();
  }
};

const getGroupTimeline = (params) => timelineBetween(briefingStore.ensureBriefingSchema(state.getStore()), {
  groupId: params.get("groupId") ?? "",
  fromUnix: Number(params.get("fromUnix")),
  toUnix: Number(params.get("toUnix")),
});

// One person of a group (群 → 个人页), on connections of its own for the read
// worker: about 0.2 s for 30 days of a busy group.
const getGroupPersonReadOnly = ({ groupId, uin, fromUnix, toUnix }) => {
  const db = new Database(path.join(state.toolRoot, "store", "messages.db"), { readonly: true, fileMustExist: true });
  try {
    return personProfile(db, String(groupId ?? ""), String(uin ?? ""), { fromUnix: Number(fromUnix), toUnix: Number(toUnix) });
  } finally {
    db.close();
  }
};

// One person across every group (个人页 → 「看 TA 在所有群」), for the read
// worker: up to about 1.3 s for 30 days of someone in 20 groups.
const getPersonAcrossReadOnly = ({ uin, fromUnix, toUnix }) => {
  const db = new Database(path.join(state.toolRoot, "store", "messages.db"), { readonly: true, fileMustExist: true });
  try {
    return personAcross(db, String(uin ?? ""), { fromUnix: Number(fromUnix), toUnix: Number(toUnix) });
  } finally {
    db.close();
  }
};

// all=1: from every group (the page's 「所有群」 view).
const getPersonMessages = (params) => personMessages(state.getStore(), {
  groupId: params.get("all") === "1" ? null : params.get("groupId") ?? "",
  uin: params.get("uin") ?? "",
  fromUnix: Number(params.get("fromUnix")),
  toUnix: Number(params.get("toUnix")),
  beforeSentAt: params.has("beforeSentAt") ? Number(params.get("beforeSentAt")) : undefined,
  beforeRowId: params.get("beforeRowId") ?? undefined,
  limit: Number(params.get("limit")) || undefined,
});

module.exports = { getGroupInsights, getGroupInsightsReadOnly, getGroupTimeline, getGroupPersonReadOnly, getPersonAcrossReadOnly, getPersonMessages };
