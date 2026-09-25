"use strict";

// Copying chosen pictures out to a folder the user can use (画廊 and the
// backup page's expiring AI originals). File names say when, where and who:
//   20260924-2053_AI朋友交流群_青苇_6d8112a1.png
// with a same-named .txt holding the prompt when the library has one.

const fs = require("node:fs");
const path = require("node:path");
const { sanitizeStem } = require("./knowledge_export");
const { formatHkt } = require("./unviewed_range");

const FOLDER_PREFIX = "picture-export-";
const FOLDER_PATTERN = /^picture-export-\d{8}-\d{6}$/u;
const MAX_LABEL_CHARS = 40;

// Extension from the first bytes, for originals QQ stored without one.
const SIGNATURES = [
  [".png", (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47],
  [".jpg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8],
  [".gif", (bytes) => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46],
  [".webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
  [".bmp", (bytes) => bytes[0] === 0x42 && bytes[1] === 0x4d],
];

const compactTime = (unix) => formatHkt(unix).replace(/[-:]/gu, "").replace(" ", "-").slice(0, 13);

const newFolderName = (nowUnix) => `${FOLDER_PREFIX}${formatHkt(nowUnix).replace(/[-:]/gu, "").replace(" ", "-")}`;

const isFolderName = (name) => FOLDER_PATTERN.test(String(name ?? ""));

const extensionOf = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|bmp)$/u.test(ext)) {
    return ext === ".jpeg" ? ".jpg" : ext;
  }
  const bytes = Buffer.alloc(12);
  const handle = fs.openSync(filePath, "r");
  try {
    fs.readSync(handle, bytes, 0, 12, 0);
  } finally {
    fs.closeSync(handle);
  }
  return SIGNATURES.find(([, test]) => test(bytes))?.[0] ?? ".bin";
};

// posting: where the picture was first posted ({ sentAt, groupName, speaker }).
const fileStem = (md5, posting) => {
  const parts = [
    posting?.sentAt > 0 ? compactTime(posting.sentAt) : "",
    sanitizeStem(String(posting?.groupName ?? "").slice(0, MAX_LABEL_CHARS), ""),
    sanitizeStem(String(posting?.speaker ?? "").slice(0, MAX_LABEL_CHARS), ""),
    md5.slice(0, 8),
  ];
  return parts.filter((part) => part !== "").join("_");
};

// "name.png", then "name (2).png", ... so two exports into one folder never
// overwrite each other.
const uniqueName = (directory, stem, ext) => {
  let name = `${stem}${ext}`;
  for (let index = 2; fs.existsSync(path.join(directory, name)); index += 1) {
    name = `${stem} (${index})${ext}`;
  }
  return name;
};

module.exports = { newFolderName, isFolderName, extensionOf, fileStem, uniqueName, compactTime };
