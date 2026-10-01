"use strict";

// Container-level text extraction for AI image metadata.
// Reads PNG text chunks, JPEG EXIF and comment text, and WebP EXIF WITHOUT
// loading pixel data (png_stealth.js reads pixels, and only when asked):
// chunk headers are read one at a time and image payloads are seeked past, so a
// 7 MB PNG costs a handful of small reads. Everything here is byte-level; no
// image decoding and no third-party dependency.

const fs = require("node:fs");
const zlib = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_TYPES = new Set(["tEXt", "zTXt", "iTXt"]);

// Chunks above the per-chunk cap are skipped, not truncated: a half prompt is
// worse than a recorded miss. The total cap stops a crafted file from making us
// buffer the whole image as "text".
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 512;
// Real pictures split their pixels into at most a few thousand IDAT chunks.
const MAX_IDAT_CHUNKS = 100000;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

const LATIN1 = "latin1";

const readExact = (fd, offset, length) => {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, offset);
  return read === length ? buffer : null;
};

const inflateText = (buffer) => {
  try {
    return zlib.inflateSync(buffer, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
  } catch {
    return null;
  }
};

const splitAtNull = (buffer, from) => {
  const index = buffer.indexOf(0, from);
  return index === -1 ? null : { value: buffer.subarray(from, index), next: index + 1 };
};

// tEXt: keyword \0 latin1-text
// zTXt: keyword \0 method(1) deflate(text)
// iTXt: keyword \0 flag(1) method(1) language \0 translated \0 utf8-text[deflated]
const decodePngTextChunk = (type, data) => {
  const keyword = splitAtNull(data, 0);
  if (keyword === null) {
    return null;
  }
  const key = keyword.value.toString(LATIN1);

  if (type === "tEXt") {
    return { key, value: data.subarray(keyword.next).toString(LATIN1) };
  }

  if (type === "zTXt") {
    const value = inflateText(data.subarray(keyword.next + 1));
    return value === null ? null : { key, value };
  }

  const compressed = data[keyword.next] === 1;
  const language = splitAtNull(data, keyword.next + 2);
  if (language === null) {
    return null;
  }
  const translated = splitAtNull(data, language.next);
  if (translated === null) {
    return null;
  }
  const payload = data.subarray(translated.next);
  const value = compressed ? inflateText(payload) : payload.toString("utf8");
  return value === null ? null : { key, value };
};

const readPngChunks = (fd, fileSize) => {
  const signature = readExact(fd, 0, PNG_SIGNATURE.length);
  if (signature === null || !signature.equals(PNG_SIGNATURE)) {
    return null;
  }

  const chunks = {};
  let offset = PNG_SIGNATURE.length;
  let ihdr = null;
  const idat = [];
  let textBytes = 0;
  let seen = 0;

  // IDAT does not count toward MAX_CHUNKS: a large picture is split into
  // well over a thousand of them, and text chunks may follow.
  while (offset + 8 <= fileSize && seen < MAX_CHUNKS) {
    const header = readExact(fd, offset, 8);
    if (header === null) {
      break;
    }
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString(LATIN1);
    const dataOffset = offset + 8;
    if (length > fileSize - dataOffset) {
      break;
    }

    if (type === "IDAT") {
      if (idat.length >= MAX_IDAT_CHUNKS) {
        break;
      }
      idat.push({ offset: dataOffset, length });
    } else if (type === "IHDR" && length >= 13) {
      seen += 1;
      const data = readExact(fd, dataOffset, 13);
      if (data !== null) {
        ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
      }
    } else if (PNG_TEXT_TYPES.has(type) && length <= MAX_CHUNK_BYTES && textBytes + length <= MAX_TOTAL_TEXT_BYTES) {
      seen += 1;
      const data = readExact(fd, dataOffset, length);
      const decoded = data === null ? null : decodePngTextChunk(type, data);
      if (decoded !== null && !(decoded.key in chunks)) {
        chunks[decoded.key] = decoded.value;
        textBytes += length;
      }
    } else if (type === "IEND") {
      break;
    } else {
      seen += 1;
    }

    offset = dataOffset + length + 4;
  }

  // Where the pixels are, for png_stealth: read only when no text says anything.
  const stealth = ihdr === null ? null : { ...ihdr, idat };
  return { container: "png", chunks, width: ihdr?.width ?? 0, height: ihdr?.height ?? 0, stealth };
};

// --- JPEG / EXIF -----------------------------------------------------------

const EXIF_TAGS = {
  0x010e: "ImageDescription",
  0x0131: "Software",
  0x9286: "UserComment",
};
const EXIF_SUB_IFD_TAG = 0x8769;
const MAX_IFD_ENTRIES = 512;

const asciiShare = (text) => {
  if (text.length === 0) {
    return 0;
  }
  let ascii = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x80) {
      ascii += 1;
    }
  }
  return ascii / text.length;
};

// Of two readings of the same UTF-16 bytes, the one that is mostly ASCII-range
// is right: every parameters string and graph is. Ties keep `preferred`.
const likelierUtf16 = (preferred, other) => (asciiShare(other) > asciiShare(preferred) ? other : preferred);

// Re-reads text that was decoded from UTF-16 with the wrong byte order
// ("笀∀爀攀" for '{"re'); returns it unchanged when it already reads right.
const repairUtf16ByteOrder = (text) =>
  likelierUtf16(text, Buffer.from(text, "utf16le").swap16().toString("utf16le"));

// The 8-byte character code: "ASCII", "UNICODE" or "JIS" padded with NULs,
// or eight NULs. Some writers drop the padding, or the code altogether (a
// bare JSON object), and cutting 8 bytes then destroys the text.
const CHARSET_CODES = ["ASCII", "UNICODE", "JIS"];

const charsetPrefix = (buffer) => {
  const head = buffer.subarray(0, 8).toString(LATIN1);
  const code = CHARSET_CODES.find((name) => head.startsWith(name));
  if (code !== undefined) {
    return { code, start: buffer[code.length] === 0 ? 8 : code.length };
  }
  const undefinedCode = buffer.length >= 8 && buffer.subarray(0, 8).every((byte) => byte === 0);
  return { code: null, start: undefinedCode ? 8 : 0 };
};

// UserComment is prefixed with that character code. NovelAI and most
// exporters write UTF-16 in the TIFF byte order (not the spec's big-endian),
// but some (Civitai) always write big-endian, so both orders are tried.
const BOM_LITTLE = [0xff, 0xfe];
const BOM_BIG = [0xfe, 0xff];

const hasBom = (payload) =>
  payload.length >= 2 && [BOM_LITTLE, BOM_BIG].some(([first, second]) => payload[0] === first && payload[1] === second);

const decodeUtf16 = (payload, littleEndian) => {
  const body = hasBom(payload) ? payload.subarray(2) : payload;
  const even = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
  const asLittle = even.toString("utf16le");
  const asBig = Buffer.from(even).swap16().toString("utf16le");
  return littleEndian ? likelierUtf16(asLittle, asBig) : likelierUtf16(asBig, asLittle);
};

const decodeUserComment = (buffer, littleEndian) => {
  const { code, start } = charsetPrefix(buffer);
  const payload = buffer.subarray(start);
  // A byte-order mark means UTF-16 even when the UNICODE code is missing.
  const text = code === "UNICODE" || hasBom(payload)
    ? decodeUtf16(payload, littleEndian)
    : payload.toString("utf8");
  return text.replace(/\0+$/u, "");
};

const readIfd = (tiff, ifdOffset, littleEndian, tags, out) => {
  if (ifdOffset + 2 > tiff.length) {
    return null;
  }
  const count = littleEndian ? tiff.readUInt16LE(ifdOffset) : tiff.readUInt16BE(ifdOffset);
  if (count > MAX_IFD_ENTRIES) {
    return null;
  }

  let subIfdOffset = null;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > tiff.length) {
      break;
    }
    const tag = littleEndian ? tiff.readUInt16LE(entry) : tiff.readUInt16BE(entry);
    const size = littleEndian ? tiff.readUInt32LE(entry + 4) : tiff.readUInt32BE(entry + 4);
    const rawValue = littleEndian ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8);

    if (tag === EXIF_SUB_IFD_TAG) {
      subIfdOffset = rawValue;
      continue;
    }
    const name = tags[tag];
    if (name === undefined || size > MAX_CHUNK_BYTES) {
      continue;
    }
    // Values of 4 bytes or fewer are stored inline in the offset field itself.
    const valueOffset = size <= 4 ? entry + 8 : rawValue;
    if (valueOffset + size > tiff.length) {
      continue;
    }
    const raw = tiff.subarray(valueOffset, valueOffset + size);
    out[name] = name === "UserComment"
      ? decodeUserComment(raw, littleEndian)
      : raw.toString(LATIN1).replace(/\0+$/u, "");
  }
  return subIfdOffset;
};

const parseExif = (tiff) => {
  if (tiff.length < 8) {
    return {};
  }
  const order = tiff.subarray(0, 2).toString(LATIN1);
  if (order !== "II" && order !== "MM") {
    return {};
  }
  const littleEndian = order === "II";
  const ifd0 = littleEndian ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);

  const out = {};
  const subIfdOffset = readIfd(tiff, ifd0, littleEndian, EXIF_TAGS, out);
  if (subIfdOffset !== null) {
    readIfd(tiff, subIfdOffset, littleEndian, EXIF_TAGS, out);
  }
  return out;
};

const readJpegChunks = (fd, fileSize) => {
  const start = readExact(fd, 0, 2);
  if (start === null || start[0] !== 0xff || start[1] !== 0xd8) {
    return null;
  }

  const chunks = {};
  let offset = 2;
  let width = 0;
  let height = 0;
  let seen = 0;

  while (offset + 4 <= fileSize && seen < MAX_CHUNKS) {
    const header = readExact(fd, offset, 4);
    if (header === null || header[0] !== 0xff) {
      break;
    }
    const marker = header[1];
    // Start of scan: everything after this is entropy-coded pixel data.
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    const length = header.readUInt16BE(2);
    if (length < 2) {
      break;
    }
    const dataOffset = offset + 4;
    const dataLength = length - 2;
    seen += 1;

    // SOF0..SOF15 carry the real dimensions (skipping the DHT/DAC/DNL markers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc && marker !== 0xc8) {
      const sof = readExact(fd, dataOffset, 5);
      if (sof !== null) {
        height = sof.readUInt16BE(1);
        width = sof.readUInt16BE(3);
      }
    } else if (marker === 0xe1 && dataLength <= MAX_CHUNK_BYTES) {
      const data = readExact(fd, dataOffset, dataLength);
      if (data !== null && data.subarray(0, 4).toString(LATIN1) === "Exif") {
        Object.assign(chunks, parseExif(data.subarray(6)));
      }
    } else if (marker === 0xfe && chunks.JpegComment === undefined) {
      // The comment segment: encoders sign it, a few tools put NovelAI JSON here.
      const data = readExact(fd, dataOffset, dataLength);
      if (data !== null) {
        chunks.JpegComment = data.toString("utf8").replace(/\0+$/u, "");
      }
    }

    offset = dataOffset + dataLength;
  }

  return { container: "jpeg", chunks, width, height };
};

// --- WebP ------------------------------------------------------------------

// RIFF chunks: VP8X carries the canvas size, VP8 / VP8L the frame size of a
// simple file, EXIF a TIFF block (some writers keep the JPEG "Exif\0\0"
// header in front of it). NovelAI's WebP puts its metadata in EXIF.
const readWebpChunks = (fd, fileSize) => {
  const header = readExact(fd, 0, 12);
  if (header === null || header.toString(LATIN1, 0, 4) !== "RIFF" || header.toString(LATIN1, 8, 12) !== "WEBP") {
    return null;
  }

  const chunks = {};
  let offset = 12;
  let width = 0;
  let height = 0;
  let seen = 0;
  // Pixels that can hide data: a lossless image, or a (lossless) alpha plane.
  let losslessPixels = false;

  while (offset + 8 <= fileSize && seen < MAX_CHUNKS) {
    const head = readExact(fd, offset, 8);
    if (head === null) {
      break;
    }
    const type = head.toString(LATIN1, 0, 4);
    const length = head.readUInt32LE(4);
    const dataOffset = offset + 8;
    if (length > fileSize - dataOffset) {
      break;
    }
    seen += 1;
    losslessPixels = losslessPixels || type === "VP8L" || type === "ALPH";

    if (type === "VP8X" && length >= 10) {
      const data = readExact(fd, dataOffset, 10);
      if (data !== null) {
        width = data.readUIntLE(4, 3) + 1;
        height = data.readUIntLE(7, 3) + 1;
      }
    } else if (type === "VP8 " && length >= 10 && width === 0) {
      const data = readExact(fd, dataOffset, 10);
      if (data !== null) {
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      }
    } else if (type === "VP8L" && length >= 5 && width === 0) {
      const data = readExact(fd, dataOffset, 5);
      if (data !== null && data[0] === 0x2f) {
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (type === "EXIF" && length <= MAX_CHUNK_BYTES) {
      const data = readExact(fd, dataOffset, length);
      if (data !== null) {
        const start = data.subarray(0, 6).toString(LATIN1) === "Exif\0\0" ? 6 : 0;
        Object.assign(chunks, parseExif(data.subarray(start)));
      }
    }

    // Chunks are padded to an even length.
    offset = dataOffset + length + (length % 2);
  }

  return { container: "webp", chunks, width, height, stealth: losslessPixels ? { kind: "webp" } : null };
};

// Returns { container, chunks, width, height, stealth } or null when the file
// is not a readable PNG, JPEG or WebP. Never throws on malformed input.
const readImageTextChunks = (filePath) => {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) {
      return null;
    }
    fd = fs.openSync(filePath, "r");
    return readPngChunks(fd, stat.size) ?? readJpegChunks(fd, stat.size) ?? readWebpChunks(fd, stat.size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};

module.exports = {
  readImageTextChunks,
  repairUtf16ByteOrder,
  // exported for tests
  decodePngTextChunk,
  decodeUserComment,
  parseExif,
};
