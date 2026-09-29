"use strict";

// AI work the pages start and then poll: 每日总览 / 周报 / 月报 and 问群聊.
// Each runs as a child process (like the quick summary), so a long LLM call
// never blocks the console, and the child resolves its own LLM credential.
// One job per kind at a time.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { toolRoot } = require("./toolkit_state");

const LOG_TAIL = 20;
const jobs = new Map();
let counter = 0;

const snapshot = (kind) => {
  const job = jobs.get(kind);
  if (job === undefined) {
    return null;
  }
  const { id, status, meta, error, result, startedAt, endedAt, logTail } = job;
  return { id, status, meta, error, result, startedAt, endedAt, logTail };
};

// Children end with "<script> failed: <reason>"; the page shows the reason.
const errorFrom = (logTail, code) => {
  const line = logTail.at(-1) ?? `进程退出码 ${code}`;
  return line.replace(/^[\w_]+ failed: /u, "");
};

const finish = (kind, id, patch) => {
  const job = jobs.get(kind);
  if (job !== undefined && job.id === id) {
    jobs.set(kind, { ...job, ...patch, endedAt: new Date().toISOString() });
  }
};

// args may contain "{input}" / "{output}", replaced by the job's temp files.
const startJob = (kind, { script, args = [], input, meta = {} }) => {
  if (jobs.get(kind)?.status === "running") {
    throw new Error("上一个请求还在进行中，请稍候。");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chatlens-${kind}-`));
  const inputPath = path.join(dir, "input.json");
  const outputPath = path.join(dir, "output.json");
  if (input !== undefined) {
    fs.writeFileSync(inputPath, JSON.stringify(input), "utf8");
  }
  const childArgs = args.map((arg) => (arg === "{input}" ? inputPath : arg === "{output}" ? outputPath : String(arg)));
  counter += 1;
  const id = counter;
  const job = { id, status: "running", meta, error: null, result: null, startedAt: new Date().toISOString(), endedAt: null, logTail: [] };
  jobs.set(kind, job);

  const child = spawn(process.execPath, [path.join(toolRoot, "src", script), ...childArgs], { cwd: toolRoot, windowsHide: true });
  let logTail = [];
  const consume = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        logTail = [...logTail.slice(-(LOG_TAIL - 1)), line.trim()];
      }
    }
    const current = jobs.get(kind);
    if (current?.id === id) {
      jobs.set(kind, { ...current, logTail });
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  child.on("error", (error) => {
    finish(kind, id, { status: "failed", error: error.message, logTail });
    cleanup();
  });
  child.on("close", (code) => {
    if (code === 0) {
      try {
        finish(kind, id, { status: "done", result: JSON.parse(fs.readFileSync(outputPath, "utf8")), logTail });
      } catch (error) {
        finish(kind, id, { status: "failed", error: `读取结果失败：${error.message}`, logTail });
      }
    } else {
      finish(kind, id, { status: "failed", error: errorFrom(logTail, code), logTail });
    }
    cleanup();
  });
  return snapshot(kind);
};

module.exports = { startJob, snapshot };
