"use strict";

// Interprets a copied QQ NT recent-contact / unread table. This is a HINT for
// the control centre ("QQ currently shows N unread") and must never be used as
// the summarise-from cursor: the column meanings are version-dependent and
// opening a chat in QQ clears the badge.

const IDENT = /^[A-Za-z0-9_]+$/u;
const UNREAD_NAME = /unread|未读/iu;
const PEER_NAME = /^(peer_uin|group_id|uin|contact_id|peerId)$/iu;
const CHAT_TYPE_NAME = /^(chat_type|chatType|type)$/iu;

// QQ NT recent_contact_v3_table uses numbered columns. Measured against a
// decrypted copy: 40010=chatType (2=group), 40021=peer id, 40005 grows on
// groups that have not been opened and stays 0 on ones that have. Treat as a
// badge hint, never as a last-read seq.
const KNOWN_TABLES = {
  recent_contact_v3_table: { peer: "40021", unread: "40005", chatType: "40010" },
};

const quoteIdent = (name) => {
  if (!IDENT.test(name)) {
    throw new Error(`Refusing to query identifier: ${name}`);
  }
  return `"${name}"`;
};

const chatTypeOf = (value) => {
  const number = Number(value);
  if (number === 2 || number === 100) {
    return "group";
  }
  if (number === 1 || number === 8) {
    return "private";
  }
  return "unknown";
};

const pickColumn = (columns, matcher) =>
  columns.find((column) => matcher.test(column.name)) ?? null;

const collectFromTable = (db, tableName, mapping) => {
  const typeSelect = mapping.chatType ? quoteIdent(mapping.chatType) : "NULL";
  const sql = `SELECT ${quoteIdent(mapping.peer)} AS peerId, ${quoteIdent(mapping.unread)} AS unreadCount, ${typeSelect} AS chatType FROM ${quoteIdent(tableName)}`;
  const rows = [];
  for (const row of db.prepare(sql).all()) {
    const unreadCount = Number(row.unreadCount);
    const peerId = String(row.peerId ?? "").trim();
    if (peerId === "" || !Number.isFinite(unreadCount) || unreadCount <= 0) {
      continue;
    }
    rows.push({
      peerId,
      unreadCount,
      chatType: chatTypeOf(row.chatType),
      table: tableName,
    });
  }
  return rows;
};

const extractUnreadRows = (db) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const seen = new Set();
  const rows = [];
  const pushAll = (batch) => {
    for (const row of batch) {
      const key = `${row.table}:${row.peerId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  };

  for (const [tableName, mapping] of Object.entries(KNOWN_TABLES)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    if (exists !== undefined) {
      pushAll(collectFromTable(db, tableName, mapping));
    }
  }

  for (const table of tables) {
    if (!IDENT.test(table.name) || KNOWN_TABLES[table.name] !== undefined) {
      continue;
    }
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all();
    const unreadColumn = pickColumn(columns, UNREAD_NAME);
    if (unreadColumn === null) {
      continue;
    }
    const peerColumn = pickColumn(columns, PEER_NAME) ?? columns.find((column) => /uin|group|peer|contact/iu.test(column.name));
    if (peerColumn === undefined) {
      continue;
    }
    const typeColumn = pickColumn(columns, CHAT_TYPE_NAME);
    pushAll(collectFromTable(db, table.name, {
      peer: peerColumn.name,
      unread: unreadColumn.name,
      chatType: typeColumn === null ? null : typeColumn.name,
    }));
  }
  return rows;
};

const hintForWatchlist = (rows, watchlist) => {
  const wanted = new Map((watchlist ?? []).map((entry) => [String(entry.groupId), entry]));
  const groups = [];
  for (const row of rows) {
    const entry = wanted.get(row.peerId);
    if (entry === undefined) {
      continue;
    }
    groups.push({
      groupId: row.peerId,
      name: entry.name || row.peerId,
      unreadCount: row.unreadCount,
    });
  }
  const totalUnread = groups.reduce((sum, group) => sum + group.unreadCount, 0);
  return {
    available: groups.length > 0,
    totalUnread,
    groups,
    disclaimer: "这是 QQ 会话列表上的红点约数，不是已读游标；打开群会把它清掉。总结范围仍以本工具的「上次读到这里」为准。",
  };
};

module.exports = {
  extractUnreadRows,
  hintForWatchlist,
};
