const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const secrets = require("../secrets");
const platform = require("../platform");
const { detectPrefixBytes } = require("../db_mirror");
const linuxScan = require("../linux_key_scan");
const packageInfo = require("../../package.json");

const BASE_URL_PATTERN = /^https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/u;
const MODEL_NAME_PATTERN = /^[\w.:/-]{1,64}$/u;
const MODEL_LIST_TIMEOUT_MS = 30000;
const KEY_SCAN_TIMEOUT_MS = 300000;
const KEY_VERIFY_TIMEOUT_MS = 420000;

const getSecretDirectory = () => path.resolve(secrets.secretDir());

// Runs a child with the same node binary as this server (works in the
// zero-setup bundle, where no system node exists). Resolves with the exit
// code and captured output instead of rejecting on non-zero exits.
const runProcess = (command, args, timeoutMs, { input } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error("子进程执行超时。"));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (timer) { clearTimeout(timer); }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) { clearTimeout(timer); }
      resolve({ code, stdout, stderr });
    });
    if (typeof input === "string") {
      child.stdin.write(input, "utf8");
    }
    child.stdin.end();
  });

const lastLine = (text) => String(text ?? "").trim().split(/\r?\n/u).filter((line) => line.trim().length > 0).at(-1) ?? "";

const getSettingsStatus = () => {
  const config = state.loadConfig();
  return {
    version: packageInfo.version,
    platform: process.platform,
    secretBackend: secrets.describeSecretStorage().backend,
    ntqqKeySaved: secrets.hasSecret("ntqqKey"),
    llmKeySaved: secrets.hasSecret("llmKey"),
    ntDbDir: config.ntDbDir ?? "",
    ntDataDir: config.ntDataDir ?? "",
    ntDbDirExists: typeof config.ntDbDir === "string" && config.ntDbDir.length > 0 && fs.existsSync(config.ntDbDir),
    ntDataDirExists: typeof config.ntDataDir === "string" && config.ntDataDir.length > 0 && fs.existsSync(config.ntDataDir),
    llm: {
      baseUrl: config.llm?.baseUrl ?? "",
      model: config.llm?.model ?? "",
    },
  };
};

// The secret travels via stdin/keyring only — never on a command line or log.
const saveSecret = async (which, secretValue) => {
  await secrets.saveSecret(which, secretValue);
};

const getJson = (rawUrl, headers) =>
  new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`模型列表请求失败（HTTP ${response.statusCode}）。`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("模型列表不是合法 JSON。"));
        }
      });
    });
    request.setTimeout(MODEL_LIST_TIMEOUT_MS, () => request.destroy(new Error("模型列表请求超时。")));
    request.on("error", reject);
  });

// Lists model ids from any OpenAI-compatible endpoint. Always uses the base
// URL already persisted in config: the stored key must never be sent to a
// caller-supplied URL.
const fetchLlmModels = async () => {
  const config = state.loadConfig();
  const trimmed = String(config.llm?.baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (!BASE_URL_PATTERN.test(trimmed)) {
    throw new Error("先保存 LLM 配置（API 地址），再获取模型列表。");
  }
  if (!secrets.hasSecret("llmKey")) {
    throw new Error("先在上方保存 LLM API key，再获取模型列表。");
  }
  const key = (await secrets.readSecret("llmKey")).trim();
  const body = await getJson(`${trimmed}/models`, { authorization: `Bearer ${key}` });
  const items = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const models = [...new Set(items.map((item) => String(item?.id ?? "").trim()).filter((id) => MODEL_NAME_PATTERN.test(id)))];
  if (models.length === 0) {
    throw new Error("该地址没有返回模型列表（检查 baseUrl 与 API key）。");
  }
  return models;
};

// Patch against the raw on-disk config and write atomically (via toolkit_state)
// so relative dirs stay relative and concurrent readers never see a torn file.
const saveConfigPatch = (patch) => {
  state.writeConfig({ ...state.loadRawConfig(), ...patch });
};

const saveLlmConfig = ({ baseUrl, model }) => {
  const trimmedUrl = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  const trimmedModel = String(model ?? "").trim();
  if (!BASE_URL_PATTERN.test(trimmedUrl)) {
    throw new Error("baseUrl 格式不对，应类似 https://api.deepseek.com");
  }
  const config = state.loadRawConfig();
  // An empty model keeps the previously saved one, so the base URL can be
  // saved (and models listed) before a model has been picked.
  const nextModel = trimmedModel.length > 0 ? trimmedModel : String(config.llm?.model ?? "");
  if (nextModel.length > 0 && !MODEL_NAME_PATTERN.test(nextModel)) {
    throw new Error("模型名格式不对。");
  }
  saveConfigPatch({ llm: { ...(config.llm ?? {}), provider: "deepseek", baseUrl: trimmedUrl, model: nextModel } });
  return { baseUrl: trimmedUrl, model: nextModel };
};

const exampleDbDir = () => (platform.isWindows ? "C:\\...\\nt_qq\\nt_db" : "/home/你/.config/QQ/nt_qq_xxxx/nt_db");

const saveQqPaths = ({ ntDbDir, ntDataDir }) => {
  const dbDir = String(ntDbDir ?? "").trim();
  const dataDir = String(ntDataDir ?? "").trim();
  if (dbDir.length === 0) {
    throw new Error("nt_db 目录不能为空。");
  }
  if (!platform.isSafeAbsoluteDir(dbDir)) {
    throw new Error(`nt_db 目录应为绝对路径（例如 ${exampleDbDir()}），且不能包含引号等特殊字符。`);
  }
  if (dataDir.length > 0 && !platform.isSafeAbsoluteDir(dataDir)) {
    throw new Error("nt_data 目录应为绝对路径，且不能包含引号等特殊字符。");
  }
  saveConfigPatch({ ntDbDir: dbDir, ntDataDir: dataDir });
  return {
    ntDbDir: dbDir,
    ntDataDir: dataDir,
    ntDbDirExists: fs.existsSync(dbDir),
    ntDataDirExists: dataDir.length === 0 || fs.existsSync(dataDir),
  };
};

const safeReaddir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const lastModified = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
};

// Windows: QQ defaults to Documents\Tencent Files, but the location is
// user-configurable — also probe <drive>:\Tencent Files on every drive letter
// (each base plus its nested "Tencent Files\Tencent Files" layout).
const windowsCandidates = () => {
  const bases = [
    path.join(os.homedir(), "Documents", "Tencent Files"),
    // OneDrive-redirected Documents live outside os.homedir()/Documents.
    ...(process.env.OneDrive ? [path.join(process.env.OneDrive, "Documents", "Tencent Files")] : []),
    path.join(os.homedir(), "OneDrive", "Documents", "Tencent Files"),
  ];
  for (let code = 67; code <= 90; code += 1) {
    bases.push(`${String.fromCharCode(code)}:\\Tencent Files`);
  }
  const candidates = [];
  for (const root of bases.flatMap((base) => [base, path.join(base, "Tencent Files")])) {
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory() || !/^\d{5,}$/u.test(entry.name)) {
        continue;
      }
      const ntDbDir = path.join(root, entry.name, "nt_qq", "nt_db");
      if (fs.existsSync(ntDbDir)) {
        candidates.push({ qq: entry.name, ntDbDir, ntDataDir: path.join(root, entry.name, "nt_qq", "nt_data") });
      }
    }
  }
  return candidates;
};

// Linux QQ (QQNT 3.x) keeps one nt_qq_<hash> folder per account under its
// config dir; the folder name does not contain the QQ number, so candidates
// are labelled by folder and ordered by most recent use.
const linuxCandidates = () => {
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, ".config");
  const roots = [
    path.join(configHome, "QQ"),
    path.join(home, ".var", "app", "com.qq.QQ", "config", "QQ"),
    path.join(home, "snap", "qq", "current", ".config", "QQ"),
  ];
  const candidates = [];
  for (const root of roots) {
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory() || !entry.name.startsWith("nt_qq")) {
        continue;
      }
      const ntDbDir = path.join(root, entry.name, "nt_db");
      if (fs.existsSync(path.join(ntDbDir, "nt_msg.db"))) {
        candidates.push({
          qq: entry.name,
          ntDbDir,
          ntDataDir: path.join(root, entry.name, "nt_data"),
          lastUsed: lastModified(path.join(ntDbDir, "nt_msg.db")),
        });
      }
    }
  }
  return candidates.sort((left, right) => right.lastUsed - left.lastUsed).map(({ lastUsed, ...rest }) => rest);
};

const detectQqPaths = () => {
  const found = platform.isWindows ? windowsCandidates() : linuxCandidates();
  return found.filter((candidate, index) => found.findIndex((other) => other.ntDbDir === candidate.ntDbDir) === index);
};

// Runs the platform's QQ memory scanner and returns the candidate file path.
const scanForCandidates = async (candidatesPath) => {
  if (platform.isWindows) {
    const script = path.join(state.toolRoot, "scripts", "scan_qq_memory_keys.ps1");
    const scan = await runProcess("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-OutputPath", candidatesPath,
    ], KEY_SCAN_TIMEOUT_MS);
    if (scan.code !== 0) {
      throw new Error(lastLine(scan.stderr).slice(0, 300) || `内存扫描失败（退出码 ${scan.code}）。`);
    }
    return;
  }
  // Reading another process's memory needs ptrace rights. pkexec shows the
  // desktop's password prompt and runs ONLY the system /bin/sh + dd, copying
  // QQ's memory regions to our stdout; the candidate scan happens here,
  // unprivileged. No file from this (user-writable) install ever runs as root.
  if (!platform.commandExists("pkexec")) {
    throw new Error("没有找到 pkexec，无法弹出授权窗口。可在终端运行 sudo node src/linux_key_scan.js --output /tmp/qq-keys.txt 自行扫描，或直接手动粘贴密钥。");
  }
  const pids = linuxScan.findQqPids();
  if (pids.length === 0) {
    throw new Error("没有找到正在运行的 QQ 进程。请先打开并登录 QQ，再重试自动获取密钥。");
  }
  const specs = linuxScan.regionSpecs(pids);
  if (specs.length === 0) {
    throw new Error("读不到 QQ 进程的内存布局，请确认 QQ 以当前用户身份运行。");
  }
  const scan = await linuxScan.streamPrivilegedScan(specs, KEY_SCAN_TIMEOUT_MS);
  if (scan.code === 126 || scan.code === 127) {
    throw new Error("授权被取消，未读取 QQ 内存。");
  }
  if (scan.bytes === 0) {
    throw new Error(`没有读到 QQ 进程内存（退出码 ${scan.code}）。可改用手动粘贴密钥。`);
  }
  fs.writeFileSync(candidatesPath, [...scan.candidates].join("\n"), { mode: 0o600 });
};

// One-click NTQQ key recovery: scan the running QQ process memory for key
// candidates, verify them against the start of the user's own database, and
// save the one that decrypts it. The key never leaves the child processes.
const autoDetectKey = async () => {
  const config = state.loadConfig();
  const ntDbDir = String(config.ntDbDir ?? "").trim();
  if (ntDbDir.length === 0) {
    throw new Error("请先在上方设置并保存「QQ 数据库路径」（nt_db 目录），再自动获取密钥。");
  }
  const sourceDb = path.join(ntDbDir, "nt_msg.db");
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`在 nt_db 目录里找不到 nt_msg.db：${ntDbDir}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-autokey-"));
  const sampleDb = path.join(workDir, "nt_msg.sample.db");
  const candidatesPath = path.join(workDir, "candidates.txt");
  try {
    const { writeDatabaseSample } = require("../save_key_from_candidates");
    writeDatabaseSample(sourceDb, sampleDb, detectPrefixBytes(sourceDb));
    await scanForCandidates(candidatesPath);
    if (!fs.existsSync(candidatesPath)) {
      throw new Error("内存扫描没有产生候选。请确认 QQ 已打开并登录后重试。");
    }
    const verify = await runProcess(
      process.execPath,
      [path.join(state.toolRoot, "src", "save_key_from_candidates.js"), sampleDb, candidatesPath],
      KEY_VERIFY_TIMEOUT_MS,
    );
    let result = null;
    try {
      result = JSON.parse(verify.stdout);
    } catch {
      result = null;
    }
    if (result?.saved === true) {
      return { saved: true, candidateCount: result.candidateCount ?? 0, tested: result.tested ?? 0 };
    }
    const scanned = result?.candidateCount ?? 0;
    throw new Error(`扫描到 ${scanned} 个候选，但没有一个能解开数据库。请确认 QQ 已登录数据库路径对应的账号后重试。`);
  } finally {
    // The candidate file holds the real key among the noise — always shred it.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
};

module.exports = {
  getSecretDirectory,
  getSettingsStatus,
  saveSecret,
  autoDetectKey,
  fetchLlmModels,
  saveLlmConfig,
  saveQqPaths,
  detectQqPaths,
};
