"use strict";

// Candidate extraction for the QQNT database key from raw process memory.
// Port of the filter in scripts/scan_qq_memory_keys.ps1 (Windows): the key is
// a 16- or 32-character printable ASCII string, stored either as ASCII or as
// UTF-16LE. Every candidate is later verified against the user's own database,
// so this only needs to be cheap and not miss the real key.

const KEY_LENGTHS = new Set([16, 32]);
const MIN_DISTINCT_CHARS = 6;

const isPrintable = (byte) => byte >= 32 && byte <= 126;

const hasUsefulShape = (value) => {
  const seen = new Set(value);
  if (seen.size < MIN_DISTINCT_CHARS) {
    return false;
  }
  let hasDigit = false;
  let hasLetter = false;
  let hasOther = false;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      hasDigit = true;
    } else if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
      hasLetter = true;
    } else {
      hasOther = true;
    }
  }
  return (hasDigit && hasLetter) || hasOther;
};

const addIfCandidate = (candidates, value) => {
  if (KEY_LENGTHS.has(value.length) && hasUsefulShape(value)) {
    candidates.add(value);
  }
};

// Printable ASCII runs of exactly 16 or 32 bytes.
const scanAscii = (buffer, length, candidates) => {
  let runStart = -1;
  for (let index = 0; index <= length; index += 1) {
    const printable = index < length && isPrintable(buffer[index]);
    if (printable && runStart < 0) {
      runStart = index;
    } else if (!printable && runStart >= 0) {
      const runLength = index - runStart;
      if (runLength === 16 || runLength === 32) {
        addIfCandidate(candidates, buffer.toString("latin1", runStart, index));
      }
      runStart = -1;
    }
  }
};

// UTF-16LE runs (printable byte followed by 0x00) of exactly 16 or 32 chars.
const scanUtf16 = (buffer, length, candidates) => {
  for (let parity = 0; parity < 2; parity += 1) {
    let chars = [];
    for (let index = parity; index + 1 < length + 2; index += 2) {
      const ok = index + 1 < length && isPrintable(buffer[index]) && buffer[index + 1] === 0;
      if (ok) {
        chars.push(buffer[index]);
        continue;
      }
      if (chars.length === 16 || chars.length === 32) {
        addIfCandidate(candidates, Buffer.from(chars).toString("latin1"));
      }
      chars = [];
    }
  }
};

const scanBuffer = (buffer, length, candidates) => {
  scanAscii(buffer, length, candidates);
  scanUtf16(buffer, length, candidates);
};

module.exports = { hasUsefulShape, scanBuffer };
