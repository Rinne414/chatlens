"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3-multiple-ciphers");
const { artistTrends, artistName } = require("../src/artist_trends");

const DAY = 86400;
const T0 = 1_800_000_000;

// The message store with the prompt library attached as kb, as the server opens it.
const openDb = () => {
  const db = new Database(":memory:");
  db.prepare("ATTACH DATABASE ':memory:' AS kb").run();
  db.exec(`
    CREATE TABLE kb.image_tags (hash TEXT, tag TEXT, source TEXT, PRIMARY KEY (hash, tag));
    CREATE INDEX kb.idx_image_tags_tag ON image_tags(tag);
    CREATE TABLE kb.sightings (hash TEXT, group_id TEXT, row_id TEXT, sent_at INTEGER, speaker TEXT, speaker_uin TEXT, group_name TEXT);
  `);
  let row = 0;
  const post = (hash, tags, at, { uin = "10001", groupId = "11111" } = {}) => {
    for (const tag of tags) {
      db.prepare("INSERT OR IGNORE INTO kb.image_tags VALUES (?, ?, 'prompt')").run(hash, tag);
    }
    row += 1;
    db.prepare("INSERT INTO kb.sightings VALUES (?, ?, ?, ?, 'x', ?, 'g')").run(hash, groupId, String(row), at, uin);
  };
  return { db, post };
};

const range = { fromUnix: T0, toUnix: T0 + 7 * DAY };

test("an artist's name is the same however it is written", () => {
  assert.equal(artistName("artist:Chen_Bin"), "chen bin");
  assert.equal(artistName("by  chen bin"), "chen bin");
  assert.equal(artistName("chen_bin"), "chen bin");
  assert.equal(artistName("artist:reoen::"), "reoen");
  assert.equal(artistName("0.28::artist:rolua::"), "rolua");
  assert.equal(artistName("@rolua"), "rolua");
});

test("pictures per artist now against the stretch before, the fastest riser first", () => {
  const { db, post } = openDb();
  // before: wlop on 3 pictures, rella on 1
  post("a1", ["artist:wlop", "1girl"], T0 - 3 * DAY);
  post("a2", ["artist:wlop"], T0 - 2 * DAY);
  post("a3", ["artist:wlop"], T0 - DAY);
  post("b1", ["artist:rella"], T0 - DAY);
  // now: wlop on 1, rella on 4 (two people, two groups), a newcomer on 2
  post("a4", ["artist:wlop"], T0 + DAY);
  post("b2", ["artist:rella"], T0 + DAY);
  post("b3", ["artist:rella"], T0 + 2 * DAY, { uin: "20002", groupId: "22222" });
  post("b4", ["by rella"], T0 + 3 * DAY);
  post("b5", ["artist:rella"], T0 + 3 * DAY);
  post("c1", ["artist:new_one"], T0 + 4 * DAY);
  post("c2", ["artist:new_one"], T0 + 5 * DAY);
  // the same file posted twice is one picture
  post("c2", ["artist:new_one"], T0 + 6 * DAY);
  const found = artistTrends(db, range);
  assert.deepEqual(found.artists.map((artist) => [artist.name, artist.now, artist.before]), [["rella", 4, 1], ["new one", 2, 0], ["wlop", 1, 3]]);
  const rella = found.artists[0];
  assert.deepEqual([rella.people, rella.groups, rella.tag], [2, 2, "artist:rella"]);
  assert.equal(found.pictures, 7);
  assert.deepEqual(found.before, { fromUnix: T0 - 7 * DAY, toUnix: T0 });
});

test("a bare name counts once the library has seen it with artist:, an ordinary tag never does", () => {
  const { db, post } = openDb();
  post("old1", ["artist:ciloranko"], T0 - 300 * DAY);
  post("old2", ["artist:ciloranko"], T0 - 299 * DAY);
  post("old3", ["artist:once"], T0 - 299 * DAY);
  post("n1", ["ciloranko", "1girl", "once"], T0 + DAY);
  post("n2", ["blue hair"], T0 + DAY);
  const found = artistTrends(db, range);
  assert.deepEqual(found.artists.map((artist) => [artist.name, artist.now, artist.tag]), [["ciloranko", 1, "ciloranko"]]);
});

test("\"by\" names an artist only when the library knows the name", () => {
  const { db, post } = openDb();
  post("old1", ["artist:wlop"], T0 - 100 * DAY);
  post("n1", ["by wlop", "by the window", "by hand"], T0 + DAY);
  assert.deepEqual(artistTrends(db, range).artists.map((artist) => [artist.name, artist.tag]), [["wlop", "by wlop"]]);
  post("n2", ["artist:new_one", "artist:new one::"], T0 + DAY);
  assert.equal(artistTrends(db, range).artists.find((artist) => artist.name === "new one").tag, "artist:new_one");
});

test("weighted and @ spellings are the same artist", () => {
  const { db, post } = openDb();
  post("old1", ["artist:rolua"], T0 - 100 * DAY);
  post("old2", ["artist:rolua"], T0 - 100 * DAY);
  post("n1", ["0.28::artist:rolua::"], T0 + DAY);
  post("n2", ["@rolua"], T0 + DAY);
  post("n3", ["1.15::artist:rolua::", "rolua"], T0 + 2 * DAY);
  const found = artistTrends(db, range).artists;
  assert.deepEqual(found.map((artist) => [artist.name, artist.now, artist.tag]), [["rolua", 3, "artist:rolua"]]);
});

test("a store without a prompt library says so instead of failing", () => {
  const db = new Database(":memory:");
  assert.deepEqual(artistTrends(db, range).artists, []);
  assert.equal(artistTrends(db, range).library, false);
});
