"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { pickPeople, linksAmong, findCircles, layoutGraph } = require("../web/relation_graph");

const person = (uin, sent, received, extra = {}) => ({ uin, name: `P${uin}`, messages: 1, isSelf: false, sent, received, ...extra });
const link = (a, b, total) => ({ a, b, aToB: { replies: total, ats: 0 }, bToA: { replies: 0, ats: 0 }, total });

test("draws the most connected people, never the unconnected, and always yourself", () => {
  const people = [person("1", 9, 9), person("2", 5, 5), person("3", 1, 0, { isSelf: true }), person("4", 0, 0)];
  assert.deepEqual(pickPeople(people, 2).map((p) => p.uin), ["1", "2", "3"]);
  assert.deepEqual(pickPeople(people, 10).map((p) => p.uin), ["1", "2", "3"]);
});

test("the person a page is about is always drawn, like yourself", () => {
  const people = [person("1", 9, 9), person("2", 5, 5), person("3", 1, 0, { isFocus: true })];
  assert.deepEqual(pickPeople(people, 1).map((p) => p.uin), ["1", "3"]);
});

test("keeps only links between drawn people", () => {
  const links = [link("1", "2", 3), link("1", "9", 4)];
  assert.deepEqual(linksAmong([person("1", 1, 1), person("2", 1, 1)], links), [links[0]]);
});

test("two cliques joined by one weak link become two circles, the larger first", () => {
  const people = ["a1", "a2", "a3", "a4", "b1", "b2", "b3"].map((uin) => person(uin, 1, 1));
  const links = [
    link("a1", "a2", 10), link("a1", "a3", 10), link("a1", "a4", 10), link("a2", "a3", 10), link("a2", "a4", 10), link("a3", "a4", 10),
    link("b1", "b2", 10), link("b1", "b3", 10), link("b2", "b3", 10),
    link("a1", "b1", 1),
  ];
  const circles = findCircles(people, links);
  assert.deepEqual(["a1", "a2", "a3", "a4"].map((uin) => circles.get(uin)), [0, 0, 0, 0]);
  assert.deepEqual(["b1", "b2", "b3"].map((uin) => circles.get(uin)), [1, 1, 1]);
});

test("people with no links each stay alone and nothing crashes on an empty graph", () => {
  assert.deepEqual([...findCircles([person("1", 0, 0), person("2", 0, 0)], []).values()].sort(), [0, 1]);
  assert.equal(layoutGraph([], [], new Map(), { width: 100, height: 100, pad: 10 }).size, 0);
});

test("the layout stays inside the box and is the same every time", () => {
  const people = ["1", "2", "3", "4", "5"].map((uin) => person(uin, 1, 1));
  const links = [link("1", "2", 20), link("2", "3", 5), link("3", "4", 1), link("4", "5", 9), link("1", "5", 2)];
  const circles = findCircles(people, links);
  const box = { width: 900, height: 560, pad: 30 };
  const first = layoutGraph(people, links, circles, box);
  assert.deepEqual(layoutGraph(people, links, circles, box), first);
  for (const { x, y } of first.values()) {
    assert.ok(x >= 30 && x <= 870 && y >= 30 && y <= 530, `${x},${y} outside the box`);
  }
  const distance = (a, b) => Math.hypot(first.get(a).x - first.get(b).x, first.get(a).y - first.get(b).y);
  assert.ok(distance("1", "2") < distance("1", "3"), "the strongest pair sits closer than a weak one");
});

test("with sizes given, bigger dots are kept further apart", () => {
  const people = ["1", "2", "3", "4"].map((uin) => person(uin, 1, 1));
  const links = [link("1", "2", 9), link("2", "3", 9), link("3", "4", 9), link("1", "4", 9)];
  const radii = new Map([["1", 30], ["2", 30], ["3", 10], ["4", 10]]);
  const box = { width: 1000, height: 620, pad: 60 };
  const positions = layoutGraph(people, links, findCircles(people, links), box, radii);
  const distance = (a, b) => Math.hypot(positions.get(a).x - positions.get(b).x, positions.get(a).y - positions.get(b).y);
  assert.ok(distance("1", "2") >= 30 + 30 + 22 - 0.5, `big dots overlap: ${distance("1", "2")}`);
});
