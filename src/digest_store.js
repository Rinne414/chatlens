"use strict";

// Persistence for the AI-written period digests, inside the message store:
//   kind "day"   — 每日总览: one overview of every group's day;
//   kind "week"  — 周报 (period = the Monday, Beijing);
//   kind "month" — 月报 (period = "YYYY-MM").
// input_key records exactly what fed a digest, so it is rewritten only when
// its input changed; complete = 1 once it was written after its period ended.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS period_digests (
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    start_unix INTEGER NOT NULL,
    end_unix INTEGER NOT NULL,
    input_key TEXT NOT NULL,
    detail TEXT NOT NULL,
    model TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, period)
  )`,
];

const KINDS = new Set(["day", "week", "month"]);

const ensureDigestSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const rowToDigest = (row) => {
  if (row === undefined) {
    return null;
  }
  try {
    const { summaryJson, complete, ...rest } = row;
    return { ...rest, complete: complete === 1, summary: JSON.parse(summaryJson) };
  } catch {
    return null;
  }
};

const COLUMNS = `kind, period, start_unix AS startUnix, end_unix AS endUnix, input_key AS inputKey, detail, model,
  summary_json AS summaryJson, generated_at AS generatedAt, complete`;

const getDigest = (db, kind, period) =>
  rowToDigest(db.prepare(`SELECT ${COLUMNS} FROM period_digests WHERE kind = ? AND period = ?`).get(kind, period));

const saveDigest = (db, digest) => {
  db.prepare(`
    INSERT INTO period_digests (kind, period, start_unix, end_unix, input_key, detail, model, summary_json, generated_at, complete)
    VALUES (@kind, @period, @startUnix, @endUnix, @inputKey, @detail, @model, @summaryJson, @generatedAt, @complete)
    ON CONFLICT(kind, period) DO UPDATE SET start_unix = excluded.start_unix, end_unix = excluded.end_unix,
      input_key = excluded.input_key, detail = excluded.detail, model = excluded.model, summary_json = excluded.summary_json,
      generated_at = excluded.generated_at, complete = excluded.complete
  `).run({
    ...digest,
    summaryJson: JSON.stringify(digest.summary),
    complete: digest.complete ? 1 : 0,
  });
};

// Newest first, headline only — for the lists of past reports.
const listDigests = (db, kind) =>
  db.prepare(`SELECT ${COLUMNS} FROM period_digests WHERE kind = ? ORDER BY start_unix DESC`).all(kind)
    .map(rowToDigest)
    .filter((digest) => digest !== null)
    .map(({ summary, ...rest }) => ({ ...rest, headline: summary.headline ?? "" }));

const digestsBetween = (db, kind, fromUnix, toUnix) =>
  db.prepare(`SELECT ${COLUMNS} FROM period_digests WHERE kind = ? AND start_unix >= ? AND end_unix <= ? ORDER BY start_unix ASC`)
    .all(kind, fromUnix, toUnix)
    .map(rowToDigest)
    .filter((digest) => digest !== null);

module.exports = { KINDS, ensureDigestSchema, getDigest, saveDigest, listDigests, digestsBetween };
