"use strict";

// Saves QQ collection pictures into the user's folder: the original from
// QQ's own cache when a local copy has the right md5, else downloaded from
// QQ's collection server (…/0; Node sends no Referer, so no hotlink
// placeholder). For about one picture in five the server no longer has the
// original, only a re-compressed JPEG of the same pixel size (the file QQ's
// own 「另存为」 gives too); that is kept, flagged `recompressed`. Anything
// else (another size, a placeholder, a broken download) is never saved.
// Names carry the recorded md5, so a later scan recognises the file by name
// even when its bytes are the re-compressed ones:
//   QQ收藏_20260915-200912_<md5>.png

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { collectorUrl } = require("./qq_collection");
const { uniqueName } = require("./picture_export");

const DOWNLOAD_ATTEMPTS = 2;
// Eight pictures download at once; a big PNG on a slow line needs a while.
const DOWNLOAD_TIMEOUT_MS = 60000;
// Far above any picture seen in a collection; bounds memory if the server
// ever answers with something else.
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

const SIGNATURES = [
  [".png", (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47],
  [".jpg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8],
  [".gif", (bytes) => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46],
  [".webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
  [".bmp", (bytes) => bytes[0] === 0x42 && bytes[1] === 0x4d],
];

const md5Of = (buffer) => crypto.createHash("md5").update(buffer).digest("hex");

const extensionOf = (buffer) => SIGNATURES.find(([, test]) => test(buffer))?.[0] ?? ".bin";

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const jpegSize = (buffer) => {
  let index = 2;
  while (index + 9 < buffer.length) {
    if (buffer[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = buffer[index + 1];
    if (JPEG_FRAME_MARKERS.has(marker)) {
      return { width: buffer.readUInt16BE(index + 7), height: buffer.readUInt16BE(index + 5) };
    }
    index += 2 + buffer.readUInt16BE(index + 2);
  }
  return null;
};

const webpSize = (buffer) => {
  const chunk = buffer.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X") {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
};

// Pixel size from the file's header, or null.
const imageSize = (buffer) => {
  try {
    switch (extensionOf(buffer)) {
      case ".png":
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      case ".jpg":
        return jpegSize(buffer);
      case ".gif":
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      case ".webp":
        return webpSize(buffer);
      case ".bmp":
        return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
      default:
        return null;
    }
  } catch {
    return null;
  }
};

const samePixelSize = (buffer, picture) => {
  const size = imageSize(buffer);
  return size !== null && picture.width > 0 && size.width === picture.width && size.height === picture.height;
};

const fileStem = (picture) => {
  const time = new Date(picture.collectedAt + BEIJING_OFFSET_MS).toISOString();
  return `QQ收藏_${time.slice(0, 10).replaceAll("-", "")}-${time.slice(11, 19).replaceAll(":", "")}_${picture.md5}`;
};

// The body, or null when it is bigger than maxBytes (reading stops there).
const readCapped = async (response, maxBytes) => {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

// The original's bytes with the recorded md5, else the server's
// re-compressed copy of the same pixel size ({ recompressed: true }), or
// { error }: "gone" (the server no longer has it), "mismatch" (it sent
// something else), "too-big" or "unavailable" (network / server trouble).
const verifiedOriginal = async (picture, { fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES }) => {
  for (const file of picture.localFiles ?? []) {
    try {
      const buffer = await fs.promises.readFile(file);
      if (md5Of(buffer) === picture.md5) {
        return { buffer, bytesMd5: picture.md5, source: "local", recompressed: false };
      }
    } catch {
      // A cache file QQ removed meanwhile: download instead.
    }
  }
  let error = "unavailable";
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(collectorUrl(picture, 0), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        await response.body?.cancel();
        error = response.status === 404 ? "gone" : "unavailable";
        continue;
      }
      const buffer = await readCapped(response, maxBytes);
      if (buffer === null) {
        return { error: "too-big" };
      }
      const bytesMd5 = md5Of(buffer);
      if (bytesMd5 === picture.md5) {
        return { buffer, bytesMd5, source: "download", recompressed: false };
      }
      if (samePixelSize(buffer, picture)) {
        return { buffer, bytesMd5, source: "download", recompressed: true };
      }
      error = "mismatch";
    } catch {
      error = "unavailable";
    }
  }
  return { error };
};

// { md5, status: "saved", file, bytesMd5, source, recompressed } or
// { md5, status: <error> }. A failed write (disk full) throws and leaves no
// cut-off file: its name carries the md5, so a later scan would count it.
const savePicture = async (picture, targetDir, { writeFile = fs.writeFileSync, ...deps }) => {
  const original = await verifiedOriginal(picture, deps);
  if (original.error !== undefined) {
    return { md5: picture.md5, status: original.error };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const name = uniqueName(targetDir, fileStem(picture), extensionOf(original.buffer));
  const file = path.join(targetDir, name);
  try {
    writeFile(file, original.buffer, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      fs.rmSync(file, { force: true });
    }
    throw error;
  }
  return { md5: picture.md5, status: "saved", file, bytesMd5: original.bytesMd5, source: original.source, recompressed: original.recompressed };
};

module.exports = { savePicture, verifiedOriginal, fileStem, extensionOf, imageSize };
