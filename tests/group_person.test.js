"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { personProfile, personMessages } = require("../src/group_person");

const DAY = 86400;
// 2026-09-01 00:00 Beijing.
const DAY0 = Date.parse("2026-09-01T00:00:00+08:00") / 1000;

const withStore = (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-person-"));
  const db = messageStore.openStore(path.join(tempDir, "messages.db"));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

let nextRow = 100;
const insertAll = (db, rows) => {
  const insert = db.prepare(`
    INSERT INTO messages (group_id, row_id, sent_at, speaker, text, is_media, speaker_uin, is_self, at_uins, reply_to_uin)
    VALUES (@groupId, @rowId, @sentAt, @speaker, @text, @isMedia, @uin, @isSelf, @atUins, @replyTo)
  `);
  for (const row of rows) {
    nextRow += 1;
    insert.run({ groupId: "100001", rowId: String(nextRow), text: "x", isMedia: 0, isSelf: 0, atUins: "", replyTo: "", ...row });
  }
};

const range = (days) => ({ fromUnix: DAY0, toUnix: DAY0 + days * DAY });

test("profile: counts, active days, Beijing hours, first and last message, latest name", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Old name", uin: "1", sentAt: DAY0 - 5 * DAY },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 9 * 3600 },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 9 * 3600 + 60, isMedia: 1 },
      { speaker: "Alice2", uin: "1", sentAt: DAY0 + DAY + 23 * 3600 },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + 3600 },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 3600, groupId: "100002" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 - 3600, groupId: "100003" },
    ]);
    db.prepare("INSERT INTO group_names (group_id, name) VALUES ('100002', 'Other group')").run();
    const profile = personProfile(db, "100001", "1", range(7));
    assert.deepEqual(profile.otherGroups, [{ groupId: "100002", name: "Other group", messages: 1 }]);
    assert.deepEqual(profile.person, {
      uin: "1", name: "Alice2", isSelf: false, messages: 3, media: 1, activeDays: 2,
      firstAt: DAY0 + 9 * 3600, lastAt: DAY0 + DAY + 23 * 3600, firstEverAt: DAY0 - 5 * DAY,
    });
    assert.equal(profile.hours[9], 2);
    assert.equal(profile.hours[23], 1);
    assert.equal(profile.hours.reduce((sum, value) => sum + value, 0), 3);
  });
});

test("partners count both directions; the daily trend follows each pair and the person's own messages", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 100, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + DAY + 100, replyTo: "2" },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + DAY + 200, replyTo: "1" },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + 2 * DAY + 200, atUins: "1,3" },
      { speaker: "Carol", uin: "3", sentAt: DAY0 + 2 * DAY + 300, replyTo: "1" },
      { speaker: "Carol", uin: "3", sentAt: DAY0 + 2 * DAY + 400, replyTo: "2" },
    ]);
    const profile = personProfile(db, "100001", "1", range(3));
    assert.deepEqual(profile.partners, [
      { uin: "2", name: "Bob", out: { replies: 2, ats: 0 }, back: { replies: 1, ats: 1 }, total: 4 },
      { uin: "3", name: "Carol", out: { replies: 0, ats: 0 }, back: { replies: 1, ats: 0 }, total: 1 },
    ]);
    assert.equal(profile.trend.unit, "day");
    assert.deepEqual(profile.trend.starts, [DAY0, DAY0 + DAY, DAY0 + 2 * DAY]);
    assert.deepEqual(profile.trend.series, [
      { uin: "2", name: "Bob", values: [1, 2, 1] },
      { uin: "3", name: "Carol", values: [0, 0, 1] },
    ]);
    assert.deepEqual(profile.trend.own, [1, 1, 0]);
  });
});

test("rising and falling compare the second half of the range with the first", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 100, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 200, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 3 * DAY, replyTo: "3" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 3 * DAY + 5, replyTo: "3" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 3 * DAY + 9, replyTo: "3" },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + 5 },
      { speaker: "Carol", uin: "3", sentAt: DAY0 + 5 },
    ]);
    const { changes } = personProfile(db, "100001", "1", range(4));
    assert.deepEqual(changes.rising, [{ uin: "3", name: "Carol", before: 0, after: 3 }]);
    assert.deepEqual(changes.falling, [{ uin: "2", name: "Bob", before: 2, after: 0 }]);
  });
});

test("ranges longer than a month are bucketed by week", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 100, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 8 * DAY, replyTo: "2" },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + 5 },
    ]);
    const { trend } = personProfile(db, "100001", "1", range(40));
    assert.equal(trend.unit, "week");
    assert.equal(trend.starts.length, 6);
    assert.deepEqual(trend.series[0].values, [1, 1, 0, 0, 0, 0]);
  });
});

test("the person's messages page newest first, all the way back", () => {
  withStore((db) => {
    insertAll(db, [1, 2, 3, 4, 5].map((index) => ({ speaker: "Alice", uin: "1", sentAt: DAY0 + index * 60, text: `m${index}` })));
    insertAll(db, [{ speaker: "Bob", uin: "2", sentAt: DAY0 + 30, text: "not hers" }]);
    const first = personMessages(db, { groupId: "100001", uin: "1", ...range(1), limit: 2 });
    assert.deepEqual(first.items.map((item) => item.text), ["m5", "m4"]);
    assert.equal(first.hasMore, true);
    const last = first.items.at(-1);
    const rest = personMessages(db, { groupId: "100001", uin: "1", ...range(1), limit: 10, beforeSentAt: last.sentAt, beforeRowId: last.rowId });
    assert.deepEqual(rest.items.map((item) => item.text), ["m3", "m2", "m1"]);
    assert.equal(rest.hasMore, false);
  });
});

test("an invalid group or person is refused", () => {
  withStore((db) => {
    assert.throws(() => personProfile(db, "abc", "1", range(1)), /群号无效/u);
    assert.throws(() => personProfile(db, "100001", "", range(1)), /QQ 号无效/u);
  });
});

test("a range of up to two days is bucketed by hour", () => {
  withStore((db) => {
    insertAll(db, [
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 9 * 3600 + 5, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 9 * 3600 + 50, replyTo: "2" },
      { speaker: "Alice", uin: "1", sentAt: DAY0 + 20 * 3600, replyTo: "2" },
      { speaker: "Bob", uin: "2", sentAt: DAY0 + 5 },
    ]);
    const { trend } = personProfile(db, "100001", "1", range(1));
    assert.equal(trend.unit, "hour");
    assert.equal(trend.starts.length, 24);
    assert.equal(trend.series[0].values[9], 2);
    assert.equal(trend.series[0].values[20], 1);
  });
});
