"use strict";

// 问群聊 history, inside the message store: every question with its answer,
// so the page can show earlier questions again without asking twice.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ask_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asked_at INTEGER NOT NULL,
    question TEXT NOT NULL,
    result_json TEXT NOT NULL
  )`,
];

const HISTORY_PAGE = 50;

const ensureAskSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const saveAsk = (db, { askedAt, question, result }) =>
  Number(db.prepare("INSERT INTO ask_log (asked_at, question, result_json) VALUES (?, ?, ?)")
    .run(askedAt, question, JSON.stringify(result)).lastInsertRowid);

const listAsks = (db, { offset = 0 } = {}) =>
  db.prepare(`SELECT id, asked_at AS askedAt, question FROM ask_log ORDER BY id DESC LIMIT ${HISTORY_PAGE} OFFSET ?`)
    .all(Math.max(0, Number.parseInt(offset, 10) || 0));

const getAsk = (db, id) => {
  const row = db.prepare("SELECT id, asked_at AS askedAt, question, result_json AS resultJson FROM ask_log WHERE id = ?").get(Number(id));
  if (row === undefined) {
    return null;
  }
  try {
    return { id: row.id, askedAt: row.askedAt, question: row.question, result: JSON.parse(row.resultJson) };
  } catch {
    return null;
  }
};

const deleteAsk = (db, id) => db.prepare("DELETE FROM ask_log WHERE id = ?").run(Number(id)).changes;

module.exports = { HISTORY_PAGE, ensureAskSchema, saveAsk, listAsks, getAsk, deleteAsk };
