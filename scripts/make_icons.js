"use strict";

// Generates web/icons/icon-{192,512}.png (+ maskable) without image libraries:
// a blue rounded square holding a white speech bubble with three "headline"
// lines — the app is a briefing of chat. Run once after changing the design:
//   node scripts/make_icons.js

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const BLUE = [21, 101, 192];
const WHITE = [255, 255, 255];
const SAMPLES = 4;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const encodePng = (size, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

// Shapes in unit space [0,1]. Returns the colour at a point, or null (transparent).
const roundedRect = (x, y, left, top, right, bottom, radius) => {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return x >= left && x <= right && y >= top && y <= bottom && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};
const inTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const colourAt = (x, y, maskable) => {
  const inset = maskable ? 0 : 0.04;
  if (!roundedRect(x, y, inset, inset, 1 - inset, 1 - inset, maskable ? 0 : 0.2)) {
    return null;
  }
  const s = maskable ? 0.8 : 1;
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;
  const bubble = roundedRect(u, v, 0.2, 0.22, 0.8, 0.68, 0.1) || inTriangle(u, v, [0.3, 0.64], [0.44, 0.66], [0.26, 0.8]);
  if (!bubble) {
    return BLUE;
  }
  const lines = [[0.32, 0.68, 0.33], [0.32, 0.62, 0.44], [0.32, 0.5, 0.55]];
  const onLine = lines.some(([left, right, top]) => roundedRect(u, v, left, top, right, top + 0.055, 0.0275));
  return onLine ? BLUE : WHITE;
};

const render = (size, maskable) => {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const colour = colourAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, maskable);
          if (colour !== null) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 1;
          }
        }
      }
      const offset = (py * size + px) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
      }
      rgba[offset + 3] = Math.round((a / SAMPLES ** 2) * 255);
    }
  }
  return encodePng(size, rgba);
};

const outDir = path.join(__dirname, "..", "web", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [["icon-192", 192, false], ["icon-512", 512, false], ["icon-maskable-512", 512, true]]) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), render(size, maskable));
}
process.stdout.write(`icons written to ${outDir}\n`);
