"use strict";

// Messages QQ writes into its database late.
//
// QQ often stores part of a busy group's messages minutes to hours after they
// were sent (catching up after a reconnect or a restart), so the refresh that
// read up to "now" has already passed their time when they appear, and the
// next one only reads back OVERLAP_SECONDS. Measured on 2026-10-30: every one
// of the 246 picture messages of a week that never reached the gallery had
// been written by QQ after the last refresh covering its minute, 10 minutes
// to 2 days late; 1,540 picture messages over 31 days were missing, older
// coverage gaps included. The one-time re-read brought that to 0.
//
// So each refresh also reads the last LATE_REREAD_SECONDS again (about 3 s)
// and stores only what the store does not have yet. Beyond that window (16 of
// 2,619 missing picture messages were written more than 48 h late; most of
// the rest fell in hours no refresh covered: the computer off, a group not
// watched yet), the 31 days Tencent still serves pictures for are read again
// one slice per refresh: right after upgrading, then every RECOVERY_REPEAT_SECONDS.

const { REMOTE_LIFETIME_SECONDS } = require("./picture_store");
const { lightCleanText } = require("./message_store");

const LATE_REREAD_SECONDS = 48 * 3600;
const RECOVERY_KEY = "late_messages_recovery_v1";
const RECOVERY_SLICE_SECONDS = 3 * 24 * 3600;
// A slice some group could not be read through (a damaged page in the copy,
// the scan limit) is tried again on the next refreshes, then given up on.
const RECOVERY_TRIES = 3;
const RECOVERY_REPEAT_SECONDS = 7 * 24 * 3600;

// The part of an export the store does not hold yet: text messages whose row
// is missing (one with no text is never stored, so it never counts), media
// messages whose row or any of whose pictures is missing.
// No coverage is recorded for it (groupIds emptied): the regular export
// already covers these windows.
const unstoredPart = (db, exportData) => {
  const hasMessage = db.prepare("SELECT 1 FROM messages WHERE group_id = ? AND row_id = ?");
  const hasPicture = db.prepare("SELECT 1 FROM pictures WHERE group_id = ? AND row_id = ? AND seq = ?");
  const messages = (exportData.messages ?? [])
    .filter((message) => lightCleanText(message.text).length > 0)
    .filter((message) => hasMessage.get(String(message.groupId), String(message.rowId)) === undefined);
  const mediaMessages = (exportData.mediaMessages ?? []).filter((message) => {
    const groupId = String(message.groupId);
    const rowId = `m${message.rowId}`;
    return hasMessage.get(groupId, rowId) === undefined
      || (message.pictures ?? []).some((picture, index) => hasPicture.get(groupId, rowId, picture.seq ?? index) === undefined);
  });
  return { ...exportData, groupIds: [], messages, mediaMessages };
};

// The next recovery slice { fromUnix, toUnix }, newest first, or null while
// the last full pass is less than RECOVERY_REPEAT_SECONDS old.
const recoverySlice = (saved, now) => {
  const restart = saved?.done === true && now - (Number(saved.at) || 0) >= RECOVERY_REPEAT_SECONDS;
  if (saved?.done === true && !restart) {
    return null;
  }
  const floor = now - REMOTE_LIFETIME_SECONDS;
  const cursor = restart ? NaN : Number(saved?.cursor);
  const toUnix = Number.isFinite(cursor) && cursor > 0 ? Math.min(cursor, now - LATE_REREAD_SECONDS) : now - LATE_REREAD_SECONDS;
  if (toUnix <= floor) {
    return null;
  }
  return { fromUnix: Math.max(floor, toUnix - RECOVERY_SLICE_SECONDS), toUnix };
};

// What to remember once a slice has been stored; `complete` is false when
// the export could not read some group through.
const recoveryStateAfter = (slice, now, { complete = true, saved = null } = {}) => {
  const tries = Number(saved?.tries) || 0;
  if (!complete && tries + 1 < RECOVERY_TRIES) {
    return { cursor: slice.toUnix, tries: tries + 1 };
  }
  return slice.fromUnix <= now - REMOTE_LIFETIME_SECONDS ? { done: true, at: now } : { cursor: slice.fromUnix };
};

module.exports = {
  LATE_REREAD_SECONDS, RECOVERY_KEY, RECOVERY_SLICE_SECONDS, RECOVERY_TRIES, RECOVERY_REPEAT_SECONDS,
  unstoredPart, recoverySlice, recoveryStateAfter,
};
