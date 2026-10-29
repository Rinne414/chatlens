"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const messageStore = require("../src/message_store");
const pictureElements = require("../src/picture_elements");
const pictureStore = require("../src/picture_store");

const FILE_MD5 = "86".repeat(16);
const SENT_AT = 1_700_000_000;
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32, 1)]);

const writeVarint = (value) => {
  const bytes = [];
  let rest = value;
  do {
    const piece = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? piece | 0x80 : piece);
  } while (rest > 0);
  return Buffer.from(bytes);
};
const fieldVarint = (field, value) => Buffer.concat([writeVarint(field * 8), writeVarint(value)]);
const fieldBytes = (field, payload) => Buffer.concat([writeVarint(field * 8 + 2), writeVarint(payload.length), payload]);
const element = (payload) => fieldBytes(40800, payload);

// A file element as QQ stores it (see picture_elements.js).
const fileElement = ({ name, localPath = "" }) => Buffer.concat([
  fieldVarint(45002, 3),
  fieldBytes(45402, Buffer.from(name)),
  fieldVarint(45405, 9616710),
  fieldBytes(45406, Buffer.from(FILE_MD5, "hex")),
  fieldVarint(45411, 2752),
  fieldVarint(45412, 2144),
  fieldVarint(45505, SENT_AT + 14 * 86400),
  ...(localPath === "" ? [] : [fieldBytes(45954, Buffer.from(`::NTOSFull::${localPath}`))]),
]);

const withStore = (work) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picture-files-"));
  const db = messageStore.openStore(path.join(dir, "store", "messages.db"));
  try {
    work(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("a picture sent as a file is read with its name and QQ's local preview; other files are not", () => {
  const body = Buffer.concat([
    element(fileElement({ name: "Moss_00008_.png", localPath: "L:\\QQ\\nt_qq\\nt_data\\File\\Thumb\\x_750.jpg" })),
    element(fileElement({ name: "workflow.json" })),
  ]);

  const pictures = pictureElements.messagePictures(body);

  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].md5, FILE_MD5);
  assert.equal(pictures[0].fileName, "Moss_00008_.png");
  assert.equal(pictures[0].localPath, "L:\\QQ\\nt_qq\\nt_data\\File\\Thumb\\x_750.jpg");
  assert.equal(pictures[0].format, 1001);
  assert.equal(pictures[0].seq, pictureElements.FILE_SEQ_BASE);
  assert.equal(pictures[0].sticker, false);
  assert.deepEqual(pictureElements.extractPictures(body), []);
});

test("a picture file is stored, never queued for Tencent, and shows QQ's preview copied into the store", () => {
  withStore((db, dir) => {
    const thumbDir = path.join(dir, "Tencent Files", "nt_qq", "nt_data", "File", "Thumb");
    fs.mkdirSync(thumbDir, { recursive: true });
    const localPath = path.join(thumbDir, `${FILE_MD5}_750.jpg`);
    fs.writeFileSync(localPath, PNG);
    messageStore.ingestExport(db, {
      messages: [],
      mediaMessages: [{
        groupId: "7", rowId: "9", sentAt: SENT_AT, senderName: "Ann", senderUin: "42", mediaRefs: [],
        pictures: pictureElements.messagePictures(element(fileElement({ name: "Moss_00008_.png", localPath }))),
      }],
    }, "run-1");
    const now = SENT_AT + 60;

    assert.equal(db.prepare("SELECT file_name FROM pictures").get().file_name, "Moss_00008_.png");
    assert.deepEqual(pictureStore.needingThumbs(db, { now, limit: 10 }), []);
    assert.equal(pictureStore.pendingCounts(db, now).thumbs, 0);
    assert.equal(pictureStore.isFileOnly(db, FILE_MD5), true);
    assert.deepEqual(pictureStore.pendingQqPreviews(db, { now, limit: 10 }), [FILE_MD5]);

    const storeDir = path.join(dir, "store");
    const copied = pictureStore.copyQqPreview(db, storeDir, FILE_MD5);

    assert.equal(copied, pictureStore.picturePath(storeDir, "preview", FILE_MD5, "png"));
    assert.deepEqual(fs.readFileSync(copied), PNG);
    assert.equal(pictureStore.fileRow(db, FILE_MD5).preview, `${FILE_MD5}.png`);
    assert.deepEqual(pictureStore.pendingQqPreviews(db, { now, limit: 10 }), []);
  });
});

test("a preview path outside QQ's file folder is never read", () => {
  withStore((db, dir) => {
    const outside = path.join(dir, "elsewhere.png");
    fs.writeFileSync(outside, PNG);
    pictureStore.ingestPictures(db, [{ groupId: "7", rowId: "m9", seq: 2000, md5: FILE_MD5, sentAt: SENT_AT, fileName: "a.png", localPath: outside }]);

    assert.equal(pictureStore.copyQqPreview(db, path.join(dir, "store"), FILE_MD5), null);
  });
});

test("a preview path that climbs out of QQ's folder with .. is refused", () => {
  withStore((db, dir) => {
    fs.writeFileSync(path.join(dir, "private.png"), PNG);
    const climbing = path.join(dir, "nt_data", "File", "..", "..", "private.png");
    pictureStore.ingestPictures(db, [{ groupId: "7", rowId: "m9", seq: 2000, md5: FILE_MD5, sentAt: SENT_AT, fileName: "a.png", localPath: climbing }]);

    assert.equal(pictureStore.copyQqPreview(db, path.join(dir, "store"), FILE_MD5), null);
  });
});

test("the preview is also found where QQ names it, when the message does not say", () => {
  withStore((db, dir) => {
    const ntDataDir = path.join(dir, "nt_qq", "nt_data");
    fs.mkdirSync(path.join(ntDataDir, "File", "Thumb"), { recursive: true });
    fs.writeFileSync(path.join(ntDataDir, "File", "Thumb", `${FILE_MD5}_750.jpg`), PNG);
    pictureStore.ingestPictures(db, [{ groupId: "7", rowId: "m9", seq: 2000, md5: FILE_MD5, sentAt: SENT_AT, fileName: "a.png" }]);

    assert.deepEqual(pictureStore.pendingQqPreviews(db, { now: SENT_AT + 60, limit: 10 }), [FILE_MD5]);
    assert.equal(pictureStore.copyQqPreview(db, path.join(dir, "store"), FILE_MD5), null);
    assert.ok(pictureStore.copyQqPreview(db, path.join(dir, "store"), FILE_MD5, { ntDataDir }).endsWith(`${FILE_MD5}.png`));
  });
});

test("a picture also posted the normal way is not file-only", () => {
  withStore((db) => {
    pictureStore.ingestPictures(db, [
      { groupId: "7", rowId: "m9", seq: 2000, md5: FILE_MD5, sentAt: SENT_AT, fileName: "a.png" },
      { groupId: "8", rowId: "m10", seq: 0, md5: FILE_MD5, sentAt: SENT_AT + 5, fileId: "fid" },
    ]);

    assert.equal(pictureStore.isFileOnly(db, FILE_MD5), false);
    assert.equal(pictureStore.locate(db, FILE_MD5).fileName, "");
    assert.equal(require("../src/gallery_store").listPictures(db, { fromUnix: SENT_AT - 60, toUnix: SENT_AT + 60 }).items[0].fileName, "");
  });
});

test("a picture sent only as a file is never shown as deleted by Tencent", () => {
  withStore((db) => {
    pictureStore.ingestPictures(db, [{ groupId: "7", rowId: "m9", seq: 2000, md5: FILE_MD5, sentAt: SENT_AT, fileName: "a.png" }]);
    pictureStore.updateFile(db, FILE_MD5, { gone: 1, failures: 3 });
    const gallery = require("../src/gallery_store");

    assert.equal(gallery.listPictures(db, { fromUnix: SENT_AT - 60, toUnix: SENT_AT + 60 }).items[0].gone, false);
    assert.equal(gallery.pictureDetail(db, FILE_MD5).gone, false);
  });
});
