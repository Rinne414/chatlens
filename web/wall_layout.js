"use strict";

// Pure layout arithmetic for picture walls, kept apart from the DOM so it can be
// tested directly. Loaded in the browser as a classic script (window.WallLayout)
// and required by tests in Node.
//
// One placement rule serves every mode: each tile goes into the currently
// shortest column (ties go to the leftmost). With equal tile heights that is
// exactly left-to-right reading order, so "grid" and "cards" need no separate
// code path; with varied heights it is a masonry ("waterfall") layout.
// A header entry spans every column and starts below the tallest one, which is
// how day separators work in all three modes.
//
// Appending entries never moves the ones already placed, so loading the next
// page keeps every visible tile where it was.

// Height / width clamp. Without it a long strip screenshot would fill a whole
// column and a panorama would shrink to a sliver.
const WALL_MIN_RATIO = 0.45;
const WALL_MAX_RATIO = 2.4;
const WALL_MODES = new Set(["grid", "masonry", "cards"]);

const clampRatio = (ratio) => {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.min(WALL_MAX_RATIO, Math.max(WALL_MIN_RATIO, value));
};

// How many columns of at least `targetSize` fit. At least one.
const wallColumns = (containerWidth, targetSize, gap) => {
  const width = Math.max(Number(containerWidth) || 0, 1);
  const size = Math.max(Number(targetSize) || 1, 1);
  return Math.max(1, Math.floor((width + gap) / (size + gap)));
};

const tileHeight = (entry, mode, width, cardHeight) => {
  if (mode === "cards") {
    return cardHeight;
  }
  if (mode === "masonry") {
    return Math.round(width * clampRatio(entry.ratio));
  }
  return Math.round(width);
};

const shortestColumn = (heights) => {
  let best = 0;
  for (let index = 1; index < heights.length; index += 1) {
    if (heights[index] < heights[best]) {
      best = index;
    }
  }
  return best;
};

// entries: [{ kind: "tile", ratio } | { kind: "header", height }]
// Returns { columns, columnWidth, boxes: [{ x, y, w, h }], height }.
const layoutWall = ({ entries, containerWidth, targetSize, gap = 8, mode = "grid", cardHeight = 360 }) => {
  if (!WALL_MODES.has(mode)) {
    throw new Error(`Unknown wall mode: ${mode}`);
  }
  const width = Math.max(Number(containerWidth) || 0, 1);
  const columns = wallColumns(width, targetSize, gap);
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const heights = new Array(columns).fill(0);
  const boxes = entries.map((entry) => {
    if (entry.kind === "header") {
      const top = Math.max(...heights);
      const height = Math.max(0, Number(entry.height) || 0);
      heights.fill(top + height + gap);
      return { x: 0, y: top, w: width, h: height };
    }
    const column = shortestColumn(heights);
    const height = tileHeight(entry, mode, columnWidth, cardHeight);
    const box = { x: column * (columnWidth + gap), y: heights[column], w: columnWidth, h: height };
    heights[column] += height + gap;
    return box;
  });
  const tallest = Math.max(...heights);
  return { columns, columnWidth, boxes, height: boxes.length === 0 ? 0 : Math.max(0, tallest - gap) };
};

// Indexes of the boxes that intersect [top, bottom]. Linear, which is cheap at
// the few thousand tiles a page holds, and needed because masonry boxes are not
// sorted by y.
const visibleIndexes = (boxes, top, bottom) => {
  const result = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box.y + box.h >= top && box.y <= bottom) {
      result.push(index);
    }
  }
  return result;
};

const wallLayout = {
  WALL_MIN_RATIO,
  WALL_MAX_RATIO,
  clampRatio,
  wallColumns,
  layoutWall,
  visibleIndexes,
};

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = wallLayout;
}
if (typeof window !== "undefined") {
  window.WallLayout = wallLayout;
}
