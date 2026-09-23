"use strict";

// Secret storage for the QQ database key and the LLM API key.
//
// Windows: DPAPI through PowerShell's ConvertFrom-SecureString — the exact
// on-disk format every earlier version wrote, so saved keys keep working.
// Linux: the desktop keyring via `secret-tool` (libsecret) when it is usable,
// otherwise a 0600 file under ~/.config/QQSummaryTools. Values travel over
// stdin/stdout only — never on a command line, never in a log.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const platform = require("./platform");

const SECRETS = {
  ntqqKey: { windowsFile: "ntqq-db-key.dpapi", file: "ntqq-db-key.secret", label: "QQ 数据库密钥" },
  llmKey: { windowsFile: "deepseek-api-key.dpapi", file: "llm-api-key.secret", label: "LLM API key" },
};

const SECRET_TOOL_ATTRS = (name) => ["application", "chatlens", "name", name];

const secretDir = () => {
  const override = process.env.CHATLENS_SECRET_DIR;
  return override && path.isAbsolute(override) ? override : platform.userConfigDir();
};

const specFor = (name) => {
  const spec = SECRETS[name];
  if (spec === undefined) {
    throw new Error(`未知的密钥类型: ${name}`);
  }
  return spec;
};

const secretFilePath = (name) => {
  const spec = specFor(name);
  return path.join(secretDir(), platform.isWindows ? spec.windowsFile : spec.file);
};

const useSecretTool = () =>
  !platform.isWindows
  && process.env.CHATLENS_SECRET_BACKEND !== "file"
  && process.env.CHATLENS_SECRET_DIR === undefined
  && platform.commandExists("secret-tool");

const validateSecret = (value) => {
  const secret = String(value ?? "").trim();
  if (secret.length < 8 || secret.length > 512) {
    throw new Error("密钥长度不合理（应为 8-512 个字符）。");
  }
  return secret;
};

/* ---------- Windows DPAPI (PowerShell) ---------- */

const encodePs = (script) => Buffer.from(script, "utf16le").toString("base64");
const psArgs = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(script)];

const DPAPI_READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$encrypted = (Get-Content -LiteralPath $env:CHATLENS_SECRET_FILE -Raw).Trim()",
  "$secure = ConvertTo-SecureString -String $encrypted",
  "$plain = (New-Object System.Management.Automation.PSCredential('x', $secure)).GetNetworkCredential().Password",
  "[Console]::Out.Write($plain)",
].join("\n");

const DPAPI_WRITE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$plain = [Console]::In.ReadToEnd().Trim()",
  "if ($plain.Length -lt 8) { throw 'Secret from stdin is empty.' }",
  "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
  "$encrypted = ConvertFrom-SecureString -SecureString $secure",
  "New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:CHATLENS_SECRET_FILE) | Out-Null",
  "Set-Content -LiteralPath $env:CHATLENS_SECRET_FILE -Value $encrypted -Encoding ASCII",
].join("\n");

const runAsync = (command, args, { input, env } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (typeof input === "string") {
      child.stdin.write(input, "utf8");
    }
    child.stdin.end();
  });

const lastLine = (text) => String(text ?? "").trim().split(/\r?\n/u).filter((line) => line.trim().length > 0).at(-1) ?? "";

/* ---------- public API ---------- */

const hasSecret = (name) => {
  specFor(name);
  if (platform.fileExists(secretFilePath(name))) {
    return true;
  }
  if (useSecretTool()) {
    const result = spawnSync("secret-tool", ["lookup", ...SECRET_TOOL_ATTRS(name)], { encoding: "utf8", timeout: 10000 });
    return result.status === 0 && String(result.stdout ?? "").trim().length > 0;
  }
  return false;
};

const missingSecretError = (name) =>
  new Error(`没有找到已保存的${specFor(name).label}。请先在控制台「设置」页保存。`);

// Synchronous read for pipeline child processes (they need the key before any
// other work and have nothing else to do meanwhile).
const readSecretSync = (name) => {
  const filePath = secretFilePath(name);
  if (platform.isWindows) {
    if (!platform.fileExists(filePath)) {
      throw missingSecretError(name);
    }
    const result = spawnSync("powershell.exe", psArgs(DPAPI_READ_SCRIPT), {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CHATLENS_SECRET_FILE: filePath },
      timeout: 60000,
    });
    if (result.status !== 0 || String(result.stdout ?? "").length === 0) {
      throw new Error(`${specFor(name).label}解密失败（DPAPI）。${lastLine(result.stderr).slice(0, 200)}`);
    }
    return result.stdout;
  }
  if (useSecretTool()) {
    const result = spawnSync("secret-tool", ["lookup", ...SECRET_TOOL_ATTRS(name)], { encoding: "utf8", timeout: 30000 });
    if (result.status === 0 && String(result.stdout ?? "").trim().length > 0) {
      return String(result.stdout).trim();
    }
  }
  if (!platform.fileExists(filePath)) {
    throw missingSecretError(name);
  }
  return fs.readFileSync(filePath, "utf8").trim();
};

const readSecret = async (name) => {
  const filePath = secretFilePath(name);
  if (platform.isWindows) {
    if (!platform.fileExists(filePath)) {
      throw missingSecretError(name);
    }
    const result = await runAsync("powershell.exe", psArgs(DPAPI_READ_SCRIPT), { env: { CHATLENS_SECRET_FILE: filePath } });
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new Error(`${specFor(name).label}解密失败（DPAPI）。${lastLine(result.stderr).slice(0, 200)}`);
    }
    return result.stdout;
  }
  return readSecretSync(name);
};

const writePrivateFile = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
};

const saveSecret = async (name, value) => {
  const secret = validateSecret(value);
  const filePath = secretFilePath(name);
  if (platform.isWindows) {
    const result = await runAsync("powershell.exe", psArgs(DPAPI_WRITE_SCRIPT), {
      input: secret,
      env: { CHATLENS_SECRET_FILE: filePath },
    });
    if (result.code !== 0) {
      throw new Error(`保存密钥失败：${lastLine(result.stderr).slice(0, 200) || `PowerShell 退出码 ${result.code}`}`);
    }
    return { backend: "dpapi", path: filePath };
  }
  if (useSecretTool()) {
    const result = await runAsync("secret-tool", ["store", `--label=ChatLens ${specFor(name).label}`, ...SECRET_TOOL_ATTRS(name)], { input: secret });
    if (result.code === 0) {
      // A keyring copy supersedes any older plain-file copy.
      fs.rmSync(filePath, { force: true });
      return { backend: "secret-tool", path: null };
    }
  }
  writePrivateFile(filePath, secret);
  return { backend: "file", path: filePath };
};

// Where the secrets live, for the storage page. The keyring has no path.
const describeSecretStorage = () => ({
  directory: secretDir(),
  backend: platform.isWindows ? "dpapi" : useSecretTool() ? "secret-tool" : "file",
});

module.exports = {
  SECRETS,
  secretDir,
  secretFilePath,
  hasSecret,
  readSecret,
  readSecretSync,
  saveSecret,
  describeSecretStorage,
};
