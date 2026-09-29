"use strict";

// Message row ids are 19-digit QQ ids ("m"-prefixed for media rows), too big
// for a double: ids of one second often compare equal as Numbers (4,545 of
// 6,351 same-second pairs on 2026-09-30). SQL compares them as 64-bit
// integers (CAST(row_id AS INTEGER)); JavaScript must use BigInt.
const DIGITS = /^\d+$/u;

const order = (left, right) => Number(left > right) - Number(left < right);

// -1 / 0 / 1, for sort() and keyset comparisons. Anything that is not a
// (possibly "m"-prefixed) number gets a stable order instead of a throw.
const compareRowIds = (left, right) => {
  const a = String(left).replace(/^m/u, "");
  const b = String(right).replace(/^m/u, "");
  if (DIGITS.test(a) && DIGITS.test(b)) {
    return order(BigInt(a), BigInt(b));
  }
  return Math.sign(a.length - b.length) || order(a, b);
};

module.exports = { compareRowIds };
