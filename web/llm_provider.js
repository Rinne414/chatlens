"use strict";

/* ---------- 设置 → Grok 订阅: sign in with a SuperGrok / X Premium+ plan ----------
   The server runs xAI's device-code sign-in; this card shows the code, opens
   the approval page and polls until the tokens are stored. Tokens never reach
   the page. */

const GROK_POLL_MS = 3000;
const grokUiState = { notice: null, busy: false, models: [], pollTimer: null };

const grokStatus = () => settingsState.status?.grok ?? null;

const grokNotice = (text, isError = false) => {
  grokUiState.notice = { text, isError };
};

const refreshGrokStatus = async () => {
  try {
    const grok = await api("/api/llm/grok");
    settingsState.status = { ...settingsState.status, grok };
  } catch (error) {
    grokNotice(`读取 Grok 状态失败：${error.message}`, true);
  }
};

// Polls only while a sign-in waits for approval.
const scheduleGrokPoll = () => {
  if (grokUiState.pollTimer !== null || grokStatus()?.login?.status !== "pending") {
    return;
  }
  grokUiState.pollTimer = setTimeout(async () => {
    grokUiState.pollTimer = null;
    await refreshGrokStatus();
    const login = grokStatus()?.login;
    if (login?.status === "done") {
      grokNotice("✓ 已登录 Grok，AI 总结改用 Grok 订阅。");
      settingsState.status = await api("/api/settings");
    } else if (login?.status === "failed") {
      grokNotice(login.error ?? "登录失败。", true);
    }
    renderSettingsView();
    scheduleGrokPoll();
  }, GROK_POLL_MS);
};

const grokAction = async (path, body, okText) => {
  grokUiState.busy = true;
  renderSettingsView();
  try {
    await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    settingsState.status = await api("/api/settings");
    grokNotice(okText);
  } catch (error) {
    grokNotice(error.message, true);
  }
  grokUiState.busy = false;
  renderSettingsView();
};

const startGrokLogin = async () => {
  grokUiState.busy = true;
  grokNotice("正在向 xAI 申请登录代码…");
  renderSettingsView();
  try {
    const login = await api("/api/llm/grok/login", { method: "POST", body: "{}" });
    settingsState.status = { ...settingsState.status, grok: { ...grokStatus(), login } };
    grokUiState.notice = null;
    window.open(login.verificationUrl, "_blank", "noopener");
  } catch (error) {
    grokNotice(error.message, true);
  }
  grokUiState.busy = false;
  renderSettingsView();
  scheduleGrokPoll();
};

const loadGrokModels = async () => {
  try {
    grokUiState.models = (await api("/api/llm/grok/models", { method: "POST", body: "{}" })).models;
    grokNotice(`取到 ${grokUiState.models.length} 个模型，点选即可切换。`);
  } catch (error) {
    grokNotice(error.message, true);
  }
  renderSettingsView();
};

const grokPendingBlock = (login) =>
  el("div", { class: "grok-login" },
    el("p", { class: "card-sub", style: "margin:0 0 8px" }, "在打开的 x.ai 页面登录有订阅的账号，确认代码一致后点同意："),
    el("div", { class: "grok-code" }, login.userCode),
    el("div", { class: "row" },
      el("a", { class: "btn small primary", href: login.verificationUrl, target: "_blank", rel: "noopener" }, "打开 x.ai 授权页"),
      el("span", { class: "card-sub", style: "margin:0" }, `等待你在浏览器里同意…（代码 ${unixToHkt(login.expiresAt).slice(11, 16)} 前有效）`)));

const grokFallbackLine = (grok) => {
  const model = settingsState.status?.llm?.model ?? "";
  return grok.fallbackReady
    ? el("p", { class: "card-sub", style: "margin:6px 0 0" },
      `Grok 不能用时（额度用完、登录失效）自动改用 ${model}，以标准详细度继续。Grok 会拒绝总结部分成人内容（返回空摘要），这些段落也会自动交给 ${model}。`)
    : el("p", { class: "card-sub", style: "margin:6px 0 0;color:var(--warn)" },
      "没有备用服务：Grok 不能用时 AI 总结会暂停，Grok 拒绝总结的成人内容段落也不会有摘要。可在下方「AI 总结（LLM）」保存一个 API key 作为备用。");
};

const grokSkippedNotice = (grok) => (grok.skipped
  ? el("div", { class: "notice warn", style: "margin:8px 0 0" },
    `Grok 暂时不可用，${unixToHkt(grok.skipped.grokSkippedUntil).slice(5, 16)} 前改用备用服务。原因：${grok.skipped.reason}`,
    " ",
    el("button", { class: "btn small", onclick: () => grokAction("/api/llm/provider", { provider: "grok-subscription" }, "已重新启用 Grok。") }, "现在重试"))
  : null);

const grokModelRow = (grok) =>
  el("div", { class: "row", style: "margin-top:8px;flex-wrap:wrap" },
    el("span", { class: "card-sub", style: "margin:0" }, `模型：${grok.model}`),
    el("button", { class: "btn small", onclick: loadGrokModels }, "换模型"),
    grokUiState.models.map((model) =>
      el("button", {
        class: `chip ${grok.model === model ? "on" : ""}`,
        onclick: () => grokAction("/api/llm/grok/model", { model }, `已改用 ${model}。`),
      }, model)));

const grokLoggedInBlock = (grok) => {
  const selected = grok.selected;
  return el("div", {},
    el("div", { class: "row" },
      el("span", { class: "tag" }, "✓ 已登录 Grok"),
      el("strong", {}, selected ? "AI 总结正在使用 Grok 订阅" : "AI 总结目前使用 API key"),
      selected
        ? el("button", { class: "btn small", disabled: grokUiState.busy, onclick: () => grokAction("/api/llm/provider", { provider: "api" }, "已改用 API key。") }, "改用 API key")
        : el("button", { class: "btn small primary", disabled: grokUiState.busy, onclick: () => grokAction("/api/llm/provider", { provider: "grok-subscription" }, "已改用 Grok 订阅。") }, "改用 Grok"),
      el("button", { class: "btn small", disabled: grokUiState.busy, onclick: () => grokAction("/api/llm/grok/logout", {}, "已退出 Grok 登录。") }, "退出登录")),
    selected ? grokModelRow(grok) : null,
    selected ? grokFallbackLine(grok) : null,
    selected ? grokSkippedNotice(grok) : null);
};

const renderGrokCard = () => {
  const grok = grokStatus();
  if (grok === null) {
    return null;
  }
  const noticeLine = el("span", { style: "font-size:13px" });
  if (grokUiState.notice !== null) {
    settingsFeedback(noticeLine, grokUiState.notice.text, grokUiState.notice.isError);
  }
  const login = grok.login;
  let body;
  if (login?.status === "pending") {
    body = grokPendingBlock(login);
    scheduleGrokPoll();
  } else if (grok.loggedIn) {
    body = grokLoggedInBlock(grok);
  } else {
    body = el("div", { class: "row" },
      el("button", { class: "btn small primary", disabled: grokUiState.busy, onclick: startGrokLogin }, "用 Grok 订阅登录"));
  }
  return el("div", { class: "card", "data-testid": "grok-card" },
    el("h2", {}, "Grok 订阅（SuperGrok / X Premium+）"),
    el("p", { class: "card-sub" },
      "有 Grok 订阅的话，AI 总结可以用订阅额度，不另外花 API 费用。用量从订阅的每周额度里扣，和你自己用 Grok 聊天、Grok Build 共用。需要网络能访问 x.ai。"),
    body,
    el("div", { style: "margin-top:6px" }, noticeLine));
};
