"use strict";

// The left rail: the followed groups with what is new in each (unread count,
// whether someone @-ed or replied to you), and a one-glance status of the
// background work. Cheap by design -- it is polled while the app is open.

const messageStore = require("./message_store");
const pictureStore = require("./picture_store");
const { formatHkt } = require("./unviewed_range");

const DAY_SECONDS = 86400;
const MENTION_LOOKBACK_SECONDS = 3 * DAY_SECONDS;
const EXPIRING_WITHIN_SECONDS = 7 * DAY_SECONDS;
const MAX_COUNTED = 999;
const BEIJING_OFFSET_SECONDS = 8 * 3600;

const beijingMidnight = (unix) => {
  const day = formatHkt(unix).slice(0, 10);
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / 1000 - BEIJING_OFFSET_SECONDS;
};

// Messages after the group's read mark, counted up to MAX_COUNTED.
const unreadCount = (db, groupId, mark) => db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT 1 FROM messages
    WHERE group_id = @groupId
      AND (sent_at > @sentAt OR (sent_at = @sentAt AND row_id > @rowId))
    LIMIT ${MAX_COUNTED})
`).get({ groupId, sentAt: mark?.sentAt ?? 0, rowId: mark?.rowId ?? "" }).n;

const storedName = (db, groupId) =>
  db.prepare("SELECT name FROM group_names WHERE group_id = ?").get(groupId)?.name || groupId;

const lastActivity = (db, groupId) =>
  db.prepare("SELECT MAX(sent_at) AS last FROM messages WHERE group_id = ?").get(groupId).last ?? 0;

// Only the direct kinds count here: an @ to me or a reply to my message, found
// by QQ number (no text search, which made this 20x slower). An @all or a name
// match is on the 简报 page, not worth a red dot on every group. One query for
// all groups; each group then keeps what is after its read mark.
const directMentions = (db, groupIds, uins, nowUnix) => {
  if (groupIds.length === 0 || uins.length === 0) {
    return [];
  }
  const args = { fromUnix: nowUnix - MENTION_LOOKBACK_SECONDS };
  const groupList = groupIds.map((groupId, index) => {
    args[`g${index}`] = String(groupId);
    return `@g${index}`;
  }).join(", ");
  const reasons = uins.flatMap((uin, index) => {
    args[`u${index}`] = String(uin);
    return [`(',' || at_uins || ',') LIKE '%,' || @u${index} || ',%'`, `reply_to_uin = @u${index}`];
  }).join(" OR ");
  return db.prepare(`
    SELECT group_id AS groupId, row_id AS rowId, sent_at AS sentAt FROM messages
    WHERE sent_at >= @fromUnix AND is_self = 0 AND group_id IN (${groupList}) AND (${reasons})
  `).all(args);
};

const afterMark = (mark) => (item) =>
  mark === null || item.sentAt > mark.sentAt || (item.sentAt === mark.sentAt && item.rowId > mark.rowId);

const todayCounts = (db, nowUnix) => {
  const start = beijingMidnight(nowUnix);
  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sent_at >= ?").get(start).n;
  // INDEXED BY: left alone, SQLite walks the md5 index for the DISTINCT and
  // scans every picture (measured 0.2 s) instead of today's few hundred.
  const pictures = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN f.probe = 'ai' THEN 1 ELSE 0 END), 0) AS ai
    FROM (SELECT DISTINCT md5 FROM pictures INDEXED BY idx_pictures_time WHERE sent_at >= ? AND sticker = 0) d
    LEFT JOIN picture_files f ON f.md5 = d.md5
  `).get(start);
  return { messages, pictures: pictures.total, aiPictures: pictures.ai };
};

// The expiring count scans every live picture (~0.4 s) and moves slowly, so it
// is recomputed at most every few minutes.
const EXPIRING_CACHE_SECONDS = 5 * 60;
let expiringCache = null;
const expiringSoon = (db, nowUnix) => {
  if (expiringCache === null || nowUnix - expiringCache.at > EXPIRING_CACHE_SECONDS) {
    expiringCache = { at: nowUnix, value: pictureStore.countExpiringAi(db, { now: nowUnix, withinSeconds: EXPIRING_WITHIN_SECONDS }) };
  }
  return expiringCache.value;
};

const railStatus = (db, { watchlist, identity, nowUnix }) => {
  const mentions = directMentions(db, watchlist.map((group) => group.groupId), identity.uins, nowUnix);
  const groups = watchlist.map((group) => {
    const mark = messageStore.getReadMark(db, group.groupId);
    return {
      groupId: group.groupId,
      name: group.name || storedName(db, group.groupId),
      unread: unreadCount(db, group.groupId, mark),
      mentions: mentions.filter((item) => item.groupId === group.groupId).filter(afterMark(mark)).length,
      lastSentAt: lastActivity(db, group.groupId),
    };
  }).sort((left, right) => right.lastSentAt - left.lastSentAt);
  return {
    groups,
    today: todayCounts(db, nowUnix),
    expiringSoon: expiringSoon(db, nowUnix),
    maxCounted: MAX_COUNTED,
  };
};

const parseJson = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const newAiPictures = (db, groupId, mark) => db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT p.md5 FROM pictures p JOIN picture_files f ON f.md5 = p.md5 AND f.probe = 'ai'
    WHERE p.group_id = ? AND p.sent_at > ? AND p.sticker = 0 LIMIT ${MAX_COUNTED})
`).get(groupId, mark?.sentAt ?? 0).n;

// What the 消息 group list shows beyond the last message: what each group is
// talking about (its current AI brief), and what is new for you since your
// read mark -- @ / replies, AI pictures, answered questions.
const inboxExtras = (db, { groupIds, identity, nowUnix }) => {
  const mentions = directMentions(db, groupIds, identity.uins, nowUnix);
  const briefs = new Map(db.prepare(`
    SELECT group_id AS groupId, summary_json AS json FROM group_briefs
    WHERE group_id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(groupIds)).map((row) => [row.groupId, parseJson(row.json)]));
  return Object.fromEntries(groupIds.map((groupId) => {
    const mark = messageStore.getReadMark(db, groupId);
    const brief = briefs.get(groupId) ?? null;
    return [groupId, {
      topics: (brief?.topics ?? []).slice(0, 3).map((topic) => topic.title),
      qa: (brief?.qa ?? []).length,
      mentions: mentions.filter((item) => item.groupId === groupId).filter(afterMark(mark)).length,
      newAi: newAiPictures(db, groupId, mark),
    }];
  }));
};

module.exports = { railStatus, inboxExtras, beijingMidnight };
