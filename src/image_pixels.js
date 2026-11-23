"use strict";

// A picture file as a small grey image, for the picture fingerprint
// (src/picture_hash.js). PNG is read here (zlib is in Node); JPEG through
// jpeg-js. Animated GIF and WebP are not read: they get no fingerprint.

const zlib = require("node:zlib");
const jpeg = require("jpeg-js");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Thumbnails are about 200 px and previews 1280 at most; a file claiming far
// more is not decoded (a small crafted file can claim any size).
const MAX_PIXELS = 16 * 1024 * 1024;
const JPEG_MEMORY_MB = 256;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

class UnsupportedImage extends Error {}

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) {
    return left;
  }
  return dUp <= dUpLeft ? up : upLeft;
};

const readPngChunks = (bytes) => {
  const chunks = { idat: [], palette: null, transparency: null, header: null };
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      chunks.header = data;
    } else if (type === "PLTE") {
      chunks.palette = data;
    } else if (type === "tRNS") {
      chunks.transparency = data;
    } else if (type === "IDAT") {
      chunks.idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  return chunks;
};

// Undoes the per-row filters in place; rows are `stride` bytes after a filter byte.
const unfilter = (raw, stride, height, bytesPerPixel) => {
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? pixels[target + index - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[target - stride + index] : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? pixels[target - stride + index - bytesPerPixel] : 0;
      const value = raw[source + index];
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[target + index] = (value + predicted) & 0xff;
    }
  }
  return pixels;
};

const luma = (red, green, blue) => (red * 299 + green * 587 + blue * 114) / 1000;
// Transparent parts read as white, the way a chat window shows them.
const onWhite = (value, alpha) => (value * alpha + 255 * (255 - alpha)) / 255;

const decodePng = (bytes) => {
  const { header, idat, palette, transparency } = readPngChunks(bytes);
  if (header === null || header.length < 13) {
    throw new UnsupportedImage("png without a header");
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colorType = header[9];
  const channels = CHANNELS[colorType];
  if (header[12] !== 0 || channels === undefined || ![8, 16].includes(depth) || (colorType === 3 && depth !== 8)) {
    throw new UnsupportedImage(`png layout not read: type ${colorType}, depth ${depth}, interlace ${header[12]}`);
  }
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
    throw new UnsupportedImage("png size out of range");
  }
  const sampleBytes = depth / 8;
  const bytesPerPixel = channels * sampleBytes;
  const stride = width * bytesPerPixel;
  // Never more than the header says the picture holds: a few hundred KB of
  // crafted data can inflate to gigabytes.
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  } catch (error) {
    throw new UnsupportedImage(`png data not read: ${error.code ?? error.message}`);
  }
  if (raw.length < (stride + 1) * height) {
    throw new UnsupportedImage("png data is cut short");
  }
  const pixels = unfilter(raw, stride, height, bytesPerPixel);
  const gray = new Uint8Array(width * height);
  // The high byte of a 16-bit sample is the 8-bit value.
  const sample = (pixel, channel) => pixels[pixel * bytesPerPixel + channel * sampleBytes];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (colorType === 3) {
      const entry = pixels[pixel];
      const alpha = transparency !== null && entry < transparency.length ? transparency[entry] : 255;
      gray[pixel] = onWhite(luma(palette[entry * 3], palette[entry * 3 + 1], palette[entry * 3 + 2]), alpha);
    } else if (colorType === 0 || colorType === 4) {
      gray[pixel] = onWhite(sample(pixel, 0), colorType === 4 ? sample(pixel, 1) : 255);
    } else {
      gray[pixel] = onWhite(luma(sample(pixel, 0), sample(pixel, 1), sample(pixel, 2)), colorType === 6 ? sample(pixel, 3) : 255);
    }
  }
  return { width, height, gray };
};

const decodeJpeg = (bytes) => {
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / (1024 * 1024), maxMemoryUsageInMB: JPEG_MEMORY_MB });
  const gray = new Uint8Array(image.width * image.height);
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    gray[pixel] = luma(image.data[pixel * 4], image.data[pixel * 4 + 1], image.data[pixel * 4 + 2]);
  }
  return { width: image.width, height: image.height, gray };
};

// { width, height, gray } or throws UnsupportedImage for a kind that is not read.
const decodeGray = (bytes) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return decodePng(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return decodeJpeg(bytes);
  }
  throw new UnsupportedImage("not a png or jpeg");
};

module.exports = { decodeGray, UnsupportedImage };
