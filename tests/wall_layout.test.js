"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { clampRatio, wallColumns, layoutWall, visibleIndexes, WALL_MAX_RATIO } = require("../web/wall_layout");

const tiles = (ratios) => ratios.map((ratio) => ({ kind: "tile", ratio }));

test("columns fit the target size and never drop below one", () => {
  assert.equal(wallColumns(1000, 200, 10), 4);
  assert.equal(wallColumns(150, 200, 10), 1);
  assert.equal(wallColumns(0, 200, 10), 1);
});

test("grid mode places square tiles in reading order", () => {
  const layout = layoutWall({ entries: tiles([1, 2, 0.5, 1, 1]), containerWidth: 430, targetSize: 100, gap: 10, mode: "grid" });
  assert.equal(layout.columns, 4);
  assert.deepEqual(layout.boxes.map((box) => [box.x, box.y]), [[0, 0], [110, 0], [220, 0], [330, 0], [0, 110]]);
  assert.ok(layout.boxes.every((box) => box.h === 100 && box.w === 100));
  assert.equal(layout.height, 210);
});

test("masonry mode fills the shortest column and keeps aspect ratios", () => {
  const layout = layoutWall({ entries: tiles([2, 1, 1]), containerWidth: 210, targetSize: 100, gap: 10, mode: "masonry" });
  assert.equal(layout.columns, 2);
  assert.deepEqual(layout.boxes.map((box) => [box.x, box.y, box.h]), [[0, 0, 200], [110, 0, 100], [110, 110, 100]]);
  assert.equal(layout.height, 210);
});

test("cards mode uses the fixed card height", () => {
  const layout = layoutWall({ entries: tiles([1, 1, 1]), containerWidth: 210, targetSize: 100, gap: 10, mode: "cards", cardHeight: 300 });
  assert.deepEqual(layout.boxes.map((box) => [box.x, box.y, box.h]), [[0, 0, 300], [110, 0, 300], [0, 310, 300]]);
});

test("a header spans every column below the tallest one", () => {
  const entries = [...tiles([2, 1]), { kind: "header", height: 30 }, ...tiles([1])];
  const layout = layoutWall({ entries, containerWidth: 210, targetSize: 100, gap: 10, mode: "masonry" });
  assert.deepEqual(layout.boxes[2], { x: 0, y: 210, w: 210, h: 30 });
  assert.deepEqual([layout.boxes[3].x, layout.boxes[3].y], [0, 250]);
});

test("appending entries never moves the ones already placed", () => {
  const first = layoutWall({ entries: tiles([1.3, 0.7, 1, 2]), containerWidth: 500, targetSize: 120, gap: 8, mode: "masonry" });
  const more = layoutWall({ entries: tiles([1.3, 0.7, 1, 2, 1, 1.5]), containerWidth: 500, targetSize: 120, gap: 8, mode: "masonry" });
  assert.deepEqual(more.boxes.slice(0, 4), first.boxes);
});

test("extreme and missing ratios are clamped", () => {
  assert.equal(clampRatio(40), WALL_MAX_RATIO);
  assert.equal(clampRatio(0), 1);
  assert.equal(clampRatio(Number.NaN), 1);
});

test("visible indexes include only boxes intersecting the window", () => {
  const layout = layoutWall({ entries: tiles(new Array(20).fill(1)), containerWidth: 100, targetSize: 100, gap: 0, mode: "grid" });
  assert.deepEqual(visibleIndexes(layout.boxes, 250, 450), [2, 3, 4]);
});

test("an empty wall has no height", () => {
  assert.equal(layoutWall({ entries: [], containerWidth: 800, targetSize: 200 }).height, 0);
});

test("an unknown mode is rejected", () => {
  assert.throws(() => layoutWall({ entries: [], containerWidth: 800, targetSize: 200, mode: "carousel" }), /Unknown wall mode/u);
});
