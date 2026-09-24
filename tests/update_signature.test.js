"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const signature = require("../src/update_signature");

const ROOT = path.resolve(__dirname, "..");

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `update-sig-${label}-`));

const releaseFixture = () => {
  const dir = tempDir("dist");
  fs.writeFileSync(path.join(dir, "chatlens-v9.9.9-win-x64.zip"), "windows bundle bytes");
  fs.writeFileSync(path.join(dir, "chatlens-v9.9.9.tar.gz"), "source bytes");
  return dir;
};

const pem = (key) => key.export({ type: "spki", format: "pem" });

test("an archive installs only when the list is signed by our key and lists its exact hash", () => {
  const dir = releaseFixture();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const names = fs.readdirSync(dir);
  const sumsText = signature.buildSums(names.map((name) => ({ name, sha256: signature.sha256File(path.join(dir, name)) })));
  const signed = signature.signSums(sumsText, privateKey);
  const archive = { archivePath: path.join(dir, "chatlens-v9.9.9-win-x64.zip"), archiveName: "chatlens-v9.9.9-win-x64.zip" };

  assert.doesNotThrow(() => signature.verifyArchive({ ...archive, sumsText, signature: signed, publicKeyPem: pem(publicKey) }));

  const stranger = crypto.generateKeyPairSync("ed25519");
  assert.throws(() => signature.verifyArchive({ ...archive, sumsText, signature: signature.signSums(sumsText, stranger.privateKey), publicKeyPem: pem(publicKey) }), /签名无效/u);
  assert.throws(() => signature.verifyArchive({ ...archive, sumsText: sumsText.replace(/^[a-f0-9]/u, "0"), signature: signed, publicKeyPem: pem(publicKey) }), /签名无效/u);
  assert.throws(() => signature.verifyArchive({ ...archive, sumsText, signature: "not base64 at all", publicKeyPem: pem(publicKey) }), /签名无效/u);
  assert.throws(() => signature.verifyArchive({ ...archive, archiveName: "chatlens-v9.9.9-linux-x64.tar.gz", sumsText, signature: signed, publicKeyPem: pem(publicKey) }), /没有这个安装包/u);

  // An old signed archive re-published under a newer tag is a downgrade.
  assert.doesNotThrow(() => signature.verifyArchive({ ...archive, sumsText, signature: signed, publicKeyPem: pem(publicKey), version: "9.9.9" }));
  assert.throws(() => signature.verifyArchive({ ...archive, sumsText, signature: signed, publicKeyPem: pem(publicKey), version: "9.9.10" }), /不属于 v9.9.10/u);

  fs.appendFileSync(archive.archivePath, "tampered");
  assert.throws(() => signature.verifyArchive({ ...archive, sumsText, signature: signed, publicKeyPem: pem(publicKey) }), /不一致/u);
});

test("sums parse strictly and the signature assets are found among release assets", () => {
  assert.throws(() => signature.parseSums("abc  ../evil.zip\n"), /格式/u);
  assert.equal(signature.parseSums(`${"a".repeat(64)}  x.zip\n`).get("x.zip"), "a".repeat(64));
  const asset = (name) => ({ name, downloadUrl: `https://example.invalid/${name}` });
  assert.equal(signature.findSignatureAssets([asset("chatlens-v1.zip")]), null);
  assert.equal(signature.findSignatureAssets([asset("chatlens-v1-SHA256SUMS.txt")]), null);
  const found = signature.findSignatureAssets([asset("chatlens-v1.zip"), asset("chatlens-v1-SHA256SUMS.txt"), asset("chatlens-v1-SHA256SUMS.txt.sig")]);
  assert.deepEqual([found.sums.name, found.sig.name], ["chatlens-v1-SHA256SUMS.txt", "chatlens-v1-SHA256SUMS.txt.sig"]);
});

const runScript = (script, args, env) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });

test("make_update_key + sign_release: create, sign, verify, back up, restore elsewhere", () => {
  const home = tempDir("keys");
  const env = {
    CHATLENS_SECRET_DIR: path.join(home, "secrets"),
    CHATLENS_SECRET_BACKEND: "file",
    CHATLENS_SIGNING_PUBLIC: path.join(home, "update-signing-public.pem"),
    CHATLENS_SIGNING_BACKUP_DIR: home,
  };
  const created = runScript("make_update_key.js", [], env);
  assert.equal(created.status, 0, created.stderr);
  assert.doesNotMatch(created.stdout, /PRIVATE KEY/u);
  const backup = path.join(home, "ChatLens-更新签名私钥-备份.pem");
  assert.match(fs.readFileSync(backup, "utf8"), /BEGIN PRIVATE KEY/u);
  assert.notEqual(runScript("make_update_key.js", [], env).status, 0, "never replaces an existing key");

  const dist = releaseFixture();
  const signed = runScript("sign_release.js", [dist, "9.9.9"], env);
  assert.equal(signed.status, 0, signed.stderr);
  const sumsText = fs.readFileSync(path.join(dist, "chatlens-v9.9.9-SHA256SUMS.txt"), "utf8");
  const sig = fs.readFileSync(path.join(dist, "chatlens-v9.9.9-SHA256SUMS.txt.sig"), "utf8");
  const publicKeyPem = fs.readFileSync(env.CHATLENS_SIGNING_PUBLIC, "utf8");
  for (const name of ["chatlens-v9.9.9-win-x64.zip", "chatlens-v9.9.9.tar.gz"]) {
    assert.doesNotThrow(() => signature.verifyArchive({ archivePath: path.join(dist, name), archiveName: name, sumsText, signature: sig, publicKeyPem }));
  }

  // A new computer: restore from the backup and keep signing with the same key.
  const moved = { ...env, CHATLENS_SECRET_DIR: path.join(home, "new-pc-secrets") };
  assert.equal(runScript("sign_release.js", [dist, "9.9.9"], moved).status, 1, "no key yet on the new computer");
  const restored = runScript("make_update_key.js", ["--restore", backup], moved);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(runScript("sign_release.js", [dist, "9.9.9"], moved).status, 0);

  // A backup of some other key is refused instead of silently switching keys.
  const otherBackup = path.join(home, "other.pem");
  fs.writeFileSync(otherBackup, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const wrong = runScript("make_update_key.js", ["--restore", otherBackup], { ...env, CHATLENS_SECRET_DIR: path.join(home, "third-pc") });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /对不上/u);
});

// A fake GitHub: https.get answers from a map of URL -> body.
const fakeGithub = (routes) => {
  const https = require("node:https");
  const { Readable } = require("node:stream");
  const original = https.get;
  https.get = (url, _options, callback) => {
    const body = routes.get(String(url));
    const response = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    response.statusCode = body === undefined ? 404 : 200;
    response.headers = {};
    process.nextTick(() => callback(response));
    return { setTimeout() {}, on() {} };
  };
  return () => {
    https.get = original;
  };
};

test("the updater refuses unsigned or tampered releases before installing anything", async () => {
  const home = tempDir("apply");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicPath = path.join(home, "public.pem");
  fs.writeFileSync(publicPath, pem(publicKey));
  process.env.CHATLENS_SIGNING_PUBLIC = publicPath;

  const base = "https://github.invalid/download/";
  const archiveName = process.platform === "win32" ? "chatlens-v9.9.9.zip" : "chatlens-v9.9.9.tar.gz";
  const archiveBytes = "the real release";
  const sumsText = signature.buildSums([{ name: archiveName, sha256: crypto.createHash("sha256").update(archiveBytes).digest("hex") }]);
  const release = (assets) => JSON.stringify({
    tag_name: "v9.9.9",
    html_url: "https://github.invalid/releases/v9.9.9",
    assets: assets.map((name) => ({ name, size: 1, browser_download_url: `${base}${name}` })),
  });
  const latest = "https://api.github.com/repos/Rinne414/chatlens/releases/latest";
  const updateOps = require("../src/server/update_ops");

  const unsigned = fakeGithub(new Map([[latest, release([archiveName])], [`${base}${archiveName}`, archiveBytes]]));
  try {
    await assert.rejects(updateOps.applyUpdate(), /没有附带签名.*手动下载/u);
  } finally {
    unsigned();
  }

  const tampered = fakeGithub(new Map([
    [latest, release([archiveName, "chatlens-v9.9.9-SHA256SUMS.txt", "chatlens-v9.9.9-SHA256SUMS.txt.sig"])],
    [`${base}${archiveName}`, "a swapped release"],
    [`${base}chatlens-v9.9.9-SHA256SUMS.txt`, sumsText],
    [`${base}chatlens-v9.9.9-SHA256SUMS.txt.sig`, signature.signSums(sumsText, privateKey)],
  ]));
  try {
    await assert.rejects(updateOps.applyUpdate(), /不一致/u);
    assert.equal(fs.existsSync(path.join(ROOT, "dist", "update", archiveName)), false, "the rejected download is deleted");
  } finally {
    tampered();
    delete process.env.CHATLENS_SIGNING_PUBLIC;
  }
});
