"use strict";

// The WebP lossless (VP8L) decoder behind reading prompts hidden in a WebP's
// alpha channel. QQ's 720px previews are lossy WebP with a LOSSLESS alpha
// plane, so a NovelAI prompt hidden in the alpha survives in them.
//
// Fixtures: tests/fixtures/webp, made with Pillow 12.3 / libwebp 1.6.0; each
// <name>.rgba is Pillow's own decode of <name>.webp, the expected answer.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { decodeWebpPixels, unfilterAlpha } = require("../src/webp_lossless");
const { parseAiMetadata } = require("../src/ai_metadata");

const FIXTURES = path.join(__dirname, "fixtures", "webp");
const fixture = (name) => ({
  webp: fs.readFileSync(path.join(FIXTURES, `${name}.webp`)),
  rgba: fs.readFileSync(path.join(FIXTURES, `${name}.rgba`)),
});
const alphaOf = (rgba) => Buffer.from(rgba.filter((_, index) => index % 4 === 3));

const LOSSLESS = ["lossless-rgba", "lossless-rgba-fast", "lossless-palette-2", "lossless-palette-4", "lossless-palette-12", "lossless-palette-200"];

for (const name of LOSSLESS) {
  test(`lossless ${name} decodes pixel for pixel like libwebp`, () => {
    const { webp, rgba } = fixture(name);

    const decoded = decodeWebpPixels(webp);

    assert.equal(decoded.rgba.length, rgba.length);
    assert.ok(decoded.rgba.equals(rgba), "pixels differ from libwebp's decode");
    assert.ok(decoded.alpha.equals(alphaOf(rgba)));
  });
}

for (const name of ["lossy-alpha-stealth", "lossy-alpha-gradient-h", "lossy-alpha-gradient-v", "lossy-alpha-gradient-d"]) {
  test(`lossy ${name}: the lossless alpha plane decodes exactly`, () => {
    const { webp, rgba } = fixture(name);

    const decoded = decodeWebpPixels(webp);

    // Lossy colour is never decoded; only the alpha plane is.
    assert.equal(decoded.rgba, null);
    assert.ok(decoded.alpha.equals(alphaOf(rgba)), "alpha differs from libwebp's decode");
  });
}

test("alpha filters: horizontal, vertical and gradient are undone", () => {
  // 3x2 plane, predictor rules from the WebP container spec (ALPH chunk).
  const original = Buffer.from([10, 20, 35, 50, 40, 90]);
  const filtered = {
    1: Buffer.from([10, 10, 15, 40, 246, 50]),
    2: Buffer.from([10, 10, 15, 40, 20, 55]),
    3: Buffer.from([10, 10, 15, 40, 236, 35]),
  };
  for (const [method, data] of Object.entries(filtered)) {
    assert.deepEqual([...unfilterAlpha(data, 3, 2, Number(method))], [...original], `method ${method}`);
  }
});

test("a NovelAI prompt hidden in a lossy WebP's alpha is read", () => {
  const filePath = path.join(FIXTURES, "lossy-alpha-stealth.webp");

  const parsed = parseAiMetadata(filePath);

  assert.equal(parsed.generator, "nai");
  assert.equal(parsed.prompt, "1girl, solo, rain");
  assert.equal(parsed.params.seed, "42");
});

test("damaged or foreign data gives null instead of throwing", () => {
  const { webp } = fixture("lossless-rgba");
  assert.equal(decodeWebpPixels(webp.subarray(0, 60)), null);
  assert.equal(decodeWebpPixels(Buffer.from("RIFF\x10\0\0\0WEBPVP8L\x04\0\0\0\x2f\0\0\0", "latin1")), null);
  assert.equal(decodeWebpPixels(Buffer.from("not a webp at all")), null);
});
