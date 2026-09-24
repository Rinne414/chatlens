"use strict";

// Signed releases for the in-app updater. The maintainer lists the sha256 of
// every release archive in <tag>-SHA256SUMS.txt and signs that list with an
// Ed25519 key (scripts/sign_release.js). An installed app downloads the list,
// its .sig and the archive, and installs only when the signature matches the
// public key it shipped with AND the archive's hash is on the list. Someone who
// takes over the GitHub account cannot produce that signature.

const crypto = require("node:crypto");
const fs = require("node:fs");

const SUMS_SUFFIX = "-SHA256SUMS.txt";
const SIG_SUFFIX = ".sig";
const SUMS_LINE = /^([a-f0-9]{64}) {2}([^\s/\\]+)$/u;

const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

// entries: [{ name, sha256 }] -> the text that gets signed.
const buildSums = (entries) =>
  `${[...entries].sort((left, right) => left.name.localeCompare(right.name)).map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`;

const parseSums = (text) => {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/u).filter((item) => item.length > 0)) {
    const match = line.match(SUMS_LINE);
    if (match === null) {
      throw new Error("签名清单格式不对。");
    }
    sums.set(match[2], match[1]);
  }
  return sums;
};

const signSums = (sumsText, privateKey) => crypto.sign(null, Buffer.from(sumsText, "utf8"), privateKey).toString("base64");

const signatureMatches = (sumsText, signatureBase64, publicKeyPem) => {
  try {
    return crypto.verify(null, Buffer.from(sumsText, "utf8"), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signatureBase64).trim(), "base64"));
  } catch {
    return false;
  }
};

// Throws a user-facing reason unless the archive is exactly what was signed.
// `version` pins the archive to the release being installed: signed file
// names carry their version, so an old signed archive re-published under a
// newer tag (a downgrade) is refused too.
const verifyArchive = ({ archivePath, archiveName, sumsText, signature, publicKeyPem, version }) => {
  if (!signatureMatches(sumsText, signature, publicKeyPem)) {
    throw new Error("更新包的签名无效：不是用本工具作者的钥匙签的。");
  }
  if (version !== undefined && !archiveName.startsWith(`chatlens-v${version}.`) && !archiveName.startsWith(`chatlens-v${version}-`)) {
    throw new Error(`安装包不属于 v${version}。`);
  }
  const expected = parseSums(sumsText).get(archiveName);
  if (expected === undefined) {
    throw new Error("签名清单里没有这个安装包。");
  }
  if (sha256File(archivePath) !== expected) {
    throw new Error("安装包和签名清单不一致（可能被篡改，或下载不完整）。");
  }
};

// The list and its signature among a release's assets, or null when unsigned.
const findSignatureAssets = (assets) => {
  const sums = assets.find((asset) => asset.name.endsWith(SUMS_SUFFIX) && typeof asset.downloadUrl === "string");
  const sig = sums === undefined ? undefined : assets.find((asset) => asset.name === `${sums.name}${SIG_SUFFIX}` && typeof asset.downloadUrl === "string");
  return sums === undefined || sig === undefined ? null : { sums, sig };
};

module.exports = { SUMS_SUFFIX, SIG_SUFFIX, sha256File, buildSums, parseSums, signSums, signatureMatches, verifyArchive, findSignatureAssets };
