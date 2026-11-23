"use strict";

// 角色卡 for the person page: start the job (src/persona_run.js), poll it,
// read the saved card, delete it.

const state = require("./toolkit_state");
const aiJobs = require("./ai_jobs");
const personaStore = require("../persona_store");
const { isLlmConfigured } = require("../llm_route");
const { UIN } = require("../group_person");

const store = () => personaStore.ensurePersonaSchema(state.getStore());

const validUin = (uin) => {
  const value = String(uin ?? "");
  if (!UIN.test(value)) {
    throw new Error("QQ 号无效。");
  }
  return value;
};

const startPersona = ({ uin, name }) => {
  const who = validUin(uin);
  if (!isLlmConfigured(state.loadConfig())) {
    throw new Error("还没有配置 AI 服务：请在「设置」页登录 Grok 或保存 LLM API key。");
  }
  return aiJobs.startJob("persona", {
    script: "persona_run.js",
    args: ["{input}", "{output}"],
    input: { uin: who },
    meta: { uin: who, name: String(name ?? "").slice(0, 80) },
  });
};

// job: the running or last job, whoever it is for (one card is made at a time).
const getPersona = ({ uin }) => {
  const who = validUin(uin);
  return { job: aiJobs.snapshot("persona"), card: personaStore.getPersona(store(), who), llmConfigured: isLlmConfigured(state.loadConfig()) };
};

const deletePersona = ({ uin }) => ({ deleted: personaStore.deletePersona(store(), validUin(uin)) });

module.exports = { startPersona, getPersona, deletePersona };
