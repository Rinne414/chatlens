"use strict";

// HTTP side of 热点 (src/trends.js), on the same read-only connection the
// gallery uses (it needs the pictures and, for AI marks, the prompt library).
// Cached per window: the answer only changes when the background refresh adds
// messages, and a 7-day scan costs about half a second.

const galleryOps = require("./gallery_ops");
const { trends } = require("../trends");

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

const getTrends = ({ days, fresh = false }) => {
  const key = String(days);
  const hit = cache.get(key);
  if (!fresh && hit !== undefined && Date.now() - hit.at < CACHE_MS) {
    return hit.value;
  }
  const value = galleryOps.withReadOnlyStore((db) => trends(db, { nowUnix: Math.floor(Date.now() / 1000), days }));
  cache.set(key, { at: Date.now(), value });
  return value;
};

module.exports = { getTrends };
