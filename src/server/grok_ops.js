"use strict";

// 设置 → AI 总结: signing in with a Grok subscription and choosing which
// provider the AI features use. The device-code login runs here in the
// background while the page polls its status; the tokens go straight to the
// secret store (src/grok_auth.js) and never reach the page.

const state = require("./toolkit_state");
const grokAuth = require("../grok_auth");
const route = require("../llm_route");

const MODEL_NAME_PATTERN = /^[\w.:/-]{1,64}$/u;
const PROVIDERS = new Set([route.GROK_PROVIDER, "api"]);

// The one sign-in in progress (or its outcome) — a new attempt replaces it.
let login = null;
let loginCounter = 0;

const publicLogin = () => (login === null
  ? null
  : { status: login.status, userCode: login.userCode, verificationUrl: login.verificationUrl, expiresAt: login.expiresAt, error: login.error });

const saveLlmPatch = (patch) => {
  const raw = state.loadRawConfig();
  state.writeConfig({ ...raw, llm: { ...(raw.llm ?? {}), ...patch } });
};

const getStatus = () => {
  const config = state.loadConfig();
  return {
    loggedIn: grokAuth.isLoggedIn(),
    selected: route.isGrokSelected(config),
    model: String(config.llm?.grokModel ?? "").trim() || grokAuth.DEFAULT_GROK_MODEL,
    fallbackReady: route.hasApiKeyProvider(config),
    skipped: route.grokSkip(),
    login: publicLogin(),
  };
};

// Starts the device-code sign-in; the page shows the code and link, the user
// approves at x.ai, and the background poll stores the tokens and switches
// the AI features to Grok.
const startLogin = async () => {
  const session = await grokAuth.startDeviceLogin();
  loginCounter += 1;
  const id = loginCounter;
  login = { id, status: "pending", userCode: session.userCode, verificationUrl: session.verificationUrl, expiresAt: session.expiresAt, error: null };
  const isCurrent = () => login !== null && login.id === id;
  grokAuth.completeDeviceLogin(session, { isCancelled: () => !isCurrent() })
    .then(() => {
      if (!isCurrent()) {
        return;
      }
      route.clearGrokUnavailable();
      saveLlmPatch({ provider: route.GROK_PROVIDER });
      login = { ...login, status: "done" };
    })
    .catch((error) => {
      if (isCurrent()) {
        login = { ...login, status: "failed", error: error.message };
      }
    });
  return publicLogin();
};

const logout = async () => {
  login = null;
  await grokAuth.logout();
  route.clearGrokUnavailable();
  if (route.isGrokSelected(state.loadConfig())) {
    saveLlmPatch({ provider: "api" });
  }
  return getStatus();
};

const selectProvider = ({ provider }) => {
  if (!PROVIDERS.has(provider)) {
    throw new Error("未知的 AI 服务。");
  }
  if (provider === route.GROK_PROVIDER && !grokAuth.isLoggedIn()) {
    throw new Error("请先登录 Grok。");
  }
  if (provider === route.GROK_PROVIDER) {
    // A deliberate switch back to Grok retries it right away.
    route.clearGrokUnavailable();
  }
  saveLlmPatch({ provider });
  return getStatus();
};

const saveModel = ({ model }) => {
  const name = String(model ?? "").trim();
  if (!MODEL_NAME_PATTERN.test(name) || !name.startsWith("grok-")) {
    throw new Error("Grok 模型名格式不对。");
  }
  saveLlmPatch({ grokModel: name });
  return getStatus();
};

const listModels = async () => ({ models: await grokAuth.listModels() });

module.exports = { getStatus, startLogin, logout, selectProvider, saveModel, listModels };
