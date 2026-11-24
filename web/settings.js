"use strict";

/* ---------- settings view: QQ paths, keys, LLM config ---------- */

const settingsState = { status: null, models: [], background: null, backgroundError: null, backgroundNotice: null, shortcutNotice: null, llmDraft: null, llmNotice: null, qqCandidates: [], pathNotice: null };
// One-click NTQQ key recovery lives across re-renders (renderSettingsView rebuilds
// the whole view), so its busy flag and last notice are kept module-level.
const autoKeyState = { busy: false, notice: null };

/* ---------- second level: what is looked up, not acted on ---------- */

// A native disclosure, so a keyboard and a finger open it as well as a mouse.
// The first screen keeps the name, the state and the action; the explanation
// (and the long values) wait in here.
// Which notes the reader has open: the pages redraw whole (a measurement
// finishing, a switch saving, a poll), and a note being read must stay open.
const openFoldNotes = new Set();

const foldNote = (label, ...children) => {
  const body = el("div", { class: "fold-note-body" }, children);
  const key = `${label}|${String(body.textContent ?? "").slice(0, 120)}`;
  const note = el("details", { class: "fold-note", open: openFoldNotes.has(key) }, el("summary", {}, label), body);
  note.addEventListener("toggle", () => (note.open ? openFoldNotes.add(key) : openFoldNotes.delete(key)));
  return note;
};

const explainNote = (...children) => foldNote("说明", ...children);

// A group of switches: the switches show only their names; each one's sentence
// is listed once under the group's 说明.
const switchHints = (options) => {
  const hinted = options.filter((option) => option.hint);
  return hinted.length === 0
    ? null
    : el("ul", { class: "fold-hints" }, hinted.map((option) =>
      el("li", {}, el("strong", {}, option.label), "：", option.hint)));
};

const switchGrid = (options) =>
  el("div", { class: "bg-grid" }, options.map((option) =>
    backgroundToggle(option.label, null, option.on, option.onChange)));

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
  await Promise.all([refreshBackgroundStatus(), loadAiUsage(), loadPictureStatus(), autoCheckForUpdate(), loadRemoteStatus(), loadNotesStatus()]);
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
    return "用 Windows 自带的加密存在这台电脑上，只有你的 Windows 账户能解开（DPAPI，%APPDATA%\\QQSummaryTools）";
  }
  if (backend === "secret-tool") {
    return "存进系统的密码保管处（钥匙圈：GNOME Keyring / KWallet，经 secret-tool）";
  }
  return "存成只有你这个账户能读的文件（~/.config/QQSummaryTools/，权限 0600）";
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

// What an API-key provider still lacks, in the words the card uses.
const aiMissing = (status) => [
  status.llmKeySaved ? null : "API Key",
  status.llm.model.length > 0 ? null : "模型名",
].filter((part) => part !== null);

// Grok (signed in and selected) or a complete API-key provider.
const aiReadiness = (status) => {
  if (status.grok?.selected && status.grok.loggedIn) {
    return { label: "AI 总结", ok: true, detail: `Grok 订阅 · ${status.grok.model}` };
  }
  const missing = aiMissing(status);
  return { label: "AI 总结", ok: missing.length === 0, detail: missing.length === 0 ? status.llm.model : `还没填 ${missing.join(" 和 ")}` };
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
    aiReadiness(status),
    { label: "后台刷新", ok: background?.settings?.enabled === true && !background?.lastError, detail: backgroundDetail() },
  ];
  // One line of label: state pairs; a state that needs attention is in the warning colour.
  const readinessCard = el("p", { class: "settings-status", "data-testid": "system-readiness" },
    readiness.map((item) => el("span", { class: `settings-status-item ${item.ok ? "ok" : "attention"}` },
      `${item.label}：`,
      el("strong", {}, item.detail))));

  /* --- QQ database paths --- */
  const dbInput = el("input", {
    type: "text",
    value: status.ntDbDir,
    placeholder: isWindowsHost() ? "例如 C:\\Users\\你\\Documents\\Tencent Files\\你的QQ号\\nt_qq\\nt_db" : "例如 /home/你/.config/QQ/nt_qq_xxxx/nt_db",
    style: "width:100%",
  });
  const dataInput = el("input", { type: "text", value: status.ntDataDir, placeholder: "QQ 存图片和文件的文件夹 nt_data（备份和导出图片用，可留空）", style: "width:100%" });
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
    el("h2", { id: "settings-paths" }, "QQ 数据库路径"),
    explainNote(el("p", { class: "card-sub" }, "电脑版 QQ 存聊天记录的文件夹（nt_db）。本程序只复制里面的文件来读，从不修改原文件。")),
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
      }, "自动探测并保存"),
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
    explainNote(
      el("p", { class: "card-sub" },
        "QQ 的聊天记录是加密的。先打开并登录电脑版 QQ，再点「自动获取密钥」：程序从运行中的 QQ 内存里读出密钥，试开一次确认后保存。"),
      el("p", { class: "card-sub" }, "只读，不联网。")),
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
            settingsState.status = await api("/api/settings");
            if (settingsState.status?.ntqqKeySaved === true) {
              autoKeyState.notice = { text: "✓ 密钥已保存。输入框不会显示它。", isError: false };
            } else {
              autoKeyState.notice = { text: "密钥验证通过，但没有写入本机保存位置。请再点一次「自动获取密钥」。", isError: true };
            }
          } catch (error) {
            autoKeyState.notice = { text: `自动获取失败：${error.message}`, isError: true };
          }
          autoKeyState.busy = false;
          renderSettingsView();
        },
      }, autoKeyState.busy ? "扫描中…" : "自动获取密钥"),
      autoKeyMsg),
    el("details", { class: "settings-fold" },
      el("summary", {}, "自动获取失败时：手动方式"),
      el("p", { class: "card-sub", style: "margin:8px 0 0" },
        "参考开源教程 ",
        el("a", { href: "https://github.com/QQBackup/qq-win-db-key", target: "_blank", rel: "noopener" }, "QQBackup/qq-win-db-key"),
        " 拿到 16 个字符的密钥后，粘贴到下面并保存。")));

  const keysCard = el("div", { class: "card", id: "settings-keys" },
    el("h2", {}, "密钥"),
    explainNote(el("p", { class: "card-sub" }, `两把密钥都${secretStorageText()}。`)),
    keyRow("QQ 数据库密钥", "ntqqKey", status.ntqqKeySaved, ntqqKeyHint),
    keyRow("AI 服务的 API Key（AI 总结用，可选）", "llmKey", status.llmKeySaved,
      explainNote(el("p", { class: "card-sub" },
        "AI 服务商给你的密钥，按用量付费。支持 OpenAI 兼容接口的服务都行，如 DeepSeek、OpenAI，或本机的 Ollama。不填就不做 AI 总结。"))));

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
      text: `已填入 ${preset.name}。${preset.models.length === 0 ? "保存 API Key 后点「查看可用模型」选一个，" : ""}确认无误后点「保存 AI 服务设置」。`,
      isError: false,
    };
    renderSettingsView();
  };

  const llmCard = el("div", { class: "card", id: "settings-llm" },
    el("h2", {}, "AI 总结用哪家服务"),
    explainNote(el("p", { class: "card-sub" }, "填服务地址和模型名（模型是这家服务里具体用哪一个 AI）。不确定就点「常用服务」自动填。")),
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
        title: "向这家服务查询有哪些模型（需要先保存 API Key）",
      }, "查看可用模型"),
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
      }, "保存 AI 服务设置"),
      llmMsg),
    settingsState.models.length > 0 ? modelChips : null);

  /* --- background refresh, notifications, desktop --- */
  const backgroundCard = renderBackgroundCard();


  const aboutCard = el("div", { class: "card" },
    el("h2", {}, "安全说明"),
    el("ul", { style: "margin:0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.9" },
      el("li", {}, "只读：程序复制数据库文件后离线解析，从不写 QQ 的任何文件，也不使用 QQ 登录协议。"),
      el("li", {}, "只在这台电脑上：ChatLens 只接受这台电脑自己的访问（127.0.0.1），每次启动还会换一个随机口令（访问令牌）。开启「手机连线」后，只有通过 Tailscale（把你自己的设备连成私人网络的软件）进来、并在这里配对过的手机能访问，而且只能看，不能改设置。"),
      el("li", {}, "会联网的地方：头像；群图片的缩略图和你点开的原图会向腾讯的图片服务器请求；开启 AI 总结时，消息文字会发给你设置的 AI 服务；检查更新（打开时和每 6 小时一次，或点「检查更新」）只向 GitHub 读取最新版本号，自动的那部分可以在上面「版本与更新」关掉。"),
      el("li", {}, "Obsidian 笔记库：只在你选的文件夹里写本地文件，不联网；那个文件夹如果被 Obsidian Sync、网盘或 Git 同步，内容会跟着上传。")));

  // The contents row is read from the cards once they are on the page.
  queueMicrotask(() => {
    document.querySelector("#view-settings > .page-index")?.remove();
    const index = pageIndex("#view-settings", "跳到");
    if (index !== null) {
      $("#view-settings").prepend(index);
    }
  });
  setChildren($("#view-settings"), readinessCard, renderUpdateCard(), renderShortcutCard(), renderMoreLinks(), pathsCard, keysCard, renderGrokCard(), llmCard, renderAiUsageCard(), renderPictureSettingsCard(), backgroundCard, renderRemoteCard(), renderNotesCard(), aboutCard);
};

/* --- pages that moved off the rail --- */

const renderMoreLinks = () =>
  el("div", { class: "settings-more" },
    el("span", { class: "card-sub" }, "更多："),
    el("button", { class: "chip", onclick: () => openView("watchlist") }, "关注群"),
    el("button", { class: "chip", onclick: () => openView("run") }, "▶ 自定义时间范围总结"),
    el("button", { class: "chip", onclick: () => openView("history") }, "历史报告"),
    el("button", { class: "chip", onclick: () => openView("storage") }, "存储"));

/* --- background refresh, notifications, desktop integration --- */

const stopBackgroundService = async () => {
  if (!await confirmInPage("停止后台服务？\n\nChatLens 会完全退出，不再自动收消息和总结，这个页面会断开。数据和设置都保留，之后从开始菜单 / 应用菜单或桌面上的「ChatLens」重新打开。", { confirmLabel: "退出 ChatLens", danger: true })) {
    return;
  }
  try {
    await api("/api/shutdown", { method: "POST", body: "{}" });
  } catch {
    // The server is going away; a dropped connection is expected.
  }
  setChildren($("#view-settings"), el("div", { class: "card" }, el("h2", {}, "后台服务已停止"),
    el("p", { class: "card-sub" }, "需要时从开始菜单 / 应用菜单或桌面上的「ChatLens」重新打开。")));
};

// Both buttons end the same process (POST /api/shutdown); the line says so,
// so nobody hunts for a difference that is not there.
const renderStopRow = () => el("div", { class: "settings-stop" },
  el("div", { class: "row" },
    el("button", { class: "btn small", type: "button", onclick: quitConsole }, "⏻ 退出 ChatLens"),
    el("button", { class: "btn small danger", type: "button", onclick: stopBackgroundService }, "停止后台服务")),
  el("p", { class: "card-sub", style: "margin:6px 0 0" },
    `两个按钮都会让 ChatLens 完全退出，直到你再打开它。数据和设置都保留。${quitReopenHint(settingsState.background?.desktop)}`));

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
  if (!background.settings.enabled) {
    return el("div", { class: "notice warn" }, "「自动刷新」关着：不会自动收新消息，也不会自动总结。",
      background.readinessProblem ? `要打开它，还得先解决：${background.readinessProblem}。` : "");
  }
  if (background.readinessProblem) {
    return el("div", { class: "notice warn" }, `后台刷新暂停：${background.readinessProblem}。`);
  }
  if (background.running) {
    return el("p", { class: "bg-status busy" }, refreshRunningText(background, "正在刷新"), " · ", refreshStopButton(refreshBackgroundStatus));
  }
  const facts = [
    background.lastFinishedAt ? `上次 ${unixToHkt(Math.floor(Date.parse(background.lastFinishedAt) / 1000)).slice(5, 16)}` : "还没有刷新过",
    background.nextRunAt ? `下次 ${unixToHkt(Math.floor(Date.parse(background.nextRunAt) / 1000)).slice(11, 16)}` : null,
    background.lastResult?.briefing?.budget ? `今天 AI 调用 ${background.lastResult.briefing.budget.used} 次（每日上限 ${background.lastResult.briefing.budget.limit}）` : null,
  ].filter(Boolean);
  return el("div", {},
    el("p", { class: "bg-status" }, facts.join(" · ")),
    background.lastError ? el("div", { class: "notice risk" }, `上次刷新出错：${background.lastError}`) : null);
};

const backgroundSwitches = (current, desktop) => [
  { label: "自动刷新", hint: "关闭后只有手动总结", on: current.enabled, onChange: (value) => saveBackgroundSetting({ enabled: value }) },
  { label: "自动 AI 总结", hint: "关闭后只收消息、不调用 AI", on: current.autoSummarize, onChange: (value) => saveBackgroundSetting({ autoSummarize: value }) },
  { label: "有人 @ 我或回复我时通知", hint: null, on: current.notifyMentions, onChange: (value) => saveBackgroundSetting({ notifyMentions: value }) },
  { label: "每天早上推送一次简报", hint: "9 点后第一次刷新时", on: current.notifyDaily, onChange: (value) => saveBackgroundSetting({ notifyDaily: value }) },
  { label: "关注的词出现时通知", hint: "在首页「关注的词」里设要关注的词", on: current.notifyWatchWords === true, onChange: (value) => saveBackgroundSetting({ notifyWatchWords: value }) },
  {
    label: isWindowsHost() ? "开机后在后台运行" : "登录后在后台运行",
    hint: "不弹窗口，打开简报时秒开",
    on: desktop.autostart === true,
    onChange: (value) => desktopAction("/api/desktop/autostart", { enabled: value }, value ? "已开启：下次登录会自动在后台运行。" : "已关闭开机后台运行。"),
  },
];

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
  const switches = backgroundSwitches(current, desktop);
  return el("div", { class: "card" },
    el("h2", { id: "settings-background" }, "后台与通知"),
    explainNote(
      el("p", { class: "card-sub" }, linked("ChatLens 开着时（窗口关掉也行）每隔一段时间收新消息，攒够一段就交给 AI 总结，打开简报时已经准备好。花了多少在上面的「AI 用量与费用」里看，也能暂停或设每日预算。")),
      switchHints(switches),
      el("p", { class: "card-sub" }, "想要独立窗口：在 Chrome / Edge 地址栏右侧点「安装」图标。任务栏图标会显示 @ 你的数量。")),
    backgroundStatusLine(background),
    switchGrid(switches),
    el("div", { class: "row", style: "margin-top:12px" },
      el("span", { style: "font-size:13px" }, "刷新间隔"),
      el("select", {
        onchange: (event) => saveBackgroundSetting({ intervalMinutes: Number(event.target.value) }),
      }, [5, 10, 15, 30, 60].map((minutes) =>
        el("option", { value: String(minutes), selected: minutes === current.intervalMinutes }, `${minutes} 分钟`))),
      el("button", {
        class: "btn small",
        disabled: background.running,
        title: "马上收一次新消息，还没攒够一段的也交给 AI 总结（开着 AI 总结时会产生费用）",
        onclick: async () => {
          await desktopAction("/api/background/run-now", { force: true }, "已开始刷新，并会把攒着的新消息一起总结。");
        },
      }, "立即刷新"),
      el("small", { class: "fold-inline" }, "开着 AI 总结时会产生费用"),
      msg),
    renderStopRow());
};
