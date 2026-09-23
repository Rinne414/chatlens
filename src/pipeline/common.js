"use strict";

// Shared plumbing for the Node pipeline entry points (summary, group list,
// coverage repair, background refresh). This replaced the PowerShell scripts
// so Windows and Linux run the exact same steps.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { withMirrorLock, syncMirror } = require("../db_mirror");

const toolRoot = path.resolve(__dirname, "..", "..");
const srcDir = path.join(toolRoot, "src");
const storeDir = path.join(toolRoot, "store");
const storeDbPath = path.join(storeDir, "messages.db");
const knowledgeDbPath = path.join(storeDir, "knowledge.db");
const mirrorDir = path.join(storeDir, "db-mirror");

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const LOCK_WAIT_MS = 1000;
const LOCK_WAIT_LIMIT_MS = 10 * 60 * 1000;

// Machine-readable stage markers consumed by server/run_jobs.js. They are a
// contract with the UI: keep the exact spelling.
const progress = (marker) => {
  process.stdout.write(`progress=${marker}\n`);
};

const result = (key, value) => {
  process.stdout.write(`${key}=${value}\n`);
};

const info = (message) => {
  process.stdout.write(`${message}\n`);
};

const warn = (message) => {
  process.stdout.write(`警告: ${message}\n`);
};

const shortStableHash = (text) => crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);

const pad = (value) => String(value).padStart(2, "0");

// Run ids stay in the historical local-time format so run_index and cleanup
// keep parsing them: qq-<mode>-<label>-<hash>-yyyyMMdd-HHmmss.
const localStamp = (date = new Date()) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

const makeRunId = (groupIds, mode, label, date = new Date()) =>
  `qq-${mode}-${label}-${shortStableHash(groupIds.join(","))}-${localStamp(date)}`;

const GROUP_ID_SPLIT = /[,;，；\s]+/u;

const normalizeGroupIds = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    for (const part of String(value ?? "").split(GROUP_ID_SPLIT)) {
      const groupId = part.trim();
      if (groupId.length === 0) {
        continue;
      }
      if (!/^\d+$/u.test(groupId)) {
        throw new Error(`无效的 QQ 群号 '${groupId}'：群号只能是数字。`);
      }
      if (!seen.has(groupId)) {
        seen.add(groupId);
        out.push(groupId);
      }
    }
  }
  return out;
};

const watchlistGroupIds = (config) =>
  normalizeGroupIds((config.watchlist ?? []).map((item) => (typeof item === "string" ? item : item?.groupId ?? "")));

// UI and reports speak Beijing time (UTC+8). A time without an explicit offset
// is Beijing time regardless of the machine's timezone.
const parseBeijingTime = (text) => {
  const trimmed = String(text ?? "").trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/u);
  if (match === null) {
    throw new Error(`无法解析时间 '${text}'。请使用北京时间，例如 2026-07-02 18:30。`);
  }
  const [, year, month, day, hour, minute, second, zone] = match;
  const utcSeconds = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0)) / 1000;
  if (zone === undefined) {
    return utcSeconds - BEIJING_OFFSET_SECONDS;
  }
  if (zone === "Z") {
    return utcSeconds;
  }
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.replace(/[+:-]/gu, "");
  const offset = sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2)) * 60);
  return utcSeconds - offset;
};

const nowUnix = () => Math.floor(Date.now() / 1000);

// Spawns one of the toolkit's node scripts with the SAME node binary (works in
// the zero-setup bundle, where no node is on PATH) and streams its output
// into ours line by line so the job log shows it live.
const runNodeScript = (scriptName, args, { env, quiet = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(srcDir, scriptName), ...args.map(String)], {
      cwd: toolRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    const forward = (stream, target) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (target === "stdout") {
          stdout += text;
        }
        buffer += text;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        if (!quiet) {
          for (const line of lines) {
            process.stdout.write(`${line}\n`);
          }
        }
      });
      stream.on("end", () => {
        if (!quiet && buffer.length > 0) {
          process.stdout.write(`${buffer}\n`);
        }
      });
    };
    forward(child.stdout, "stdout");
    forward(child.stderr, "stderr");
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });

const runNodeScriptOrThrow = async (scriptName, args, options, failureMessage) => {
  const outcome = await runNodeScript(scriptName, args, options);
  if (outcome.code !== 0) {
    throw new Error(`${failureMessage}（退出码 ${outcome.code}）`);
  }
  return outcome;
};

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// Syncs the database mirror and runs `readFn(mirror)` while holding the
// mirror lock, so no other process rewrites the files mid-read. A manual run
// waits for a background refresh (seconds) instead of failing.
const withFreshMirror = async (config, owner, readFn, { wait = true } = {}) => {
  const ntDbDir = String(config.ntDbDir ?? "").trim();
  if (ntDbDir.length === 0 || !path.isAbsolute(ntDbDir)) {
    throw new Error("还没有设置 QQ 数据库路径。请在「设置」页填写或自动探测。");
  }
  const startedAt = Date.now();
  for (;;) {
    const outcome = await withMirrorLock(mirrorDir, owner, async () => {
      const mirror = syncMirror({ ntDbDir, mirrorDir });
      if (!mirror.consistent) {
        warn("QQ 正在频繁写入数据库，本次副本可能不完整；读取失败的群不会被标记为已覆盖，下次会自动补上。");
      }
      return readFn(mirror);
    });
    if (outcome.acquired) {
      return outcome.value;
    }
    if (!wait || Date.now() - startedAt > LOCK_WAIT_LIMIT_MS) {
      const holder = outcome.holder?.owner ?? "另一个任务";
      throw new Error(`数据库副本正被占用（${holder}），请稍后重试。`);
    }
    await sleep(LOCK_WAIT_MS);
  }
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
};

// Top-level wrapper: prints the error for the job log and sets the exit code.
const runMain = (main) => {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
};

module.exports = {
  toolRoot,
  srcDir,
  storeDir,
  storeDbPath,
  knowledgeDbPath,
  mirrorDir,
  progress,
  result,
  info,
  warn,
  shortStableHash,
  localStamp,
  makeRunId,
  normalizeGroupIds,
  watchlistGroupIds,
  parseBeijingTime,
  nowUnix,
  runNodeScript,
  runNodeScriptOrThrow,
  withFreshMirror,
  writeJson,
  sleep,
  runMain,
};
