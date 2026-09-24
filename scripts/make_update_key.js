"use strict";

// Creates (once) the key that signs releases for the in-app updater.
//
//   node scripts/make_update_key.js                   create a new key
//   node scripts/make_update_key.js --restore <file>  restore from the backup
//
// - Private key: saved like the other secrets (Windows DPAPI tied to this
//   Windows account; Linux keyring or a 0600 file). Nothing to remember:
//   scripts/sign_release.js reads it by itself.
// - Backup: one copy on the desktop, to be moved to a USB stick or a private
//   cloud folder. Whoever has that file can sign updates — keep it private.
// - Public key: update-signing-public.pem in the project root. Safe to commit;
//   installed apps check every update against it.
// Never replaces an existing key.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const secrets = require("../src/secrets");

const SECRET_NAME = "updateSigningKey";
const toolRoot = path.resolve(__dirname, "..");
// Overrides exist for automated tests only.
const publicPath = process.env.CHATLENS_SIGNING_PUBLIC || path.join(toolRoot, "update-signing-public.pem");
const backupDir = process.env.CHATLENS_SIGNING_BACKUP_DIR
  || [path.join(os.homedir(), "Desktop"), os.homedir()].find((dir) => fs.existsSync(dir));
const backupPath = path.join(backupDir, "ChatLens-更新签名私钥-备份.pem");

const fingerprintOf = (publicKey) =>
  crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

// The secret store holds one line: base64 of the PKCS#8 DER.
const secretValueOf = (privateKey) => privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

const refuseIfPresent = () => {
  if (secrets.hasSecret(SECRET_NAME)) {
    throw new Error("这台电脑上已经有更新签名私钥，不会覆盖它。");
  }
};

// Proves what was stored signs things the public key accepts.
const selfCheck = (publicKey) => {
  const stored = crypto.createPrivateKey({ key: Buffer.from(secrets.readSecretSync(SECRET_NAME).trim(), "base64"), format: "der", type: "pkcs8" });
  const probe = Buffer.from("chatlens update key check");
  if (!crypto.verify(null, probe, publicKey, crypto.sign(null, probe, stored))) {
    throw new Error("自检失败：保存的私钥签不出公钥认可的签名。");
  }
};

const create = async () => {
  refuseIfPresent();
  if (fs.existsSync(backupPath)) {
    throw new Error(`桌面上已经有一份备份：${backupPath}\n如果它是旧钥匙，请用 --restore 还原它，而不是生成新的。`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const saved = await secrets.saveSecret(SECRET_NAME, secretValueOf(privateKey));
  fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), "utf8");
  fs.writeFileSync(backupPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  selfCheck(publicKey);
  console.log("更新签名钥匙已生成。");
  console.log(`  私钥：已加密保存在这台电脑（${saved.backend}），发布时自动使用，不需要密码。`);
  console.log(`  公钥：${publicPath}`);
  console.log(`  指纹：${fingerprintOf(publicKey)}`);
  console.log("");
  console.log(`备份：${backupPath}`);
  console.log("  请把这个文件移到 U 盘或网盘的私人文件夹，然后从桌面删掉。");
  console.log("  换电脑或重装系统后，用它还原：node scripts/make_update_key.js --restore <备份文件>");
  console.log("  拿到这个文件的人可以签出更新，不要发给别人、不要放公开的地方。");
};

const restore = async (file) => {
  refuseIfPresent();
  const privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(file)));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("这不是更新签名私钥的备份文件。");
  }
  const publicKey = crypto.createPublicKey(privateKey);
  if (fs.existsSync(publicPath)) {
    const shipped = crypto.createPublicKey(fs.readFileSync(publicPath));
    if (fingerprintOf(shipped) !== fingerprintOf(publicKey)) {
      throw new Error(`这份备份和项目里的公钥对不上（${fingerprintOf(publicKey)} ≠ ${fingerprintOf(shipped)}），没有还原。`);
    }
  } else {
    fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), "utf8");
  }
  await secrets.saveSecret(SECRET_NAME, secretValueOf(privateKey));
  selfCheck(publicKey);
  console.log(`已从备份还原更新签名私钥（指纹 ${fingerprintOf(publicKey)}），发布时会自动使用。`);
};

const main = async () => {
  const [flag, file] = process.argv.slice(2);
  if (flag === "--restore") {
    if (!file) {
      throw new Error("用法：node scripts/make_update_key.js --restore <备份文件>");
    }
    await restore(file);
    return;
  }
  if (flag !== undefined) {
    throw new Error("用法：node scripts/make_update_key.js [--restore <备份文件>]");
  }
  await create();
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
