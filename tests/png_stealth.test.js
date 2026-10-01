"use strict";

// Stealth PNG info: generation data in the pixels' least significant bits,
// which survives when the text chunks are stripped. Found in the field: 277
// pictures (NovelAI and Forge) in the user's library had their prompt only
// there, with no text chunk at all.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { readStealthChunks, probeStealthBytes } = require("../src/png_stealth");
const { readImageTextChunks } = require("../src/image_text_chunks");
const { parseAiMetadata } = require("../src/ai_metadata");
const { makePng } = require("./png_fixture");

const withFile = (t, bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stealth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "image.png");
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

const stealthOf = (filePath) => {
  const container = readImageTextChunks(filePath);
  return readStealthChunks(filePath, container.stealth);
};

const NAI_METADATA = {
  Title: "NovelAI generated image",
  Description: "1girl, solo, rain",
  Software: "NovelAI",
  Source: "NovelAI Diffusion V4.5 4BDE2A90",
  "Generation time": "3.2",
  Comment: JSON.stringify({ prompt: "1girl, solo, rain", uc: "lowres", steps: 28, scale: 5, seed: 42, sampler: "k_euler_ancestral" }),
};

/* ---------- tests ---------- */

test("gzip JSON in the alpha channel (what NovelAI writes) becomes its metadata fields", (t) => {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(NAI_METADATA), "utf8"));
  const filePath = withFile(t, makePng({ signature: "stealth_pngcomp", payload }));

  const chunks = stealthOf(filePath);

  assert.equal(chunks.Software, "NovelAI");
  assert.equal(JSON.parse(chunks.Comment).seed, 42);
});

test("plain A1111 parameters in the alpha channel come back as `parameters`", (t) => {
  const text = "1girl, solo\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 1";
  const filePath = withFile(t, makePng({ signature: "stealth_pnginfo", payload: Buffer.from(text, "utf8") }));

  assert.deepEqual(stealthOf(filePath), { parameters: text });
});

test("the RGB carrier works in RGB and RGBA pictures", (t) => {
  const text = "a cat\nSteps: 20, Sampler: Euler, CFG scale: 6, Seed: 9";
  for (const channels of [3, 4]) {
    const filePath = withFile(t, makePng({ channels, signature: "stealth_rgbinfo", payload: Buffer.from(text, "utf8") }));

    assert.equal(stealthOf(filePath)?.parameters, text, `channels=${channels}`);
  }
});

test("a picture without a carrier gives nothing", (t) => {
  assert.equal(stealthOf(withFile(t, makePng({}))), null);
});

test("a damaged carrier gives nothing instead of throwing", (t) => {
  const bad = zlib.gzipSync(Buffer.from("{}", "utf8")).subarray(0, 8);
  assert.equal(stealthOf(withFile(t, makePng({ signature: "stealth_pngcomp", payload: bad }))), null);
});

test("a NovelAI picture whose text chunks were stripped is recognised with its prompt", (t) => {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(NAI_METADATA), "utf8"));
  const filePath = withFile(t, makePng({ signature: "stealth_pngcomp", payload }));

  const parsed = parseAiMetadata(filePath, fs.statSync(filePath).size);

  assert.equal(parsed.generator, "nai");
  assert.equal(parsed.prompt, "1girl, solo, rain");
  assert.equal(parsed.params.seed, "42");
});

test("text chunks still win: the pixels are only read when the chunks say nothing", (t) => {
  const payload = Buffer.from("hidden\nSteps: 1, Sampler: Euler, CFG scale: 1, Seed: 1", "utf8");
  const parameters = "visible\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 5";
  const filePath = withFile(t, makePng({ signature: "stealth_pnginfo", payload, textChunks: { parameters } }));

  assert.equal(parseAiMetadata(filePath).prompt, "visible");
});

test("the head of a download tells whether the full picture is worth fetching", () => {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(NAI_METADATA), "utf8"));
  const withCarrier = makePng({ signature: "stealth_pngcomp", payload });

  assert.equal(probeStealthBytes(withCarrier), "yes");
  assert.equal(probeStealthBytes(makePng({})), "no");
  // Cut inside the first IDAT: too few rows to read the 120-bit signature.
  assert.equal(probeStealthBytes(withCarrier.subarray(0, 120)), "short");
  // Not a PNG, or a PNG whose pixels cannot carry one.
  assert.equal(probeStealthBytes(Buffer.from("GIF89a....")), "no");
});
