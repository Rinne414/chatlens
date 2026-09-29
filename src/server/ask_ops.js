"use strict";

// 问群聊 for the page: start a question (src/ask_history.js), poll it, and
// browse or delete earlier questions.

const state = require("./toolkit_state");
const aiJobs = require("./ai_jobs");
const askStore = require("../ask_store");
const { isValidPeriod } = require("../digest_periods");
const { isLlmConfigured } = require("../llm_route");

const MAX_QUESTION = 500;

const store = () => askStore.ensureAskSchema(state.getStore());

const optionalDay = (value, label) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (!isValidPeriod("day", value)) {
    throw new Error(`${label}格式应为 YYYY-MM-DD。`);
  }
  return value;
};

const startAsk = ({ question, fromDay, toDay }) => {
  const text = String(question ?? "").trim();
  if (text.length === 0 || text.length > MAX_QUESTION) {
    throw new Error(`问题应为 1-${MAX_QUESTION} 个字。`);
  }
  const from = optionalDay(fromDay, "开始日期");
  const to = optionalDay(toDay, "结束日期");
  if (from !== null && to !== null && from > to) {
    throw new Error("开始日期不能晚于结束日期。");
  }
  if (!isLlmConfigured(state.loadConfig())) {
    throw new Error("还没有配置 AI 服务：请在「设置」页登录 Grok 或保存 LLM API key。");
  }
  return aiJobs.startJob("ask", {
    script: "ask_history.js",
    args: ["{input}", "{output}"],
    input: { question: text, fromDay: from, toDay: to },
    meta: { question: text },
  });
};

const getAskStatus = ({ offset }) => ({
  job: aiJobs.snapshot("ask"),
  history: askStore.listAsks(store(), { offset }),
  pageSize: askStore.HISTORY_PAGE,
});

const getAskItem = ({ id }) => {
  const item = askStore.getAsk(store(), id);
  if (item === null) {
    throw new Error("找不到这个问题。");
  }
  return item;
};

const deleteAskItem = ({ id }) => ({ deleted: askStore.deleteAsk(store(), id) });

module.exports = { startAsk, getAskStatus, getAskItem, deleteAskItem };
