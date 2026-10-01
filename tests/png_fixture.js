"use strict";

// Builds small PNGs for tests, optionally with a stealth carrier in the
// pixels (see src/png_stealth.js) and tEXt chunks.

const zlib = require("node:zlib");

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
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

// Every row uses the next of the five PNG filters, so all are exercised.
const filterRows = (pixels, width, height, channels) => {
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    out[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const raw = pixels[y * stride + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      out[y * (stride + 1) + 1 + i] = (raw - predictor) & 0xff;
    }
  }
  return out;
};

const toBits = (buffer) => [...buffer].flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >> shift) & 1));

const carrierBits = (signature, payload) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length * 8);
  return toBits(Buffer.concat([Buffer.from(signature, "latin1"), length, payload]));
};

// bits run down each column (x outer, y inner), one per pixel in the alpha
// channel or three (R, G, B) per pixel for the RGB carriers.
const makePng = ({ width = 96, height = 140, channels = 4, signature = null, payload = Buffer.alloc(0), textChunks = {} }) => {
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      pixels[base] = (x * 7 + y * 3) & 0xff;
      pixels[base + 1] = (x * 5 + y * 11) & 0xff;
      pixels[base + 2] = (x * 13 + y) & 0xff;
      if (channels === 4) {
        pixels[base + 3] = 254;
      }
    }
  }
  if (signature !== null) {
    const rgb = signature.startsWith("stealth_rgb");
    const perPixel = rgb ? 3 : 1;
    carrierBits(signature, payload).forEach((bit, index) => {
      const pixel = Math.floor(index / perPixel);
      const x = Math.floor(pixel / height);
      const y = pixel % height;
      const offset = (y * width + x) * channels + (rgb ? index % perPixel : 3);
      pixels[offset] = (pixels[offset] & 0xfe) | bit;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const compressed = zlib.deflateSync(filterRows(pixels, width, height, channels));
  const idat = [];
  for (let offset = 0; offset < compressed.length; offset += 700) {
    idat.push(pngChunk("IDAT", compressed.subarray(offset, offset + 700)));
  }
  const text = Object.entries(textChunks).map(([key, value]) => pngChunk("tEXt", Buffer.from(`${key}\0${value}`, "latin1")));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...text,
    ...idat,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

module.exports = { makePng };
