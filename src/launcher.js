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
const { spawn } = require("node:child_process");
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

const ensureDependencies = () => {
  const binding = path.join(toolRoot, "node_modules", "better-sqlite3-multiple-ciphers");
  if (!fs.existsSync(binding)) {
    throw new Error(`缺少依赖。请在 ${toolRoot} 里运行一次 npm install（发行版压缩包已自带依赖）。`);
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

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
