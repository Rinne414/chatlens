"use strict";

// 问答库 / 资源库 (回顾), for the read worker on a connection of its own: a
// month of a busy library is tens of thousands of notes to read through, and
// the server's thread must keep answering meanwhile.

const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");
const state = require("./toolkit_state");
const review = require("../review_store");

const MAX_QUERY_LENGTH = 80;
const numberOrNull = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

const searchLibraryReadOnly = ({ q, fromUnix = null, toUnix = null, library, summaryOffset = 0, answered = null }) => {
  const db = new Database(path.join(state.toolRoot, "store", "messages.db"), { readonly: true, fileMustExist: true });
  try {
    // A store that has never been summarized has no notes table yet.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'summary_chunks'").get() === undefined) {
      const none = { total: 0, byDay: [], items: [] };
      return { terms: [], summaries: none, messages: none, library };
    }
    return review.search(db, {
      query: String(q ?? "").slice(0, MAX_QUERY_LENGTH),
      fromUnix: numberOrNull(fromUnix),
      toUnix: numberOrNull(toUnix),
      library,
      summaryOffset,
      answered: answered === "yes" || answered === "no" ? answered : null,
      readOnly: true,
    });
  } finally {
    db.close();
  }
};

module.exports = { searchLibraryReadOnly };
