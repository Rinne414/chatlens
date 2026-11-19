"use strict";

// 「留存的原图」 explains itself and lets pictures go: each kept original has a
// reason, the library can be filtered by it, and an original the user took out
// waits in a removed folder (it can be put back) and is never copied in again
// by a rule.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pictureStore = require("../src/picture_store");
const gallery = require("../src/gallery_store");
const removed = require("../src/media_removed");
const { persistMediaObject } = require("../src/media_object_store");

const NOW = 1_790_000_000;
const range = { fromUnix: NOW - 86400, toUnix: NOW + 60 };
const md5 = (seed) => seed.repeat(32).slice(0, 32);
const MANUAL = md5("a");
const BY_GROUP = md5("b");
const EARLY_IN_GROUP = md5("c");
const EARLY_ELSEWHERE = md5("d");
const NOT_KEPT = md5("e");

// The folder goes when the work is done, also when the work is async.
const withTemp = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unkeep-"));
  const clean = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = work(dir);
  } catch (error) {
    clean();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(clean);
  }
  clean();
  return result;
};

// A file whose name is its md5, as the kept originals are.
const writeOriginal = (dir, text) => {
  const bytes = Buffer.from(text);
  const hash = crypto.createHash("md5").update(bytes).digest("hex");
  const source = path.join(dir, `${hash}.png`);
  fs.writeFileSync(source, bytes);
  return { hash, source, bytes: bytes.length };
};

const withStore = (work) => withTemp((dir) => {
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  try {
    const picture = db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker)
      VALUES (?, ?, 0, ?, 800, 800, ?, 1001, ?, ?, 0)`);
    [[MANUAL, "1", 100], [BY_GROUP, "1", 200], [EARLY_IN_GROUP, "1", 300], [EARLY_ELSEWHERE, "2", 400], [NOT_KEPT, "1", 500]]
      .forEach(([hash, groupId, size], index) => picture.run(groupId, `m${index}`, hash, size, NOW - 1000 + index, NOW + 86400 * 20));
    const file = db.prepare("INSERT INTO picture_files (md5, kept, kept_by) VALUES (?, ?, ?)");
    file.run(MANUAL, 1, "manual");
    file.run(BY_GROUP, 1, "group");
    file.run(EARLY_IN_GROUP, 1, "");
    file.run(EARLY_ELSEWHERE, 1, "");
    return work(db);
  } finally {
    db.close();
  }
});

test("a removed original waits in its own folder and can be put back", () => {
  withTemp((dir) => {
    const objectDir = path.join(dir, "media-objects");
    const { hash, source, bytes } = writeOriginal(dir, "one original");
    const kept = persistMediaObject(source, objectDir, hash).objectPath;

    assert.equal(removed.moveOut(objectDir, hash), bytes);
    assert.equal(fs.existsSync(kept), false);
    assert.equal(removed.isRemoved(objectDir, hash), true);
    assert.equal(fs.existsSync(path.join(dir, "media-removed", hash.slice(0, 2), `${hash}.png`)), true);

    assert.equal(removed.moveBack(objectDir, hash), kept);
    assert.equal(fs.readFileSync(kept, "utf8"), "one original");
    assert.equal(removed.isRemoved(objectDir, hash), false);
  });
});

test("nothing copies a removed original back in, before or after it is emptied", () => {
  withTemp((dir) => {
    const objectDir = path.join(dir, "media-objects");
    const { hash, source, bytes } = writeOriginal(dir, "not wanted");
    persistMediaObject(source, objectDir, hash);
    removed.moveOut(objectDir, hash);

    assert.deepEqual(persistMediaObject(source, objectDir, hash), { objectPath: null, status: "removed-by-user" });
    assert.equal(removed.empty(objectDir, hash), bytes);
    assert.equal(removed.moveBack(objectDir, hash), null);
    assert.deepEqual(persistMediaObject(source, objectDir, hash), { objectPath: null, status: "removed-by-user" });

    // Keeping it again by hand forgets the removal.
    removed.forget(objectDir, hash);
    assert.equal(persistMediaObject(source, objectDir, hash).status, "stored");
  });
});

test("moving out a picture that has no kept original says so", () => {
  withTemp((dir) => {
    assert.equal(removed.moveOut(path.join(dir, "media-objects"), NOT_KEPT), null);
  });
});

test("originals kept before the reason was recorded get one: the group rule as a guess, or early", () => {
  withStore((db) => {
    assert.equal(pictureStore.labelEarlyKept(db, ["1"]), 2);
    const by = (hash) => pictureStore.fileRow(db, hash).kept_by;
    assert.equal(by(EARLY_IN_GROUP), "group_guess");
    assert.equal(by(EARLY_ELSEWHERE), "early");
    assert.equal(by(MANUAL), "manual");
    assert.equal(pictureStore.labelEarlyKept(db, ["1"]), 0);
  });
});

test("each kept picture says why, and the library counts and filters by reason", () => {
  withStore((db) => {
    pictureStore.labelEarlyKept(db, ["1"]);
    const page = gallery.listPictures(db, { ...range, kept: true });
    assert.deepEqual(Object.fromEntries(page.items.map((item) => [item.md5, item.keptWhy])), {
      [MANUAL]: "manual", [BY_GROUP]: "group", [EARLY_IN_GROUP]: "group_guess", [EARLY_ELSEWHERE]: "early",
    });
    assert.equal(gallery.listPictures(db, range).items.find((item) => item.md5 === NOT_KEPT).keptWhy, "");
    assert.deepEqual(gallery.galleryFacets(db, { ...range, kept: true }).whys, { manual: 1, group: 2, ai: 0, local: 0, early: 1 });
    assert.deepEqual(gallery.listPictures(db, { ...range, kept: true, why: "group" }).items.map((item) => item.md5).sort(), [BY_GROUP, EARLY_IN_GROUP]);
    assert.equal(gallery.galleryFacets(db, range).whys, null);
    assert.throws(() => gallery.listPictures(db, { ...range, kept: true, why: "nonsense" }), /未知的留存原因/u);
  });
});

test("a removed picture leaves the library, shows in the removed list, and the summary counts both", () => {
  withStore((db) => {
    assert.deepEqual(gallery.keptSummary(db), { kept: { count: 4, bytes: 1000 }, outside: { count: 0 }, removed: { count: 0, bytes: 0, unlisted: 0 } });
    pictureStore.updateFile(db, BY_GROUP, { kept: 0, removed: 1 });
    // The kept list is built once per connection, and each request opens its own.
    db.exec("DROP TABLE temp.gallery_kept");
    assert.deepEqual(gallery.keptSummary(db), { kept: { count: 3, bytes: 800 }, outside: { count: 0 }, removed: { count: 1, bytes: 200, unlisted: 0 } });
    assert.equal(gallery.listPictures(db, { ...range, kept: true }).items.some((item) => item.md5 === BY_GROUP), false);
    const waiting = gallery.listPictures(db, { ...range, removed: true, kind: "all" });
    assert.deepEqual(waiting.items.map((item) => [item.md5, item.kept, item.removed]), [[BY_GROUP, false, true]]);
  });
});

test("the keep-every-picture rule skips a picture the user removed", () => {
  withStore((db) => {
    const wanted = () => pictureStore.needingKeep(db, { now: NOW, limit: 10, groupIds: ["1"] }).map((row) => row.md5);
    assert.deepEqual(wanted(), [NOT_KEPT]);
    pictureStore.updateFile(db, NOT_KEPT, { removed: 2 });
    assert.deepEqual(wanted(), []);
  });
});

/* ---------- the whole trip with real files (src/picture_unkeep.js) ---------- */

const unkeepCore = require("../src/picture_unkeep");
const knowledgeStore = require("../src/knowledge_store");

// A store, a media-objects folder and a prompt library in one temp folder.
// keep(text, { byStore, inLibrary }) stores a real original both stores can point at.
const withLibrary = (work) => withTemp((dir) => {
  const db = messageStore.openStore(path.join(dir, "messages.db"));
  const knowledgeDbPath = path.join(dir, "knowledge.db");
  knowledgeStore.openKnowledgeStore(knowledgeDbPath).close();
  const objectDir = path.join(dir, "media-objects");
  const context = { db, objectDir, knowledgeDbPath };
  const libraryPath = (hash) => {
    const kb = knowledgeStore.openKnowledgeStore(knowledgeDbPath);
    try {
      return kb.prepare("SELECT object_path AS objectPath FROM images WHERE hash = ?").get(hash)?.objectPath ?? null;
    } finally {
      kb.close();
    }
  };
  const keep = (text, { byStore = "", inLibrary = false }) => {
    const { hash, source, bytes } = writeOriginal(dir, text);
    const objectPath = persistMediaObject(source, objectDir, hash).objectPath;
    if (byStore !== "") {
      pictureStore.updateFile(db, hash, { kept: 1, kept_by: byStore });
    }
    if (inLibrary) {
      const kb = knowledgeStore.openKnowledgeStore(knowledgeDbPath);
      kb.prepare("INSERT INTO images (hash, generator, prompt, checkpoint, parsed_at, object_path) VALUES (?, 'unknown', '', '', 1, ?)").run(hash, objectPath);
      kb.close();
    }
    return { hash, source, bytes, objectPath };
  };
  let result;
  try {
    result = work({ context, keep, libraryPath, dir });
  } catch (error) {
    db.close();
    throw error;
  }
  // An async test keeps the store open until it is done.
  if (result instanceof Promise) {
    return result.finally(() => db.close());
  }
  db.close();
  return result;
});

const stateOf = ({ db, objectDir }, hash) => {
  const row = pictureStore.fileRow(db, hash);
  return {
    kept: row?.kept ?? 0,
    removed: row?.removed ?? 0,
    by: row?.kept_by ?? "",
    inObjects: removed.findByName(objectDir, hash) !== null,
    waiting: removed.waitingFile(objectDir, hash) !== null,
  };
};

test("a picture kept both ways goes out, back, out again and is emptied, with every record following the file", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const { hash, bytes, objectPath, source } = keep("kept both ways", { byStore: "group", inLibrary: true });

    assert.deepEqual(unkeepCore.unkeep(context, [hash]).tally, { removed: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 0, removed: 1, by: "group", inObjects: false, waiting: true });
    assert.equal(libraryPath(hash), "");

    assert.deepEqual(unkeepCore.restore(context, [hash]).tally, { restored: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 1, removed: 0, by: "group", inObjects: true, waiting: false });
    assert.equal(libraryPath(hash), objectPath);

    unkeepCore.unkeep(context, [hash]);
    const emptied = unkeepCore.empty(context, [hash]);
    assert.deepEqual([emptied.tally, emptied.bytes], [{ emptied: 1 }, bytes]);
    assert.deepEqual(stateOf(context, hash), { kept: 0, removed: 2, by: "group", inObjects: false, waiting: false });
    assert.equal(libraryPath(hash), "");
    assert.equal(persistMediaObject(source, context.objectDir, hash).status, "removed-by-user");
    assert.deepEqual(unkeepCore.restore(context, [hash]).tally, { emptied: 1 });
  });
});

test("the library's own copy goes back as the library's copy; without its library row it stays reachable as kept", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const local = keep("library copy", { inLibrary: true });
    unkeepCore.unkeep(context, [local.hash]);
    assert.deepEqual(stateOf(context, local.hash), { kept: 0, removed: 1, by: "local", inObjects: false, waiting: true });
    unkeepCore.restore(context, [local.hash]);
    assert.deepEqual(stateOf(context, local.hash), { kept: 0, removed: 0, by: "local", inObjects: true, waiting: false });
    assert.equal(libraryPath(local.hash), local.objectPath);

    unkeepCore.unkeep(context, [local.hash]);
    const kb = knowledgeStore.openKnowledgeStore(context.knowledgeDbPath);
    kb.prepare("DELETE FROM images WHERE hash = ?").run(local.hash);
    kb.close();
    unkeepCore.restore(context, [local.hash]);
    assert.deepEqual(stateOf(context, local.hash), { kept: 1, removed: 0, by: "early", inObjects: true, waiting: false });
  });
});

test("a picture that is not kept is left alone, so the keep rules still apply to it", () => {
  withLibrary(({ context }) => {
    assert.deepEqual(unkeepCore.unkeep(context, [NOT_KEPT]).tally, { "not-kept": 1 });
    assert.equal(pictureStore.fileRow(context.db, NOT_KEPT), null);
    assert.equal(removed.isRemoved(context.objectDir, NOT_KEPT), false);
  });
});

test("a kept record whose file is gone leaves the library and is not copied in again", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const { hash, objectPath, source } = keep("file lost", { byStore: "manual", inLibrary: true });
    fs.rmSync(objectPath);
    assert.deepEqual(unkeepCore.unkeep(context, [hash]).tally, { missing: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 0, removed: 2, by: "manual", inObjects: false, waiting: false });
    assert.equal(libraryPath(hash), "");
    assert.equal(persistMediaObject(source, context.objectDir, hash).status, "removed-by-user");
  });
});

test("a removal stopped between the file move and the records finishes when asked again", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const { hash } = keep("interrupted", { byStore: "group", inLibrary: true });
    // The file moved, then the program stopped: both records still say kept.
    removed.moveOut(context.objectDir, hash);
    assert.deepEqual(unkeepCore.unkeep(context, [hash]).tally, { removed: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 0, removed: 1, by: "group", inObjects: false, waiting: true });
    assert.equal(libraryPath(hash), "");

    // The same for putting back: the file is home, the records are not.
    removed.moveBack(context.objectDir, hash);
    assert.deepEqual(unkeepCore.restore(context, [hash]).tally, { restored: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 1, removed: 0, by: "group", inObjects: true, waiting: false });
  });
});

test("one picture that cannot be moved does not stop the others, and their records still follow", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const good = keep("moves fine", { byStore: "group", inLibrary: true });
    const stuck = keep("cannot move", { byStore: "group", inLibrary: true });
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(from).includes(stuck.hash)) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return realRename(from, to);
    };
    let result;
    try {
      result = unkeepCore.unkeep(context, [stuck.hash, good.hash]);
    } finally {
      fs.renameSync = realRename;
    }
    assert.deepEqual(result.tally, { failed: 1, removed: 1 });
    assert.equal(libraryPath(good.hash), "");
    assert.deepEqual(stateOf(context, stuck.hash), { kept: 1, removed: 0, by: "group", inObjects: true, waiting: false });
    assert.equal(libraryPath(stuck.hash), stuck.objectPath);
  });
});

test("emptying stopped halfway leaves the original waiting, not hidden behind its marker", () => {
  withLibrary(({ context, keep }) => {
    const { hash } = keep("half emptied", { byStore: "manual" });
    unkeepCore.unkeep(context, [hash]);
    // The marker was written, then the program stopped before deleting the file.
    removed.markEmptied(context.objectDir, hash);
    assert.equal(removed.waitingFile(context.objectDir, hash) !== null, true);
    assert.deepEqual(unkeepCore.restore(context, [hash]).tally, { restored: 1 });
    assert.deepEqual(stateOf(context, hash), { kept: 1, removed: 0, by: "manual", inObjects: true, waiting: false });
  });
});

test("originals the gallery has no posting for are counted apart and can all be taken out together", async () => {
  await withLibrary(async ({ context, keep, libraryPath }) => {
    const listed = keep("posted in a group", { inLibrary: true });
    const unlisted = keep("only the library knows it", { inLibrary: true });
    context.db.prepare(`INSERT INTO pictures (group_id, row_id, seq, md5, width, height, size, format, sent_at, expires_at, sticker)
      VALUES ('1', 'm1', 0, ?, 800, 800, 100, 1001, ?, ?, 0)`).run(listed.hash, NOW - 100, NOW + 86400);
    const summaryOf = () => {
      const reader = new (require("better-sqlite3-multiple-ciphers"))(context.db.name, { readonly: true });
      reader.prepare("ATTACH DATABASE ? AS kb").run(context.knowledgeDbPath);
      try {
        return gallery.keptSummary(reader);
      } finally {
        reader.close();
      }
    };
    assert.deepEqual([summaryOf().kept.count, summaryOf().outside.count], [1, 1]);
    assert.deepEqual(unkeepCore.outsideGalleryMd5s(context), [unlisted.hash]);

    const done = await unkeepCore.unkeepOutsideGallery(context, async () => {});
    assert.deepEqual(done.tally, { removed: 1 });
    assert.deepEqual(stateOf(context, unlisted.hash), { kept: 0, removed: 1, by: "local", inObjects: false, waiting: true });
    assert.equal(libraryPath(listed.hash), listed.objectPath);
    const after = summaryOf();
    assert.deepEqual([after.kept.count, after.outside.count, after.removed.count, after.removed.unlisted], [1, 0, 1, 1]);

    await unkeepCore.forAllWaiting(context, unkeepCore.restore, async () => {});
    assert.deepEqual(stateOf(context, unlisted.hash), { kept: 0, removed: 0, by: "local", inObjects: true, waiting: false });
    assert.equal(libraryPath(unlisted.hash), unlisted.objectPath);
  });
});

test("everything removed is worked through in chunks", async () => {
  await withLibrary(async ({ context, keep }) => {
    const hashes = ["one", "two", "three"].map((text) => keep(text, { byStore: "group" }).hash);
    unkeepCore.unkeep(context, hashes);
    let pauses = 0;
    const done = await unkeepCore.forAllWaiting(context, unkeepCore.empty, async () => { pauses += 1; });
    assert.deepEqual([done.tally, pauses], [{ emptied: 3 }, 1]);
    assert.deepEqual(unkeepCore.waitingMd5s(context.db), []);
  });
});

/* ---------- the records follow the kept folder (src/picture_reconcile.js) ---------- */

const reconcileCore = require("../src/picture_reconcile");

test("an original deleted straight from the folder leaves the kept library and is not copied in again", async () => {
  await withLibrary(async ({ context, keep, libraryPath }) => {
    const stays = keep("still there", { byStore: "group", inLibrary: true });
    const deleted = keep("deleted by hand", { byStore: "group", inLibrary: true });
    assert.deepEqual(await reconcileCore.reconcile(context), { available: true, dropped: 0, adopted: 0, unconfirmed: 0 });

    fs.rmSync(deleted.objectPath);
    assert.deepEqual(await reconcileCore.reconcile(context), { available: true, dropped: 1, adopted: 0, unconfirmed: 0 });
    assert.deepEqual(stateOf(context, deleted.hash), { kept: 0, removed: 2, by: "group", inObjects: false, waiting: false });
    assert.equal(libraryPath(deleted.hash), "");
    assert.equal(persistMediaObject(deleted.source, context.objectDir, deleted.hash).status, "removed-by-user");
    assert.deepEqual(stateOf(context, stays.hash), { kept: 1, removed: 0, by: "group", inObjects: true, waiting: false });
    assert.equal(libraryPath(stays.hash), stays.objectPath);
  });
});

test("putting the file back makes it kept again", async () => {
  await withLibrary(async ({ context, keep, libraryPath, dir }) => {
    const { hash, objectPath } = keep("comes back", { byStore: "group", inLibrary: true });
    const aside = path.join(dir, "recycle-bin.png");
    fs.renameSync(objectPath, aside);
    await reconcileCore.reconcile(context);
    assert.equal(stateOf(context, hash).kept, 0);

    fs.renameSync(aside, objectPath);
    assert.deepEqual(await reconcileCore.reconcile(context), { available: true, dropped: 0, adopted: 1, unconfirmed: 0 });
    assert.deepEqual(stateOf(context, hash), { kept: 1, removed: 0, by: "manual", inObjects: true, waiting: false });
    assert.equal(libraryPath(hash), objectPath);
    assert.equal(removed.isRemoved(context.objectDir, hash), false);
  });
});

test("a folder that is away changes nothing, and neither does most of it vanishing at once until confirmed", async () => {
  await withLibrary(async ({ context, keep }) => {
    const hashes = Array.from({ length: 120 }, (_, index) => keep(`original ${index}`, { byStore: "group" }).hash);
    const away = `${context.objectDir}-away`;
    fs.renameSync(context.objectDir, away);
    assert.deepEqual(await reconcileCore.reconcile(context), { available: false, dropped: 0, adopted: 0, unconfirmed: 0 });
    assert.equal(stateOf(context, hashes[0]).kept, 1);

    fs.renameSync(away, context.objectDir);
    for (const hash of hashes.slice(0, 110)) {
      fs.rmSync(removed.findByName(context.objectDir, hash));
    }
    assert.deepEqual(await reconcileCore.reconcile(context), { available: true, dropped: 0, adopted: 0, unconfirmed: 110 });
    assert.equal(stateOf(context, hashes[0]).kept, 1);
    assert.deepEqual(await reconcileCore.reconcile(context, { confirmed: true }), { available: true, dropped: 110, adopted: 0, unconfirmed: 0 });
    assert.equal(stateOf(context, hashes[0]).kept, 0);
    assert.equal(stateOf(context, hashes[119]).kept, 1);
  });
});

test("a harvest does not copy back an original the user deleted from the folder", () => {
  withLibrary(({ context, keep, libraryPath }) => {
    const { persistOriginalsForHashes } = require("../src/media_object_store");
    const { hash, objectPath, source } = keep("deleted before the next harvest", { inLibrary: true });
    fs.rmSync(objectPath);
    const kb = knowledgeStore.openKnowledgeStore(context.knowledgeDbPath);
    try {
      persistOriginalsForHashes({ hashes: [hash], sourceByHash: new Map([[hash, source]]), objectDir: context.objectDir, db: kb });
    } finally {
      kb.close();
    }
    assert.equal(removed.findByName(context.objectDir, hash), null);
    assert.equal(libraryPath(hash), objectPath);
  });
});
