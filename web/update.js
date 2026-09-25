"use strict";

/* ---------- version + updates: the rail line and the settings card ----------
   The version is always visible at the bottom of the rail. The console asks
   GitHub for the latest release when it opens and every 6 hours after (the
   server keeps the answer, so this is at most one request per 6 hours). When
   a newer release exists the rail says so, and the card at the top of 设置
   already shows its notes and the one-click update button. 检查更新 asks
   again right away. */

const UPDATE_AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 30 * 60 * 1000;

const updateState = { info: null, busy: false, notice: null, checkedAt: 0, nextAutoCheckAt: 0, autoChecking: false, autoError: null };

const currentVersionText = () => updateState.info?.currentVersion ?? railState.data?.version ?? settingsState.status?.version ?? null;

const renderUpdateViews = () => {
  renderRailVersion();
  if (app.view === "settings" && settingsState.status !== null) {
    renderSettingsView();
  }
};

// fresh: always ask GitHub (the button); otherwise the server may answer from
// its 6-hour cache.
const checkForUpdate = async ({ fresh }) => {
  const info = await api(`/api/update/check${fresh ? "" : "?cached=1"}`);
  updateState.info = info;
  updateState.checkedAt = Date.now();
  updateState.nextAutoCheckAt = Date.now() + UPDATE_AUTO_CHECK_MS;
  return info;
};

// Runs from the rail's poll; quiet on failure (the reason shows as a tooltip).
const autoCheckForUpdate = async () => {
  if (updateState.busy || updateState.autoChecking || Date.now() < updateState.nextAutoCheckAt) {
    return;
  }
  updateState.autoChecking = true;
  try {
    await checkForUpdate({ fresh: false });
    updateState.autoError = null;
  } catch (error) {
    updateState.autoError = error.message;
    updateState.nextAutoCheckAt = Date.now() + UPDATE_RETRY_MS;
  }
  updateState.autoChecking = false;
  renderUpdateViews();
};

const runUpdateCheck = async () => {
  updateState.busy = true;
  updateState.notice = { text: "正在检查更新…", isError: false };
  renderUpdateViews();
  try {
    const info = await checkForUpdate({ fresh: true });
    updateState.autoError = null;
    updateState.notice = info.hasUpdate
      ? { text: `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）。`, isError: false }
      : { text: `已是最新版本（v${info.currentVersion}）。`, isError: false };
  } catch (error) {
    updateState.notice = { text: `检查失败：${error.message}`, isError: true };
  }
  updateState.busy = false;
  renderUpdateViews();
};

const applyUpdateNow = async (info) => {
  if (!window.confirm(`更新到 v${info.latestVersion}？\n控制台会自动退出并重启（约 10-30 秒）。配置、密钥和已生成的数据都会保留。`)) {
    return;
  }
  updateState.busy = true;
  updateState.notice = { text: "正在下载并安装更新…", isError: false };
  renderUpdateViews();
  try {
    await api("/api/update/apply", { method: "POST", body: "{}" });
    showView("settings");
    setChildren($("#view-settings"),
      el("div", { class: "card" },
        el("h2", {}, "正在更新"),
        el("p", { class: "card-sub" },
          "控制台正在退出并替换程序文件，完成后会自动重新启动并打开新页面。",
          el("br"),
          isWindowsHost()
            ? "如果 30 秒后没有自动打开，请手动双击 Start-QQ-Console.cmd。"
            : "如果 30 秒后没有自动打开，请运行安装目录里的 ./start.sh。")));
    return;
  } catch (error) {
    updateState.notice = { text: `更新失败：${error.message}`, isError: true };
  }
  updateState.busy = false;
  renderUpdateViews();
};

const openUpdateCard = () => {
  openView("settings");
  window.scrollTo({ top: 0 });
};

/* --- rail: version, status, and the new-version button --- */

const railVersionStatus = () => {
  if (updateState.busy) {
    return { text: "检查中…", tone: "" };
  }
  if (updateState.notice?.isError) {
    return { text: "检查失败", tone: "error" };
  }
  if (updateState.info !== null && !updateState.info.hasUpdate) {
    return { text: `已是最新 · ${railAgo(Math.floor(updateState.checkedAt / 1000))}检查`, tone: "ok" };
  }
  return null;
};

const renderRailVersion = () => {
  const node = $("#rail-version");
  if (node === null) {
    return;
  }
  const version = currentVersionText();
  const info = updateState.info;
  const status = railVersionStatus();
  node.classList.toggle("has-update", info?.hasUpdate === true);
  setChildren(node,
    info?.hasUpdate === true
      ? el("button", {
        class: "rail-update",
        type: "button",
        title: "看更新内容，一键更新",
        onclick: openUpdateCard,
      }, el("strong", {}, `↑ 有新版本 v${info.latestVersion}`), el("span", {}, "点这里看更新内容并一键更新"))
      : null,
    el("div", { class: "rail-version-row" },
      el("span", { class: "rail-version-text", title: updateState.autoError ? `自动检查更新失败：${updateState.autoError}` : `ChatLens ${version === null ? "" : `v${version}`}` },
        version === null ? "版本读取中" : `版本 v${version}`),
      el("button", {
        class: "rail-version-check",
        type: "button",
        disabled: updateState.busy,
        onclick: runUpdateCheck,
      }, "检查更新")),
    status === null ? null : el("p", { class: `rail-version-status ${status.tone}` }, status.text));
};

/* --- settings: the 版本与更新 card (first card on the page) --- */

const renderUpdateCard = () => {
  const msg = el("span", { style: "font-size:13px" });
  if (updateState.notice !== null) {
    settingsFeedback(msg, updateState.notice.text, updateState.notice.isError);
  }
  const info = updateState.info;
  const version = currentVersionText() ?? "?";
  const hasUpdate = info?.hasUpdate === true;

  const applyButton = hasUpdate
    ? el("button", { class: "btn small primary", disabled: updateState.busy, onclick: () => applyUpdateNow(info) }, `一键更新到 v${info.latestVersion}`)
    : null;
  const checkButton = el("button", { class: "btn small", disabled: updateState.busy, onclick: runUpdateCheck }, "检查更新");
  const notesBlock = hasUpdate && info.notes
    ? el("pre", { class: "update-notes" }, info.notes)
    : null;
  const state = hasUpdate
    ? `，可以更新到 v${info.latestVersion}`
    : info !== null ? "，已是最新" : "";

  return el("div", { class: `card update-card ${hasUpdate ? "has-update" : ""}`, id: "update-card" },
    el("h2", {}, "版本与更新"),
    el("p", { class: "update-version" }, el("strong", {}, `当前版本 v${version}`), state),
    el("div", { class: "row" }, applyButton, checkButton, msg),
    notesBlock,
    el("p", { class: "card-sub update-footnote" },
      "控制台打开时和之后每 6 小时会自动向 GitHub 查一次最新版本；一键更新会下载安装包、核对签名后自动重启控制台，你的配置、密钥和数据不受影响。",
      updateState.checkedAt > 0 ? `上次检查：${railAgo(Math.floor(updateState.checkedAt / 1000))}。` : "",
      " 项目主页：",
      el("a", { href: "https://github.com/Rinne414/chatlens", target: "_blank", rel: "noopener" }, "GitHub"),
      "。"));
};
