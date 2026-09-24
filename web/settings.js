"use strict";

/* ---------- settings view: QQ paths, keys, LLM config ---------- */

const settingsState = { status: null, models: [], background: null, backgroundError: null, backgroundNotice: null, llmDraft: null, llmNotice: null, qqCandidates: [], pathNotice: null };
// One-click NTQQ key recovery lives across re-renders (renderSettingsView rebuilds
// the whole view), so its busy flag and last notice are kept module-level.
const autoKeyState = { busy: false, notice: null };

const openSettingsView = async () => {
  showView("settings");
  settingsState.llmDraft = null;
  settingsState.llmNotice = null;
  settingsState.qqCandidates = [];
  settingsState.pathNotice = null;
  renderSettingsView();
  try {
    settingsState.status = await api("/api/settings");
  } catch (error) {
    setChildren($("#view-settings"),
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取设置失败: ${error.message}`)));
    return;
  }
  renderSettingsView();
  await Promise.all([refreshBackgroundStatus(), loadAiUsage()]);
  renderSettingsView();
};

const refreshBackgroundStatus = async () => {
  try {
    settingsState.background = await api("/api/background");
    settingsState.backgroundError = null;
  } catch (error) {
    settingsState.background = null;
    settingsState.backgroundError = error.message;
  }
  renderSettingsView();
};

const isWindowsHost = () => settingsState.status?.platform === "win32";

const secretStorageText = () => {
  const backend = settingsState.status?.secretBackend;
  if (backend === "dpapi") {
    return "用 Windows DPAPI 加密存在本机 %APPDATA%\\QQSummaryTools\\，只有当前 Windows 用户能解密";
  }
  if (backend === "secret-tool") {
    return "存进系统钥匙圈（GNOME Keyring / KWallet，经 secret-tool）";
  }
  return "存在 ~/.config/QQSummaryTools/，文件权限 0600，只有你自己能读";
};

const savedTag = (isSaved) =>
  el("span", { class: `tag ${isSaved ? "" : "plain"}` }, isSaved ? "✓ 已保存" : "未保存");

const settingsFeedback = (element, text, isError) => {
  element.textContent = text;
  element.style.color = isError ? "var(--risk)" : "var(--ok)";
};

// Persist the detected/typed QQ path immediately so the key auto-detect (which
// reads the SAVED server-side config) works without a separate save click.
const saveDetectedQqPath = async (candidate) => {
  const result = await api("/api/settings/qq-paths", {
    method: "POST",
    body: JSON.stringify({ ntDbDir: candidate.ntDbDir, ntDataDir: candidate.ntDataDir }),
  });
  settingsState.status = await api("/api/settings");
  return { ntDbDirExists: result.ntDbDirExists };
};

const renderSettingsView = () => {
  const status = settingsState.status;
  if (status === null) {
    setChildren($("#view-settings"), el("div", { class: "card" }, el("div", { class: "empty" }, "正在读取设置…")));
    return;
  }

  const background = settingsState.background;
  const backgroundDetail = () => {
    if (settingsState.backgroundError !== null) {
      return `读取失败：${settingsState.backgroundError}`;
    }
    if (background === null) {
      return "读取中";
    }
    if (!background.settings.enabled) {
      return "已关闭";
    }
    return background.lastError ? "上次出错" : `每 ${background.settings.intervalMinutes} 分钟`;
  };
  const readiness = [
    { label: "QQ 数据库", ok: status.ntDbDirExists, detail: status.ntDbDirExists ? "路径可用" : "路径不可用" },
    { label: "解密密钥", ok: status.ntqqKeySaved, detail: status.ntqqKeySaved ? "已保存" : "未保存" },
    { label: "AI 总结", ok: status.llmKeySaved && status.llm.model.length > 0, detail: status.llmKeySaved && status.llm.model.length > 0 ? status.llm.model : "未配置完整" },
    { label: "后台刷新", ok: background?.settings?.enabled === true && !background?.lastError, detail: backgroundDetail() },
  ];
  const readinessCard = el("div", { class: "system-readiness", "data-testid": "system-readiness" },
    readiness.map((item) => el("div", { class: `readiness-item ${item.ok ? "ok" : "attention"}` },
      el("span", {}, item.label),
      el("strong", {}, item.detail))));

  /* --- QQ database paths --- */
  const dbInput = el("input", {
    type: "text",
    value: status.ntDbDir,
    placeholder: isWindowsHost() ? "例如 C:\\Users\\你\\Documents\\Tencent Files\\你的QQ号\\nt_qq\\nt_db" : "例如 /home/你/.config/QQ/nt_qq_xxxx/nt_db",
    style: "width:100%",
  });
  const dataInput = el("input", { type: "text", value: status.ntDataDir, placeholder: "nt_data 目录（媒体导出用，可留空）", style: "width:100%" });
  const pathMsg = el("span", { style: "font-size:13px" });
  if (settingsState.pathNotice !== null) {
    settingsFeedback(pathMsg, settingsState.pathNotice.text, settingsState.pathNotice.isError);
  }
  // Multiple QQ accounts on this machine → one-click switch chips, each saving
  // on click so there is never a separate "save" step.
  const accountRow = settingsState.qqCandidates.length > 1
    ? el("div", { class: "row", style: "margin-bottom:10px;flex-wrap:wrap" },
        el("span", { class: "card-sub", style: "margin:0" }, "选择账号："),
        settingsState.qqCandidates.map((candidate) =>
          el("button", {
            class: `chip ${status.ntDbDir === candidate.ntDbDir ? "on" : ""}`,
            onclick: async () => {
              try {
                const saved = await saveDetectedQqPath(candidate);
                settingsState.pathNotice = {
                  text: saved.ntDbDirExists ? `已切换并保存 QQ ${candidate.qq}。` : `已保存 QQ ${candidate.qq}，但该目录当前不存在。`,
                  isError: !saved.ntDbDirExists,
                };
              } catch (error) {
                settingsState.pathNotice = { text: error.message, isError: true };
              }
              renderSettingsView();
            },
          }, `QQ ${candidate.qq}`)))
    : null;
  const pathsCard = el("div", { class: "card" },
    el("h2", {}, "QQ 数据库路径"),
    el("p", { class: "card-sub" }, "QQNT 的本地数据库目录。工具只会复制这里的文件做只读分析，绝不修改原文件。"),
    el("div", { style: "display:grid;gap:8px;margin-bottom:10px" }, dbInput, dataInput),
    accountRow,
    el("div", { class: "row" },
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          event.target.disabled = true;
          settingsFeedback(pathMsg, "正在探测…", false);
          try {
            const result = await api("/api/settings/detect-qq", { method: "POST" });
            if (result.candidates.length === 0) {
              settingsState.qqCandidates = [];
              settingsState.pathNotice = { text: "没有在默认位置找到，请手动填写路径后点「保存路径」（QQ 设置里可查看文件保存位置）。", isError: true };
            } else {
              settingsState.qqCandidates = result.candidates;
              // Auto-save the first hit so a single-account user is fully one-click.
              const saved = await saveDetectedQqPath(result.candidates[0]);
              settingsState.pathNotice = result.candidates.length > 1
                ? { text: `找到 ${result.candidates.length} 个账号，已默认保存 QQ ${result.candidates[0].qq}；要用其它账号点上面切换即可。`, isError: false }
                : {
                    text: saved.ntDbDirExists
                      ? `已找到并保存 QQ ${result.candidates[0].qq} 的数据库路径，可直接到下面获取密钥。`
                      : `已保存 QQ ${result.candidates[0].qq}，但该 nt_db 目录当前不存在，请检查。`,
                    isError: !saved.ntDbDirExists,
                  };
            }
          } catch (error) {
            settingsState.pathNotice = { text: error.message, isError: true };
          }
          renderSettingsView();
        },
      }, "🔍 自动探测并保存"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          try {
            const result = await api("/api/settings/qq-paths", {
              method: "POST",
              body: JSON.stringify({ ntDbDir: dbInput.value, ntDataDir: dataInput.value }),
            });
            settingsState.status = await api("/api/settings");
            settingsState.pathNotice = { text: result.ntDbDirExists ? "已保存。" : "已保存，但该 nt_db 目录当前不存在，请检查。", isError: !result.ntDbDirExists };
          } catch (error) {
            settingsState.pathNotice = { text: error.message, isError: true };
          }
          renderSettingsView();
        },
      }, "保存路径"),
      pathMsg));

  /* --- keys --- */
  const keyRow = (label, which, isSaved, hint) => {
    const input = el("input", { type: "password", placeholder: isSaved ? "已保存 — 粘贴新值可覆盖" : "粘贴后点保存", style: "flex:1;min-width:220px" });
    const msg = el("span", { style: "font-size:13px" });
    const tag = savedTag(isSaved);
    return el("div", { style: "margin-bottom:14px" },
      el("div", { class: "row", style: "margin-bottom:6px" },
        el("strong", {}, label), tag),
      hint,
      el("div", { class: "row" },
        input,
        el("button", {
          class: "btn small primary",
          onclick: async (event) => {
            const button = event.target;
            if (input.value.trim().length === 0) {
              settingsFeedback(msg, "先粘贴密钥。", true);
              return;
            }
            button.disabled = true;
            try {
              await api("/api/settings/keys", { method: "POST", body: JSON.stringify({ [which]: input.value }) });
              input.value = "";
              settingsFeedback(msg, "已加密保存。", false);
              settingsState.status = await api("/api/settings");
              // Update the tag in place — a full re-render would wipe this feedback line.
              tag.textContent = "✓ 已保存";
              tag.className = "tag";
            } catch (error) {
              settingsFeedback(msg, error.message, true);
            }
            button.disabled = false;
          },
        }, "保存"),
        msg));
  };

  const autoKeyMsg = el("span", { style: "font-size:13px" });
  if (autoKeyState.notice !== null) {
    settingsFeedback(autoKeyMsg, autoKeyState.notice.text, autoKeyState.notice.isError);
  }
  const ntqqKeyHint = el("div", { style: "margin:0 0 8px" },
    el("p", { class: "card-sub", style: "margin:0 0 8px" },
      "推荐「自动获取」：打开并登录 QQ 后点下面的按钮，工具会从本机 QQ 进程内存里读出数据库密钥、验证并保存，全程在本机完成，不联网、不改动 QQ 的任何文件。"),
    el("div", { class: "row" },
      el("button", {
        class: "btn small primary",
        disabled: autoKeyState.busy,
        onclick: async () => {
          if (autoKeyState.busy) {
            return;
          }
          autoKeyState.busy = true;
          autoKeyState.notice = { text: "正在扫描 QQ 内存并验证密钥…（需 QQ 已打开并登录，可能要几分钟，请勿关闭页面）", isError: false };
          renderSettingsView();
          try {
            const result = await api("/api/settings/keys/auto-detect", { method: "POST", body: "{}" });
            autoKeyState.notice = { text: `✓ 已自动获取并保存密钥（从 ${result.candidateCount} 个候选中命中）。`, isError: false };
            settingsState.status = await api("/api/settings");
          } catch (error) {
            autoKeyState.notice = { text: `自动获取失败：${error.message}`, isError: true };
          }
          autoKeyState.busy = false;
          renderSettingsView();
        },
      }, autoKeyState.busy ? "扫描中…" : "🔑 自动获取密钥"),
      autoKeyMsg),
    el("p", { class: "card-sub", style: "margin:8px 0 0" },
      "手动方式（自动获取失败时）：参考开源教程 ",
      el("a", { href: "https://github.com/QQBackup/qq-win-db-key", target: "_blank", rel: "noopener" }, "QQBackup/qq-win-db-key"),
      " 拿到 16 位 key 后，粘贴到下面并保存。"));

  const keysCard = el("div", { class: "card" },
    el("h2", {}, "密钥"),
    el("p", { class: "card-sub" }, `两把密钥都${secretStorageText()}，不进项目目录，不进 Git。`),
    keyRow("NTQQ_DB_KEY（QQ 数据库解密密钥）", "ntqqKey", status.ntqqKeySaved, ntqqKeyHint),
    keyRow("LLM API Key（AI 总结用，可选）", "llmKey", status.llmKeySaved,
      el("p", { class: "card-sub", style: "margin:0 0 8px" },
        "任何 OpenAI 兼容服务的 key 都行（DeepSeek / OpenAI / 本地 Ollama 等）。不保存则只用本地统计，不做 AI 总结。")));

  /* --- LLM config --- */
  // Inputs read from a draft so re-renders (model chips, schedule refresh)
  // never clobber values the user is still typing.
  const draft = settingsState.llmDraft ?? {};
  const draftPatch = (patch) => {
    settingsState.llmDraft = { ...(settingsState.llmDraft ?? {}), ...patch };
  };
  const urlInput = el("input", {
    type: "text",
    value: draft.baseUrl ?? status.llm.baseUrl,
    placeholder: "https://api.deepseek.com",
    style: "width:280px",
    oninput: (event) => draftPatch({ baseUrl: event.target.value }),
  });
  const modelInput = el("input", {
    type: "text",
    value: draft.model ?? status.llm.model,
    placeholder: "模型名，例如 deepseek-v4-flash",
    style: "width:240px",
    oninput: (event) => draftPatch({ model: event.target.value }),
  });
  const llmMsg = el("span", { style: "font-size:13px" });
  if (settingsState.llmNotice !== null) {
    settingsFeedback(llmMsg, settingsState.llmNotice.text, settingsState.llmNotice.isError);
  }
  const modelChips = el("div", { class: "chips", style: "margin-top:10px" },
    settingsState.models.map((model) =>
      el("button", {
        class: `chip ${modelInput.value === model ? "on" : ""}`,
        onclick: () => {
          draftPatch({ model });
          renderSettingsView();
        },
      }, model)));

  const pickPreset = (preset) => {
    draftPatch({ baseUrl: preset.baseUrl, model: preset.models[0] ?? "" });
    settingsState.models = preset.models;
    settingsState.llmNotice = {
      text: `已填入 ${preset.name}。${preset.models.length === 0 ? "保存 key 后点「获取模型列表」选一个模型，" : ""}确认无误后点「保存 LLM 配置」。`,
      isError: false,
    };
    renderSettingsView();
  };

  const llmCard = el("div", { class: "card" },
    el("h2", {}, "AI 总结（LLM）"),
    renderProviderPresets(pickPreset),
    el("div", { class: "row" },
      urlInput,
      modelInput,
      el("button", {
        class: "btn small",
        onclick: async (event) => {
          const button = event.target;
          button.disabled = true;
          settingsFeedback(llmMsg, "正在获取模型列表…", false);
          try {
            // Save the base URL first: the server only sends the stored API key
            // to the saved provider, never to a caller-supplied URL.
            await api("/api/settings/llm", {
              method: "POST",
              body: JSON.stringify({ baseUrl: urlInput.value, model: modelInput.value }),
            });
            settingsState.status = await api("/api/settings");
            const result = await api("/api/llm/models", { method: "POST" });
            settingsState.models = result.models;
            settingsState.llmNotice = { text: `取到 ${result.models.length} 个模型，点选即可填入。`, isError: false };
            renderSettingsView();
            return;
          } catch (error) {
            settingsFeedback(llmMsg, error.message, true);
          }
          button.disabled = false;
        },
      }, "获取模型列表"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          try {
            const result = await api("/api/settings/llm", {
              method: "POST",
              body: JSON.stringify({ baseUrl: urlInput.value, model: modelInput.value }),
            });
            settingsState.llmDraft = null;
            settingsState.llmNotice = null;
            settingsFeedback(llmMsg, `已保存：${result.model.length > 0 ? result.model : "（未选模型）"}`, false);
            settingsState.status = await api("/api/settings");
          } catch (error) {
            settingsFeedback(llmMsg, error.message, true);
          }
        },
      }, "保存 LLM 配置"),
      llmMsg),
    settingsState.models.length > 0 ? modelChips : null);

  /* --- background refresh, notifications, desktop --- */
  const backgroundCard = renderBackgroundCard();

  /* --- check & update --- */
  const updateCard = renderUpdateCard();

  const aboutCard = el("div", { class: "card" },
    el("h2", {}, "安全说明"),
    el("ul", { style: "margin:0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.9" },
      el("li", {}, "只读：工具复制数据库文件后离线解析，从不写 QQ 的任何文件，也不使用 QQ 登录协议。"),
      el("li", {}, "本地：控制台只监听 127.0.0.1，带每次启动随机生成的访问令牌。"),
      el("li", {}, "外部流量：头像，以及本机缺原图时补下载群图片（按 md5 校验），走 QQ 公开 CDN；开启 AI 总结时消息文本会发送到你配置的 LLM 服务；「检查更新」访问 GitHub。")));

  setChildren($("#view-settings"), readinessCard, renderMoreLinks(), pathsCard, keysCard, llmCard, renderAiUsageCard(), backgroundCard, updateCard, aboutCard);
};

/* --- check & update card --- */

const updateState = { info: null, busy: false, notice: null };

const renderUpdateCard = () => {
  const msg = el("span", { style: "font-size:13px" });
  if (updateState.notice !== null) {
    settingsFeedback(msg, updateState.notice.text, updateState.notice.isError);
  }
  const info = updateState.info;
  const currentVersion = settingsState.status?.version ?? "?";

  const checkButton = el("button", {
    class: "btn small",
    disabled: updateState.busy,
    onclick: async () => {
      updateState.busy = true;
      updateState.notice = { text: "正在检查更新…", isError: false };
      renderSettingsView();
      try {
        updateState.info = await api("/api/update/check");
        updateState.notice = updateState.info.hasUpdate
          ? { text: `发现新版本 v${updateState.info.latestVersion}（当前 v${updateState.info.currentVersion}）。`, isError: false }
          : { text: `已是最新版本（v${updateState.info.currentVersion}）。`, isError: false };
      } catch (error) {
        updateState.notice = { text: `检查失败：${error.message}`, isError: true };
      }
      updateState.busy = false;
      renderSettingsView();
    },
  }, "🔎 检查更新");

  const applyButton = info?.hasUpdate === true
    ? el("button", {
        class: "btn small primary",
        disabled: updateState.busy,
        onclick: async () => {
          if (!window.confirm(`更新到 v${info.latestVersion}？\n控制台会自动退出并重启（约 10-30 秒）。配置、密钥和已生成的数据都会保留。`)) {
            return;
          }
          updateState.busy = true;
          updateState.notice = { text: "正在下载并安装更新…", isError: false };
          renderSettingsView();
          try {
            await api("/api/update/apply", { method: "POST", body: "{}" });
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
          renderSettingsView();
        },
      }, `⬆️ 一键更新到 v${info.latestVersion}`)
    : null;

  const notesBlock = info?.hasUpdate === true && info.notes
    ? el("pre", { style: "margin:10px 0 0;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre-wrap;max-height:180px;overflow:auto;color:var(--muted)" }, info.notes)
    : null;

  return el("div", { class: "card" },
    el("h2", {}, "关于与更新"),
    el("p", { class: "card-sub" },
      `当前版本 v${currentVersion} · 项目主页 `,
      el("a", { href: "https://github.com/Rinne414/chatlens", target: "_blank", rel: "noopener" }, "GitHub"),
      "。检查更新会访问 GitHub 获取最新发布版本；一键更新会下载对应安装包并自动重启控制台，你的配置、密钥和数据不受影响。"),
    el("div", { class: "row" }, checkButton, applyButton, msg),
    notesBlock);
};

/* --- pages that moved off the rail --- */

const renderMoreLinks = () =>
  el("div", { class: "settings-more" },
    el("span", { class: "card-sub" }, "更多："),
    el("button", { class: "chip", onclick: () => openView("watchlist") }, "⭐ 关注群"),
    el("button", { class: "chip", onclick: () => openView("run") }, "▶ 自定义时间范围总结"),
    el("button", { class: "chip", onclick: () => openView("history") }, "📚 历史报告"),
    el("button", { class: "chip", onclick: () => openView("storage") }, "💾 存储"));

/* --- background refresh, notifications, desktop integration --- */

const backgroundToggle = (label, hint, checked, onChange) =>
  el("label", { class: "bg-toggle" },
    el("input", { type: "checkbox", checked, onchange: (event) => onChange(event.target.checked) }),
    el("span", {}, el("strong", {}, label), hint ? el("small", {}, hint) : null));

const saveBackgroundSetting = async (patch) => {
  try {
    await api("/api/background", { method: "POST", body: JSON.stringify(patch) });
    settingsState.backgroundNotice = { text: "已保存。", isError: false };
  } catch (error) {
    settingsState.backgroundNotice = { text: error.message, isError: true };
  }
  await refreshBackgroundStatus();
};

const desktopAction = async (path, body, okText) => {
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    settingsState.backgroundNotice = { text: okText, isError: false };
  } catch (error) {
    settingsState.backgroundNotice = { text: error.message, isError: true };
  }
  await refreshBackgroundStatus();
};

const backgroundStatusLine = (background) => {
  if (background.readinessProblem) {
    return el("div", { class: "notice warn" }, `后台刷新暂停：${background.readinessProblem}。`);
  }
  if (background.running) {
    return el("p", { class: "bg-status busy" }, "正在刷新…");
  }
  const facts = [
    background.lastFinishedAt ? `上次 ${unixToHkt(Math.floor(Date.parse(background.lastFinishedAt) / 1000)).slice(5, 16)}` : "还没有刷新过",
    background.nextRunAt ? `下次 ${unixToHkt(Math.floor(Date.parse(background.nextRunAt) / 1000)).slice(11, 16)}` : null,
    background.lastResult?.briefing?.budget ? `今天 AI 调用 ${background.lastResult.briefing.budget.used}/${background.lastResult.briefing.budget.limit}` : null,
  ].filter(Boolean);
  return el("div", {},
    el("p", { class: "bg-status" }, facts.join(" · ")),
    background.lastError ? el("div", { class: "notice risk" }, `上次刷新出错：${background.lastError}`) : null);
};

const renderBackgroundCard = () => {
  const background = settingsState.background;
  const msg = el("span", { style: "font-size:13px" });
  if (settingsState.backgroundNotice !== null) {
    settingsFeedback(msg, settingsState.backgroundNotice.text, settingsState.backgroundNotice.isError);
  }
  if (background === null) {
    return el("div", { class: "card" }, el("h2", {}, "后台与通知"),
      settingsState.backgroundError !== null
        ? el("div", { class: "notice risk" }, `读取失败：${settingsState.backgroundError}`)
        : el("p", { class: "card-sub" }, "正在读取…"));
  }
  const current = background.settings;
  const desktop = background.desktop ?? {};
  const loginLabel = isWindowsHost() ? "开机后在后台运行" : "登录后在后台运行";
  return el("div", { class: "card" },
    el("h2", {}, "后台与通知"),
    el("p", { class: "card-sub" },
      "控制台开着时（窗口可以关掉），会每隔一段时间自动收新消息、攒够一段就交给 AI 总结。你打开「简报」时内容已经准备好。每条消息只总结一次；各群的总览最多每 2 小时重写一次。实际花了多少看下面的「AI 用量与费用」，也可以随时暂停或设每日预算。"),
    backgroundStatusLine(background),
    el("div", { class: "bg-grid" },
      backgroundToggle("自动刷新", "关闭后只有手动总结", current.enabled, (value) => saveBackgroundSetting({ enabled: value })),
      backgroundToggle("自动 AI 总结", "关闭后只收消息、不调用 AI", current.autoSummarize, (value) => saveBackgroundSetting({ autoSummarize: value })),
      backgroundToggle("有人 @ 我或回复我时通知", null, current.notifyMentions, (value) => saveBackgroundSetting({ notifyMentions: value })),
      backgroundToggle("每天早上推送一次简报", "9 点后第一次刷新时", current.notifyDaily, (value) => saveBackgroundSetting({ notifyDaily: value })),
      backgroundToggle(loginLabel, "不弹窗口，打开简报时秒开", desktop.autostart === true, (value) =>
        desktopAction("/api/desktop/autostart", { enabled: value }, value ? "已开启：下次登录会自动在后台运行。" : "已关闭开机后台运行。"))),
    el("div", { class: "row", style: "margin-top:12px" },
      el("span", { style: "font-size:13px" }, "刷新间隔"),
      el("select", {
        onchange: (event) => saveBackgroundSetting({ intervalMinutes: Number(event.target.value) }),
      }, [5, 10, 15, 30, 60].map((minutes) =>
        el("option", { value: String(minutes), selected: minutes === current.intervalMinutes }, `${minutes} 分钟`))),
      el("button", {
        class: "btn small",
        disabled: background.running,
        onclick: async () => {
          await desktopAction("/api/background/run-now", { force: true }, "已开始刷新，并会把攒着的新消息一起总结。");
        },
      }, "立即刷新"),
      el("button", {
        class: "btn small",
        onclick: () => desktopAction("/api/desktop/shortcut", {}, isWindowsHost()
          ? "已在开始菜单创建「QQ 群消息简报」（快捷键 Ctrl+Alt+U）。"
          : "已在应用菜单创建「QQ 群消息简报」。"),
      }, desktop.appShortcut ? "重建开始菜单快捷方式" : "创建开始菜单快捷方式"),
      el("button", {
        class: "btn small danger",
        onclick: async () => {
          if (!window.confirm("停止后台服务？\n页面会断开；之后从开始菜单或启动器重新打开即可。")) {
            return;
          }
          try {
            await api("/api/shutdown", { method: "POST", body: "{}" });
          } catch {
            // The server is going away; a dropped connection is expected.
          }
          setChildren($("#view-settings"), el("div", { class: "card" }, el("h2", {}, "后台服务已停止"),
            el("p", { class: "card-sub" }, "需要时从开始菜单 / 应用菜单的「QQ 群消息简报」重新打开。")));
        },
      }, "停止后台服务"),
      msg),
    el("p", { class: "card-sub", style: "margin:12px 0 0" },
      "想要像 App 一样的独立窗口：在 Chrome / Edge 地址栏右侧点「安装」图标，之后从开始菜单直接打开，任务栏图标还会显示 @ 你的数量。"));
};
