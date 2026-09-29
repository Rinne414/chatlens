"use strict";

// Sign-in with a SuperGrok / X Premium+ subscription instead of a paid API key.
//
// xAI's device-code OAuth (the flow the Grok CLI, Hermes Agent and OpenClaw
// use, with the same public client id): the user approves a short code in the
// browser, we receive an access token (~6 h) plus a refresh token, and calls to
// https://api.x.ai/v1 draw from the subscription's weekly usage pool.
//
// The tokens live in the OS secret store (src/secrets.js, "grokAuth") and are
// never logged. Several processes (background refresh, manual run, quick
// summary) may need a fresh token at once; a lock file makes sure only one of
// them spends the refresh token.

const fs = require("node:fs");
const path = require("node:path");
const secrets = require("./secrets");

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const GROK_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_GROK_MODEL = "grok-4.7";

const REQUEST_TIMEOUT_MS = 30000;
// Refresh an hour early: a manual run started just before expiry must not
// have its token die halfway through.
const REFRESH_SKEW_SECONDS = 3600;
const LOCK_STALE_MS = 60000;
const LOCK_WAIT_MS = 30000;
const LOCK_POLL_MS = 300;
const SLOW_DOWN_STEP_SECONDS = 5;

class GrokAuthError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = "GrokAuthError";
    this.code = code;
    this.status = status;
  }
}

const nowUnix = () => Math.floor(Date.now() / 1000);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestJson = async (url, { method = "GET", form, token } = {}) => {
  const headers = { accept: "application/json" };
  if (form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: form === undefined ? undefined : new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
};

let cachedTokenEndpoint = null;
const tokenEndpoint = async () => {
  if (cachedTokenEndpoint !== null) {
    return cachedTokenEndpoint;
  }
  const { status, json } = await requestJson(DISCOVERY_URL);
  const endpoint = String(json?.token_endpoint ?? "");
  if (status !== 200 || !endpoint.startsWith(`${ISSUER}/`)) {
    throw new GrokAuthError(`无法读取 xAI 登录配置（HTTP ${status}）。`, "discovery-failed", status);
  }
  cachedTokenEndpoint = endpoint;
  return endpoint;
};

/* ---------- stored tokens ---------- */

const authFromTokenResponse = (json, previousRefreshToken, now) => {
  const accessToken = String(json?.access_token ?? "");
  if (accessToken.length === 0) {
    throw new GrokAuthError("xAI 没有返回 access token。", "token-missing");
  }
  const expiresIn = Number(json.expires_in);
  return {
    v: 1,
    accessToken,
    // xAI may or may not rotate the refresh token; keep the old one if not.
    refreshToken: String(json.refresh_token ?? previousRefreshToken ?? ""),
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 6 * 3600),
    savedAt: now,
  };
};

const isLoggedIn = () => secrets.hasSecret("grokAuth");

const readAuth = () => {
  if (!isLoggedIn()) {
    return null;
  }
  try {
    const auth = JSON.parse(secrets.readSecretSync("grokAuth"));
    return typeof auth?.accessToken === "string" ? auth : null;
  } catch {
    return null;
  }
};

const saveAuth = (auth) => secrets.saveSecret("grokAuth", JSON.stringify(auth));

const lockPath = () => path.join(secrets.secretDir(), "grok-auth.lock");

const tryLock = (filePath) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.closeSync(fs.openSync(filePath, "wx"));
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    // A crashed holder leaves its lock behind; take over once it is stale.
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Removed by its holder meanwhile: the next attempt decides.
    }
    return false;
  }
};

const withRefreshLock = async (work) => {
  const filePath = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryLock(filePath)) {
    if (Date.now() > deadline) {
      throw new GrokAuthError("等待 Grok 登录凭证刷新超时。", "lock-timeout");
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await work();
  } finally {
    fs.rmSync(filePath, { force: true });
  }
};

const isFresh = (auth, now) => auth !== null && auth.expiresAt - now > REFRESH_SKEW_SECONDS;

const refreshTokens = async (auth, now) => {
  if (!auth.refreshToken) {
    throw new GrokAuthError("Grok 登录已过期，请在「设置」页重新登录。", "no-refresh-token");
  }
  const { status, json } = await requestJson(await tokenEndpoint(), {
    method: "POST",
    form: { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: auth.refreshToken },
  });
  if (status !== 200) {
    // 400/401: the refresh token is dead. 403: xAI refused this account
    // (usually a subscription tier gate). Either way the user must act.
    throw new GrokAuthError(
      status === 403 ? "xAI 拒绝了这个账号的订阅授权（HTTP 403），请确认订阅方案后重新登录。" : `Grok 登录已失效（HTTP ${status}），请在「设置」页重新登录。`,
      "refresh-rejected",
      status,
    );
  }
  const next = authFromTokenResponse(json, auth.refreshToken, now);
  await saveAuth(next);
  return next;
};

// A usable access token, refreshed when it is within an hour of expiry.
const getAccessToken = async () => {
  const auth = readAuth();
  if (auth === null) {
    throw new GrokAuthError("还没有登录 Grok。", "not-logged-in");
  }
  if (isFresh(auth, nowUnix())) {
    return auth.accessToken;
  }
  return withRefreshLock(async () => {
    // Another process may have refreshed while this one waited for the lock.
    const latest = readAuth() ?? auth;
    const now = nowUnix();
    return isFresh(latest, now) ? latest.accessToken : (await refreshTokens(latest, now)).accessToken;
  });
};

/* ---------- device-code sign-in ---------- */

const startDeviceLogin = async () => {
  const { status, json } = await requestJson(DEVICE_CODE_URL, { method: "POST", form: { client_id: CLIENT_ID, scope: SCOPE } });
  if (status !== 200 || typeof json?.device_code !== "string" || typeof json?.user_code !== "string") {
    throw new GrokAuthError(`无法开始 Grok 登录（HTTP ${status}）。请确认网络能访问 x.ai。`, "device-code-failed", status);
  }
  const now = nowUnix();
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUrl: String(json.verification_uri_complete ?? json.verification_uri ?? ""),
    interval: Math.max(1, Number(json.interval) || 5),
    expiresAt: now + (Number(json.expires_in) || 900),
  };
};

// Polls until the user approves in the browser, then stores the tokens.
// `isCancelled` lets the caller abandon an old attempt.
const completeDeviceLogin = async (session, { isCancelled = () => false } = {}) => {
  const endpoint = await tokenEndpoint();
  let interval = session.interval;
  while (nowUnix() < session.expiresAt) {
    await sleep(interval * 1000);
    if (isCancelled()) {
      throw new GrokAuthError("登录已取消。", "cancelled");
    }
    const { status, json } = await requestJson(endpoint, {
      method: "POST",
      form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, device_code: session.deviceCode },
    });
    if (status === 200 && json?.access_token) {
      await saveAuth(authFromTokenResponse(json, null, nowUnix()));
      return { loggedIn: true };
    }
    const error = json?.error;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      interval += SLOW_DOWN_STEP_SECONDS;
      continue;
    }
    if (error === "access_denied") {
      throw new GrokAuthError("你在浏览器里拒绝了授权。", "denied", status);
    }
    if (error === "expired_token") {
      throw new GrokAuthError("登录代码已过期，请重新开始登录。", "expired", status);
    }
    throw new GrokAuthError(`Grok 登录失败（HTTP ${status}${error ? `，${error}` : ""}）。`, "token-failed", status);
  }
  throw new GrokAuthError("登录代码已过期，请重新开始登录。", "expired");
};

const logout = async () => {
  await secrets.deleteSecret("grokAuth");
  fs.rmSync(lockPath(), { force: true });
};

// Model ids the subscription can use (text models only).
const listModels = async () => {
  const { status, json } = await requestJson(`${GROK_BASE_URL}/models`, { token: await getAccessToken() });
  if (status !== 200) {
    throw new GrokAuthError(`读取 Grok 模型列表失败（HTTP ${status}）。`, "models-failed", status);
  }
  return (Array.isArray(json?.data) ? json.data : [])
    .map((item) => String(item?.id ?? ""))
    .filter((id) => id.startsWith("grok-") && !id.includes("imagine"));
};

module.exports = {
  GROK_BASE_URL,
  DEFAULT_GROK_MODEL,
  REFRESH_SKEW_SECONDS,
  GrokAuthError,
  authFromTokenResponse,
  isLoggedIn,
  getAccessToken,
  startDeviceLogin,
  completeDeviceLogin,
  logout,
  listModels,
};
