"use strict";

// 画廊: every group picture the background has recorded (the `pictures` table,
// fed by the refresh since v0.0.13), browsed by time, group, sender and kind.
//
// One wall entry per picture (md5), not per posting: a picture reposted in
// five groups is one tile carrying "5 群". Its spread -- who posted it first,
// where it travelled -- is what the detail view shows.
//
// Queries run on a read-only connection to messages.db; when knowledge.db is
// attached as `kb`, AI pictures found in QQ's local originals count as AI too
// (not only the ones the picture pass probed on Tencent).

const DAY_SECONDS = 86400;
const MAX_LIMIT = 240;
const DEFAULT_LIMIT = 120;
const CONTEXT_MESSAGES = 6;
const KINDS = new Set(["images", "stickers", "all"]);
const SORTS = new Set(["recent", "spread"]);
const MD5 = /^[a-f0-9]{32}$/u;

const hasKnowledge = (db) => db.prepare("PRAGMA database_list").all().some((row) => row.name === "kb");

// SQL for "this picture is AI-generated" over pictures aliased `p`.
const aiCondition = (db) => {
  const probed = "EXISTS (SELECT 1 FROM picture_files f WHERE f.md5 = p.md5 AND f.probe = 'ai')";
  return hasKnowledge(db)
    ? `(${probed} OR EXISTS (SELECT 1 FROM kb.images i WHERE i.hash = p.md5 AND i.generator NOT IN ('stripped', 'unknown')))`
    : probed;
};

const clampLimit = (limit) => {
  const value = Number.parseInt(limit, 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT;
};

// Filters shared by the list and the facet counts. `sender` is a QQ number, or
// a display name for rows stored before the number was recorded.
const buildFilter = (db, { fromUnix, toUnix, groupId = "", sender = "", kind = "images", ai = false }) => {
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error("时间范围无效。");
  }
  if (!KINDS.has(kind)) {
    throw new Error(`未知的类型：${kind}`);
  }
  const conditions = ["p.sent_at >= @fromUnix", "p.sent_at < @toUnix"];
  const args = { fromUnix, toUnix };
  if (groupId !== "") {
    conditions.push("p.group_id = @groupId");
    args.groupId = String(groupId);
  }
  if (kind !== "all") {
    conditions.push(kind === "stickers" ? "p.sticker = 1" : "p.sticker = 0");
  }
  if (ai) {
    conditions.push(aiCondition(db));
  }
  let join = "";
  if (sender !== "") {
    join = "JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id";
    conditions.push("(m.speaker_uin = @sender OR (m.speaker_uin = '' AND m.speaker = @sender))");
    args.sender = String(sender);
  }
  return { join, where: conditions.join(" AND "), args };
};

const ORDER = {
  recent: "lastAt DESC, p.md5",
  spread: "groups DESC, posts DESC, lastAt DESC, p.md5",
};

// groups / posts count every posting of the picture, not only the filtered
// ones: with one group selected, "posted in 5 groups" is still the point.
const SPREAD_GROUPS = "(SELECT COUNT(DISTINCT q.group_id) FROM pictures q WHERE q.md5 = p.md5)";

const pageRows = (db, filter, { sort, limit, offset }) => db.prepare(`
  SELECT p.md5, MIN(p.sent_at) AS firstAt, MAX(p.sent_at) AS lastAt,
         (SELECT COUNT(*) FROM pictures q WHERE q.md5 = p.md5) AS posts, ${SPREAD_GROUPS} AS groups,
         MAX(p.width) AS width, MAX(p.height) AS height, MAX(p.size) AS size,
         MAX(p.format) AS format, MAX(p.sticker) AS sticker, MAX(p.expires_at) AS expiresAt
  FROM pictures p ${filter.join}
  WHERE ${filter.where}
  GROUP BY p.md5
  ORDER BY ${ORDER[sort]}
  LIMIT @limit OFFSET @offset
`).all({ ...filter.args, limit, offset });

// Every posting of the page's pictures, oldest first: the first is where the
// picture came from, and the filter decides which posting the tile shows.
const occurrencesOf = (db, md5s) => db.prepare(`
  SELECT p.md5, p.group_id AS groupId, p.row_id AS rowId, p.sent_at AS sentAt,
         COALESCE(m.speaker, '') AS speaker, COALESCE(m.speaker_uin, '') AS speakerUin,
         COALESCE(g.name, '') AS groupName
  FROM pictures p
  LEFT JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
  LEFT JOIN group_names g ON g.group_id = p.group_id
  WHERE p.md5 IN (SELECT value FROM json_each(@md5s))
  ORDER BY p.sent_at, p.group_id, p.row_id
`).all({ md5s: JSON.stringify(md5s) });

const filesOf = (db, md5s) => new Map(db.prepare(`
  SELECT md5, COALESCE(thumb, '') <> '' AS hasThumb, kept, probe, gone
  FROM picture_files WHERE md5 IN (SELECT value FROM json_each(@md5s))
`).all({ md5s: JSON.stringify(md5s) }).map((row) => [row.md5, row]));

const knowledgeOf = (db, md5s) => {
  if (!hasKnowledge(db)) {
    return new Map();
  }
  return new Map(db.prepare(`
    SELECT i.hash, i.generator, i.checkpoint,
           (SELECT COUNT(*) FROM kb.image_loras l WHERE l.hash = i.hash) AS loras,
           (SELECT COUNT(*) FROM kb.prompt_requests r WHERE r.image_hash = i.hash) AS asks
    FROM kb.images i WHERE i.hash IN (SELECT value FROM json_each(@md5s))
  `).all({ md5s: JSON.stringify(md5s) }).map((row) => [row.hash, row]));
};

// Worth opening in the 咒语库 only when it has a prompt or an ask to show.
const inLibrary = (knowledge, aiKnown) => knowledge !== undefined && (aiKnown || knowledge.asks > 0);

const posting = (row) => ({
  groupId: row.groupId,
  groupName: row.groupName,
  rowId: row.rowId,
  sentAt: row.sentAt,
  speaker: row.speaker,
  speakerUin: row.speakerUin,
});

const matchesFilter = (row, { fromUnix, toUnix, groupId, sender }) =>
  row.sentAt >= fromUnix && row.sentAt < toUnix
  && (groupId === "" || row.groupId === String(groupId))
  && (sender === "" || row.speakerUin === String(sender) || (row.speakerUin === "" && row.speaker === String(sender)));

const describe = (row, occurrences, file, knowledge, options) => {
  const inFilter = occurrences.filter((item) => matchesFilter(item, options));
  const shown = inFilter[inFilter.length - 1] ?? occurrences[occurrences.length - 1];
  const origin = occurrences[0];
  const aiKnown = knowledge !== undefined && !["stripped", "unknown"].includes(knowledge.generator);
  return {
    md5: row.md5,
    width: row.width,
    height: row.height,
    size: row.size,
    format: row.format,
    sticker: row.sticker === 1,
    expiresAt: row.expiresAt,
    lastAt: row.lastAt,
    shown: shown === undefined ? null : posting(shown),
    origin: origin === undefined ? null : posting(origin),
    groups: new Set(occurrences.map((item) => item.groupId)).size,
    posts: occurrences.length,
    hasThumb: file?.hasThumb === 1,
    kept: file?.kept === 1,
    gone: file?.gone === 1,
    ai: file?.probe === "ai" || aiKnown,
    generator: aiKnown ? knowledge.generator : "",
    checkpoint: aiKnown ? knowledge.checkpoint : "",
    loras: knowledge?.loras ?? 0,
    asks: knowledge?.asks ?? 0,
    inLibrary: inLibrary(knowledge, aiKnown),
  };
};

const listPictures = (db, options) => {
  const sort = SORTS.has(options.sort) ? options.sort : "recent";
  const normalized = { groupId: "", sender: "", kind: "images", ai: false, ...options };
  const filter = buildFilter(db, normalized);
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Number.parseInt(options.offset ?? 0, 10) || 0);
  const rows = pageRows(db, filter, { sort, limit, offset });
  const total = db.prepare(`SELECT COUNT(DISTINCT p.md5) AS n FROM pictures p ${filter.join} WHERE ${filter.where}`).get(filter.args).n;
  const md5s = rows.map((row) => row.md5);
  const byMd5 = new Map(md5s.map((md5) => [md5, []]));
  for (const row of occurrencesOf(db, md5s)) {
    byMd5.get(row.md5).push(row);
  }
  const files = filesOf(db, md5s);
  const knowledge = knowledgeOf(db, md5s);
  return {
    total,
    items: rows.map((row) => describe(row, byMd5.get(row.md5), files.get(row.md5), knowledge.get(row.md5), normalized)),
  };
};

// Counts for the sidebar under the current filter; each dimension is counted
// without its own selection, so the other options stay visible.
const galleryFacets = (db, options) => {
  const normalized = { groupId: "", sender: "", kind: "images", ai: false, ...options };
  const distinct = (filter, extra = "") =>
    db.prepare(`SELECT COUNT(DISTINCT p.md5) AS n FROM pictures p ${filter.join} WHERE ${filter.where} ${extra}`).get(filter.args).n;
  const allKinds = buildFilter(db, { ...normalized, kind: "all", ai: false });
  const kinds = {
    images: distinct(allKinds, "AND p.sticker = 0"),
    stickers: distinct(allKinds, "AND p.sticker = 1"),
  };
  const noAi = buildFilter(db, { ...normalized, ai: false });
  const ai = distinct(noAi, `AND ${aiCondition(db)}`);
  const current = buildFilter(db, normalized);
  const spread = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT p.md5 FROM pictures p ${current.join} WHERE ${current.where}
      GROUP BY p.md5 HAVING ${SPREAD_GROUPS} > 1)
  `).get(current.args).n;
  const byGroup = buildFilter(db, { ...normalized, groupId: "" });
  const groups = db.prepare(`
    SELECT p.group_id AS value, COALESCE(g.name, '') AS label, COUNT(DISTINCT p.md5) AS count
    FROM pictures p ${byGroup.join} LEFT JOIN group_names g ON g.group_id = p.group_id
    WHERE ${byGroup.where} GROUP BY p.group_id ORDER BY count DESC
  `).all(byGroup.args);
  const bySender = buildFilter(db, { ...normalized, sender: "" });
  const senders = db.prepare(`
    SELECT CASE WHEN m.speaker_uin <> '' THEN m.speaker_uin ELSE m.speaker END AS value,
           MAX(m.speaker) AS label, COUNT(DISTINCT p.md5) AS count
    FROM pictures p JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
    WHERE ${bySender.where} AND m.speaker <> ''
    GROUP BY value ORDER BY count DESC
  `).all(bySender.args);
  return { kinds, ai, spread, groups, senders };
};

// Everything the detail view needs about one picture.
const pictureDetail = (db, md5) => {
  if (!MD5.test(String(md5))) {
    throw new Error("图片编号无效。");
  }
  const occurrences = occurrencesOf(db, [md5]).map(posting);
  if (occurrences.length === 0) {
    return null;
  }
  const meta = db.prepare(`
    SELECT MAX(width) AS width, MAX(height) AS height, MAX(size) AS size, MAX(format) AS format,
           MAX(sticker) AS sticker, MAX(expires_at) AS expiresAt
    FROM pictures WHERE md5 = ?
  `).get(md5);
  const file = filesOf(db, [md5]).get(md5);
  const knowledge = knowledgeOf(db, [md5]).get(md5);
  const aiKnown = knowledge !== undefined && !["stripped", "unknown"].includes(knowledge.generator);
  return {
    md5,
    ...meta,
    sticker: meta.sticker === 1,
    kept: file?.kept === 1,
    gone: file?.gone === 1,
    probe: file?.probe ?? "",
    ai: file?.probe === "ai" || aiKnown,
    generator: aiKnown ? knowledge.generator : "",
    inLibrary: inLibrary(knowledge, aiKnown),
    occurrences,
  };
};

// The chat around one posting: a few messages before and after, in order.
const messageContext = (db, { groupId, rowId, sentAt }) => {
  const at = Number(sentAt);
  if (!/^\d+$/u.test(String(groupId)) || !Number.isFinite(at)) {
    throw new Error("消息位置无效。");
  }
  const columns = "row_id AS rowId, sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds";
  const before = db.prepare(`
    SELECT ${columns} FROM messages WHERE group_id = @groupId AND (sent_at < @at OR (sent_at = @at AND row_id <= @rowId))
    ORDER BY sent_at DESC, row_id DESC LIMIT ${CONTEXT_MESSAGES + 1}
  `).all({ groupId: String(groupId), at, rowId: String(rowId ?? "") }).reverse();
  const after = db.prepare(`
    SELECT ${columns} FROM messages WHERE group_id = @groupId AND (sent_at > @at OR (sent_at = @at AND row_id > @rowId))
    ORDER BY sent_at, row_id LIMIT ${CONTEXT_MESSAGES}
  `).all({ groupId: String(groupId), at, rowId: String(rowId ?? "") });
  return { messages: [...before, ...after], focusRowId: String(rowId ?? "") };
};

// Every non-sticker picture posted in the window that has been posted in more
// than one group (counting all its postings), for 热点.
const spreadPictures = (db, { fromUnix, toUnix }) => db.prepare(`
  SELECT p.md5 FROM pictures p
  WHERE p.sent_at >= ? AND p.sent_at < ? AND p.sticker = 0
  GROUP BY p.md5 HAVING ${SPREAD_GROUPS} > 1
`).all(fromUnix, toUnix).map((row) => row.md5);

const rangeForDays = (days, nowUnix) => ({ fromUnix: nowUnix - days * DAY_SECONDS, toUnix: nowUnix + 60 });

module.exports = { listPictures, galleryFacets, pictureDetail, messageContext, spreadPictures, rangeForDays, hasKnowledge };
