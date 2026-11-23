"use strict";

// 角色卡, inside the message store: one card per person (QQ number), replaced
// when it is made again.

const SCHEMA = `CREATE TABLE IF NOT EXISTS persona_cards (
  uin TEXT PRIMARY KEY,
  built_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL
)`;

const ensurePersonaSchema = (db) => {
  db.prepare(SCHEMA).run();
  return db;
};

const savePersona = (db, { uin, builtAt, name, model, result }) => {
  db.prepare(`
    INSERT INTO persona_cards (uin, built_at, name, model, result_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(uin) DO UPDATE SET built_at = excluded.built_at, name = excluded.name, model = excluded.model, result_json = excluded.result_json
  `).run(String(uin), builtAt, name, model, JSON.stringify(result));
};

const getPersona = (db, uin) => {
  const row = db.prepare("SELECT uin, built_at AS builtAt, name, model, result_json AS json FROM persona_cards WHERE uin = ?").get(String(uin));
  if (row === undefined) {
    return null;
  }
  try {
    return { uin: row.uin, builtAt: row.builtAt, name: row.name, model: row.model, ...JSON.parse(row.json) };
  } catch {
    return null;
  }
};

const deletePersona = (db, uin) => db.prepare("DELETE FROM persona_cards WHERE uin = ?").run(String(uin)).changes > 0;

module.exports = { ensurePersonaSchema, savePersona, getPersona, deletePersona };
