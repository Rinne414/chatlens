"use strict";

// 摘要回馈: what the reader said about a thing in the briefing — 「不重要」
// (I do not care about this) or 「讲错了」 (the summary got it wrong).
//
// What it changes:
// - the thing leaves the briefing at once (and can be put back);
// - things marked 不重要 lately are shown to the AI that makes the next
//   briefing's things, as the kind of matter this reader does not want listed;
// - everything said is kept as a list the reader can copy out, which is how
//   someone other than the author can report what the summaries get wrong.

const SCHEMA = `CREATE TABLE IF NOT EXISTS summary_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  title TEXT NOT NULL,
  takeaway TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  groups TEXT NOT NULL DEFAULT ''
)`;

const VERDICTS = ["unimportant", "wrong"];
const MAX_TEXT = 400;
// How many 不重要 titles the AI is shown, the newest first, and for how long one counts.
const TASTE_TITLES = 30;
const TASTE_DAYS = 60;

const ensureFeedbackSchema = (db) => {
  db.prepare(SCHEMA).run();
  return db;
};

const clip = (value) => [...String(value ?? "").trim()].slice(0, MAX_TEXT).join("");

const addFeedback = (db, { verdict, title, takeaway = "", kind = "", groups = [], now }) => {
  if (!VERDICTS.includes(verdict)) {
    throw new Error("verdict must be unimportant or wrong");
  }
  const name = clip(title);
  if (name === "") {
    throw new Error("title is required");
  }
  ensureFeedbackSchema(db);
  // Saying the same about the same thing twice is one entry.
  db.prepare("DELETE FROM summary_feedback WHERE verdict = ? AND title = ?").run(verdict, name);
  const id = Number(db.prepare("INSERT INTO summary_feedback (created_at, verdict, title, takeaway, kind, groups) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, verdict, name, clip(takeaway), clip(kind), (Array.isArray(groups) ? groups : []).map(clip).filter(Boolean).slice(0, 12).join("、")).lastInsertRowid);
  return { id };
};

const listFeedback = (db) => ensureFeedbackSchema(db)
  .prepare("SELECT id, created_at AS createdAt, verdict, title, takeaway, kind, groups FROM summary_feedback ORDER BY id DESC").all();

const removeFeedback = (db, id) => ensureFeedbackSchema(db).prepare("DELETE FROM summary_feedback WHERE id = ?").run(Number(id)).changes > 0;

// Titles the reader took out of the briefing: a thing with one of them stays out.
const hiddenTitles = (db) => new Set(ensureFeedbackSchema(db).prepare("SELECT title FROM summary_feedback").all().map((row) => row.title));

// For the prompt that makes the things: what this reader marked 不重要 lately.
const tasteTitles = (db, now) => ensureFeedbackSchema(db).prepare(`
  SELECT title FROM summary_feedback WHERE verdict = 'unimportant' AND created_at >= ? ORDER BY id DESC LIMIT ${TASTE_TITLES}
`).all(now - TASTE_DAYS * 86400).map((row) => row.title);

module.exports = { ensureFeedbackSchema, addFeedback, listFeedback, removeFeedback, hiddenTitles, tasteTitles, VERDICTS };
