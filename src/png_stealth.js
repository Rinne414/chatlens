"use strict";

// Stealth PNG info: generation data hidden in the least significant bits of a
// PNG's pixels. NovelAI writes it into every picture, A1111/Forge do with the
// stealth-pnginfo extension. It survives when an app strips the text chunks
// but keeps the pixels, which is how many pictures arrive through QQ.
// Ported from sd-image-sorter (backend/metadata_parser/png_stealth.py).
//
// The bits run down each column (x outer, y inner): a 15-byte signature, a
// 32-bit big-endian payload length IN BITS, then the payload ("comp" payloads
// are gzip). Alpha carriers use the alpha LSB of each pixel, RGB carriers the
// R, G and B LSBs. Only the pixels are decoded, never rendered.

const fs = require("node:fs");
const zlib = require("node:zlib");
const { decodeWebpPixels } = require("./webp_lossless");

const SIGNATURE_BYTES = 15;
const SIGNATURE_BITS = SIGNATURE_BYTES * 8;
const LENGTH_BYTES = 4;
const CARRIERS = new Map([
  ["stealth_pnginfo", { channel: "alpha", compressed: false }],
  ["stealth_pngcomp", { channel: "alpha", compressed: true }],
  ["stealth_rgbinfo", { channel: "rgb", compressed: false }],
  ["stealth_rgbcomp", { channel: "rgb", compressed: true }],
]);
const MAX_PIXEL_BYTES = 128 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
// The signature sits in the first column(s); this much compressed data
// covers those rows in nearly every picture, and is grown when it does not.
const PROBE_START_BYTES = 256 * 1024;
const PROBE_GROWTH = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Only what the writers produce: 8-bit RGB or RGBA, not interlaced.
const layoutOf = (info) => {
  if (info === null || info === undefined || info.bitDepth !== 8 || info.interlace !== 0) {
    return null;
  }
  const channels = { 2: 3, 6: 4 }[info.colorType];
  const { width, height } = info;
  if (channels === undefined || width <= 0 || height <= 0 || width * height * channels > MAX_PIXEL_BYTES) {
    return null;
  }
  return { width, height, channels, hasAlpha: channels === 4, alphaIndex: 3, rgb: true, stride: width * channels };
};

// Rows that hold the signature: 120 bits down column 0 (alpha), or 40 pixels
// of three bits (RGB); a short picture wraps into the next columns.
const probeRows = (layout) => Math.min(layout.height, layout.hasAlpha ? SIGNATURE_BITS : SIGNATURE_BITS / 3);

const rawBytesFor = (layout, rows) => rows * (layout.stride + 1);

// Inflates as much as the (possibly cut) zlib stream allows.
const inflatePrefix = (compressed, layout) => {
  try {
    return zlib.inflateSync(compressed, {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
      maxOutputLength: rawBytesFor(layout, layout.height) + 1024,
    });
  } catch {
    return null;
  }
};

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
};

// Reverses the per-row PNG filters for the first `rows` rows.
const unfilterRows = (raw, layout, rows) => {
  const { stride, channels } = layout;
  const out = Buffer.alloc(rows * stride);
  for (let y = 0; y < rows; y += 1) {
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    const filter = raw[src - 1];
    if (filter > 4) {
      return null;
    }
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[row + i - channels] : 0;
      const up = y > 0 ? out[above + i] : 0;
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = (left + up) >> 1;
      } else if (filter === 4) {
        predictor = paeth(left, up, y > 0 && i >= channels ? out[above + i - channels] : 0);
      }
      out[row + i] = (raw[src + i] + predictor) & 0xff;
    }
  }
  return out;
};

// Reads carrier bytes in column order from decoded pixels.
const bitReader = (pixels, layout, channel) => {
  const { width, height, channels } = layout;
  const perPixel = channel === "alpha" ? 1 : 3;
  const total = width * height * perPixel;
  let index = 0;
  const readBytes = (count) => {
    if (count * 8 > total - index) {
      return null;
    }
    const out = Buffer.alloc(count);
    for (let byte = 0; byte < count; byte += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const pixel = Math.floor(index / perPixel);
        const x = Math.floor(pixel / height);
        const y = pixel % height;
        const offset = y * width * channels + x * channels + (channel === "alpha" ? layout.alphaIndex : index % perPixel);
        value = (value << 1) | (pixels[offset] & 1);
        index += 1;
      }
      out[byte] = value;
    }
    return out;
  };
  return { readBytes, remainingBits: () => total - index };
};

const signatureIn = (pixels, layout) => {
  const channelsToTry = [layout.hasAlpha ? "alpha" : null, layout.rgb ? "rgb" : null].filter((name) => name !== null);
  for (const channel of channelsToTry) {
    const signature = bitReader(pixels, layout, channel).readBytes(SIGNATURE_BYTES)?.toString("latin1");
    if (CARRIERS.get(signature)?.channel === channel) {
      return signature;
    }
  }
  return null;
};

const WEBUI_TAIL = /(?:^|\n)Steps:\s*\d+\s*,[^\n]*\bSampler:/u;

// The payload is a JSON object of metadata fields (NovelAI) or a plain
// A1111 parameters string. Field values are kept as strings, like PNG text.
const metadataFromText = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.trimStart();
    return (start.startsWith("{") || start.startsWith("[")) && !WEBUI_TAIL.test(text) ? null : { parameters: text };
  }
  if (typeof value === "string") {
    return value.trim() === "" ? null : { parameters: value };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== null && field !== undefined)
    .map(([key, field]) => [key, typeof field === "string" ? field : JSON.stringify(field)]));
};

const decodeCarrier = (pixels, layout, signature) => {
  const { channel, compressed } = CARRIERS.get(signature);
  const reader = bitReader(pixels, layout, channel);
  reader.readBytes(SIGNATURE_BYTES);
  const length = reader.readBytes(LENGTH_BYTES);
  const bits = length === null ? 0 : length.readUInt32BE(0);
  if (bits === 0 || bits % 8 !== 0 || bits > reader.remainingBits() || bits / 8 > MAX_PAYLOAD_BYTES) {
    return null;
  }
  try {
    const payload = reader.readBytes(bits / 8);
    const bytes = compressed ? zlib.gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES }) : payload;
    const text = UTF8.decode(bytes);
    return text.trim() === "" ? null : metadataFromText(text);
  } catch {
    return null;
  }
};

/* ---------- from a file (chunk positions from image_text_chunks) ---------- */

const readIdat = (fd, segments, limit) => {
  const parts = [];
  let total = 0;
  for (const segment of segments) {
    if (total >= limit) {
      break;
    }
    const length = Math.min(segment.length, limit - total);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, segment.offset);
    parts.push(buffer);
    total += length;
  }
  return Buffer.concat(parts);
};

// WebP: a lossless picture carries both carriers; a lossy one only its alpha
// plane (lossy colour has lost its low bits). webp_lossless.js decodes.
const readWebpStealth = (filePath) => {
  try {
    const decoded = decodeWebpPixels(fs.readFileSync(filePath));
    if (decoded === null) {
      return null;
    }
    const { width, height } = decoded;
    const [pixels, layout] = decoded.rgba === null
      ? [decoded.alpha, { width, height, channels: 1, hasAlpha: true, alphaIndex: 0, rgb: false }]
      : [decoded.rgba, { width, height, channels: 4, hasAlpha: true, alphaIndex: 3, rgb: true }];
    const signature = signatureIn(pixels, layout);
    return signature === null ? null : decodeCarrier(pixels, layout, signature);
  } catch {
    return null;
  }
};

// info: from image_text_chunks -- for a PNG { width, height, bitDepth,
// colorType, interlace, idat: [{ offset, length }] }, for a WebP { kind: "webp" }.
// Returns the carrier's metadata fields, or null. Never throws.
const readStealthChunks = (filePath, info) => {
  if (info?.kind === "webp") {
    return readWebpStealth(filePath);
  }
  const layout = layoutOf(info);
  if (layout === null || !Array.isArray(info.idat) || info.idat.length === 0) {
    return null;
  }
  const idatBytes = info.idat.reduce((sum, segment) => sum + segment.length, 0);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const needed = rawBytesFor(layout, probeRows(layout));
    let limit = PROBE_START_BYTES;
    let raw = inflatePrefix(readIdat(fd, info.idat, limit), layout);
    while (raw !== null && raw.length < needed && limit < idatBytes) {
      limit *= PROBE_GROWTH;
      raw = inflatePrefix(readIdat(fd, info.idat, limit), layout);
    }
    if (raw === null || raw.length < needed) {
      return null;
    }
    const head = unfilterRows(raw, layout, probeRows(layout));
    const signature = head === null ? null : signatureIn(head, layout);
    if (signature === null) {
      return null;
    }
    const full = limit >= idatBytes ? raw : inflatePrefix(readIdat(fd, info.idat, idatBytes), layout);
    if (full === null || full.length < rawBytesFor(layout, layout.height)) {
      return null;
    }
    const pixels = unfilterRows(full, layout, layout.height);
    return pixels === null ? null : decodeCarrier(pixels, layout, signature);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};

/* ---------- from the head of a download ---------- */

// "yes": the head shows a carrier signature, so the whole picture is worth
// fetching; "short": a PNG that could carry one, but the head ends before
// the rows that would tell; "no": anything else.
const probeStealthBytes = (bytes) => {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "no";
  }
  let info = null;
  const idat = [];
  let pos = 8;
  let ended = false;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.subarray(pos + 4, pos + 8).toString("latin1");
    if (type === "IHDR" && pos + 21 <= bytes.length) {
      info = {
        width: bytes.readUInt32BE(pos + 8),
        height: bytes.readUInt32BE(pos + 12),
        bitDepth: bytes[pos + 16],
        colorType: bytes[pos + 17],
        interlace: bytes[pos + 20],
      };
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(pos + 8, Math.min(pos + 8 + length, bytes.length)));
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    pos += 12 + length;
  }
  const layout = layoutOf(info);
  if (layout === null) {
    return "no";
  }
  const raw = idat.length === 0 ? Buffer.alloc(0) : inflatePrefix(Buffer.concat(idat), layout);
  if (raw === null) {
    return "no";
  }
  if (raw.length < rawBytesFor(layout, probeRows(layout))) {
    return ended ? "no" : "short";
  }
  const head = unfilterRows(raw, layout, probeRows(layout));
  return head !== null && signatureIn(head, layout) !== null ? "yes" : "no";
};

module.exports = { readStealthChunks, probeStealthBytes };
