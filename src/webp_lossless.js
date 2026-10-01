"use strict";

// WebP lossless (VP8L) decoding, written from the format specification
// (RFC 9649), so data hidden in a WebP's alpha channel can be read
// (png_stealth.js). Lossy colour (VP8) is never decoded: QQ's 720px previews
// are lossy colour with a LOSSLESS alpha plane (the ALPH chunk, itself a
// VP8L image stream), and the alpha plane is all a hidden prompt needs.
// Pure JavaScript, no dependency. Anything malformed gives null.

const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CODE_LENGTH = 15;
const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REPEAT_EXTRA_BITS = [2, 3, 7];
const REPEAT_OFFSETS = [3, 3, 11];
const PREDICTOR = 0;
const CROSS_COLOR = 1;
const SUBTRACT_GREEN = 2;
const COLOR_INDEXING = 3;
const VP8L_SIGNATURE = 0x2f;

// Distance codes 1..120 name a nearby pixel as (dx, dy): dx pixels to the
// left, dy rows up (RFC 9649, section 4.2.2).
const DISTANCE_MAP = [
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1,
  2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5,
  3, 4, -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5,
  5, 3, -5, 3, 0, 6, 6, 0, 1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6,
  -3, 6, 6, 3, -6, 3, 0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7,
  7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2,
  6, 6, -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7,
];

class MalformedError extends Error {}

const fail = (message) => {
  throw new MalformedError(message);
};

/* ---------- bits: least significant first ---------- */

const createBitReader = (bytes) => {
  let index = 0;
  let buffer = 0;
  let count = 0;
  const fill = (need) => {
    while (count < need) {
      if (index >= bytes.length) {
        fail("data ended early");
      }
      buffer = (buffer | (bytes[index] << count)) >>> 0;
      index += 1;
      count += 8;
    }
  };
  return {
    // n <= 24
    read: (n) => {
      if (n === 0) {
        return 0;
      }
      fill(n);
      const value = buffer & ((1 << n) - 1);
      buffer >>>= n;
      count -= n;
      return value;
    },
    bit: () => {
      fill(1);
      const value = buffer & 1;
      buffer >>>= 1;
      count -= 1;
      return value;
    },
  };
};

/* ---------- canonical prefix codes ---------- */

// From code lengths; codes are read a bit at a time like DEFLATE's. A code
// with a single symbol takes no bits at all.
const buildCode = (lengths) => {
  const count = new Uint16Array(MAX_CODE_LENGTH + 1);
  let used = 0;
  let onlySymbol = -1;
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    if (lengths[symbol] > 0) {
      count[lengths[symbol]] += 1;
      used += 1;
      onlySymbol = symbol;
    }
  }
  if (used === 0) {
    fail("empty prefix code");
  }
  if (used === 1) {
    return { single: onlySymbol };
  }
  let left = 1;
  for (let length = 1; length <= MAX_CODE_LENGTH; length += 1) {
    left = (left << 1) - count[length];
    if (left < 0) {
      fail("over-subscribed prefix code");
    }
  }
  if (left !== 0) {
    fail("incomplete prefix code");
  }
  const offsets = new Uint16Array(MAX_CODE_LENGTH + 2);
  for (let length = 1; length <= MAX_CODE_LENGTH; length += 1) {
    offsets[length + 1] = offsets[length] + count[length];
  }
  const symbols = new Uint16Array(used);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    if (lengths[symbol] > 0) {
      symbols[offsets[lengths[symbol]]] = symbol;
      offsets[lengths[symbol]] += 1;
    }
  }
  return { single: -1, count, symbols };
};

const readSymbol = (code, reader) => {
  if (code.single >= 0) {
    return code.single;
  }
  let value = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= MAX_CODE_LENGTH; length += 1) {
    value |= reader.bit();
    const count = code.count[length];
    if (value - count < first) {
      return code.symbols[index + value - first];
    }
    index += count;
    first = (first + count) << 1;
    value <<= 1;
  }
  return fail("bad prefix code");
};

const readCodeLengths = (reader, lengthCode, alphabetSize) => {
  const lengths = new Uint8Array(alphabetSize);
  let budget = alphabetSize;
  if (reader.read(1) === 1) {
    const lengthBits = 2 + 2 * reader.read(3);
    budget = 2 + reader.read(lengthBits);
    if (budget > alphabetSize) {
      fail("code length count too large");
    }
  }
  let symbol = 0;
  let previous = 8;
  while (symbol < alphabetSize && budget > 0) {
    budget -= 1;
    const length = readSymbol(lengthCode, reader);
    if (length < 16) {
      lengths[symbol] = length;
      symbol += 1;
      previous = length === 0 ? previous : length;
      continue;
    }
    const slot = length - 16;
    const repeat = reader.read(REPEAT_EXTRA_BITS[slot]) + REPEAT_OFFSETS[slot];
    if (symbol + repeat > alphabetSize) {
      fail("code length repeat runs past the alphabet");
    }
    lengths.fill(length === 16 ? previous : 0, symbol, symbol + repeat);
    symbol += repeat;
  }
  return lengths;
};

const readPrefixCode = (reader, alphabetSize) => {
  if (reader.read(1) === 1) {
    const lengths = new Uint8Array(alphabetSize);
    const symbolCount = reader.read(1) + 1;
    const first = reader.read(reader.read(1) === 1 ? 8 : 1);
    if (first >= alphabetSize) {
      fail("simple code symbol out of range");
    }
    lengths[first] = 1;
    if (symbolCount === 2) {
      const second = reader.read(8);
      if (second >= alphabetSize) {
        fail("simple code symbol out of range");
      }
      lengths[second] = 1;
    }
    return buildCode(lengths);
  }
  const lengthCodeLengths = new Uint8Array(CODE_LENGTH_ORDER.length);
  const listed = reader.read(4) + 4;
  for (let index = 0; index < listed; index += 1) {
    lengthCodeLengths[CODE_LENGTH_ORDER[index]] = reader.read(3);
  }
  return buildCode(readCodeLengths(reader, buildCode(lengthCodeLengths), alphabetSize));
};

/* ---------- pixels: ARGB in a Uint32Array ---------- */

const subSampleSize = (size, bits) => (size + (1 << bits) - 1) >> bits;

// Length and distance values: a prefix symbol plus extra bits.
const prefixValue = (symbol, reader) => {
  if (symbol < 4) {
    return symbol + 1;
  }
  const extraBits = (symbol - 2) >> 1;
  return ((2 + (symbol & 1)) << extraBits) + reader.read(extraBits) + 1;
};

const distanceFor = (code, width) => {
  if (code > 120) {
    return code - 120;
  }
  const distance = DISTANCE_MAP[(code - 1) * 2] + DISTANCE_MAP[(code - 1) * 2 + 1] * width;
  return distance >= 1 ? distance : 1;
};

const decodePixels = (reader, width, height, { groups, meta, cacheBits }) => {
  const total = width * height;
  const out = new Uint32Array(total);
  const cache = cacheBits > 0 ? new Uint32Array(1 << cacheBits) : null;
  const cacheShift = 32 - cacheBits;
  const remember = (argb) => {
    if (cache !== null) {
      cache[Math.imul(0x1e35a7bd, argb) >>> cacheShift] = argb;
    }
  };
  const groupAt = (x, y) => (meta === null ? groups[0] : groups[meta.codes[(y >> meta.bits) * meta.width + (x >> meta.bits)]]);
  let pos = 0;
  let x = 0;
  let y = 0;
  while (pos < total) {
    const group = groupAt(x, y);
    const code = readSymbol(group[0], reader);
    if (code < NUM_LITERAL_CODES) {
      const red = readSymbol(group[1], reader);
      const blue = readSymbol(group[2], reader);
      const alpha = readSymbol(group[3], reader);
      out[pos] = ((alpha << 24) | (red << 16) | (code << 8) | blue) >>> 0;
      remember(out[pos]);
      pos += 1;
      x += 1;
    } else if (code < NUM_LITERAL_CODES + NUM_LENGTH_CODES) {
      const length = prefixValue(code - NUM_LITERAL_CODES, reader);
      const distance = distanceFor(prefixValue(readSymbol(group[4], reader), reader), width);
      if (distance > pos || pos + length > total) {
        fail("backward reference out of range");
      }
      for (let step = 0; step < length; step += 1) {
        out[pos] = out[pos - distance];
        remember(out[pos]);
        pos += 1;
      }
      x += length;
    } else {
      const key = code - NUM_LITERAL_CODES - NUM_LENGTH_CODES;
      if (cache === null || key >= cache.length) {
        fail("colour cache index out of range");
      }
      out[pos] = cache[key];
      remember(out[pos]);
      pos += 1;
      x += 1;
    }
    while (x >= width) {
      x -= width;
      y += 1;
    }
  }
  return out;
};

/* ---------- inverse transforms ---------- */

const addPixels = (a, b) =>
  ((((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00) | (((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff)) >>> 0;

const average2 = (a, b) => ((((a ^ b) & 0xfefefefe) >>> 1) + ((a & b) >>> 0)) >>> 0;

const channel = (argb, shift) => (argb >>> shift) & 0xff;
const SHIFTS = [24, 16, 8, 0];
const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);
const fromChannels = (compute) => SHIFTS.reduce((argb, shift) => (argb | (compute(shift) << shift)) >>> 0, 0);

const select = (left, top, topLeft) => {
  let toLeft = 0;
  let toTop = 0;
  for (const shift of SHIFTS) {
    toLeft += Math.abs(channel(top, shift) - channel(topLeft, shift));
    toTop += Math.abs(channel(left, shift) - channel(topLeft, shift));
  }
  return toLeft < toTop ? left : top;
};

const clampAddSubtractFull = (a, b, c) =>
  fromChannels((shift) => clamp255(channel(a, shift) + channel(b, shift) - channel(c, shift)));

const clampAddSubtractHalf = (a, b) =>
  fromChannels((shift) => clamp255(channel(a, shift) + Math.trunc((channel(a, shift) - channel(b, shift)) / 2)));

const predict = (mode, data, index, width) => {
  const left = data[index - 1];
  const top = data[index - width];
  const topLeft = data[index - width - 1];
  // On the last column this wraps to the row's first pixel, as specified.
  const topRight = data[index - width + 1];
  switch (mode) {
    case 0: return 0xff000000;
    case 1: return left;
    case 2: return top;
    case 3: return topRight;
    case 4: return topLeft;
    case 5: return average2(average2(left, topRight), top);
    case 6: return average2(left, topLeft);
    case 7: return average2(left, top);
    case 8: return average2(topLeft, top);
    case 9: return average2(top, topRight);
    case 10: return average2(average2(left, topLeft), average2(top, topRight));
    case 11: return select(left, top, topLeft);
    case 12: return clampAddSubtractFull(left, top, topLeft);
    case 13: return clampAddSubtractHalf(average2(left, top), topLeft);
    default: return 0xff000000;
  }
};

const inversePredictor = ({ width, bits, data: modes }, data, height) => {
  const tilesPerRow = subSampleSize(width, bits);
  data[0] = addPixels(data[0], 0xff000000);
  for (let x = 1; x < width; x += 1) {
    data[x] = addPixels(data[x], data[x - 1]);
  }
  for (let y = 1; y < height; y += 1) {
    const row = y * width;
    data[row] = addPixels(data[row], data[row - width]);
    const tileRow = (y >> bits) * tilesPerRow;
    for (let x = 1; x < width; x += 1) {
      const mode = (modes[tileRow + (x >> bits)] >>> 8) & 0xf;
      data[row + x] = addPixels(data[row + x], predict(mode, data, row + x, width));
    }
  }
  return data;
};

const signed8 = (value) => (value & 0x80 ? (value & 0xff) - 256 : value & 0xff);
const colorDelta = (multiplier, color) => (signed8(multiplier) * signed8(color)) >> 5;

const inverseCrossColor = ({ width, bits, data: elements }, data, height) => {
  const tilesPerRow = subSampleSize(width, bits);
  for (let y = 0; y < height; y += 1) {
    const tileRow = (y >> bits) * tilesPerRow;
    for (let x = 0; x < width; x += 1) {
      const element = elements[tileRow + (x >> bits)];
      const index = y * width + x;
      const argb = data[index];
      const green = (argb >>> 8) & 0xff;
      const red = (((argb >>> 16) & 0xff) + colorDelta(element, green)) & 0xff;
      let blue = ((argb & 0xff) + colorDelta(element >>> 8, green)) & 0xff;
      blue = (blue + colorDelta(element >>> 16, red)) & 0xff;
      data[index] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
    }
  }
  return data;
};

const inverseSubtractGreen = (data) => {
  for (let index = 0; index < data.length; index += 1) {
    const argb = data[index];
    const green = (argb >>> 8) & 0xff;
    const red = (((argb >>> 16) & 0xff) + green) & 0xff;
    const blue = ((argb & 0xff) + green) & 0xff;
    data[index] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
  }
  return data;
};

// Several small palette indices are packed into one pixel's green channel.
const inverseColorIndexing = ({ width, bits, table }, data, height) => {
  const packedWidth = subSampleSize(width, bits);
  const bitsPerIndex = 8 >> bits;
  const indexMask = (1 << bitsPerIndex) - 1;
  const perPixel = (1 << bits) - 1;
  const out = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const green = (data[y * packedWidth + (x >> bits)] >>> 8) & 0xff;
      out[y * width + x] = table[(green >> ((x & perPixel) * bitsPerIndex)) & indexMask];
    }
  }
  return out;
};

const INVERSE = {
  [PREDICTOR]: inversePredictor,
  [CROSS_COLOR]: inverseCrossColor,
  [SUBTRACT_GREEN]: (transform, data) => inverseSubtractGreen(data),
  [COLOR_INDEXING]: inverseColorIndexing,
};

/* ---------- image streams ---------- */

const readTransform = (reader, type, width, height) => {
  if (type === SUBTRACT_GREEN) {
    return { type, width };
  }
  if (type === COLOR_INDEXING) {
    const colors = reader.read(8) + 1;
    const bits = colors > 16 ? 0 : colors > 4 ? 1 : colors > 2 ? 2 : 3;
    // eslint-disable-next-line no-use-before-define
    const deltas = decodeImageStream(reader, colors, 1, false);
    // The table is delta-coded; indices past it are transparent black.
    const table = new Uint32Array(1 << (8 >> bits));
    for (let index = 0; index < colors; index += 1) {
      table[index] = index === 0 ? deltas[0] : addPixels(deltas[index], table[index - 1]);
    }
    return { type, width, bits, table };
  }
  const bits = reader.read(3) + 2;
  // eslint-disable-next-line no-use-before-define
  const data = decodeImageStream(reader, subSampleSize(width, bits), subSampleSize(height, bits), false);
  return { type, width, bits, data };
};

// A main image ("level 0") may carry transforms and per-region prefix codes;
// the sub-images that describe those never do.
const decodeImageStream = (reader, width, height, isMain) => {
  if (width * height > MAX_PIXELS) {
    fail("image too large");
  }
  const transforms = [];
  let codedWidth = width;
  if (isMain) {
    const seen = new Set();
    while (reader.read(1) === 1) {
      const type = reader.read(2);
      if (seen.has(type)) {
        fail("transform repeated");
      }
      seen.add(type);
      const transform = readTransform(reader, type, codedWidth, height);
      transforms.push(transform);
      if (type === COLOR_INDEXING) {
        codedWidth = subSampleSize(codedWidth, transform.bits);
      }
    }
  }

  let cacheBits = 0;
  if (reader.read(1) === 1) {
    cacheBits = reader.read(4);
    if (cacheBits < 1 || cacheBits > 11) {
      fail("bad colour cache size");
    }
  }

  let meta = null;
  let groupCount = 1;
  if (isMain && reader.read(1) === 1) {
    const bits = reader.read(3) + 2;
    const metaWidth = subSampleSize(codedWidth, bits);
    const entropy = decodeImageStream(reader, metaWidth, subSampleSize(height, bits), false);
    const codes = new Uint16Array(entropy.length);
    for (let index = 0; index < entropy.length; index += 1) {
      codes[index] = (entropy[index] >>> 8) & 0xffff;
      groupCount = Math.max(groupCount, codes[index] + 1);
    }
    meta = { bits, width: metaWidth, codes };
  }

  const greenAlphabet = NUM_LITERAL_CODES + NUM_LENGTH_CODES + (cacheBits > 0 ? 1 << cacheBits : 0);
  const groups = [];
  for (let group = 0; group < groupCount; group += 1) {
    groups.push([greenAlphabet, NUM_LITERAL_CODES, NUM_LITERAL_CODES, NUM_LITERAL_CODES, NUM_DISTANCE_CODES]
      .map((size) => readPrefixCode(reader, size)));
  }

  let pixels = decodePixels(reader, codedWidth, height, { groups, meta, cacheBits });
  for (let index = transforms.length - 1; index >= 0; index -= 1) {
    pixels = INVERSE[transforms[index].type](transforms[index], pixels, height);
  }
  return pixels;
};

const decodeVp8l = (bytes) => {
  const reader = createBitReader(bytes);
  if (reader.read(8) !== VP8L_SIGNATURE) {
    fail("not a VP8L stream");
  }
  const width = reader.read(14) + 1;
  const height = reader.read(14) + 1;
  reader.read(1);
  if (reader.read(3) !== 0) {
    fail("unknown VP8L version");
  }
  return { width, height, argb: decodeImageStream(reader, width, height, true) };
};

/* ---------- the ALPH chunk ---------- */

// Undoes the alpha plane's prediction filter (1 horizontal, 2 vertical,
// 3 gradient). The first row predicts from the left and the first column
// from above, whatever the method.
const unfilterAlpha = (data, width, height, method) => {
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let predictor = 0;
      if (y === 0) {
        predictor = x === 0 ? 0 : out[index - 1];
      } else if (x === 0) {
        predictor = out[index - width];
      } else if (method === 1) {
        predictor = out[index - 1];
      } else if (method === 2) {
        predictor = out[index - width];
      } else {
        predictor = clamp255(out[index - 1] + out[index - width] - out[index - width - 1]);
      }
      out[index] = (data[index] + predictor) & 0xff;
    }
  }
  return out;
};

const decodeAlphaChunk = (bytes, width, height) => {
  const compression = bytes[0] & 0x03;
  const filter = (bytes[0] >> 2) & 0x03;
  let plane;
  if (compression === 0) {
    if (bytes.length - 1 < width * height) {
      fail("raw alpha too short");
    }
    plane = Buffer.from(bytes.subarray(1, 1 + width * height));
  } else if (compression === 1) {
    // The alpha values sit in the green channel of a VP8L image stream.
    const argb = decodeImageStream(createBitReader(bytes.subarray(1)), width, height, true);
    plane = Buffer.alloc(width * height);
    for (let index = 0; index < plane.length; index += 1) {
      plane[index] = (argb[index] >>> 8) & 0xff;
    }
  } else {
    fail("unknown alpha compression");
  }
  return filter === 0 ? plane : unfilterAlpha(plane, width, height, filter);
};

/* ---------- the file ---------- */

const riffChunks = (bytes) => {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }
  const chunks = new Map();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) {
      return null;
    }
    if (!chunks.has(type)) {
      chunks.set(type, bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 8 + length + (length % 2);
  }
  return chunks;
};

const argbToRgba = (argb) => {
  const rgba = Buffer.alloc(argb.length * 4);
  for (let index = 0; index < argb.length; index += 1) {
    const pixel = argb[index];
    rgba[index * 4] = (pixel >>> 16) & 0xff;
    rgba[index * 4 + 1] = (pixel >>> 8) & 0xff;
    rgba[index * 4 + 2] = pixel & 0xff;
    rgba[index * 4 + 3] = pixel >>> 24;
  }
  return rgba;
};

// Returns { width, height, rgba, alpha } for a lossless WebP (rgba: R,G,B,A
// bytes), { width, height, rgba: null, alpha } for lossy colour with an alpha
// plane, and null for anything else (no alpha, animation, damage).
const decodeWebpPixels = (bytes) => {
  try {
    if (bytes.length > MAX_FILE_BYTES) {
      return null;
    }
    const chunks = riffChunks(bytes);
    if (chunks === null || chunks.has("ANIM")) {
      return null;
    }
    if (chunks.has("VP8L")) {
      const { width, height, argb } = decodeVp8l(chunks.get("VP8L"));
      const rgba = argbToRgba(argb);
      return { width, height, rgba, alpha: Buffer.from(rgba.filter((_, index) => index % 4 === 3)) };
    }
    const header = chunks.get("VP8X");
    const alph = chunks.get("ALPH");
    if (header === undefined || header.length < 10 || alph === undefined || alph.length < 2) {
      return null;
    }
    const width = header.readUIntLE(4, 3) + 1;
    const height = header.readUIntLE(7, 3) + 1;
    if (width * height > MAX_PIXELS) {
      return null;
    }
    return { width, height, rgba: null, alpha: decodeAlphaChunk(alph, width, height) };
  } catch (error) {
    if (error instanceof MalformedError || error instanceof RangeError) {
      return null;
    }
    throw error;
  }
};

module.exports = { decodeWebpPixels, unfilterAlpha };
