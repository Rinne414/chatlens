"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const { personAcross } = require("../src/person_across");
const { personMessages } = require("../src/group_person");

const DAY = 86400;
const DAY0 = Date.parse("2026-09-01T00:00:00+08:00") / 1000;
const RANGE = { fromUnix: DAY0, toUnix: DAY0 + 3 * DAY };
const A = "100001";
const B = "100002";
const C = "100003";

const withStore = (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-person-across-"));
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
    insert.run({ rowId: String(nextRow), text: "x", isMedia: 0, isSelf: 0, atUins: "", replyTo: "", sentAt: DAY0 + 3600, ...row });
  }
  const name = db.prepare("INSERT OR REPLACE INTO group_names (group_id, name) VALUES (?, ?)");
  name.run(A, "A群");
  name.run(B, "B群");
  name.run(C, "C群");
};

// Alice (1) talks in A and B (and once in C, before the range); you (9) are
// in A and C. Bob (2) is her partner in both A and B; Dave (4) @s her in B
// and replies to Bob there; Carol (3) only talks with Bob.
const seed = (db) => insertAll(db, [
  { groupId: A, speaker: "Alice", uin: "1", replyTo: "2" },
  { groupId: A, speaker: "Bob", uin: "2", replyTo: "1", sentAt: DAY0 + 7200 },
  { groupId: A, speaker: "Carol", uin: "3", replyTo: "2" },
  { groupId: B, speaker: "Ali", uin: "1", replyTo: "2", sentAt: DAY0 + DAY },
  { groupId: B, speaker: "Ali", uin: "1", isMedia: 1, sentAt: DAY0 + DAY + 60 },
  { groupId: B, speaker: "Dave", uin: "4", atUins: "1", sentAt: DAY0 + DAY + 120 },
  { groupId: B, speaker: "Dave", uin: "4", replyTo: "2", sentAt: DAY0 + DAY + 180 },
  { groupId: C, speaker: "Alice in C", uin: "1", sentAt: DAY0 - 10 * DAY },
  { groupId: A, speaker: "Me", uin: "9", isSelf: 1 },
  { groupId: C, speaker: "Me", uin: "9", isSelf: 1, sentAt: DAY0 - 5 * DAY },
  // Stored before is_self was recorded: still you, still a shared group.
  { groupId: B, speaker: "Me", uin: "9", isSelf: 0, sentAt: DAY0 - 30 * DAY },
]);

test("the person across groups: latest name, groups with their name there, groups shared with you", () => {
  withStore((db) => {
    seed(db);
    const across = personAcross(db, "1", RANGE);
    assert.equal(across.person.name, "Ali");
    assert.equal(across.person.messages, 3);
    assert.equal(across.person.media, 1);
    assert.equal(across.person.groupsEver, 3);
    assert.equal(across.person.sharedWithMe, 3);
    assert.deepEqual(across.groups.map((group) => [group.groupId, group.groupName, group.name, group.messages]), [
      [B, "B群", "Ali", 2],
      [A, "A群", "Alice", 1],
      [C, "C群", "Alice in C", 0],
    ]);
  });
});

test("partners across groups say in which groups the two talk", () => {
  withStore((db) => {
    seed(db);
    const { partners } = personAcross(db, "1", RANGE);
    assert.deepEqual(partners.map((partner) => [partner.uin, partner.total, partner.groups.map((group) => [group.groupId, group.total])]), [
      ["2", 3, [[A, 2], [B, 1]]],
      ["4", 1, [[B, 1]]],
    ]);
  });
});

test("the network links the person's partners among themselves, across groups; strangers stay out", () => {
  withStore((db) => {
    seed(db);
    const { network } = personAcross(db, "1", RANGE);
    assert.deepEqual(network.people.map((person) => person.uin).sort(), ["1", "2", "4"]);
    assert.equal(network.people.find((person) => person.uin === "1").isFocus, true);
    assert.deepEqual(network.links.map((link) => `${link.a}-${link.b}:${link.total}`).sort(), ["1-2:3", "1-4:1", "2-4:1"]);
  });
});

test("the trend and the person's messages cover every group", () => {
  withStore((db) => {
    seed(db);
    const { trend } = personAcross(db, "1", RANGE);
    assert.deepEqual(trend.own, [1, 2, 0]);
    const page = personMessages(db, { groupId: null, uin: "1", ...RANGE });
    assert.deepEqual(page.items.map((item) => item.groupId), [B, B, A]);
  });
});

test("a bad QQ number is refused", () => {
  withStore((db) => {
    assert.throws(() => personAcross(db, "x", RANGE), /QQ 号无效/u);
  });
});
