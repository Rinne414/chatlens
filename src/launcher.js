"use strict";

// Opens the console. If it is already running (e.g. started hidden at login)
// this just opens the browser; otherwise it starts the server DETACHED and
// windowless — no console window that stops everything when closed — waits
// until it answers, then opens the browser.
//
//   node src/launcher.js                start if needed + open the briefing
//   node src/launcher.js --background   start if needed, no browser (login autostart)
//   node src/launcher.js --autostart=unviewed   open and summarize "未查看"

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const platform = require("./platform");
const { withAutostart, parseAutostart } = require("./autostart");
const { readInstanceId } = require("./instance");

const toolRoot = path.resolve(__dirname, "..");
const serverScript = path.join(toolRoot, "src", "server", "control_center.js");
const logDir = path.join(toolRoot, "store", "logs");
const PORTS = Array.from({ length: 10 }, (_, index) => 8321 + index);
const PROBE_TIMEOUT_MS = 800;
const START_WAIT_MS = 20000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const probe = (port) =>
  new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: PROBE_TIMEOUT_MS }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          // The server writes its random instance id before listening; a
          // console answering with a different id is another install.
          const expected = readInstanceId(toolRoot);
          resolve(body?.app === "chatlens" && expected !== null && body.instance === expected ? port : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });

const findRunning = async () => {
  for (const port of PORTS) {
    if (await probe(port)) {
      return port;
    }
  }
  return null;
};

const openLog = () => {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "server.log");
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, path.join(logDir, "server.old.log"));
    }
  } catch {
    // No log yet.
  }
  return fs.openSync(logPath, "a");
};

const startServer = () => {
  const log = openLog();
  const child = spawn(process.execPath, [serverScript, "--no-open"], {
    cwd: toolRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
};

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const waitForServer = async () => {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const port = await findRunning();
    if (port !== null) {
      return port;
    }
    await sleep(300);
  }
  return null;
};

const BINDING_PACKAGE = "better-sqlite3-multiple-ciphers";
const BINDING_PROBE_MS = 20000;
const BINDING_INSTALL_MS = 120000;

// Node's own loader text. A binary built for another Node (NODE_MODULE_VERSION)
// or a missing .node both need the prebuild for THIS node.exe, not a new npm.
const needsNativeRebuild = (output) => {
  const text = String(output ?? "");
  return /NODE_MODULE_VERSION/u.test(text)
    || /different Node\.js version/u.test(text)
    || /Could not locate the bindings file/u.test(text);
};

const bindingPackageDir = () => path.join(toolRoot, "node_modules", BINDING_PACKAGE);

const probeNativeBinding = () => spawnSync(process.execPath, [
  "-e",
  "const Database = require('better-sqlite3-multiple-ciphers'); const db = new Database(':memory:'); db.close();",
], {
  cwd: toolRoot,
  windowsHide: true,
  encoding: "utf8",
  timeout: BINDING_PROBE_MS,
});

const installNativeBinding = () => {
  const packageDir = bindingPackageDir();
  fs.rmSync(path.join(packageDir, "build", "Release", "better_sqlite3.node"), { force: true });
  const installer = path.join(toolRoot, "node_modules", "prebuild-install", "bin.js");
  if (!fs.existsSync(installer)) {
    throw new Error(`缺少 prebuild-install，无法按当前 Node.js 重装数据库模块。`);
  }
  return spawnSync(process.execPath, [installer], {
    cwd: packageDir,
    windowsHide: true,
    encoding: "utf8",
    timeout: BINDING_INSTALL_MS,
  });
};

const ensureDependencies = () => {
  if (!fs.existsSync(bindingPackageDir())) {
    throw new Error(`缺少依赖。请在 ${toolRoot} 里运行一次 npm install（发行版压缩包已自带依赖）。`);
  }
  const probe = probeNativeBinding();
  if (probe.status === 0) {
    return;
  }
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (!needsNativeRebuild(output)) {
    throw new Error(output.trim() || "数据库模块无法加载。");
  }
  // The file on disk was built for another Node. Leaving it in place makes
  // every shortcut open the same "npm install" error. Swap in this Node's prebuild.
  const installed = installNativeBinding();
  if (installed.status !== 0) {
    const detail = `${installed.stderr ?? ""}\n${installed.stdout ?? ""}`.trim();
    throw new Error(`数据库模块和当前 Node.js 不一致，自动重装失败。${detail}`);
  }
  const again = probeNativeBinding();
  if (again.status !== 0) {
    const detail = `${again.stderr ?? ""}\n${again.stdout ?? ""}`.trim();
    throw new Error(`数据库模块和当前 Node.js 不一致，自动重装后仍无法加载。${detail}`);
  }
};

const main = async () => {
  ensureDependencies();
  const background = process.argv.includes("--background");
  const autostartFlag = process.argv.find((arg) => arg.startsWith("--autostart="));
  const autostart = autostartFlag === undefined ? null : parseAutostart(`run=${autostartFlag.slice("--autostart=".length)}`);

  let port = await findRunning();
  if (port === null) {
    startServer();
    port = await waitForServer();
    if (port === null) {
      throw new Error(`控制台没有在 ${START_WAIT_MS / 1000} 秒内启动。详情见 ${path.join(logDir, "server.log")}`);
    }
  }
  const url = withAutostart(`http://127.0.0.1:${port}/`, autostart);
  if (!background) {
    platform.openUrl(url);
  }
  process.stdout.write(`${url}\n`);
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { needsNativeRebuild };
