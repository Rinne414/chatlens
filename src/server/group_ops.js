"use strict";

// HTTP side of the 群 page (src/group_insights.js): the store's own connection
// for messages and summaries, a read-only one for the prompt library.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const state = require("./toolkit_state");
const briefingStore = require("../briefing_store");
const { groupInsights, timelineBetween } = require("../group_insights");

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

const getGroupTimeline = (params) => timelineBetween(briefingStore.ensureBriefingSchema(state.getStore()), {
  groupId: params.get("groupId") ?? "",
  fromUnix: Number(params.get("fromUnix")),
  toUnix: Number(params.get("toUnix")),
});

module.exports = { getGroupInsights, getGroupTimeline };
