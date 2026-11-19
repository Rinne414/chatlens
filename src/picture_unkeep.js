"use strict";

// Taking originals out of 「留存的原图」 and back, over a context
// { db, objectDir, knowledgeDbPath }. Removing moves the file to the removed
// folder (media_removed.js) and nothing is deleted until the user empties it;
// a removed picture is never kept again by a rule, only by hand.
//
// One picture failing (a locked file) never stops the others, and every step
// reads the folders first, so a step that was interrupted between the file
// move and the database can simply be asked for again.

const store = require("./picture_store");
const pictureAi = require("./picture_ai");
const removed = require("./media_removed");

const REMOVED = { no: 0, waiting: 1, emptied: 2 };
const CHUNK = 200;

const report = (results) => ({
  requested: results.length,
  tally: results.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {}),
  bytes: results.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  results,
});

const guarded = (md5, work) => {
  try {
    return work();
  } catch (error) {
    return { md5, status: "failed", error: error.message };
  }
};

// How it came in, so putting it back restores the same state.
const keptByOf = (row) => {
  if (row?.removed === REMOVED.waiting && row.kept_by !== "") {
    return row.kept_by;
  }
  return row?.kept === 1 ? (row.kept_by || "early") : "local";
};

const unkeepOne = ({ db, objectDir }, md5, inLibrary) => guarded(md5, () => {
  const row = store.fileRow(db, md5);
  const moved = removed.moveOut(objectDir, md5);
  const waiting = removed.waitingFile(objectDir, md5);
  if (moved === null && waiting === null) {
    if (row?.kept !== 1 && !inLibrary) {
      // Not a kept picture: nothing changes, and the keep rules still apply to it.
      return { md5, status: "not-kept" };
    }
    // Recorded as kept but the file is not there: it leaves the library, and
    // the marker stops a harvest from quietly copying it in again.
    removed.markEmptied(objectDir, md5);
    store.updateFile(db, md5, { kept: 0, removed: REMOVED.emptied });
    return { md5, status: "missing" };
  }
  store.updateFile(db, md5, { kept: 0, removed: REMOVED.waiting, kept_by: keptByOf(row) });
  return { md5, status: "removed", bytes: moved ?? 0 };
});

const unkeep = (context, md5s) => {
  const library = pictureAi.originalPaths({ knowledgeDbPath: context.knowledgeDbPath, md5s });
  const results = md5s.map((md5) => unkeepOne(context, md5, library.has(md5)));
  pictureAi.setOriginals({
    knowledgeDbPath: context.knowledgeDbPath,
    originals: results.filter((item) => item.status === "removed" || item.status === "missing").map((item) => ({ md5: item.md5, objectPath: "" })),
  });
  return report(results);
};

const restoreOne = ({ db, objectDir }, md5) => guarded(md5, () => {
  const row = store.fileRow(db, md5);
  // Already back in place (an earlier try moved it and then stopped) counts too.
  const objectPath = removed.moveBack(objectDir, md5)
    ?? (row?.removed === REMOVED.waiting ? removed.findByName(objectDir, md5) : null);
  if (objectPath === null) {
    return { md5, status: row?.removed === REMOVED.emptied ? "emptied" : "not-removed" };
  }
  store.updateFile(db, md5, { kept: row?.kept_by === "local" ? 0 : 1, removed: REMOVED.no });
  return { md5, status: "restored", objectPath, local: row?.kept_by === "local" };
});

const restore = (context, md5s) => {
  const results = md5s.map((md5) => restoreOne(context, md5));
  const restored = results.filter((item) => item.status === "restored");
  const unattached = new Set(pictureAi.setOriginals({
    knowledgeDbPath: context.knowledgeDbPath,
    originals: restored.map((item) => ({ md5: item.md5, objectPath: item.objectPath })),
  }));
  // It was only the library's copy and the library no longer lists it: kept
  // by the picture store instead, so the file stays reachable.
  for (const item of restored.filter((entry) => entry.local && unattached.has(entry.md5))) {
    store.updateFile(context.db, item.md5, { kept: 1, kept_by: "early" });
  }
  return report(results);
};

const emptyOne = ({ db, objectDir }, md5) => guarded(md5, () => {
  if (store.fileRow(db, md5)?.removed !== REMOVED.waiting) {
    return { md5, status: "not-removed" };
  }
  const bytes = removed.empty(objectDir, md5);
  store.updateFile(db, md5, { removed: REMOVED.emptied });
  return { md5, status: "emptied", bytes };
});

const empty = (context, md5s) => report(md5s.map((md5) => emptyOne(context, md5)));

const waitingMd5s = (db) => db.prepare("SELECT md5 FROM picture_files WHERE removed = ?").all(REMOVED.waiting).map((row) => row.md5);

// Originals the prompt library holds for pictures the gallery has no record
// of (no group, no time), so the gallery cannot list them one by one.
const outsideGalleryMd5s = ({ db, knowledgeDbPath }) => {
  const library = pictureAi.originalHashes({ knowledgeDbPath });
  if (library.length === 0) {
    return [];
  }
  const known = new Set(db.prepare("SELECT DISTINCT md5 FROM pictures").pluck().all());
  return library.filter((md5) => !known.has(md5));
};

// Many pictures, a chunk at a time with a pause between chunks so the
// program keeps answering while thousands of files move.
const inChunks = async (context, md5s, action, pause) => {
  const results = [];
  for (let start = 0; start < md5s.length; start += CHUNK) {
    // One store transaction per chunk. Stopped in the middle, the files of
    // that chunk have moved and its records have not: asking again finishes it.
    const chunk = md5s.slice(start, start + CHUNK);
    results.push(...context.db.transaction(() => action(context, chunk))().results);
    await pause();
  }
  return report(results);
};

const forAllWaiting = (context, action, pause) => inChunks(context, waitingMd5s(context.db), action, pause);

const unkeepOutsideGallery = (context, pause) => inChunks(context, outsideGalleryMd5s(context), unkeep, pause);

module.exports = { unkeep, restore, empty, forAllWaiting, unkeepOutsideGallery, outsideGalleryMd5s, waitingMd5s, REMOVED };
