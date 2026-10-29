"use strict";

// Structured picture facts from a QQNT message body (column 40800).
//
// The body is a protobuf of message elements; an element carries its type in
// field 45002 (2 = picture). A picture element states the ORIGINAL's md5, byte
// size, dimensions and format, and where Tencent serves it:
//   45003 sub type (0 / absent = a real picture; every other value measured
//         so far - 1, 2, 4, 7, 11, 13 - is a sticker: small squares and GIFs)
//   45405 original size      45406 md5 (16 bytes)    45411/45412 width/height
//   45416 format (1000 jpg, 1001 png, 1002 webp, 2000 gif, ...)
//   45505 when Tencent deletes the file (upload + 31 days)
//   45804 original URL path: "/download?appid=1407&fileid=..." (NT, needs an
//         rkey) or "/gchatpic_new/<a>/<b>-<c>-<MD5>/0?..." (legacy, no rkey)
// Elements are not descended into, so the picture a reply QUOTES (nested
// inside the reply element) is never attributed to the replier.

// A file element (type 3) whose name ends in a picture extension is a picture
// sent as a file, usually an original kept whole (AI pictures with their
// prompt). It is recorded like a picture, but Tencent serves it only through
// the group-file service, so what can be shown is QQ's own local preview:
//   45402 file name    45405 size    45406 md5 (16 bytes)    45411/45412 size
//   45954 "::NTOSFull::<...>/nt_data/File/Thumb/<md5>_750.jpg" (despite the
//         name a PNG up to 1280 px, written once QQ has shown the file)

const ELEMENT_TYPE_FIELD = 45002;
const PICTURE_ELEMENT = 2;
const FILE_ELEMENT = 3;
const FILE_FORMATS = { jpg: 1000, jpeg: 1000, png: 1001, webp: 1002, bmp: 1005, gif: 2000 };
const LOCAL_PATH_PREFIX = "::NTOSFull::";
const MAX_DEPTH = 4;
const LEGACY_PATH = /^(\/gchatpic_new\/\d+\/[\w-]+)\/\d+(?:\?.*)?$/u;
const FILE_ID = /[?&]fileid=([\w-]+)/u;

const readVarint = (buf, start) => {
  let value = 0;
  let scale = 1;
  let pos = start;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      return [value, pos];
    }
    scale *= 128;
    if (pos - start > 10) {
      return [null, pos];
    }
  }
  return [null, pos];
};

// Returns null on any malformed field, so arbitrary bytes are not mistaken
// for a nested message.
const decodeFields = (buf) => {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    if (tag === null || tag < 8) {
      return null;
    }
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    pos = afterTag;
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      if (value === null) {
        return null;
      }
      fields.push({ field, value });
      pos = next;
    } else if (wire === 2) {
      const [length, next] = readVarint(buf, pos);
      if (length === null || next + length > buf.length) {
        return null;
      }
      fields.push({ field, bytes: buf.subarray(next, next + length) });
      pos = next + length;
    } else if (wire === 5 || wire === 1) {
      pos += wire === 5 ? 4 : 8;
      if (pos > buf.length) {
        return null;
      }
    } else {
      return null;
    }
  }
  return fields;
};

const collectElements = (buf, depth, out) => {
  const fields = decodeFields(buf);
  if (fields === null) {
    return;
  }
  if (fields.some((item) => item.field === ELEMENT_TYPE_FIELD && item.value !== undefined)) {
    out.push(fields);
    return;
  }
  if (depth >= MAX_DEPTH) {
    return;
  }
  for (const item of fields) {
    if (item.bytes !== undefined && item.bytes.length > 2) {
      collectElements(item.bytes, depth + 1, out);
    }
  }
};

const numberField = (fields, field) => fields.find((item) => item.field === field && item.value !== undefined)?.value ?? null;
const bytesField = (fields, field) => fields.find((item) => item.field === field && item.bytes !== undefined)?.bytes ?? null;
const textField = (fields, field) => bytesField(fields, field)?.toString("utf8") ?? "";

const md5Of = (fields) => {
  const raw = bytesField(fields, 45406);
  if (raw !== null && raw.length === 16) {
    return raw.toString("hex");
  }
  const fromName = textField(fields, 45402).replaceAll("-", "").match(/[a-f0-9]{32}/iu);
  return fromName === null ? null : fromName[0].toLowerCase();
};

const pictureFrom = (fields) => {
  const md5 = md5Of(fields);
  if (md5 === null) {
    return null;
  }
  const url = textField(fields, 45804);
  const legacy = url.match(LEGACY_PATH);
  return {
    md5,
    fileId: url.startsWith("/download") ? (url.match(FILE_ID)?.[1] ?? "") : "",
    legacyPath: legacy === null ? "" : legacy[1],
    size: numberField(fields, 45405) ?? 0,
    width: numberField(fields, 45411) ?? 0,
    height: numberField(fields, 45412) ?? 0,
    format: numberField(fields, 45416) ?? 0,
    subType: numberField(fields, 45003),
    expiresAt: numberField(fields, 45505) ?? 0,
  };
};

const toBuffer = (body) => {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string" && body.length > 0 && /^[0-9a-f]+$/iu.test(body)) {
    return Buffer.from(body, "hex");
  }
  return null;
};

const fileExtension = (name) => name.match(/\.([a-z]{3,4})$/iu)?.[1].toLowerCase() ?? "";

const imageFileFrom = (fields) => {
  const fileName = textField(fields, 45402);
  const format = FILE_FORMATS[fileExtension(fileName)];
  const md5 = bytesField(fields, 45406);
  if (format === undefined || md5 === null || md5.length !== 16) {
    return null;
  }
  const localPath = textField(fields, 45954);
  return {
    md5: md5.toString("hex"),
    fileId: "",
    legacyPath: "",
    size: numberField(fields, 45405) ?? 0,
    width: numberField(fields, 45411) ?? 0,
    height: numberField(fields, 45412) ?? 0,
    format,
    subType: null,
    expiresAt: numberField(fields, 45505) ?? 0,
    fileName,
    localPath: localPath.startsWith(LOCAL_PATH_PREFIX) ? localPath.slice(LOCAL_PATH_PREFIX.length) : localPath,
  };
};

// Pictures sent as files (see above); a quoted file is never included.
const extractImageFiles = (body) => {
  const buf = toBuffer(body);
  if (buf === null) {
    return [];
  }
  const elements = [];
  collectElements(buf, 0, elements);
  return elements
    .filter((fields) => numberField(fields, ELEMENT_TYPE_FIELD) === FILE_ELEMENT)
    .map(imageFileFrom)
    .filter((picture) => picture !== null);
};

// All picture elements of one message, stickers included (see isSticker).
const extractPictures = (body) => {
  const buf = toBuffer(body);
  if (buf === null) {
    return [];
  }
  const elements = [];
  collectElements(buf, 0, elements);
  return elements
    .filter((fields) => numberField(fields, ELEMENT_TYPE_FIELD) === PICTURE_ELEMENT)
    .map(pictureFrom)
    .filter((picture) => picture !== null);
};

const isSticker = (picture) => picture.subType !== null && picture.subType !== 0;

// Stickers are numbered from here so a real picture keeps the seq it had
// before stickers were recorded (seq is part of the pictures primary key);
// pictures sent as files from FILE_SEQ_BASE for the same reason.
const STICKER_SEQ_BASE = 1000;
const FILE_SEQ_BASE = 2000;

// The pictures of one message as stored: real pictures seq 0..n, stickers
// flagged and numbered from STICKER_SEQ_BASE, picture files (fileName set)
// from FILE_SEQ_BASE.
const messagePictures = (body) => {
  const all = extractPictures(body);
  const plain = all.filter((picture) => !isSticker(picture)).map((picture, index) => ({ ...picture, sticker: false, seq: index }));
  const stickers = all.filter(isSticker).map((picture, index) => ({ ...picture, sticker: true, seq: STICKER_SEQ_BASE + index }));
  const files = extractImageFiles(body).map((picture, index) => ({ ...picture, sticker: false, seq: FILE_SEQ_BASE + index }));
  return [...plain, ...stickers, ...files];
};

// True for one element message of type picture (stickers included).
const isPictureElement = (buf) => {
  const fields = decodeFields(buf);
  return fields !== null && numberField(fields, ELEMENT_TYPE_FIELD) === PICTURE_ELEMENT;
};

module.exports = { STICKER_SEQ_BASE, FILE_SEQ_BASE, extractPictures, extractImageFiles, messagePictures, isSticker, isPictureElement, decodeFields };
