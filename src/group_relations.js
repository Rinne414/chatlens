"use strict";

// 群 → 关系网: who replies to and @-mentions whom in one group over a date
// range, from the reply target and @ targets stored with each message (no
// AI). A link is one pair of people with both directions counted apart, so
// the page can say "A 回 B 12 次，B 回 A 3 次". Lists are complete; the page
// decides how many people to draw.

const splitUins = (value) => String(value ?? "").split(",").filter((uin) => uin !== "");

const pairKey = (left, right) => (left < right ? `${left}|${right}` : `${right}|${left}`);

// Adds one directed interaction to the pair's link.
const countInto = (links, from, to, kind, count) => {
  if (from === "" || to === "" || from === to) {
    return;
  }
  const key = pairKey(from, to);
  const [a, b] = key.split("|");
  const link = links.get(key) ?? { a, b, aToB: { replies: 0, ats: 0 }, bToA: { replies: 0, ats: 0 }, total: 0 };
  const direction = from === a ? link.aToB : link.bToA;
  direction[kind] += count;
  link.total += count;
  links.set(key, link);
};

const collectLinks = (db, groupId, { fromUnix, toUnix }) => {
  const links = new Map();
  const replies = db.prepare(`
    SELECT speaker_uin AS source, reply_to_uin AS target, COUNT(*) AS n
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND reply_to_uin <> ''
    GROUP BY speaker_uin, reply_to_uin
  `).all(groupId, fromUnix, toUnix);
  for (const row of replies) {
    countInto(links, row.source, row.target, "replies", row.n);
  }
  const mentions = db.prepare(`
    SELECT speaker_uin AS source, at_uins AS targets
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND at_uins <> ''
  `).all(groupId, fromUnix, toUnix);
  for (const row of mentions) {
    for (const target of splitUins(row.targets)) {
      countInto(links, row.source, target, "ats", 1);
    }
  }
  return [...links.values()].sort((left, right) => right.total - left.total || left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
};

// Each person's latest name in this group (people replied to or @'d who did
// not speak in the range, or anyone the page names). Unknown ones are left out.
const latestNames = (db, groupId, uins) => {
  if (uins.length === 0) {
    return new Map();
  }
  const rows = db.prepare(`
    SELECT speaker_uin AS uin, speaker AS name, MAX(sent_at) AS lastAt
    FROM messages WHERE group_id = ? AND speaker_uin IN (${uins.map(() => "?").join(",")}) AND speaker <> ''
    GROUP BY speaker_uin
  `).all(groupId, ...uins);
  return new Map(rows.map((row) => [row.uin, row.name]));
};

// Everyone who spoke in the range -> the name they used last in it. (SQLite
// takes a bare column from the row that holds the single MAX().)
const rangeNames = (db, groupId, { fromUnix, toUnix }) => new Map(db.prepare(`
  SELECT speaker_uin AS uin, speaker AS name, MAX(sent_at) AS lastAt
  FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND speaker_uin <> '' AND speaker <> ''
  GROUP BY speaker_uin
`).all(groupId, fromUnix, toUnix).map((row) => [row.uin, row.name]));

const relationMap = (db, groupId, range) => {
  const id = String(groupId);
  const links = collectLinks(db, id, range);
  const speakers = db.prepare(`
    SELECT speaker_uin AS uin, COUNT(*) AS messages, MAX(is_self) AS isSelf
    FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND speaker_uin <> ''
    GROUP BY speaker_uin
  `).all(id, range.fromUnix, range.toUnix);
  const spokenNames = rangeNames(db, id, range);
  const people = new Map(speakers.map((row) => [row.uin, {
    uin: row.uin, name: spokenNames.get(row.uin) ?? row.uin, messages: row.messages, isSelf: row.isSelf === 1, sent: 0, received: 0,
  }]));
  const silent = [...new Set(links.flatMap((link) => [link.a, link.b]))].filter((uin) => !people.has(uin));
  const names = latestNames(db, id, silent);
  for (const uin of silent) {
    people.set(uin, { uin, name: names.get(uin) ?? uin, messages: 0, isSelf: false, sent: 0, received: 0 });
  }
  for (const link of links) {
    const a = people.get(link.a);
    const b = people.get(link.b);
    const aSent = link.aToB.replies + link.aToB.ats;
    const bSent = link.bToA.replies + link.bToA.ats;
    a.sent += aSent;
    a.received += bSent;
    b.sent += bSent;
    b.received += aSent;
  }
  return {
    people: [...people.values()].sort((left, right) => (right.sent + right.received) - (left.sent + left.received) || right.messages - left.messages),
    links,
  };
};

module.exports = { relationMap, collectLinks, countInto, latestNames, rangeNames, splitUins };
