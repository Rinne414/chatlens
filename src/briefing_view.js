"use strict";

// Assembles the home-page briefing from what the background refresh already
// prepared: per-group briefs, "跟我有关" mentions, cross-group highlights and
// the images people asked about. Pure reads — nothing here calls the LLM.

const fs = require("node:fs");
const Database = require("better-sqlite3-multiple-ciphers");
const messageStore = require("./message_store");
const briefingStore = require("./briefing_store");

const MAX_NEW_THINGS = 12;
const MAX_QA = 10;
const MAX_HOT_TOPICS = 8;
const MAX_IMAGES = 12;
const MAX_IMAGE_CANDIDATES = 60;
const MAX_MENTIONS = 40;
const IMPORTANCE_RANK = { high: 3, medium: 2, low: 1 };

const groupActivity = (db, fromUnix, toUnix) =>
  db.prepare(`
    SELECT m.group_id AS groupId, COALESCE(n.name, '') AS name,
           SUM(CASE WHEN m.is_media = 0 THEN 1 ELSE 0 END) AS textMessages,
           SUM(CASE WHEN m.is_media = 1 THEN 1 ELSE 0 END) AS mediaMessages,
           COUNT(DISTINCT m.speaker) AS speakers,
           MAX(m.sent_at) AS lastSentAt
    FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
    WHERE m.sent_at >= ? AND m.sent_at < ?
    GROUP BY m.group_id
  `).all(fromUnix, toUnix);

const unsummarizedCount = (db, groupId, fromUnix) => {
  const boundary = briefingStore.lastChunkBoundary(db, groupId);
  if (boundary === null || boundary.sentAt < fromUnix) {
    return db.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND is_media = 0 AND sent_at >= ?")
      .get(String(groupId), fromUnix).n;
  }
  return db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND is_media = 0
      AND (sent_at > ? OR (sent_at = ? AND CAST(row_id AS INTEGER) > CAST(? AS INTEGER)))
  `).get(String(groupId), boundary.sentAt, boundary.sentAt, boundary.rowId).n;
};

const withGroup = (group) => (item) => ({ ...item, groupId: group.groupId, groupName: group.name });

const crossGroupHighlights = (groups) => {
  const briefed = groups.filter((group) => group.brief !== null);
  const newThings = briefed.flatMap((group) => (group.brief.newThings ?? []).map(withGroup(group)));
  const qa = briefed
    .flatMap((group) => (group.brief.qa ?? []).map(withGroup(group)))
    .sort((left, right) => Number(right.resolved) - Number(left.resolved));
  const hotTopics = briefed
    .flatMap((group) => (group.brief.topics ?? []).map(withGroup(group)))
    .filter((topic) => topic.importance !== "low")
    .sort((left, right) =>
      (IMPORTANCE_RANK[right.importance] ?? 0) - (IMPORTANCE_RANK[left.importance] ?? 0)
      || (right.messageCountEstimate ?? 0) - (left.messageCountEstimate ?? 0));
  return {
    newThings: newThings.slice(0, MAX_NEW_THINGS),
    qa: qa.slice(0, MAX_QA),
    hotTopics: hotTopics.slice(0, MAX_HOT_TOPICS).map((topic) => ({
      title: topic.title,
      summary: topic.summary,
      importance: topic.importance,
      messageCountEstimate: topic.messageCountEstimate,
      groupId: topic.groupId,
      groupName: topic.groupName,
    })),
  };
};

// AI images seen in the window, most-asked-about first ("求tag"/"看看原图"
// asks are the clearest sign people liked a picture), then newest.
// `isAvailable(hash)` drops pictures QQ has already evicted from its cache —
// a popular image nobody can see is worse than a less popular visible one.
const popularImages = (knowledgeDbPath, fromUnix, toUnix, isAvailable = () => true) => {
  if (!fs.existsSync(knowledgeDbPath)) {
    return [];
  }
  const db = new Database(knowledgeDbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT s.hash, s.group_id AS groupId, s.group_name AS groupName, s.speaker, MIN(s.sent_at) AS sentAt,
             i.width, i.height, i.checkpoint,
             (SELECT COUNT(*) FROM prompt_requests p WHERE p.image_hash = s.hash) AS asks,
             (SELECT COUNT(*) FROM sightings s2 WHERE s2.hash = s.hash) AS sightings
      FROM sightings s JOIN images i ON i.hash = s.hash
      WHERE s.sent_at >= ? AND s.sent_at < ?
      GROUP BY s.hash
      -- Metadata-less ("stripped") pictures are mostly reaction stickers
      -- reposted all day; keep one only if someone asked for its prompt.
      HAVING i.generator <> 'stripped' OR asks > 0
      ORDER BY asks DESC, sentAt DESC
      LIMIT ${MAX_IMAGE_CANDIDATES}
    `).all(fromUnix, toUnix).filter((image) => isAvailable(image.hash)).slice(0, MAX_IMAGES);
  } catch {
    // An older knowledge.db without these tables simply has no gallery yet.
    return [];
  } finally {
    db.close();
  }
};

const buildBriefing = ({ db, knowledgeDbPath, watchlist, nowUnix, extraSelfUins = [], status = {}, isImageAvailable }) => {
  briefingStore.ensureBriefingSchema(db);
  const windowStart = Number(briefingStore.getState(db, "briefing_since", nowUnix - 24 * 3600));
  const watchNames = new Map(watchlist.map((item) => [item.groupId, item.name ?? ""]));
  const activity = groupActivity(db, windowStart, nowUnix + 60);
  const activityById = new Map(activity.map((row) => [row.groupId, row]));
  const groupIds = [...new Set([...watchlist.map((item) => item.groupId), ...activity.map((row) => row.groupId)])];

  const groups = groupIds.map((groupId) => {
    const row = activityById.get(groupId);
    const stored = briefingStore.getGroupBrief(db, groupId);
    const brief = stored !== null && stored.windowStart === windowStart ? stored.summary : null;
    return {
      groupId,
      name: row?.name || watchNames.get(groupId) || groupId,
      watched: watchNames.has(groupId),
      textMessages: row?.textMessages ?? 0,
      mediaMessages: row?.mediaMessages ?? 0,
      speakers: row?.speakers ?? 0,
      lastSentAt: row?.lastSentAt ?? null,
      unsummarized: unsummarizedCount(db, groupId, windowStart),
      brief,
    };
  }).sort((left, right) => (right.textMessages + right.mediaMessages) - (left.textMessages + left.mediaMessages));

  const identity = messageStore.getSelfIdentity(db, extraSelfUins);
  const mentions = messageStore.getMentions(db, { fromUnix: windowStart, toUnix: nowUnix + 60, identity, limit: MAX_MENTIONS });
  const chunkStats = briefingStore.chunkStatsInWindow(db, windowStart);

  return {
    windowStart,
    now: nowUnix,
    identity: { known: identity.uins.length > 0, names: identity.names },
    totals: {
      groups: groups.filter((group) => group.textMessages + group.mediaMessages > 0).length,
      textMessages: groups.reduce((total, group) => total + group.textMessages, 0),
      mediaMessages: groups.reduce((total, group) => total + group.mediaMessages, 0),
      unsummarized: groups.reduce((total, group) => total + group.unsummarized, 0),
      queuedChunks: chunkStats.reduce((total, row) => total + row.queued, 0),
      failedChunks: chunkStats.reduce((total, row) => total + row.failed, 0),
    },
    mentions,
    highlights: crossGroupHighlights(groups),
    images: popularImages(knowledgeDbPath, windowStart, nowUnix + 60, isImageAvailable),
    groups: groups.map(({ brief, ...group }) => ({
      ...group,
      summary: brief?.summary ?? null,
      topics: (brief?.topics ?? []).slice(0, 4).map((topic) => topic.title),
      coverage: brief?.coverage ?? null,
    })),
    status,
  };
};

module.exports = { buildBriefing, crossGroupHighlights };
