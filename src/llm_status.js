"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LLM_ERROR_FILE = "llm-error.json";
const LLM_UNUSED_FILE = "llm-unused.json";
const MESSAGE_LIMIT = 500;

const llmErrorPath = (analysisDir) => path.join(analysisDir, LLM_ERROR_FILE);
const llmUnusedPath = (analysisDir) => path.join(analysisDir, LLM_UNUSED_FILE);

const unlinkIfPresent = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
};

const normalizeLlmError = (value) => {
  if (value === null || value === undefined || value === false) {
    return null;
  }
  if (typeof value === "object") {
    return {
      failed: true,
      message: String(value.message ?? "").slice(0, MESSAGE_LIMIT),
    };
  }
  return { failed: true, message: String(value).slice(0, MESSAGE_LIMIT) };
};

const readLlmError = (analysisDir) => {
  const filePath = llmErrorPath(analysisDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return normalizeLlmError(JSON.parse(fs.readFileSync(filePath, "utf8"))) ?? { failed: true, message: "" };
  } catch {
    return { failed: true, message: "" };
  }
};

const readLlmUnused = (analysisDir) => {
  if (!fs.existsSync(llmUnusedPath(analysisDir))) {
    return null;
  }
  return { unused: true };
};

const clearLlmError = (analysisDir) => {
  unlinkIfPresent(llmErrorPath(analysisDir));
};

const clearLlmUnused = (analysisDir) => {
  unlinkIfPresent(llmUnusedPath(analysisDir));
};

const writeLlmError = (analysisDir, error) => {
  fs.mkdirSync(analysisDir, { recursive: true });
  clearLlmUnused(analysisDir);
  const payload = {
    failed: true,
    failedAt: new Date().toISOString(),
    message: String(error?.message ?? error ?? "LLM failed").slice(0, MESSAGE_LIMIT),
  };
  fs.writeFileSync(llmErrorPath(analysisDir), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
};

const writeLlmUnused = (analysisDir) => {
  fs.mkdirSync(analysisDir, { recursive: true });
  clearLlmError(analysisDir);
  const payload = { unused: true };
  fs.writeFileSync(llmUnusedPath(analysisDir), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
};

const llmAbsentSummary = (llmError, { markdown = false, unused = false } = {}) => {
  const text = llmError
    ? "LLM 失败，已改用本地分组。"
    : unused
      ? "未启用 LLM；这里只包含本地动态分组和统计。"
      : "无法判断这次是未使用 LLM 还是 LLM 失败；这里只包含本地动态分组和统计。";
  return markdown ? `- ${text}` : text;
};

module.exports = {
  LLM_ERROR_FILE,
  LLM_UNUSED_FILE,
  llmErrorPath,
  llmUnusedPath,
  normalizeLlmError,
  readLlmError,
  readLlmUnused,
  writeLlmError,
  writeLlmUnused,
  clearLlmError,
  clearLlmUnused,
  llmAbsentSummary,
};
