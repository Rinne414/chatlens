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

const ELEMENT_TYPE_FIELD = 45002;
const PICTURE_ELEMENT = 2;
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
// before stickers were recorded (seq is part of the pictures primary key).
const STICKER_SEQ_BASE = 1000;

// The pictures of one message as stored: real pictures seq 0..n, stickers
// flagged and numbered from STICKER_SEQ_BASE.
const messagePictures = (body) => {
  const all = extractPictures(body);
  const plain = all.filter((picture) => !isSticker(picture)).map((picture, index) => ({ ...picture, sticker: false, seq: index }));
  const stickers = all.filter(isSticker).map((picture, index) => ({ ...picture, sticker: true, seq: STICKER_SEQ_BASE + index }));
  return [...plain, ...stickers];
};

// True for one element message of type picture (stickers included).
const isPictureElement = (buf) => {
  const fields = decodeFields(buf);
  return fields !== null && numberField(fields, ELEMENT_TYPE_FIELD) === PICTURE_ELEMENT;
};

module.exports = { STICKER_SEQ_BASE, extractPictures, messagePictures, isSticker, isPictureElement, decodeFields };
