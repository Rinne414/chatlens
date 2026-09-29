"use strict";

// 每日总览 / 周报 / 月报 for the pages: read stored digests, list past
// reports, and start writing one on request (src/digest_run.js).

const state = require("./toolkit_state");
const aiJobs = require("./ai_jobs");
const digestStore = require("../digest_store");
const { isValidPeriod } = require("../digest_periods");
const { isLlmConfigured } = require("../llm_route");

const validate = ({ kind, period }) => {
  if (!digestStore.KINDS.has(kind) || !isValidPeriod(kind, period)) {
    throw new Error("时间段无效。");
  }
};

const store = () => digestStore.ensureDigestSchema(state.getStore());

const getDigest = ({ kind, period }) => {
  validate({ kind, period });
  return {
    digest: digestStore.getDigest(store(), kind, period),
    job: aiJobs.snapshot("digest"),
    llmConfigured: isLlmConfigured(state.loadConfig()),
  };
};

const listDigests = ({ kind }) => {
  if (!digestStore.KINDS.has(kind)) {
    throw new Error("类型无效。");
  }
  return { items: digestStore.listDigests(store(), kind), job: aiJobs.snapshot("digest") };
};

const generateDigest = ({ kind, period }) => {
  validate({ kind, period });
  if (!isLlmConfigured(state.loadConfig())) {
    throw new Error("还没有配置 AI 服务：请在「设置」页登录 Grok 或保存 LLM API key。");
  }
  return aiJobs.startJob("digest", { script: "digest_run.js", args: [kind, period, "{output}"], meta: { kind, period } });
};

module.exports = { getDigest, listDigests, generateDigest };
