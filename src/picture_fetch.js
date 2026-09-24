"use strict";

// Fetching group pictures from Tencent the way QQ itself does when a picture
// is opened. NT uploads (almost all since 2024) need an rkey, a short-lived
// download key the running QQ client holds (see rkey.js); legacy uploads and
// the md5 route do not.
//
// spec: 198 = the thumbnail QQ lists, 720 = the preview QQ opens first,
// 0 = the untouched original (md5-verified by the caller).
// Measured 2026-09-24: an rkey from QQ's memory fetched 150/150 sampled
// originals from 4-6 groups up to 31 days old; older ones answer -5503042.

const crypto = require("node:crypto");

const NT_HOST = "https://multimedia.nt.qq.com.cn";
const LEGACY_HOST = "https://gchat.qpic.cn";
const GROUP_APPID = 1407;
const SPECS = { thumb: 198, preview: 720, original: 0 };
const RKEY_REJECTED = new Set([-5503007, -5503010, -5503023]);
const FILE_GONE = new Set([-5503042]);
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const PROBE_BYTES = 128 * 1024;
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;
const MAX_VARIANT_BYTES = 8 * 1024 * 1024;

const SAFE_TOKEN = /^[\w-]+$/u;
const SAFE_LEGACY = /^\/gchatpic_new\/\d+\/[\w-]+$/u;

// Candidate URLs for one picture and size, best first. An NT picture with no
// usable rkey still gets the md5 route (it answers for ~30% of pictures).
const urlsFor = (picture, size, rkey) => {
  const spec = SPECS[size];
  if (spec === undefined) {
    throw new Error(`Unknown picture size: ${size}`);
  }
  const urls = [];
  if (picture.fileId && SAFE_TOKEN.test(picture.fileId) && rkey && SAFE_TOKEN.test(rkey)) {
    urls.push({ via: "nt", url: `${NT_HOST}/download?appid=${GROUP_APPID}&fileid=${picture.fileId}&spec=${spec}&rkey=${rkey}` });
  }
  if (picture.legacyPath && SAFE_LEGACY.test(picture.legacyPath)) {
    urls.push({ via: "legacy", url: `${LEGACY_HOST}${picture.legacyPath}/${spec}?term=255&is_origin=0` });
  }
  if (/^[a-f0-9]{32}$/u.test(picture.md5 ?? "")) {
    urls.push({ via: "md5", url: `${LEGACY_HOST}/gchatpic_new/0/0-0-${picture.md5.toUpperCase()}/${spec}` });
  }
  return urls;
};

const sniffExtension = (bytes) => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return null;
};

const retcodeOf = (bytes) => {
  if (bytes.length === 0 || bytes.length > 4096 || bytes[0] !== 0x7b) {
    return null;
  }
  const match = bytes.toString("utf8").match(/"retcode"\s*:\s*(-?\d+)/u);
  return match === null ? null : Number(match[1]);
};

// ok | rkey (the key was refused: rescan) | gone (deleted on Tencent's side)
// | missing (this route does not have it) | error (network / unexpected).
const classify = ({ status, bytes }) => {
  const retcode = retcodeOf(bytes);
  if (retcode !== null && RKEY_REJECTED.has(retcode)) return "rkey";
  if (retcode !== null && FILE_GONE.has(retcode)) return "gone";
  if ((status === 200 || status === 206) && sniffExtension(bytes) !== null) return "ok";
  if (status === 404 || status === 400 || retcode !== null) return "missing";
  return "error";
};

// Reads at most `cap` bytes of the body, so an oversized or Range-ignoring
// response is never buffered whole.
const readCapped = async (response, cap) => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { bytes: Buffer.concat(chunks), truncated: false };
    }
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks).subarray(0, cap), truncated: true };
    }
  }
};

// With `range`, only the first `range` bytes are wanted (a server that ignores
// Range is cut off there); without it, a body over maxBytes is refused.
const download = async (url, { maxBytes, range = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: range === null ? {} : { Range: `bytes=0-${range - 1}` },
    });
    const declared = Number(response.headers.get("content-length"));
    if (range === null && Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      return { status: response.status, bytes: Buffer.alloc(0), tooLarge: true };
    }
    const { bytes, truncated } = await readCapped(response, range ?? maxBytes);
    if (truncated && range === null) {
      return { status: response.status, bytes: Buffer.alloc(0), tooLarge: true };
    }
    return { status: response.status, bytes, tooLarge: false };
  } catch (error) {
    return { status: 0, bytes: Buffer.alloc(0), tooLarge: false, error: error.name };
  } finally {
    clearTimeout(timer);
  }
};

const md5Of = (bytes) => crypto.createHash("md5").update(bytes).digest("hex");

// Tries each route in turn. Returns { outcome, bytes?, ext?, via } where
// outcome is ok | rkey | gone | missing | error. An original must match its
// md5; a thumbnail or preview only has to be an image.
const fetchPicture = async (picture, size, { rkey, fetchImpl } = {}) => {
  const maxBytes = size === "original" ? MAX_ORIGINAL_BYTES : MAX_VARIANT_BYTES;
  let worst = "missing";
  for (const { via, url } of urlsFor(picture, size, rkey)) {
    const result = await download(url, { maxBytes, fetchImpl });
    const outcome = result.tooLarge ? "missing" : classify(result);
    if (outcome === "ok" && (size !== "original" || md5Of(result.bytes) === picture.md5)) {
      return { outcome, bytes: result.bytes, ext: sniffExtension(result.bytes), via };
    }
    if (outcome === "gone") {
      return { outcome, via };
    }
    if (outcome === "rkey" || (outcome === "error" && worst === "missing")) {
      worst = outcome;
    }
  }
  return { outcome: worst, via: null };
};

// AI metadata sits before the image data: a PNG text chunk ahead of the first
// IDAT, or EXIF text in a JPEG/WebP header. Checked against full parses of 80
// large pictures: 24/24 prompts found, 1 false alarm (the full parse decides).
const AI_KEYWORD = /^(parameters|prompt|workflow|comment|description|invokeai_metadata|sd-metadata|dream|generation_data)$/iu;
const AI_TEXT = /Steps: \d+|Negative prompt|"prompt"|"workflow"|sampler|\bcfg\b|UNICODE/iu;

const headLooksGenerated = (bytes) => {
  if (sniffExtension(bytes) === "png") {
    let pos = 8;
    while (pos + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(pos);
      const type = bytes.subarray(pos + 4, pos + 8).toString("latin1");
      if (type === "IDAT") {
        return false;
      }
      if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
        const keyword = bytes.subarray(pos + 8, Math.min(pos + 88, bytes.length)).toString("latin1").split("\0")[0];
        if (AI_KEYWORD.test(keyword)) {
          return true;
        }
      }
      pos += 12 + length;
    }
    // The head ended before any image data: undecided, so look at the file.
    return true;
  }
  return AI_TEXT.test(bytes.toString("latin1"));
};

// True when the head holds every metadata block, so it can be parsed without
// the rest of the file: a PNG whose image data (IDAT) starts inside the head,
// a JPEG whose scan data (SOS marker) does. WebP keeps EXIF after the image
// data, so it never qualifies; a head shorter than asked is the whole file.
const headIsComplete = (bytes, requested = PROBE_BYTES) => {
  if (bytes.length < requested) {
    return true;
  }
  const ext = sniffExtension(bytes);
  if (ext === "png") {
    let pos = 8;
    while (pos + 8 <= bytes.length) {
      const type = bytes.subarray(pos + 4, pos + 8).toString("latin1");
      if (type === "IDAT" || type === "IEND") {
        return true;
      }
      pos += 12 + bytes.readUInt32BE(pos);
    }
    return false;
  }
  if (ext === "jpg") {
    let pos = 2;
    while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
      if (bytes[pos + 1] === 0xda) {
        return true;
      }
      pos += 2 + bytes.readUInt16BE(pos + 2);
    }
    return false;
  }
  return false;
};

// The first "length" bytes of the original. Returns { outcome, bytes? }.
const fetchHead = async (picture, { rkey, fetchImpl, length = PROBE_BYTES } = {}) => {
  let worst = "missing";
  for (const { url, via } of urlsFor(picture, "original", rkey)) {
    const result = await download(url, { maxBytes: length, range: length, fetchImpl });
    const outcome = classify(result);
    if (outcome === "ok") {
      return { outcome, bytes: result.bytes, via };
    }
    if (outcome === "gone") {
      return { outcome };
    }
    if (outcome === "rkey" || (outcome === "error" && worst === "missing")) {
      worst = outcome;
    }
  }
  return { outcome: worst };
};

module.exports = {
  SPECS,
  PROBE_BYTES,
  urlsFor,
  sniffExtension,
  classify,
  download,
  fetchPicture,
  headLooksGenerated,
  headIsComplete,
  fetchHead,
  md5Of,
};
