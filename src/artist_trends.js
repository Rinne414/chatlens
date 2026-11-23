"use strict";

// 画师趋势 (热点 → 画师): which artists' names appear in the prompts of the
// pictures posted in a stretch of time, against the stretch of the same
// length before it. Counting only, no AI.
//
// What counts as an artist: a tag written `artist:name` or `by name`, and the
// bare `name` once the library has seen it written with `artist:` (people
// drop the prefix; the library's own tags are the only list there is).
//
// db: the message store with the prompt library attached as `kb`
// (gallery_ops.withReadOnlyStore).

const BARE_MIN_CHARS = 4;
// A name seen with the prefix this often is trusted without it, unless it is
// used bare more than this many times as often.
const BARE_MIN_PREFIXED = 2;
const BARE_MAX_TIMES = 3;

// "artist:Chen_Bin" / "by chen bin" / "chen_bin" / "@chen_bin" /
// "1.2::artist:chen_bin::" (NovelAI's weighting) -> "chen bin"
const artistName = (tag) => String(tag ?? "").toLowerCase()
  .replace(/^-?[\d.]+::\s*/u, "")
  .replace(/^@/u, "")
  .replace(/^artist:\s*/u, "")
  .replace(/^by\s+/u, "")
  .replace(/:+$/u, "")
  .replace(/_/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const isPrefixed = (tag) => /(^|::\s*)(artist:|by\s)/iu.test(String(tag ?? ""));

// The names the library knows as artists, and every bare spelling of them
// that is not also an everyday tag: a word used far more often without the
// prefix than with it ("luminous", "realistic") is a word, not a person.
const bareSpellings = (db) => {
  const rows = db.prepare("SELECT tag, COUNT(*) AS n FROM kb.image_tags WHERE tag >= 'artist:' AND tag < 'artist;' GROUP BY tag").all();
  const prefixed = new Map();
  for (const row of rows) {
    const name = artistName(row.tag);
    if ([...name].length >= BARE_MIN_CHARS) {
      prefixed.set(name, (prefixed.get(name) ?? 0) + row.n);
    }
  }
  const candidates = [...prefixed.entries()].filter(([, count]) => count >= BARE_MIN_PREFIXED)
    .flatMap(([name]) => [...new Set([name, name.replace(/ /gu, "_"), `@${name}`, `@${name.replace(/ /gu, "_")}`])]);
  const bare = new Map(db.prepare("SELECT tag, COUNT(*) AS n FROM kb.image_tags WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY tag")
    .all(JSON.stringify(candidates)).map((row) => [row.tag, row.n]));
  // "@name" is only ever an artist: it does not count towards "used as an everyday word"
  const used = (name) => (bare.get(name) ?? 0) + (name.includes(" ") ? bare.get(name.replace(/ /gu, "_")) ?? 0 : 0);
  return {
    // every name written with artist: at least once ("by name" is believed only for these)
    known: new Set(prefixed.keys()),
    bare: candidates.filter((spelling) => {
      const name = artistName(spelling);
      return used(name) <= prefixed.get(name) * BARE_MAX_TIMES;
    }),
  };
};

// One search term for the library that finds the artist however the name was
// written. The library matches a tag that contains the term, with `_`
// standing for any one character, so "artist:chen_bin" finds "artist:chen bin",
// "artist:chen_bin" and "artist:chen bin::". A bare name is used only when the
// window has no prefixed spelling: it also finds tags that merely contain it.
const libraryTag = (name, spellings) => {
  const joined = name.replace(/ /gu, "_");
  if (spellings.some((tag) => tag.includes("artist:"))) {
    return `artist:${joined}`;
  }
  return spellings.some(isPrefixed) ? `by ${joined}` : joined;
};

const hasLibrary = (db) => {
  try {
    db.prepare("SELECT 1 FROM kb.image_tags LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
};

// { range, before, artists: [{ name, tag, now, before, people, groups, lastAt }], pictures }
// now / before: pictures (distinct files) whose prompt names the artist.
// tag: what to search the library for (libraryTag).
const artistTrends = (db, { fromUnix, toUnix }) => {
  const span = toUnix - fromUnix;
  const before = { fromUnix: fromUnix - span, toUnix: fromUnix };
  if (!hasLibrary(db)) {
    return { range: { fromUnix, toUnix }, before, artists: [], pictures: 0, library: false };
  }
  const vocabulary = bareSpellings(db);
  // From the few tags that can be an artist to where their pictures were posted
  // (the other way round reads every tag of every picture of the two stretches).
  const rows = db.prepare(`
    WITH wanted AS (
      SELECT hash, tag FROM kb.image_tags WHERE tag LIKE '%artist:%'
      UNION ALL SELECT hash, tag FROM kb.image_tags WHERE tag >= 'by ' AND tag < 'by!'
      UNION ALL SELECT hash, tag FROM kb.image_tags WHERE tag IN (SELECT value FROM json_each(@bare))
    )
    SELECT w.tag AS tag, s.hash AS hash, s.speaker_uin AS uin, s.group_id AS groupId, s.sent_at AS sentAt
    FROM wanted w JOIN kb.sightings s ON s.hash = w.hash
    WHERE s.sent_at >= @from AND s.sent_at < @to
  `).all({ from: before.fromUnix, to: toUnix, bare: JSON.stringify(vocabulary.bare) });
  const artists = new Map();
  const pictures = new Set();
  for (const row of rows) {
    const name = artistName(row.tag);
    // "by the window" is a phrase; "by wlop" is an artist the library knows.
    if (name === "" || (/^by\s/u.test(row.tag) && !vocabulary.known.has(name)) || !/^(-?[\d.]+::\s*)?(artist:|by\s|@)?[^:]+:*$/u.test(row.tag)) {
      continue;
    }
    if (!artists.has(name)) {
      artists.set(name, { name, now: new Set(), before: new Set(), people: new Set(), groups: new Set(), spellings: new Map(), lastAt: 0 });
    }
    const artist = artists.get(name);
    if (row.sentAt >= fromUnix) {
      artist.now.add(row.hash);
      pictures.add(row.hash);
      if (row.uin) {
        artist.people.add(row.uin);
      }
      artist.groups.add(row.groupId);
      artist.lastAt = Math.max(artist.lastAt, row.sentAt);
      artist.spellings.set(row.tag, (artist.spellings.get(row.tag) ?? 0) + 1);
    } else {
      artist.before.add(row.hash);
    }
  }
  return {
    range: { fromUnix, toUnix },
    before,
    library: true,
    pictures: pictures.size,
    artists: [...artists.values()].filter((artist) => artist.now.size > 0).map((artist) => ({
      name: artist.name,
      tag: libraryTag(artist.name, [...artist.spellings.keys()]),
      now: artist.now.size,
      before: artist.before.size,
      people: artist.people.size,
      groups: artist.groups.size,
      lastAt: artist.lastAt,
    })).sort((left, right) => (right.now - right.before) - (left.now - left.before) || right.now - left.now || left.name.localeCompare(right.name)),
  };
};

module.exports = { artistTrends, artistName };
