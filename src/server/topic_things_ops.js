"use strict";

// HTTP side of 群 → 重要的事 (src/topic_things.js): read a day's things, and
// make them with one LLM call in a child process (src/topic_things_run.js).
// One at a time, so a double click never pays twice.

const path = require("node:path");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const briefingOps = require("./briefing_ops");
const { readThings } = require("../topic_things");
const { isLlmConfigured } = require("../llm_route");

const ERROR_TAIL_CHARS = 400;
let running = null;
let lastResult = null;

const getThings = (params) => {
  const groupId = params.get("groupId") ?? "";
  const day = params.get("day") ?? "";
  if (!/^\d+$/u.test(groupId)) {
    throw new Error("群号无效。");
  }
  const watchWords = briefingOps.watchWordsOf(state.loadConfig());
  const result = readThings(state.getStore(), groupId, day, watchWords);
  const job = running !== null && running.groupId === groupId && running.day === day
    ? { status: "running" }
    : lastResult !== null && lastResult.groupId === groupId && lastResult.day === day ? lastResult : null;
  return { ...result, job };
};

const startThings = ({ groupId, day }) => {
  if (!/^\d+$/u.test(String(groupId)) || !/^\d{4}-\d{2}-\d{2}$/u.test(String(day))) {
    throw new Error("群号或日期无效。");
  }
  if (running !== null) {
    throw new Error("另一个群正在整理，等它好了再点。");
  }
  if (!isLlmConfigured(state.loadConfig())) {
    throw new Error("还没有配置 AI 服务：请在「设置」页登录 Grok 或保存 LLM API key。");
  }
  running = { groupId: String(groupId), day: String(day) };
  lastResult = null;
  const child = spawn(process.execPath, [path.join(state.toolRoot, "src", "topic_things_run.js"), running.groupId, running.day], {
    cwd: state.toolRoot,
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-ERROR_TAIL_CHARS);
  });
  child.on("close", (code) => {
    lastResult = { ...running, status: code === 0 ? "done" : "failed", error: code === 0 ? null : stderr.trim().split(/\r?\n/u).at(-1) || `退出码 ${code}` };
    running = null;
  });
  child.on("error", (error) => {
    lastResult = { ...running, status: "failed", error: error.message };
    running = null;
  });
  return { started: true };
};

module.exports = { getThings, startThings };
