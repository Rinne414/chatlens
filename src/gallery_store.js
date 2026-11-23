"use strict";

// 画廊: every group picture the background has recorded (the `pictures` table,
// fed by the refresh since v0.0.13), browsed by time, group, sender and kind.
//
// One wall entry per picture (md5), not per posting: a picture reposted in
// five groups is one tile carrying "5 群". Its spread -- who posted it first,
// where it travelled -- is what the detail view shows.
//
// Queries run on a read-only connection to messages.db; when knowledge.db is
// attached as `kb`, AI pictures found in QQ's local originals count as AI too
// (not only the ones the picture pass probed on Tencent).

const { KNOWN_STICKER } = require("./picture_store");

const DAY_SECONDS = 86400;
const MAX_LIMIT = 240;
const DEFAULT_LIMIT = 120;
const CONTEXT_MESSAGES = 6;
const KINDS = new Set(["images", "stickers", "all"]);
const SORTS = new Set(["recent", "spread"]);
const MD5 = /^[a-f0-9]{32}$/u;

// Shape and size buckets over a posting's stated dimensions (p.width/height;
// 0 when unknown, which no bucket matches). A long picture is mostly a phone
// screenshot or a comic strip.
const KNOWN = "p.width > 0 AND p.height > 0";
const SHAPES = {
  wide: `${KNOWN} AND p.width > p.height * 1.15`,
  square: `${KNOWN} AND p.width <= p.height * 1.15 AND p.height <= p.width * 1.15`,
  tall: `${KNOWN} AND p.height > p.width * 1.15 AND p.height < p.width * 1.8`,
  long: `${KNOWN} AND p.height >= p.width * 1.8`,
};
const LARGE_SIDE = 1000;
const SMALL_SIDE = 500;
const SIZES = {
  large: `max(p.width, p.height) >= ${LARGE_SIDE}`,
  medium: `max(p.width, p.height) >= ${SMALL_SIDE} AND max(p.width, p.height) < ${LARGE_SIDE}`,
  small: `${KNOWN} AND max(p.width, p.height) < ${SMALL_SIDE}`,
};

// The prompt library copies QQ's own local originals into media-objects and
// records where (images.object_path; a library from before that has no column).
const libraryKeepsOriginals = (db) => hasKnowledge(db)
  && db.prepare("SELECT 1 FROM kb.pragma_table_info('images') WHERE name = 'object_path'").get() !== undefined;

// SQL for "this tool holds the picture's original" over pictures aliased `p`:
// kept by the picture service, or copied in by the prompt library. The two
// lists go into one temp table per connection (a read-only connection may
// still write its own temp tables): asking both stores for every picture took
// 10 s over all time on a real store, the table takes well under one.
// why: what kept it. 'manual', 'group', 'ai' are recorded when it happens;
// 'group_guess' / 'early' label originals kept before that was recorded;
// 'local' is the prompt library's copy of an original already on this computer.
const hasKeptBy = (db) => db.prepare("SELECT 1 FROM pragma_table_info('picture_files') WHERE name = 'kept_by'").get() !== undefined;

const ensureKeptTable = (db) => {
  if (db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name = 'gallery_kept'").get() === undefined) {
    db.exec("CREATE TEMP TABLE gallery_kept (md5 TEXT PRIMARY KEY, why TEXT NOT NULL) WITHOUT ROWID");
    const why = hasKeptBy(db) ? "CASE kept_by WHEN '' THEN 'early' ELSE kept_by END" : "'early'";
    db.exec(`INSERT OR IGNORE INTO temp.gallery_kept SELECT md5, ${why} FROM picture_files WHERE kept = 1`);
    if (libraryKeepsOriginals(db)) {
      db.exec("INSERT OR IGNORE INTO temp.gallery_kept SELECT hash, 'local' FROM kb.images WHERE object_path <> ''");
    }
  }
};

// One row in the sidebar per reason a user can tell apart.
const WHY_BUCKETS = {
  manual: "'manual'",
  group: "'group', 'group_guess'",
  ai: "'ai'",
  local: "'local'",
  early: "'early'",
};

const keptCondition = (db) => {
  ensureKeptTable(db);
  // "+": the temp table is looked up per picture, never used to drive the
  // query (SQLite knows nothing about its size and picked it, which made a
  // 7-day count 15 times slower than without the switch).
  return "+p.md5 IN (SELECT md5 FROM temp.gallery_kept)";
};

// picture_saves arrived with 存图托盘; a store opened read-only before its
// first upgrade has no such table yet.
const hasSaves = (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'picture_saves'").get() !== undefined;

// Opt-in switches; the two that need the prompt library match nothing
// without it.
const extraConditions = (db) => {
  const kb = hasKnowledge(db);
  return {
    // Never saved out to a folder with this program.
    unsaved: hasSaves(db) ? "+p.md5 NOT IN (SELECT md5 FROM picture_saves)" : "1",
    prompt: kb ? "EXISTS (SELECT 1 FROM kb.images ki WHERE ki.hash = p.md5 AND ki.prompt <> '')" : "0",
    asked: kb ? "EXISTS (SELECT 1 FROM kb.prompt_requests kr WHERE kr.image_hash = p.md5)" : "0",
    file: "p.file_name <> ''",
    // Read only when asked for: it fills a temp table, which a plain list never needs.
    get kept() {
      return keptCondition(db);
    },
  };
};

// Taken out of the kept library by the user and not emptied yet.
const removedCondition = (db) => (hasKeptBy(db) ? "p.md5 IN (SELECT md5 FROM picture_files WHERE removed = 1)" : "0");

const escapeLike = (text) => text.replace(/[\\%_]/gu, (character) => `\\${character}`);

const searchWords = (q) => String(q ?? "").trim().split(/\s+/u).filter((word) => word.length > 0);

const LIKE = "LIKE @like ESCAPE '\\'";

// Pictures posted in the window that one word finds: in the prompt, a LoRA or
// the model (prompt library; its tags are cut from the prompt, so the prompt
// covers them), the file name, who posted it, or the text sent with it (the
// same QQ message's text row: its row id without "m").
const wordMatches = (db, word, { fromUnix, toUnix }) => {
  const args = { like: `%${escapeLike(word)}%`, fromUnix, toUnix };
  const inWindow = "p.sent_at >= @fromUnix AND p.sent_at < @toUnix";
  const queries = [
    `SELECT p.md5 FROM pictures p WHERE ${inWindow} AND p.file_name ${LIKE}`,
    `SELECT p.md5 FROM messages sm JOIN pictures p ON p.group_id = sm.group_id AND p.row_id IN (sm.row_id, 'm' || sm.row_id)
     WHERE sm.sent_at >= @fromUnix AND sm.sent_at < @toUnix AND (sm.text ${LIKE} OR sm.speaker ${LIKE})`,
  ];
  if (hasKnowledge(db)) {
    queries.push(`SELECT p.md5 FROM pictures p WHERE ${inWindow} AND p.md5 IN (
      SELECT hash FROM kb.images WHERE prompt ${LIKE} OR checkpoint ${LIKE}
      UNION SELECT hash FROM kb.image_loras WHERE lora_name ${LIKE})`);
  }
  return new Set(queries.flatMap((sql) => db.prepare(sql).all(args).map((row) => row.md5)));
};

// The list and the facet counts are two requests with the same words: the
// matches are kept a minute per store, words and window.
const SEARCH_CACHE_MS = 60 * 1000;
let searchCache = { key: "", at: 0, md5s: [] };

// md5s every word finds (each word may match a different field).
const searchMatches = (db, words, window) => {
  const key = JSON.stringify([db.name, words, window.fromUnix, window.toUnix]);
  if (searchCache.key === key && Date.now() - searchCache.at < SEARCH_CACHE_MS) {
    return searchCache.md5s;
  }
  const [first, ...rest] = words.map((word) => wordMatches(db, word, window));
  const md5s = [...first].filter((md5) => rest.every((set) => set.has(md5)));
  searchCache = { key, at: Date.now(), md5s };
  return md5s;
};

const hasKnowledge = (db) => db.prepare("PRAGMA database_list").all().some((row) => row.name === "kb");

// SQL for "this picture is AI-generated" over pictures aliased `p`.
const aiCondition = (db) => {
  const probed = "EXISTS (SELECT 1 FROM picture_files f WHERE f.md5 = p.md5 AND f.probe = 'ai')";
  return hasKnowledge(db)
    ? `(${probed} OR EXISTS (SELECT 1 FROM kb.images i WHERE i.hash = p.md5 AND i.generator NOT IN ('stripped', 'unknown')))`
    : probed;
};

const clampLimit = (limit) => {
  const value = Number.parseInt(limit, 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT;
};

// Filters shared by the list and the facet counts. `sender` is a QQ number, or
// a display name for rows stored before the number was recorded. `q` is the
// search text, shape / size a bucket name, prompt / asked / file / kept switches.
const buildFilter = (db, {
  fromUnix, toUnix, groupId = "", sender = "", kind = "images", ai = false,
  q = "", shape = "", size = "", prompt = false, asked = false, file = false, kept = false, unsaved = false, why = "", removed = false,
}) => {
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix >= toUnix) {
    throw new Error("时间范围无效。");
  }
  if (!KINDS.has(kind)) {
    throw new Error(`未知的类型：${kind}`);
  }
  if (shape !== "" && SHAPES[shape] === undefined) {
    throw new Error(`未知的形状：${shape}`);
  }
  if (size !== "" && SIZES[size] === undefined) {
    throw new Error(`未知的大小：${size}`);
  }
  if (why !== "" && WHY_BUCKETS[why] === undefined) {
    throw new Error(`未知的留存原因：${why}`);
  }
  const conditions = ["p.sent_at >= @fromUnix", "p.sent_at < @toUnix"];
  const args = { fromUnix, toUnix };
  if (groupId !== "") {
    conditions.push("p.group_id = @groupId");
    args.groupId = String(groupId);
  }
  if (kind !== "all") {
    conditions.push(kind === "stickers" ? KNOWN_STICKER : `NOT ${KNOWN_STICKER}`);
  }
  if (ai) {
    conditions.push(aiCondition(db));
  }
  if (shape !== "") {
    conditions.push(SHAPES[shape]);
  }
  if (size !== "") {
    conditions.push(SIZES[size]);
  }
  const extras = extraConditions(db);
  for (const [name, on] of [["prompt", prompt], ["asked", asked], ["file", file], ["kept", kept], ["unsaved", unsaved]]) {
    if (on) {
      conditions.push(extras[name]);
    }
  }
  if (why !== "") {
    ensureKeptTable(db);
    conditions.push(`+p.md5 IN (SELECT md5 FROM temp.gallery_kept WHERE why IN (${WHY_BUCKETS[why]}))`);
  }
  if (removed) {
    conditions.push(removedCondition(db));
  }
  const words = searchWords(q);
  if (words.length > 0) {
    args.searchMd5s = JSON.stringify(searchMatches(db, words, { fromUnix, toUnix }));
    conditions.push("p.md5 IN (SELECT value FROM json_each(@searchMd5s))");
  }
  let join = "";
  if (sender !== "") {
    join = "JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id";
    conditions.push("(m.speaker_uin = @sender OR (m.speaker_uin = '' AND m.speaker = @sender))");
    args.sender = String(sender);
  }
  return { join, where: conditions.join(" AND "), args };
};

const ORDER = {
  recent: "lastAt DESC, p.md5",
  spread: "groups DESC, posts DESC, lastAt DESC, p.md5",
};

// groups / posts count every posting of the picture, not only the filtered
// ones: with one group selected, "posted in 5 groups" is still the point.
const SPREAD_GROUPS = "(SELECT COUNT(DISTINCT q.group_id) FROM pictures q WHERE q.md5 = p.md5)";

const pageRows = (db, filter, { sort, limit, offset }) => db.prepare(`
  SELECT p.md5, MIN(p.sent_at) AS firstAt, MAX(p.sent_at) AS lastAt,
         (SELECT COUNT(*) FROM pictures q WHERE q.md5 = p.md5) AS posts, ${SPREAD_GROUPS} AS groups,
         MAX(p.width) AS width, MAX(p.height) AS height, MAX(p.size) AS size,
         MAX(p.format) AS format, MAX(p.sticker) AS sticker, MAX(p.expires_at) AS expiresAt,
         (SELECT CASE WHEN MIN(q.file_name) <> '' THEN MAX(q.file_name) ELSE '' END FROM pictures q WHERE q.md5 = p.md5) AS fileName
  FROM pictures p ${filter.join}
  WHERE ${filter.where}
  GROUP BY p.md5
  ORDER BY ${ORDER[sort]}
  LIMIT @limit OFFSET @offset
`).all({ ...filter.args, limit, offset });

// The same row shape as a page of the wall, for pictures picked by md5
// (similar pictures): every posting counts, whatever the wall's filter is.
const rowsOfMd5s = (db, md5s) => db.prepare(`
  SELECT p.md5, MIN(p.sent_at) AS firstAt, MAX(p.sent_at) AS lastAt,
         COUNT(*) AS posts, COUNT(DISTINCT p.group_id) AS groups,
         MAX(p.width) AS width, MAX(p.height) AS height, MAX(p.size) AS size,
         MAX(p.format) AS format, MAX(p.sticker) AS sticker, MAX(p.expires_at) AS expiresAt,
         CASE WHEN MIN(p.file_name) <> '' THEN MAX(p.file_name) ELSE '' END AS fileName
  FROM pictures p
  WHERE p.md5 IN (SELECT value FROM json_each(@md5s))
  GROUP BY p.md5
`).all({ md5s: JSON.stringify(md5s) });

// Every posting of the page's pictures, oldest first: the first is where the
// picture came from, and the filter decides which posting the tile shows.
const occurrencesOf = (db, md5s) => db.prepare(`
  SELECT p.md5, p.group_id AS groupId, p.row_id AS rowId, p.sent_at AS sentAt,
         COALESCE(m.speaker, '') AS speaker, COALESCE(m.speaker_uin, '') AS speakerUin,
         COALESCE(g.name, '') AS groupName
  FROM pictures p
  LEFT JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
  LEFT JOIN group_names g ON g.group_id = p.group_id
  WHERE p.md5 IN (SELECT value FROM json_each(@md5s))
  ORDER BY p.sent_at, p.group_id, p.row_id
`).all({ md5s: JSON.stringify(md5s) });

const filesOf = (db, md5s) => new Map(db.prepare(`
  SELECT md5, COALESCE(thumb, '') <> '' AS hasThumb, kept, probe, gone,
         ${hasKeptBy(db) ? "kept_by AS keptBy, removed" : "'' AS keptBy, 0 AS removed"}
  FROM picture_files WHERE md5 IN (SELECT value FROM json_each(@md5s))
`).all({ md5s: JSON.stringify(md5s) }).map((row) => [row.md5, row]));

// When and where each picture was last saved out to a folder (absent = never).
const savedOf = (db, md5s) => {
  if (!hasSaves(db)) {
    return new Map();
  }
  return new Map(db.prepare(`
    SELECT md5, MAX(saved_at) AS savedAt, dir AS savedDir FROM picture_saves
    WHERE md5 IN (SELECT value FROM json_each(@md5s)) GROUP BY md5
  `).all({ md5s: JSON.stringify(md5s) }).map((row) => [row.md5, row]));
};

const knowledgeOf = (db, md5s) => {
  if (!hasKnowledge(db)) {
    return new Map();
  }
  return new Map(db.prepare(`
    SELECT i.hash, i.generator, i.checkpoint, ${libraryKeepsOriginals(db) ? "i.object_path <> ''" : "0"} AS hasOriginal,
           (SELECT COUNT(*) FROM kb.image_loras l WHERE l.hash = i.hash) AS loras,
           (SELECT COUNT(*) FROM kb.prompt_requests r WHERE r.image_hash = i.hash) AS asks
    FROM kb.images i WHERE i.hash IN (SELECT value FROM json_each(@md5s))
  `).all({ md5s: JSON.stringify(md5s) }).map((row) => [row.hash, row]));
};

// Why this tool holds the original ('' when it does not).
const keptWhy = (file, knowledge) => {
  if (file?.kept === 1) {
    return file.keptBy || "early";
  }
  return knowledge?.hasOriginal === 1 ? "local" : "";
};

// Worth opening in the 咒语库 only when it has a prompt or an ask to show.
const inLibrary = (knowledge, aiKnown) => knowledge !== undefined && (aiKnown || knowledge.asks > 0);

const posting = (row) => ({
  groupId: row.groupId,
  groupName: row.groupName,
  rowId: row.rowId,
  sentAt: row.sentAt,
  speaker: row.speaker,
  speakerUin: row.speakerUin,
});

const matchesFilter = (row, { fromUnix, toUnix, groupId, sender }) =>
  row.sentAt >= fromUnix && row.sentAt < toUnix
  && (groupId === "" || row.groupId === String(groupId))
  && (sender === "" || row.speakerUin === String(sender) || (row.speakerUin === "" && row.speaker === String(sender)));

const describe = (row, occurrences, file, knowledge, options) => {
  const inFilter = occurrences.filter((item) => matchesFilter(item, options));
  const shown = inFilter[inFilter.length - 1] ?? occurrences[occurrences.length - 1];
  const origin = occurrences[0];
  const aiKnown = knowledge !== undefined && !["stripped", "unknown"].includes(knowledge.generator);
  return {
    md5: row.md5,
    width: row.width,
    height: row.height,
    size: row.size,
    format: row.format,
    sticker: row.sticker === 1,
    expiresAt: row.expiresAt,
    lastAt: row.lastAt,
    // Set when it was sent as a file: what is shown is QQ's own preview.
    fileName: row.fileName ?? "",
    shown: shown === undefined ? null : posting(shown),
    origin: origin === undefined ? null : posting(origin),
    groups: new Set(occurrences.map((item) => item.groupId)).size,
    posts: occurrences.length,
    hasThumb: file?.hasThumb === 1,
    kept: file?.kept === 1 || knowledge?.hasOriginal === 1,
    keptWhy: keptWhy(file, knowledge),
    removed: file?.removed === 1,
    // Tencent never had a picture sent only as a file, so it cannot be gone
    // there (an older picture pass may have asked anyway).
    gone: file?.gone === 1 && !row.fileName,
    ai: file?.probe === "ai" || aiKnown,
    generator: aiKnown ? knowledge.generator : "",
    checkpoint: aiKnown ? knowledge.checkpoint : "",
    loras: knowledge?.loras ?? 0,
    asks: knowledge?.asks ?? 0,
    inLibrary: inLibrary(knowledge, aiKnown),
  };
};

const DEFAULT_OPTIONS = { groupId: "", sender: "", kind: "images", ai: false, q: "", shape: "", size: "", prompt: false, asked: false, file: false, kept: false, unsaved: false, why: "", removed: false };

// Wall items for a list of md5s, in the order given (the ones with no
// posting on record are left out).
const picturesByMd5 = (db, md5s) => {
  const byMd5 = new Map(rowsOfMd5s(db, md5s).map((row) => [row.md5, row]));
  const rows = md5s.map((md5) => byMd5.get(md5)).filter((row) => row !== undefined);
  return describeRows(db, rows, { ...DEFAULT_OPTIONS, fromUnix: 0, toUnix: Number.MAX_SAFE_INTEGER });
};

// Every posting of several files of one picture, oldest first, each saying
// which file it was.
const postingsOf = (db, md5s) => occurrencesOf(db, md5s).map((row) => ({ ...posting(row), md5: row.md5 }));

const listPictures = (db, options) => {
  const sort = SORTS.has(options.sort) ? options.sort : "recent";
  const normalized = { ...DEFAULT_OPTIONS, ...options };
  const filter = buildFilter(db, normalized);
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Number.parseInt(options.offset ?? 0, 10) || 0);
  const rows = pageRows(db, filter, { sort, limit, offset });
  const total = db.prepare(`SELECT COUNT(DISTINCT p.md5) AS n FROM pictures p ${filter.join} WHERE ${filter.where}`).get(filter.args).n;
  return { total, items: describeRows(db, rows, normalized) };
};

// How many pictures each day (UTC+8, as the wall's day headings) of the range
// holds, newest day first: the wall's date rail. A picture counts on the day
// of its newest posting inside the filter, which is where the wall shows it.
const DAY_ZONE_SECONDS = 8 * 3600;
const pictureDays = (db, options) => {
  const filter = buildFilter(db, { ...DEFAULT_OPTIONS, ...options });
  return db.prepare(`
    SELECT day, COUNT(*) AS n FROM (
      SELECT strftime('%Y-%m-%d', MAX(p.sent_at) + ${DAY_ZONE_SECONDS}, 'unixepoch') AS day
      FROM pictures p ${filter.join}
      WHERE ${filter.where}
      GROUP BY p.md5
    ) GROUP BY day ORDER BY day DESC
  `).all(filter.args);
};

const describeRows = (db, rows, normalized) => {
  const md5s = rows.map((row) => row.md5);
  const byMd5 = new Map(md5s.map((md5) => [md5, []]));
  for (const row of occurrencesOf(db, md5s)) {
    byMd5.get(row.md5).push(row);
  }
  const files = filesOf(db, md5s);
  const knowledge = knowledgeOf(db, md5s);
  const saved = savedOf(db, md5s);
  return rows.map((row) => ({
    ...describe(row, byMd5.get(row.md5), files.get(row.md5), knowledge.get(row.md5), normalized),
    savedAt: saved.get(row.md5)?.savedAt ?? 0,
    savedDir: saved.get(row.md5)?.savedDir ?? "",
  }));
};

// Counts for the sidebar under the current filter. Each dimension is counted
// without its own selection, so the other options stay visible (picking
// another shape replaces the shape; each switch adds to the others).
//
// Ten counts each walking every posting again took 7-11 s over all time
// (240k postings, measured 2026-11-20). The postings in the window are
// gathered once, then one row per picture with every yes/no the counts need,
// and the counts read that small table.
// Each yes/no as one set the pictures are looked up in (asking per picture
// took 9 s for 240k of them; the sets take well under one).
const pictureFlags = (db) => {
  const kb = hasKnowledge(db);
  const probed = "p.md5 IN (SELECT md5 FROM picture_files WHERE probe = 'ai')";
  return {
    sticker: "p.md5 IN (SELECT md5 FROM pictures WHERE sticker = 1)",
    ai: kb ? `(${probed} OR p.md5 IN (SELECT hash FROM kb.images WHERE generator NOT IN ('stripped', 'unknown')))` : probed,
    hasPrompt: kb ? "p.md5 IN (SELECT hash FROM kb.images WHERE prompt <> '')" : "0",
    asked: kb ? "p.md5 IN (SELECT image_hash FROM kb.prompt_requests)" : "0",
    saved: hasSaves(db) ? "p.md5 IN (SELECT md5 FROM picture_saves)" : "0",
  };
};

// "Posted in more than one group" counts every posting ever. When the window
// already holds every posting, the window's own count is that number.
const windowHoldsEverything = (db, { fromUnix, toUnix }) => {
  const span = db.prepare("SELECT MIN(sent_at) AS first, MAX(sent_at) AS last FROM pictures").get();
  return span.first === null || (fromUnix <= span.first && toUnix > span.last);
};

const buildFacetTables = (db, normalized) => {
  // What every count shares: the time window, the search words, and the place
  // (kept library / removed list). Everything else is a column or a posting.
  const base = buildFilter(db, { ...DEFAULT_OPTIONS, fromUnix: normalized.fromUnix, toUnix: normalized.toUnix, q: normalized.q, kept: normalized.kept, removed: normalized.removed, kind: "all" });
  ensureKeptTable(db);
  db.exec("DROP TABLE IF EXISTS temp.facet_post; DROP TABLE IF EXISTS temp.facet_pic");
  db.prepare(`
    CREATE TEMP TABLE facet_post AS
    SELECT p.md5, p.group_id AS groupId, p.width, p.height, p.file_name,
           CASE WHEN m.speaker_uin <> '' THEN m.speaker_uin ELSE COALESCE(m.speaker, '') END AS sender,
           COALESCE(m.speaker, '') AS speaker
    FROM pictures p LEFT JOIN messages m ON m.group_id = p.group_id AND m.row_id = p.row_id
    WHERE ${base.where}
  `).run(base.args);
  // Postings are looked up by picture for the group, sender and sent-as-file
  // choices, and for the sent-as-file count.
  db.exec("CREATE INDEX temp.facet_post_md5 ON facet_post(md5)");
  db.exec(`
    DROP TABLE IF EXISTS temp.facet_grouped;
    CREATE TEMP TABLE facet_grouped AS
    SELECT md5, MAX(width) AS width, MAX(height) AS height, MAX(file_name) AS file_name, COUNT(DISTINCT groupId) AS groupsInWindow
    FROM temp.facet_post GROUP BY md5
  `);
  const flags = pictureFlags(db);
  const spread = windowHoldsEverything(db, normalized) ? "p.groupsInWindow > 1" : `${SPREAD_GROUPS} > 1`;
  db.exec(`
    CREATE TEMP TABLE facet_pic AS
    SELECT p.md5, p.width, p.height, p.file_name,
           ${flags.sticker} AS sticker, ${flags.ai} AS ai, ${flags.hasPrompt} AS hasPrompt, ${flags.asked} AS asked,
           ${flags.saved} AS saved,
           ${spread} AS spread,
           COALESCE((SELECT k.why FROM temp.gallery_kept k WHERE k.md5 = p.md5), '') AS why
    FROM temp.facet_grouped p;
    CREATE UNIQUE INDEX temp.facet_pic_md5 ON facet_pic(md5);
  `);
};

// The picture-level choices as conditions over facet_pic p; `omit` names the
// ones a count leaves out.
const pictureConditions = (normalized, omit = []) => {
  const on = (name) => !omit.includes(name);
  return [
    on("kind") && normalized.kind !== "all" ? `p.sticker = ${normalized.kind === "stickers" ? 1 : 0}` : null,
    on("ai") && normalized.ai ? "p.ai = 1" : null,
    on("shape") && normalized.shape !== "" ? `(${SHAPES[normalized.shape]})` : null,
    on("size") && normalized.size !== "" ? `(${SIZES[normalized.size]})` : null,
    on("prompt") && normalized.prompt ? "p.hasPrompt = 1" : null,
    on("asked") && normalized.asked ? "p.asked = 1" : null,
    on("unsaved") && normalized.unsaved ? "p.saved = 0" : null,
    on("why") && normalized.why !== "" ? `p.why IN (${WHY_BUCKETS[normalized.why]})` : null,
  ].filter((condition) => condition !== null);
};

// The posting-level choices (group, sender) over facet_post x.
const postingConditions = (normalized, omit = []) => [
  !omit.includes("groupId") && normalized.groupId !== "" ? "x.groupId = @groupId" : null,
  !omit.includes("sender") && normalized.sender !== "" ? "x.sender = @sender" : null,
  !omit.includes("file") && normalized.file ? "x.file_name <> ''" : null,
].filter((condition) => condition !== null);

// `posting`: one more condition the same posting must meet.
const facetWhere = (normalized, omit = [], posting = null) => {
  const postings = [...postingConditions(normalized, omit), ...(posting === null ? [] : [posting])];
  const conditions = [
    ...pictureConditions(normalized, omit),
    postings.length === 0 ? null : `EXISTS (SELECT 1 FROM temp.facet_post x WHERE x.md5 = p.md5 AND ${postings.join(" AND ")})`,
  ].filter((condition) => condition !== null);
  return conditions.length === 0 ? "1" : conditions.join(" AND ");
};

const galleryFacets = (db, options) => {
  const normalized = { ...DEFAULT_OPTIONS, ...options };
  buildFilter(db, normalized);
  buildFacetTables(db, normalized);
  const args = { groupId: String(normalized.groupId), sender: String(normalized.sender) };
  const used = (sql) => Object.fromEntries(Object.entries(args).filter(([name]) => sql.includes(`@${name}`)));
  const run = (sql) => db.prepare(sql).all(used(sql));
  const count = (omit, extra = "1") => run(`SELECT COUNT(*) AS n FROM temp.facet_pic p WHERE ${facetWhere(normalized, omit)} AND ${extra}`)[0].n;
  const buckets = (choices, omit) => {
    const columns = Object.entries(choices).map(([bucket, condition]) => `COUNT(CASE WHEN ${condition} THEN 1 END) AS "${bucket}"`);
    return run(`SELECT ${columns.join(", ")} FROM temp.facet_pic p WHERE ${facetWhere(normalized, omit)}`)[0];
  };
  const perPosting = (value, label, omit, extra = "1") => run(`
    SELECT ${value} AS value, ${label} AS label, COUNT(DISTINCT x.md5) AS count
    FROM temp.facet_post x JOIN temp.facet_pic p ON p.md5 = x.md5 ${value === "x.groupId" ? "LEFT JOIN group_names g ON g.group_id = x.groupId" : ""}
    WHERE ${[...pictureConditions(normalized), ...postingConditions(normalized, omit), extra].join(" AND ")}
    GROUP BY value ORDER BY count DESC
  `);
  const whys = normalized.kept
    ? new Map(run(`SELECT p.why, COUNT(*) AS n FROM temp.facet_pic p WHERE ${facetWhere(normalized, ["why"])} GROUP BY p.why`).map((row) => [row.why, row.n]))
    : null;
  return {
    kinds: {
      images: count(["kind", "ai"], "p.sticker = 0"),
      stickers: count(["kind", "ai"], "p.sticker = 1"),
    },
    ai: count(["ai"], "p.ai = 1"),
    spread: count([], "p.spread = 1"),
    groups: perPosting("x.groupId", "COALESCE(g.name, '')", ["groupId"]),
    senders: perPosting("x.sender", "MAX(x.speaker)", ["sender"], "x.speaker <> ''"),
    // Inside the kept library: how many pictures each reason kept.
    whys: whys === null ? null : Object.fromEntries(Object.keys(WHY_BUCKETS).map((bucket) => [bucket,
      WHY_BUCKETS[bucket].split(",").reduce((sum, name) => sum + (whys.get(name.trim().slice(1, -1)) ?? 0), 0)])),
    shapes: buckets(SHAPES, ["shape"]),
    sizes: buckets(SIZES, ["size"]),
    extras: {
      prompt: count(["prompt"], "p.hasPrompt = 1"),
      asked: count(["asked"], "p.asked = 1"),
      file: run(`SELECT COUNT(*) AS n FROM temp.facet_pic p WHERE ${facetWhere(normalized, ["file"], "x.file_name <> ''")}`)[0].n,
      kept: count([], "p.why <> ''"),
      unsaved: count(["unsaved"], "p.saved = 0"),
    },
  };
};

// The whole kept library in three numbers, stickers included: what the page
// header, the settings and the storage page all quote.
const ORIGINAL_BYTES = "(SELECT MAX(q.size) FROM pictures q WHERE q.md5 = k.md5)";
const keptSummary = (db) => {
  ensureKeptTable(db);
  const kept = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(${ORIGINAL_BYTES}), 0) AS bytes
    FROM temp.gallery_kept k WHERE EXISTS (SELECT 1 FROM pictures q WHERE q.md5 = k.md5)
  `).get();
  // Kept, but the gallery has no posting for it (the prompt library took it
  // in before pictures were recorded): it cannot be listed here.
  const outside = db.prepare("SELECT COUNT(*) AS count FROM temp.gallery_kept k WHERE NOT EXISTS (SELECT 1 FROM pictures q WHERE q.md5 = k.md5)").get();
  const removed = hasKeptBy(db)
    ? db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(${ORIGINAL_BYTES}), 0) AS bytes,
               COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM pictures q WHERE q.md5 = k.md5) THEN 1 END) AS unlisted
        FROM picture_files k WHERE k.removed = 1`).get()
    : { count: 0, bytes: 0, unlisted: 0 };
  return { kept, outside, removed };
};

// Everything the detail view needs about one picture.
const pictureDetail = (db, md5) => {
  if (!MD5.test(String(md5))) {
    throw new Error("图片编号无效。");
  }
  const occurrences = occurrencesOf(db, [md5]).map(posting);
  if (occurrences.length === 0) {
    return null;
  }
  const meta = db.prepare(`
    SELECT MAX(width) AS width, MAX(height) AS height, MAX(size) AS size, MAX(format) AS format,
           MAX(sticker) AS sticker, MAX(expires_at) AS expiresAt,
           CASE WHEN MIN(file_name) <> '' THEN MAX(file_name) ELSE '' END AS fileName
    FROM pictures WHERE md5 = ?
  `).get(md5);
  const file = filesOf(db, [md5]).get(md5);
  const knowledge = knowledgeOf(db, [md5]).get(md5);
  const aiKnown = knowledge !== undefined && !["stripped", "unknown"].includes(knowledge.generator);
  return {
    md5,
    ...meta,
    sticker: meta.sticker === 1,
    kept: file?.kept === 1 || knowledge?.hasOriginal === 1,
    keptWhy: keptWhy(file, knowledge),
    removed: file?.removed === 1,
    gone: file?.gone === 1 && !meta.fileName,
    probe: file?.probe ?? "",
    ai: file?.probe === "ai" || aiKnown,
    generator: aiKnown ? knowledge.generator : "",
    inLibrary: inLibrary(knowledge, aiKnown),
    // Copies saved out to the user's own folders, newest first.
    saves: hasSaves(db)
      ? db.prepare("SELECT dir, file, saved_at AS savedAt FROM picture_saves WHERE md5 = ? ORDER BY saved_at DESC").all(md5)
      : [],
    occurrences,
  };
};

// The chat around one posting: a few messages before and after, in order.
const messageContext = (db, { groupId, rowId, sentAt }) => {
  const at = Number(sentAt);
  if (!/^\d+$/u.test(String(groupId)) || !Number.isFinite(at)) {
    throw new Error("消息位置无效。");
  }
  const columns = "row_id AS rowId, sent_at AS sentAt, speaker, text, is_media AS isMedia, media_kinds AS mediaKinds";
  const before = db.prepare(`
    SELECT ${columns} FROM messages WHERE group_id = @groupId AND (sent_at < @at OR (sent_at = @at AND row_id <= @rowId))
    ORDER BY sent_at DESC, row_id DESC LIMIT ${CONTEXT_MESSAGES + 1}
  `).all({ groupId: String(groupId), at, rowId: String(rowId ?? "") }).reverse();
  const after = db.prepare(`
    SELECT ${columns} FROM messages WHERE group_id = @groupId AND (sent_at > @at OR (sent_at = @at AND row_id > @rowId))
    ORDER BY sent_at, row_id LIMIT ${CONTEXT_MESSAGES}
  `).all({ groupId: String(groupId), at, rowId: String(rowId ?? "") });
  return { messages: [...before, ...after], focusRowId: String(rowId ?? "") };
};

// Every non-sticker picture posted in the window that has been posted in more
// than one group (counting all its postings), for 热点.
const spreadPictures = (db, { fromUnix, toUnix }) => db.prepare(`
  SELECT p.md5 FROM pictures p
  WHERE p.sent_at >= ? AND p.sent_at < ? AND NOT ${KNOWN_STICKER}
  GROUP BY p.md5 HAVING ${SPREAD_GROUPS} > 1
`).all(fromUnix, toUnix).map((row) => row.md5);

const rangeForDays = (days, nowUnix) => ({ fromUnix: nowUnix - days * DAY_SECONDS, toUnix: nowUnix + 60 });

module.exports = { picturesByMd5, postingsOf, listPictures, pictureDays, galleryFacets, pictureDetail, messageContext, spreadPictures, rangeForDays, hasKnowledge, keptSummary };
