"use strict";

// What a 角色卡 is built from: one person's own words in every group, each
// with what they were answering where that is known. No AI here.
//
// - exchanges: "someone said X, the person replied Y" (a quoted reply), spread
//   over the people they talk with, so how they treat each of them shows;
// - monologues: their longer messages, where views and ways of arguing show;
// - heldOut: exchanges kept away from the AI that writes the card, for the
//   blind test afterwards.

const messageStore = require("./message_store");

const DEFAULT_DAYS = 180;
const MAX_OWN_MESSAGES = 12000;
const MAX_EXCHANGES = 420;
const MAX_PER_PARTNER = 40;
const MAX_MONOLOGUES = 180;
const MONOLOGUE_MIN_CHARS = 25;
const HELD_OUT = 8;
// Enough of each side to tell a real reply from a written one.
const TEST_MIN_CHARS = 6;
const TEST_MAX_CHARS = 80;
const LINE_MAX_CHARS = 300;
const BATCH_MAX_CHARS = 9000;
const MAX_BATCHES = 6;

const length = (text) => [...String(text ?? "")].length;
const clip = (text) => {
  const chars = [...String(text ?? "").replace(/\s+/gu, " ").trim()];
  return chars.length > LINE_MAX_CHARS ? `${chars.slice(0, LINE_MAX_CHARS).join("")}…` : chars.join("");
};
// Sticker and picture placeholders say nothing about how someone talks.
const hasWords = (text) => /[\p{L}\p{N}]/u.test(String(text ?? "").replace(/\[[^\]]*\]|nt_\d+/gu, ""));

const ownMessages = (db, uin, fromUnix, toUnix) => db.prepare(`
  SELECT m.group_id AS groupId, COALESCE(NULLIF(n.name, ''), m.group_id) AS groupName, m.row_id AS rowId, m.sent_at AS sentAt,
         m.speaker, m.text, m.reply_to_seq AS replyToSeq, m.reply_to_uin AS replyToUin
  FROM messages m LEFT JOIN group_names n ON n.group_id = m.group_id
  WHERE m.speaker_uin = ? AND m.sent_at >= ? AND m.sent_at < ? AND m.is_media = 0
  ORDER BY m.sent_at DESC
  LIMIT ${MAX_OWN_MESSAGES}
`).all(String(uin), fromUnix, toUnix).filter((message) => hasWords(message.text));

// The person's quoted replies with the message each one answers.
const repliesWithOriginals = (db, messages) => {
  const byGroup = new Map();
  for (const message of messages.filter((item) => item.replyToSeq)) {
    byGroup.set(message.groupId, [...(byGroup.get(message.groupId) ?? []), message]);
  }
  const found = [];
  for (const [groupId, replies] of byGroup) {
    const originals = messageStore.repliedMessages(db, groupId, replies);
    for (const reply of replies) {
      const original = originals.get(reply.rowId);
      if (original !== undefined && original.isMedia !== 1 && hasWords(original.text)) {
        found.push({
          groupId, groupName: reply.groupName, rowId: reply.rowId, sentAt: reply.sentAt,
          partnerUin: String(reply.replyToUin ?? ""), partnerName: original.speaker,
          said: clip(original.text), reply: clip(reply.text),
        });
      }
    }
  }
  return found.sort((left, right) => right.sentAt - left.sentAt);
};

// Evenly through a list, so every stretch of time is represented.
const spread = (items, count) => {
  if (items.length <= count) {
    return items;
  }
  const step = items.length / count;
  return Array.from({ length: count }, (unused, index) => items[Math.floor(index * step)]);
};

// One per partner in turn, the people they answer most first, so one busy
// friendship cannot crowd out the rest.
const acrossPartners = (exchanges) => {
  const byPartner = new Map();
  for (const exchange of exchanges) {
    const key = exchange.partnerUin || exchange.partnerName;
    byPartner.set(key, [...(byPartner.get(key) ?? []), exchange]);
  }
  const queues = [...byPartner.values()].sort((left, right) => right.length - left.length).map((list) => spread(list, MAX_PER_PARTNER));
  const picked = [];
  for (let round = 0; picked.length < MAX_EXCHANGES && queues.some((queue) => round < queue.length); round += 1) {
    for (const queue of queues) {
      if (round < queue.length && picked.length < MAX_EXCHANGES) {
        picked.push(queue[round]);
      }
    }
  }
  return picked;
};

// A sticker or picture placeholder in the real reply would give it away in the test.
const PLACEHOLDER = /\[[^\]]*\]|nt_\d+/u;
const testable = (exchange) => length(exchange.said) >= TEST_MIN_CHARS && length(exchange.reply) >= TEST_MIN_CHARS
  && length(exchange.reply) <= TEST_MAX_CHARS && !PLACEHOLDER.test(exchange.reply);

const exchangeLine = (item) => `${item.id} [${item.groupName}] ${item.partnerName}：${item.said} → TA：${item.reply}`;
const monologueLine = (item) => `${item.id} [${item.groupName}] TA：${item.text}`;

// Lines into at most MAX_BATCHES texts of about BATCH_MAX_CHARS; what does not fit is left out and counted.
const toBatches = (lines) => {
  const batches = [];
  let current = [];
  let chars = 0;
  let left = 0;
  for (const line of lines) {
    if (chars + line.length > BATCH_MAX_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    if (batches.length >= MAX_BATCHES) {
      left += 1;
      continue;
    }
    current.push(line);
    chars += line.length + 1;
  }
  if (current.length > 0 && batches.length < MAX_BATCHES) {
    batches.push(current);
  }
  return { batches, left };
};

const gather = (db, { uin, now, days = DEFAULT_DAYS }) => {
  const fromUnix = now - days * 86400;
  const own = ownMessages(db, uin, fromUnix, now + 60);
  const replies = repliesWithOriginals(db, own);
  // Kept from the card's writer: spread over time, never among the sampled ones.
  const heldOut = spread(replies.filter(testable), HELD_OUT * 3).filter((unused, index) => index % 3 === 1).slice(0, HELD_OUT);
  const held = new Set(heldOut.map((item) => `${item.groupId}|${item.rowId}`));
  // Also where someone (the person included) quotes a held-back reply: its words would be in the material.
  const heldWords = new Set(heldOut.map((item) => item.reply));
  const exchanges = acrossPartners(replies.filter((item) => !held.has(`${item.groupId}|${item.rowId}`) && !heldWords.has(item.said)))
    .map((item, index) => ({ ...item, id: `E${index + 1}` }));
  const quoted = new Set(replies.map((item) => `${item.groupId}|${item.rowId}`));
  const monologues = spread(
    own.filter((message) => !quoted.has(`${message.groupId}|${message.rowId}`) && length(message.text) >= MONOLOGUE_MIN_CHARS),
    MAX_MONOLOGUES,
  ).map((message, index) => ({ id: `M${index + 1}`, groupId: message.groupId, groupName: message.groupName, rowId: message.rowId, sentAt: message.sentAt, text: clip(message.text) }));
  // Mixed, so every batch holds both kinds and several groups.
  const lines = [];
  for (let index = 0; index < Math.max(exchanges.length, monologues.length); index += 1) {
    if (index < exchanges.length) {
      lines.push(exchangeLine(exchanges[index]));
    }
    if (index < monologues.length) {
      lines.push(monologueLine(monologues[index]));
    }
  }
  const { batches, left } = toBatches(lines);
  const shown = batches.flat();
  const names = [...new Set(own.map((message) => message.speaker).filter(Boolean))];
  // A very busy person fills the limit before the range is through: say how far back it really went.
  const oldest = own.length === 0 ? now : own[own.length - 1].sentAt;
  const reached = own.length >= MAX_OWN_MESSAGES ? Math.max(1, Math.ceil((now - oldest) / 86400)) : days;
  return {
    uin: String(uin),
    names,
    days: reached,
    range: { fromUnix: own.length >= MAX_OWN_MESSAGES ? oldest : fromUnix, toUnix: now },
    exchanges,
    monologues,
    heldOut: heldOut.map((item, index) => ({ ...item, n: index + 1 })),
    batches,
    // exchanges / monologues: the ones the AI is shown (what did not fit is leftOut).
    stats: {
      ownMessages: own.length, replies: replies.length,
      exchanges: shown.filter((line) => line.startsWith("E")).length, monologues: shown.filter((line) => line.startsWith("M")).length,
      leftOut: left, groups: new Set(own.map((message) => message.groupId)).size,
    },
  };
};

// Too little to say anything about a person from.
const MIN_OWN_MESSAGES = 60;
const enough = (material) => material.stats.ownMessages >= MIN_OWN_MESSAGES && material.batches.length > 0;

module.exports = { gather, enough, DEFAULT_DAYS, MIN_OWN_MESSAGES, HELD_OUT, TEST_MAX_CHARS };
