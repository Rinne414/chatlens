"use strict";

// Generation data outside PNG text chunks, as found in the user's library:
// NovelAI WebP with the metadata object in EXIF, JPEGs with NovelAI JSON in
// UserComment (with and without the 8-byte charset code) or in the JPEG
// comment segment, and a "UNICODE" code missing its NUL padding.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectAndParse, parseAiMetadata } = require("../src/ai_metadata");
const { decodeUserComment, readImageTextChunks } = require("../src/image_text_chunks");

const NAI_COMMENT = JSON.stringify({ prompt: "best quality, 1girl", uc: "lowres", steps: 28, scale: 5, seed: 7, sampler: "k_euler_ancestral" });
const NAI_CARRIER = JSON.stringify({ Comment: NAI_COMMENT, Software: "NovelAI", Source: "NovelAI Diffusion V4.5 4BDE2A90" });

/* ---------- UserComment decoding ---------- */

test("a UserComment written without the charset code keeps its first characters", () => {
  assert.equal(decodeUserComment(Buffer.from(NAI_CARRIER, "utf8"), true), NAI_CARRIER);
});

test("a UNICODE code missing its NUL padding still reads as UTF-16", () => {
  const raw = Buffer.concat([Buffer.from("UNICODE", "latin1"), Buffer.from("nsfw, 1girl", "utf16le")]);

  assert.equal(decodeUserComment(raw, true), "nsfw, 1girl");
});

test("UTF-16 with a byte-order mark but no UNICODE code is read as UTF-16", () => {
  const text = "nsfw, 1girl\nSteps: 28, Sampler: Euler a, CFG scale: 5, Seed: 1";
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

  assert.equal(decodeUserComment(Buffer.concat([Buffer.alloc(8), bom]), true), text);
  assert.equal(decodeUserComment(bom, true), text);
});

test("the usual ASCII and UNICODE codes are still stripped", () => {
  assert.equal(decodeUserComment(Buffer.from(`ASCII\0\0\0${NAI_CARRIER}`, "latin1"), true), NAI_CARRIER);
  const unicode = Buffer.concat([Buffer.from("UNICODE\0", "latin1"), Buffer.from(NAI_COMMENT, "utf16le")]);
  assert.equal(decodeUserComment(unicode, true), NAI_COMMENT);
});

/* ---------- NovelAI JSON outside a PNG ---------- */

test("NovelAI's metadata object in EXIF UserComment is read like its PNG chunks", () => {
  const parsed = detectAndParse({ UserComment: NAI_CARRIER });

  assert.equal(parsed.generator, "nai");
  assert.equal(parsed.prompt, "best quality, 1girl");
  assert.equal(parsed.negativePrompt, "lowres");
});

test("a bare NovelAI comment in UserComment is recognised too", () => {
  assert.equal(detectAndParse({ UserComment: NAI_COMMENT })?.prompt, "best quality, 1girl");
});

test("NovelAI WebP: the prompt in ImageDescription, the rest in UserComment", () => {
  const parsed = detectAndParse({
    Software: "NovelAI Diffusion V5 0ADF9AB7",
    ImageDescription: "best quality, 1girl",
    UserComment: JSON.stringify({ Comment: NAI_COMMENT }),
  });

  assert.equal(parsed.generator, "nai");
  assert.equal(parsed.params.seed, "7");
});

test("NovelAI JSON in the JPEG comment segment is read", () => {
  assert.equal(detectAndParse({ JpegComment: NAI_COMMENT })?.generator, "nai");
});

test("JSON and notes from cameras and apps are still not prompts", () => {
  const notes = [
    "CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 70",
    '{"data":{"did":"etywyowwqpuouwieqpp"},"source_type":"douyin_beauty_me"}',
    '{"AIGC":{"Label":"1","ContentProducer":"NETA"}}',
    '{"prompt": "not really", "source": "somewhere"}',
  ];
  for (const note of notes) {
    assert.equal(detectAndParse({ JpegComment: note }), null, note);
    assert.equal(detectAndParse({ UserComment: note }), null, note);
  }
});

/* ---------- containers ---------- */

// A little-endian TIFF with ImageDescription + Software in IFD0 and
// UserComment in the EXIF sub-IFD.
const tiff = ({ description, software, userComment }) => {
  const ascii = (text) => Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
  const values = [
    { tag: 0x010e, type: 2, data: ascii(description) },
    { tag: 0x0131, type: 2, data: ascii(software) },
  ];
  const sub = { tag: 0x9286, type: 7, data: Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(userComment, "utf8")]) };
  const ifd0Size = 2 + (values.length + 1) * 12 + 4;
  const subIfdOffset = 8 + ifd0Size;
  const subIfdSize = 2 + 12 + 4;
  let dataOffset = subIfdOffset + subIfdSize;
  const entry = (tag, type, count, value) => {
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(type, 2);
    out.writeUInt32LE(count, 4);
    out.writeUInt32LE(value, 8);
    return out;
  };
  const blobs = [];
  const place = (item) => {
    const offset = dataOffset;
    blobs.push(item.data);
    dataOffset += item.data.length;
    return entry(item.tag, item.type, item.data.length, offset);
  };
  const ifd0Entries = values.map(place);
  const subEntry = place(sub);
  const count = (n) => {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(n);
    return out;
  };
  return Buffer.concat([
    Buffer.from("II*\0", "latin1"), Buffer.from([8, 0, 0, 0]),
    count(values.length + 1), ...ifd0Entries, entry(0x8769, 4, 1, subIfdOffset), Buffer.alloc(4),
    count(1), subEntry, Buffer.alloc(4),
    ...blobs,
  ]);
};

const riffChunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

const webp = (exif) => {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;
  vp8x.writeUIntLE(831, 4, 3);
  vp8x.writeUIntLE(1215, 7, 3);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), riffChunk("VP8X", vp8x), riffChunk("VP8L", Buffer.alloc(20)), riffChunk("EXIF", exif)]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const jpegWithComment = (text) => {
  const comment = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(comment.length + 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xc0, 0x03, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), length, comment, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
};

const withFile = (t, name, bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carriers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

test("WebP EXIF is read, with the canvas size from VP8X", (t) => {
  const exif = tiff({ description: "best quality, 1girl", software: "NovelAI Diffusion V5 0ADF9AB7", userComment: JSON.stringify({ Comment: NAI_COMMENT }) });
  const filePath = withFile(t, "x.webp", webp(exif));

  const container = readImageTextChunks(filePath);
  assert.equal(container.container, "webp");
  assert.deepEqual([container.width, container.height], [832, 1216]);
  assert.equal(container.chunks.Software, "NovelAI Diffusion V5 0ADF9AB7");

  const parsed = parseAiMetadata(filePath);
  assert.equal(parsed.generator, "nai");
  assert.equal(parsed.prompt, "best quality, 1girl");
});

test("a WebP whose EXIF has the 'Exif' header prefix is read too", (t) => {
  const exif = tiff({ description: "d", software: "NovelAI", userComment: NAI_COMMENT });
  const filePath = withFile(t, "y.webp", webp(Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exif])));

  assert.equal(parseAiMetadata(filePath).prompt, "best quality, 1girl");
});

test("the JPEG comment segment is read", (t) => {
  const filePath = withFile(t, "z.jpg", jpegWithComment(NAI_COMMENT));

  assert.equal(readImageTextChunks(filePath).chunks.JpegComment, NAI_COMMENT);
  assert.equal(parseAiMetadata(filePath).generator, "nai");
});
