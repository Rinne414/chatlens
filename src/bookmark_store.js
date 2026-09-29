"use strict";

// 收藏: things worth coming back to (a new model, an answer, a topic), saved
// from the briefing with where they came from. Lives in the message store.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    speaker TEXT NOT NULL DEFAULT '',
    sent_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at)",
];

const KINDS = new Set(["thing", "qa", "topic", "message"]);
const LIMITS = { title: 200, body: 4000, link: 1000, name: 100 };

const ensureBookmarkSchema = (db) => {
  for (const statement of SCHEMA) {
    db.prepare(statement).run();
  }
  return db;
};

const text = (value, max) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

// The same thing saved twice (same kind, group and title) is one bookmark.
const itemKeyOf = (item) => `${item.kind}|${item.groupId}|${item.title.toLowerCase()}`;

// Validated at the boundary: the page sends what it shows.
const normalizeBookmark = (raw) => {
  const kind = String(raw?.kind ?? "");
  if (!KINDS.has(kind)) {
    throw new Error("收藏类型无效。");
  }
  const title = text(raw.title, LIMITS.title);
  if (title === "") {
    throw new Error("收藏需要标题。");
  }
  const link = text(raw.link, LIMITS.link);
  const sentAt = Number(raw.sentAt);
  const item = {
    kind,
    title,
    body: String(raw.body ?? "").trim().slice(0, LIMITS.body),
    link: /^https?:\/\//iu.test(link) ? link : "",
    groupId: /^\d+$/u.test(String(raw.groupId ?? "")) ? String(raw.groupId) : "",
    groupName: text(raw.groupName, LIMITS.name),
    speaker: text(raw.speaker, LIMITS.name),
    sentAt: Number.isInteger(sentAt) && sentAt > 0 ? sentAt : null,
  };
  return { ...item, itemKey: itemKeyOf(item) };
};

// Saving again refreshes the text and keeps the first save's time.
const addBookmark = (db, raw, now = Math.floor(Date.now() / 1000)) => {
  const item = normalizeBookmark(raw);
  db.prepare(`
    INSERT INTO bookmarks (item_key, kind, title, body, link, group_id, group_name, speaker, sent_at, created_at)
    VALUES (@itemKey, @kind, @title, @body, @link, @groupId, @groupName, @speaker, @sentAt, @now)
    ON CONFLICT(item_key) DO UPDATE SET body = excluded.body, link = excluded.link, group_name = excluded.group_name,
      speaker = excluded.speaker, sent_at = COALESCE(excluded.sent_at, bookmarks.sent_at)
  `).run({ ...item, now });
  return db.prepare("SELECT id FROM bookmarks WHERE item_key = ?").get(item.itemKey).id;
};

const removeBookmark = (db, id) => db.prepare("DELETE FROM bookmarks WHERE id = ?").run(Number(id)).changes;

const COLUMNS = `id, item_key AS itemKey, kind, title, body, link, group_id AS groupId, group_name AS groupName,
  speaker, sent_at AS sentAt, created_at AS createdAt`;

// Newest saves first; a date range on when they were saved and a text filter.
// Pages of `limit`; `total` says how many match in all.
const listBookmarks = (db, { fromUnix = null, toUnix = null, query = "", limit = 200, offset = 0 } = {}) => {
  const where = ["1 = 1"];
  const params = { limit: Math.max(1, Math.min(500, Number(limit) || 200)), offset: Math.max(0, Number(offset) || 0) };
  if (Number.isFinite(Number(fromUnix)) && fromUnix !== null) {
    where.push("created_at >= @fromUnix");
    params.fromUnix = Number(fromUnix);
  }
  if (Number.isFinite(Number(toUnix)) && toUnix !== null) {
    where.push("created_at < @toUnix");
    params.toUnix = Number(toUnix);
  }
  const words = String(query ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, 8);
  words.forEach((word, index) => {
    params[`w${index}`] = `%${word.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
    where.push(`(title LIKE @w${index} ESCAPE '\\' OR body LIKE @w${index} ESCAPE '\\' OR group_name LIKE @w${index} ESCAPE '\\' OR speaker LIKE @w${index} ESCAPE '\\')`);
  });
  const clause = where.join(" AND ");
  return {
    total: db.prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE ${clause}`).get(params).n,
    items: db.prepare(`SELECT ${COLUMNS} FROM bookmarks WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`).all(params),
  };
};

// Which of the page's items are saved already (to fill their stars).
const savedKeys = (db) => db.prepare("SELECT item_key AS itemKey, id FROM bookmarks").all();

module.exports = { ensureBookmarkSchema, normalizeBookmark, addBookmark, removeBookmark, listBookmarks, savedKeys };
