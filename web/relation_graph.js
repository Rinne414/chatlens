"use strict";

// 群 → 关系网: the pure part (no DOM), tested directly in Node and loaded in
// the browser as window.RelationGraph. Picks whom to draw, finds the circles
// of people who mostly talk among themselves (Louvain modularity), and lays
// the graph out with a deterministic force simulation (same data, same
// picture, so re-renders never make it jump).

const REL_ITERATIONS = 320;
const REL_MIN_LINK_STRENGTH = 0.25;
const REL_MAX_LOUVAIN_PASSES = 30;
const REL_IDEAL_DISTANCE = 60;
const REL_GRAVITY = 0.5;
const REL_CIRCLE_PULL = 1.2;
const REL_BACKBONE_PER_PERSON = 3;
const REL_MIN_GAP = 34;
// Room under a dot for its name when dots come with their own sizes.
const REL_LABEL_ROOM = 22;
const REL_SPREAD_PASSES = 60;

// The `count` most connected people (never someone without any relation),
// plus yourself and the person a page is about (isFocus) when they have any.
// People arrive sorted by the server.
const pickPeople = (people, count) => {
  const related = people.filter((person) => person.sent + person.received > 0);
  const shown = related.slice(0, Math.max(0, count));
  const pinned = related.filter((person) => (person.isSelf || person.isFocus) && !shown.includes(person));
  return [...shown, ...pinned];
};

// Links between drawn people only.
const linksAmong = (people, links) => {
  const shown = new Set(people.map((person) => person.uin));
  return links.filter((link) => shown.has(link.a) && shown.has(link.b));
};

/* ---------- circles (Louvain) ---------- */

// One level of local moves: each node joins the neighbouring community that
// raises modularity most. Returns the community of each node, or null when
// nothing moved.
const louvainLevel = (adjacency) => {
  const size = adjacency.length;
  const degree = adjacency.map((neighbours) => [...neighbours.values()].reduce((sum, weight) => sum + weight, 0));
  const total = degree.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return null;
  }
  const community = Array.from({ length: size }, (_, index) => index);
  const communityDegree = [...degree];
  let movedAny = false;
  for (let pass = 0; pass < REL_MAX_LOUVAIN_PASSES; pass += 1) {
    let moved = false;
    for (let node = 0; node < size; node += 1) {
      const current = community[node];
      const toCommunity = new Map();
      for (const [neighbour, weight] of adjacency[node]) {
        if (neighbour !== node) {
          toCommunity.set(community[neighbour], (toCommunity.get(community[neighbour]) ?? 0) + weight);
        }
      }
      communityDegree[current] -= degree[node];
      let best = current;
      let bestGain = (toCommunity.get(current) ?? 0) - (communityDegree[current] * degree[node]) / total;
      for (const [candidate, weight] of toCommunity) {
        const gain = weight - (communityDegree[candidate] * degree[node]) / total;
        if (gain > bestGain + 1e-9) {
          best = candidate;
          bestGain = gain;
        }
      }
      communityDegree[best] += degree[node];
      if (best !== current) {
        community[node] = best;
        moved = true;
      }
    }
    movedAny = movedAny || moved;
    if (!moved) {
      break;
    }
  }
  return movedAny ? community : null;
};

// Merges each community into one node; weights inside a community become a
// self loop counted twice (the convention louvainLevel's degrees assume).
const aggregate = (adjacency, community) => {
  const ids = [...new Set(community)];
  const renumber = new Map(ids.map((id, index) => [id, index]));
  const merged = ids.map(() => new Map());
  adjacency.forEach((neighbours, node) => {
    const from = renumber.get(community[node]);
    for (const [neighbour, weight] of neighbours) {
      const to = renumber.get(community[neighbour]);
      merged[from].set(to, (merged[from].get(to) ?? 0) + weight);
    }
  });
  return { merged, renumber };
};

// uin -> circle index; circle 0 is the largest. Link weight = interactions.
const findCircles = (people, links) => {
  const index = new Map(people.map((person, position) => [person.uin, position]));
  let adjacency = people.map(() => new Map());
  for (const link of links) {
    const a = index.get(link.a);
    const b = index.get(link.b);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + link.total);
    adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + link.total);
  }
  let membership = people.map((_, position) => position);
  for (;;) {
    const community = louvainLevel(adjacency);
    if (community === null) {
      break;
    }
    const { merged, renumber } = aggregate(adjacency, community);
    membership = membership.map((node) => renumber.get(community[node]));
    adjacency = merged;
  }
  const sizes = new Map();
  for (const circle of membership) {
    sizes.set(circle, (sizes.get(circle) ?? 0) + 1);
  }
  const order = [...sizes].sort((left, right) => right[1] - left[1] || left[0] - right[0]).map(([circle]) => circle);
  const rank = new Map(order.map((circle, position) => [circle, position]));
  return new Map(people.map((person, position) => [person.uin, rank.get(membership[position])]));
};

/* ---------- layout ---------- */

// Only each person's strongest few links pull (a busy group has a line
// between almost everyone, and pulling on all of them squeezes the picture
// into one ball); every link is still drawn.
const backboneLinks = (links) => {
  const kept = new Set();
  const perPerson = new Map();
  for (const link of links) {
    for (const uin of [link.a, link.b]) {
      perPerson.set(uin, [...(perPerson.get(uin) ?? []), link]);
    }
  }
  for (const own of perPerson.values()) {
    for (const link of [...own].sort((left, right) => right.total - left.total).slice(0, REL_BACKBONE_PER_PERSON)) {
      kept.add(link);
    }
  }
  return links.filter((link) => kept.has(link));
};

// Mean position of each circle's members.
const circleCentres = (nodes, circles) => {
  const sums = new Map();
  for (const node of nodes) {
    const circle = circles.get(node.uin);
    const sum = sums.get(circle) ?? { x: 0, y: 0, n: 0 };
    sums.set(circle, { x: sum.x + node.x, y: sum.y + node.y, n: sum.n + 1 });
  }
  return new Map([...sums].map(([circle, sum]) => [circle, { x: sum.x / sum.n, y: sum.y / sum.n }]));
};

// Fits the free layout into the box without squashing it (the same scale on
// both axes — a wide short box used to crush a round cloud into one pile),
// then pushes apart dots that still overlap: their radii plus REL_LABEL_ROOM
// when `radii` (uin -> radius) is given, else REL_MIN_GAP.
const fitToBox = (nodes, { width, height, pad }, radii) => {
  const gapOf = (a, b) => (radii === null ? REL_MIN_GAP : (radii.get(a.uin) ?? 0) + (radii.get(b.uin) ?? 0) + REL_LABEL_ROOM);
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const spanX = Math.max(0, maxX - minX);
  const spanY = Math.max(0, maxY - minY);
  const scaleX = spanX < 1 ? 0 : (width - 2 * pad) / spanX;
  const scaleY = spanY < 1 ? 0 : (height - 2 * pad) / spanY;
  const scale = scaleX === 0 && scaleY === 0 ? 0 : Math.min(scaleX === 0 ? scaleY : scaleX, scaleY === 0 ? scaleX : scaleY);
  const usedW = spanX * scale;
  const usedH = spanY * scale;
  const originX = pad + ((width - 2 * pad) - usedW) / 2;
  const originY = pad + ((height - 2 * pad) - usedH) / 2;
  for (const node of nodes) {
    node.x = scale === 0 ? width / 2 : originX + (node.x - minX) * scale;
    node.y = scale === 0 ? height / 2 : originY + (node.y - minY) * scale;
  }
  const passes = Math.min(180, Math.round(REL_SPREAD_PASSES * Math.max(1, Math.sqrt(nodes.length / 30))));
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const distance = Math.hypot(dx, dy);
        const gap = gapOf(nodes[i], nodes[j]);
        if (distance >= gap) {
          continue;
        }
        const push = (gap - distance) / 2;
        const ux = distance < 0.01 ? 1 : dx / distance;
        const uy = distance < 0.01 ? 0 : dy / distance;
        nodes[i].x = Math.min(width - pad, Math.max(pad, nodes[i].x - ux * push));
        nodes[i].y = Math.min(height - pad, Math.max(pad, nodes[i].y - uy * push));
        nodes[j].x = Math.min(width - pad, Math.max(pad, nodes[j].x + ux * push));
        nodes[j].y = Math.min(height - pad, Math.max(pad, nodes[j].y + uy * push));
      }
    }
  }
};

// Positions inside a width x height box, `pad` from the edges. The forces run
// in open space (repulsion between everyone, springs on the backbone links, a
// pull towards the own circle's middle so a circle sits together, a light
// pull to the middle so loose people stay near); the result is then
// fitted to the box. Start on a circle ordered by circle index, so a circle
// starts out together.
const layoutGraph = (people, links, circles, box, radii = null) => {
  const count = people.length;
  const positions = new Map();
  if (count === 0) {
    return positions;
  }
  // A hundred people at the small-graph spacing collapse into one ball. Spread
  // the ideal gap with the count, and ease the pull toward the middle so
  // circles can sit apart instead of stacking.
  const spread = Math.max(1, Math.sqrt(count / 36));
  const ideal = REL_IDEAL_DISTANCE * spread;
  const gravity = REL_GRAVITY / spread;
  const circlePull = REL_CIRCLE_PULL / Math.sqrt(spread);
  const order = [...people].sort((left, right) => circles.get(left.uin) - circles.get(right.uin));
  const nodes = order.map((person, position) => {
    const angle = (2 * Math.PI * position) / count;
    const radius = ideal * Math.sqrt(count);
    return { uin: person.uin, x: radius * Math.cos(angle), y: radius * Math.sin(angle), dx: 0, dy: 0 };
  });
  const byUin = new Map(nodes.map((node) => [node.uin, node]));
  const maxTotal = Math.max(1, ...links.map((link) => link.total));
  const springs = backboneLinks(links).map((link) => ({
    a: byUin.get(link.a),
    b: byUin.get(link.b),
    strength: REL_MIN_LINK_STRENGTH + (1 - REL_MIN_LINK_STRENGTH) * (Math.log1p(link.total) / Math.log1p(maxTotal)),
  }));
  let temperature = ideal * Math.sqrt(count) / 2;
  for (let step = 0; step < REL_ITERATIONS; step += 1) {
    for (const node of nodes) {
      node.dx = 0;
      node.dy = 0;
    }
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          distance = Math.hypot(dx, dy);
        }
        const force = (ideal * ideal) / distance;
        const minDistance = radii === null
          ? REL_MIN_GAP
          : (radii.get(a.uin) ?? 0) + (radii.get(b.uin) ?? 0) + REL_LABEL_ROOM;
        const overlap = distance < minDistance ? (minDistance - distance) * 0.35 : 0;
        const push = force + overlap;
        a.dx += (dx / distance) * push;
        a.dy += (dy / distance) * push;
        b.dx -= (dx / distance) * push;
        b.dy -= (dy / distance) * push;
      }
    }
    for (const spring of springs) {
      const dx = spring.a.x - spring.b.x;
      const dy = spring.a.y - spring.b.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const force = ((distance * distance) / ideal) * spring.strength;
      spring.a.dx -= (dx / distance) * force;
      spring.a.dy -= (dy / distance) * force;
      spring.b.dx += (dx / distance) * force;
      spring.b.dy += (dy / distance) * force;
    }
    const centres = circleCentres(nodes, circles);
    for (const node of nodes) {
      const centre = centres.get(circles.get(node.uin));
      node.dx += (centre.x - node.x) * circlePull - node.x * gravity;
      node.dy += (centre.y - node.y) * circlePull - node.y * gravity;
      const length = Math.max(0.01, Math.hypot(node.dx, node.dy));
      const moveBy = Math.min(length, temperature);
      node.x += (node.dx / length) * moveBy;
      node.y += (node.dy / length) * moveBy;
    }
    temperature = Math.max(0.5, temperature * 0.985);
  }
  fitToBox(nodes, box, radii);
  for (const node of nodes) {
    positions.set(node.uin, { x: Math.round(node.x * 10) / 10, y: Math.round(node.y * 10) / 10 });
  }
  return positions;
};

const relationGraph = { pickPeople, linksAmong, findCircles, layoutGraph };

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = relationGraph;
}
if (typeof window !== "undefined") {
  window.RelationGraph = relationGraph;
}
