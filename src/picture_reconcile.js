"use strict";

// The kept records follow the kept folder, over a context
// { db, objectDir, knowledgeDbPath }. A user may delete originals straight
// from store/media-objects, or put them back (from the recycle bin, a backup):
//   - recorded as kept, file gone  -> it leaves the kept library and is marked
//     so no rule or harvest copies it in again (same as 取消留存 + 彻底删除);
//   - file there, not recorded     -> kept again, as if kept by hand.
// When the folder itself cannot be read (drive away), nothing is changed.

const store = require("./picture_store");
const pictureAi = require("./picture_ai");
const removed = require("./media_removed");
const folder = require("./media_folder");
const unkeepCore = require("./picture_unkeep");

const CHUNK = 200;
const NOTHING = { available: true, dropped: 0, adopted: 0, unconfirmed: 0 };
// Most of the folder gone at once looks less like tidying up than like a
// store copied without its pictures: that is only applied when the user says so.
const SUDDEN_LOSS_MIN = 100;
const SUDDEN_LOSS_SHARE = 0.5;

// The folder state the records were last matched against, per folder.
const settled = new Map();

const recordedHashes = ({ db, knowledgeDbPath }) => new Set([
  ...db.prepare("SELECT md5 FROM picture_files WHERE kept = 1").pluck().all(),
  ...pictureAi.originalHashes({ knowledgeDbPath }),
]);

const adopt = ({ db, objectDir, knowledgeDbPath }, md5s) => {
  const originals = [];
  for (const md5 of md5s) {
    const objectPath = removed.findByName(objectDir, md5);
    if (objectPath !== null) {
      removed.forget(objectDir, md5);
      store.updateFile(db, md5, { kept: 1, kept_by: "manual", removed: unkeepCore.REMOVED.no });
      originals.push({ md5, objectPath });
    }
  }
  pictureAi.setOriginals({ knowledgeDbPath, originals });
  return originals.length;
};

const inChunks = async (context, md5s, action, pause) => {
  let done = 0;
  for (let start = 0; start < md5s.length; start += CHUNK) {
    const chunk = md5s.slice(start, start + CHUNK);
    done += context.db.transaction(() => action(context, chunk))();
    await pause();
  }
  return done;
};

const drop = (context, md5s) => unkeepCore.unkeep(context, md5s).tally.missing ?? 0;

// confirmed: the user said the missing files really are gone.
const reconcile = async (context, { pause = async () => {}, confirmed = false } = {}) => {
  const listing = await folder.listHashes(context.objectDir);
  if (listing === null) {
    // No folder at all is fine while nothing is recorded as kept.
    return { ...NOTHING, available: recordedHashes(context).size === 0 };
  }
  if (settled.get(context.objectDir) === listing.key) {
    return NOTHING;
  }
  const recorded = recordedHashes(context);
  const gone = [...recorded].filter((md5) => !listing.hashes.has(md5));
  const back = [...listing.hashes].filter((md5) => !recorded.has(md5));
  const sudden = gone.length >= SUDDEN_LOSS_MIN && gone.length > recorded.size * SUDDEN_LOSS_SHARE;
  if (sudden && !confirmed) {
    return { ...NOTHING, adopted: await inChunks(context, back, adopt, pause), unconfirmed: gone.length };
  }
  const result = {
    ...NOTHING,
    dropped: await inChunks(context, gone, drop, pause),
    adopted: await inChunks(context, back, adopt, pause),
  };
  // Dropping writes markers elsewhere and adopting moves nothing: the folder
  // is as it was listed, and the records now match it.
  settled.set(context.objectDir, listing.key);
  return result;
};

module.exports = { reconcile };
