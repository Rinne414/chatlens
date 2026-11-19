"use strict";

// HTTP side of taking originals out of 「留存的原图」 and back
// (src/picture_unkeep.js does the work).

const service = require("./picture_service");
const state = require("./toolkit_state");
const core = require("../picture_unkeep");

const MD5 = /^[a-f0-9]{32}$/u;
const MAX_PER_REQUEST = 500;

const context = () => ({ db: state.getStore(), objectDir: service.objectDir, knowledgeDbPath: service.knowledgeDbPath });

const wantedMd5s = (md5s) =>
  [...new Set((Array.isArray(md5s) ? md5s : []).map(String).filter((md5) => MD5.test(md5)))].slice(0, MAX_PER_REQUEST);

const pause = () => new Promise((resolve) => { setImmediate(resolve); });

// `outsideGallery: true`: every kept original the gallery cannot list.
const unkeep = async ({ md5s, outsideGallery }) => {
  if (outsideGallery !== true) {
    return core.unkeep(context(), wantedMd5s(md5s));
  }
  // Thousands of pictures: the totals are the answer, not a row for each.
  const { requested, tally, bytes } = await core.unkeepOutsideGallery(context(), pause);
  return { requested, tally, bytes };
};

// `all: true` works through everything removed, however many.
const restore = async ({ md5s, all }) =>
  (all === true ? core.forAllWaiting(context(), core.restore, pause) : core.restore(context(), wantedMd5s(md5s)));

// Deleting for good names how many the user was shown: if that changed since,
// nothing is deleted and the page asks again with the new number.
const empty = async ({ md5s, all, expected }) => {
  if (all !== true) {
    return core.empty(context(), wantedMd5s(md5s));
  }
  const waiting = core.waitingMd5s(context().db).length;
  if (waiting !== Number(expected)) {
    throw new Error(`取消留存的图现在是 ${waiting} 张，和刚才显示的不一样，请再确认一次。`);
  }
  return core.forAllWaiting(context(), core.empty, pause);
};

module.exports = { unkeep, restore, empty };
