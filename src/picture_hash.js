"use strict";

// The picture fingerprint: 64 bits that stay (nearly) the same when a picture
// is re-compressed, resized or re-saved, so the same picture posted again as a
// different file can be recognised. A perceptual hash: the grey picture is
// shrunk to 32x32, its lowest 8x8 frequencies (without the overall brightness)
// are compared with their median, one bit each. Two fingerprints are compared
// by how many bits differ.

const SIZE = 32;
const LOW = 8;
const BITS = LOW * LOW;
// A picture whose 32x32 grey values differ by less than this (standard
// deviation, of 255) is one flat colour: every such picture would get the
// same fingerprint. A soft gradient is well above it.
const FLAT_DEVIATION = 2;

// Area average: every source pixel falls in exactly one cell, so a large
// picture and its thumbnail shrink to nearly the same 32x32.
const shrink = ({ width, height, gray }) => {
  const sums = new Float64Array(SIZE * SIZE);
  const counts = new Uint32Array(SIZE * SIZE);
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(SIZE - 1, Math.floor((y * SIZE) / height));
    for (let x = 0; x < width; x += 1) {
      const cell = cellY * SIZE + Math.min(SIZE - 1, Math.floor((x * SIZE) / width));
      sums[cell] += gray[y * width + x];
      counts[cell] += 1;
    }
  }
  const small = new Float64Array(SIZE * SIZE);
  for (let cell = 0; cell < small.length; cell += 1) {
    // A picture narrower than 32 leaves cells empty: they take their left / upper neighbour.
    small[cell] = counts[cell] > 0 ? sums[cell] / counts[cell] : small[cell % SIZE > 0 ? cell - 1 : Math.max(0, cell - SIZE)];
  }
  return small;
};

const COSINES = Array.from({ length: LOW }, (unused, frequency) =>
  Float64Array.from({ length: SIZE }, (unused2, position) => Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * SIZE))));

// The LOW x LOW lowest frequencies of the 32x32 picture.
const lowFrequencies = (small) => {
  const rows = new Float64Array(SIZE * LOW);
  for (let y = 0; y < SIZE; y += 1) {
    for (let u = 0; u < LOW; u += 1) {
      let sum = 0;
      for (let x = 0; x < SIZE; x += 1) {
        sum += small[y * SIZE + x] * COSINES[u][x];
      }
      rows[y * LOW + u] = sum;
    }
  }
  const low = new Float64Array(BITS);
  for (let v = 0; v < LOW; v += 1) {
    for (let u = 0; u < LOW; u += 1) {
      let sum = 0;
      for (let y = 0; y < SIZE; y += 1) {
        sum += rows[y * LOW + u] * COSINES[v][y];
      }
      low[v * LOW + u] = sum;
    }
  }
  return low;
};

// 16 hex characters, or null for a picture that is one flat colour.
const hashOfGray = (image) => {
  if (image.width < LOW || image.height < LOW) {
    return null;
  }
  const small = shrink(image);
  const mean = small.reduce((sum, value) => sum + value, 0) / small.length;
  const deviation = Math.sqrt(small.reduce((sum, value) => sum + (value - mean) ** 2, 0) / small.length);
  if (deviation < FLAT_DEVIATION) {
    return null;
  }
  const low = lowFrequencies(small);
  // Without [0]: the overall brightness says nothing about what is in the picture.
  const rest = [...low.subarray(1)].sort((left, right) => left - right);
  const median = (rest[Math.floor(rest.length / 2) - 1] + rest[Math.floor(rest.length / 2)]) / 2;
  let hex = "";
  for (let nibble = 0; nibble < BITS / 4; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const index = nibble * 4 + bit;
      value = (value << 1) | (index > 0 && low[index] > median ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
};

// The fingerprint as two 32-bit halves, for fast comparing.
const halves = (hex) => [Number.parseInt(hex.slice(0, 8), 16), Number.parseInt(hex.slice(8), 16)];

const popcount = (value) => {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const distanceOfHalves = (left, right) => popcount((left[0] ^ right[0]) >>> 0) + popcount((left[1] ^ right[1]) >>> 0);

const distance = (leftHex, rightHex) => distanceOfHalves(halves(leftHex), halves(rightHex));

module.exports = { hashOfGray, halves, distance, distanceOfHalves, BITS, SIZE };
