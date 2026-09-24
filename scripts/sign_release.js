"use strict";

// Signs a release before it is published (a required release step):
//
//   node scripts/sign_release.js <distDir> <version>
//
// Hashes every chatlens-v<version>* archive in distDir, writes
// chatlens-v<version>-SHA256SUMS.txt and its .sig (Ed25519, key from
// scripts/make_update_key.js), then verifies the result against the project's
// public key. Upload both files with the archives: installed apps refuse
// updates without them.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const secrets = require("../src/secrets");
const signature = require("../src/update_signature");

const toolRoot = path.resolve(__dirname, "..");
const publicPath = process.env.CHATLENS_SIGNING_PUBLIC || path.join(toolRoot, "update-signing-public.pem");
const ARCHIVE = /\.(zip|tar\.gz)$/iu;

const main = () => {
  const [distDir, version] = process.argv.slice(2);
  if (!distDir || !/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
    throw new Error("用法：node scripts/sign_release.js <distDir> <version>，例如 dist 0.0.10");
  }
  if (!secrets.hasSecret("updateSigningKey")) {
    throw new Error("这台电脑上没有更新签名私钥。新电脑请先用备份还原：node scripts/make_update_key.js --restore <备份文件>");
  }
  const prefix = `chatlens-v${version}`;
  const archives = fs.readdirSync(distDir).filter((name) => name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}-`)).filter((name) => ARCHIVE.test(name));
  if (archives.length === 0) {
    throw new Error(`${distDir} 里没有 ${prefix} 的安装包。`);
  }
  const sumsText = signature.buildSums(archives.map((name) => ({ name, sha256: signature.sha256File(path.join(distDir, name)) })));
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(secrets.readSecretSync("updateSigningKey").trim(), "base64"), format: "der", type: "pkcs8" });
  const signed = signature.signSums(sumsText, privateKey);
  if (!signature.signatureMatches(sumsText, signed, fs.readFileSync(publicPath, "utf8"))) {
    throw new Error("签名和项目里的公钥对不上：这台电脑的私钥不是项目公钥那一把。");
  }
  const sumsName = `${prefix}${signature.SUMS_SUFFIX}`;
  fs.writeFileSync(path.join(distDir, sumsName), sumsText, "utf8");
  fs.writeFileSync(path.join(distDir, `${sumsName}${signature.SIG_SUFFIX}`), `${signed}\n`, "utf8");
  console.log(`已签名 ${archives.length} 个安装包：`);
  for (const name of archives) {
    console.log(`  ${name}`);
  }
  console.log(`上传时带上：${sumsName} 和 ${sumsName}${signature.SIG_SUFFIX}`);
};

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
