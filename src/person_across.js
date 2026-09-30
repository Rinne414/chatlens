"use strict";

// 群 → 个人页 → 「看 TA 在所有群」: one person across every stored group, for
// the dates the page shows. Many friends sit in the same few groups (on the
// user's data: 961 people spoke in 2+ watched groups in 30 days, 69 in 5+),
// so this page puts together: the groups they talk in and the name they use
// in each, the groups they share with you, whom they talk with anywhere (and
// in which groups each pair talks), how that changes over time, and their
// own network: their partners and how those partners talk among themselves,
// across groups. From stored messages only; about four range / index reads.

const { interactions, trendOf, changesOf, UIN } = require("./group_person");
const { countInto, splitUins } = require("./group_relations");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const DAY_SECONDS = 86400;

const beijingDayOf = (unix) => Math.floor((unix + BEIJING_OFFSET_SECONDS) / DAY_SECONDS);
const beijingHourOf = (unix) => Math.floor(((unix + BEIJING_OFFSET_SECONDS) % DAY_SECONDS) / 3600);

const groupNames = (db) => new Map(db.prepare("SELECT group_id AS groupId, name FROM group_names").all()
  .map((row) => [row.groupId, row.name || row.groupId]));

// Every group the person ever spoke in: groupId -> { name used last, lastAt, total }.
const groupsEver = (db, uin) => new Map(db.prepare(`
  SELECT group_id AS groupId, speaker AS name, MAX(sent_at) AS lastAt, COUNT(*) AS total
  FROM messages WHERE speaker_uin = ? GROUP BY group_id
`).all(uin).map((row) => [row.groupId, row]));

// Your own QQ numbers (is_self rows, through their index) and every group
// you spoke in: rows stored before is_self was recorded have it 0, so the
// groups come from your QQ numbers, not from the flag.
const selfFacts = (db) => {
  const uins = db.prepare("SELECT DISTINCT speaker_uin AS uin FROM messages WHERE is_self = 1 AND speaker_uin <> ''").all().map((row) => row.uin);
  const groups = uins.length === 0 ? [] : db.prepare(`SELECT DISTINCT group_id AS groupId FROM messages WHERE speaker_uin IN (${uins.map(() => "?").join(",")})`).all(...uins);
  return { uins: new Set(uins), groups: new Set(groups.map((row) => row.groupId)) };
};

// The latest of a set of { sentAt, name } rows, per key.
const latestBy = (rows, keyOf) => {
  const latest = new Map();
  for (const row of rows) {
    const known = latest.get(keyOf(row));
    if (row.name && (known === undefined || row.sentAt > known.sentAt)) {
      latest.set(keyOf(row), row);
    }
  }
  return new Map([...latest].map(([key, row]) => [key, row.name]));
};

const personSummary = ({ uin, ownRows, ever, self, names }) => {
  const lastSeen = [...ever.values()].sort((left, right) => right.lastAt - left.lastAt)[0];
  const sentAts = ownRows.map((row) => row.sentAt);
  return {
    uin,
    name: names.get(uin) ?? lastSeen?.name ?? uin,
    isSelf: self.uins.has(uin),
    messages: ownRows.length,
    media: ownRows.filter((row) => row.isMedia).length,
    activeDays: new Set(sentAts.map(beijingDayOf)).size,
    firstAt: sentAts.length > 0 ? Math.min(...sentAts) : null,
    lastAt: sentAts.length > 0 ? Math.max(...sentAts) : null,
    groupsInRange: new Set(ownRows.map((row) => row.groupId)).size,
    groupsEver: ever.size,
    sharedWithMe: [...ever.keys()].filter((groupId) => self.groups.has(groupId)).length,
  };
};

// Each group they ever spoke in, busiest in the range first.
const groupList = ({ ownRows, ever, titles }) => {
  const inRange = new Map();
  for (const row of ownRows) {
    inRange.set(row.groupId, (inRange.get(row.groupId) ?? 0) + 1);
  }
  const nameThere = latestBy(ownRows, (row) => row.groupId);
  return [...ever.values()].map((group) => ({
    groupId: group.groupId,
    groupName: titles.get(group.groupId) ?? group.groupId,
    name: nameThere.get(group.groupId) ?? group.name,
    messages: inRange.get(group.groupId) ?? 0,
    lastAt: group.lastAt,
  })).sort((left, right) => right.messages - left.messages || right.lastAt - left.lastAt);
};

// Everyone they talk with, with the groups each pair talks in.
const partnerList = (events, names, titles) => {
  const byPartner = new Map();
  for (const event of events) {
    const partner = byPartner.get(event.partner) ?? {
      uin: event.partner, name: names.get(event.partner) ?? event.partner,
      out: { replies: 0, ats: 0 }, back: { replies: 0, ats: 0 }, total: 0, byGroup: new Map(),
    };
    partner[event.direction][event.kind] += 1;
    partner.total += 1;
    partner.byGroup.set(event.groupId, (partner.byGroup.get(event.groupId) ?? 0) + 1);
    byPartner.set(event.partner, partner);
  }
  return [...byPartner.values()]
    .sort((left, right) => right.total - left.total || left.uin.localeCompare(right.uin))
    .map(({ byGroup, ...partner }) => ({
      ...partner,
      groups: [...byGroup].map(([groupId, total]) => ({ groupId, groupName: titles.get(groupId) ?? groupId, total }))
        .sort((left, right) => right.total - left.total),
    }));
};

// The person, their partners, and every reply / @ among all of them in the
// range, whatever the group: the same shape as the 群 page's 关系网.
const networkOf = (db, uin, partners, range, selfUins) => {
  const members = [uin, ...partners.map((partner) => partner.uin)];
  const memberSet = new Set(members);
  const rows = db.prepare(`
    SELECT speaker_uin AS source, speaker AS name, sent_at AS sentAt, reply_to_uin AS target, at_uins AS ats
    FROM messages WHERE sent_at >= ? AND sent_at < ? AND speaker_uin IN (${members.map(() => "?").join(",")})
  `).all(range.fromUnix, range.toUnix, ...members);
  const links = new Map();
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
    if (memberSet.has(row.target)) {
      countInto(links, row.source, row.target, "replies", 1);
    }
    for (const target of splitUins(row.ats).filter((item) => memberSet.has(item))) {
      countInto(links, row.source, target, "ats", 1);
    }
  }
  const names = latestBy(rows.map((row) => ({ ...row, key: row.source })), (row) => row.key);
  const people = new Map(members.map((member) => [member, {
    uin: member, name: names.get(member) ?? member, messages: counts.get(member) ?? 0,
    isSelf: selfUins.has(member), isFocus: member === uin, sent: 0, received: 0,
  }]));
  const sorted = [...links.values()].sort((left, right) => right.total - left.total || left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
  for (const link of sorted) {
    people.get(link.a).sent += link.aToB.replies + link.aToB.ats;
    people.get(link.a).received += link.bToA.replies + link.bToA.ats;
    people.get(link.b).sent += link.bToA.replies + link.bToA.ats;
    people.get(link.b).received += link.aToB.replies + link.aToB.ats;
  }
  return {
    people: [...people.values()].sort((left, right) => (right.sent + right.received) - (left.sent + left.received) || right.messages - left.messages),
    links: sorted,
    names,
  };
};

// Names of people who did not speak in the range (someone replied to them):
// their latest name in any group.
const namesAnyGroup = (db, uins) => (uins.length === 0 ? new Map() : new Map(db.prepare(`
  SELECT speaker_uin AS uin, speaker AS name, MAX(sent_at) AS lastAt
  FROM messages WHERE speaker_uin IN (${uins.map(() => "?").join(",")}) AND speaker <> ''
  GROUP BY speaker_uin
`).all(...uins).map((row) => [row.uin, row.name])));

const personAcross = (db, uin, range) => {
  const who = String(uin);
  if (!UIN.test(who)) {
    throw new Error("QQ 号无效。");
  }
  const titles = groupNames(db);
  const self = selfFacts(db);
  const ever = groupsEver(db, who);
  const found = interactions(db, null, who, range);
  const partnerUins = [...new Set(found.events.map((event) => event.partner))];
  const spoke = latestBy(found.ownRows, () => who);
  const draftPartners = partnerList(found.events, new Map(), titles);
  const network = networkOf(db, who, draftPartners, range, self.uins);
  const missing = partnerUins.filter((partner) => !network.names.has(partner));
  const names = new Map([...namesAnyGroup(db, missing), ...network.names, ...spoke]);
  const partners = draftPartners.map((partner) => ({ ...partner, name: names.get(partner.uin) ?? partner.uin }));
  const people = network.people.map((person) => ({ ...person, name: names.get(person.uin) ?? person.name }));
  const hours = new Array(24).fill(0);
  for (const row of found.ownRows) {
    hours[beijingHourOf(row.sentAt)] += 1;
  }
  return {
    uin: who,
    range,
    person: personSummary({ uin: who, ownRows: found.ownRows, ever, self, names }),
    groups: groupList({ ownRows: found.ownRows, ever, titles }),
    hours,
    partners,
    trend: trendOf(found, partners, range),
    changes: changesOf(found.events, partners, range),
    network: { people, links: network.links },
  };
};

module.exports = { personAcross };
