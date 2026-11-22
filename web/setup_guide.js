"use strict";

/* First-run guide on the 简报 page. Every step is done right here, in order,
   and each shows whether it is done: find the QQ database, read its key, pick
   the groups to follow, optionally add an AI service. It stays until the
   first messages arrive, so a new user never lands on an empty page. */

const setupGuide = { status: null, error: null, isLoading: false, busy: "", notice: null, candidates: [], search: "", listScroll: 0 };

const loadSetupStatus = async () => {
  if (setupGuide.isLoading) {
    return;
  }
  setupGuide.isLoading = true;
  try {
    setupGuide.status = await api("/api/settings");
    setupGuide.error = null;
  } catch (error) {
    setupGuide.error = error.message;
  }
  setupGuide.isLoading = false;
  renderBriefView();
};

// One action at a time; the step shows `busy` text while it runs and the
// result (or the reason it failed) afterwards.
const runSetupAction = async (name, action) => {
  if (setupGuide.busy !== "") {
    return;
  }
  setupGuide.busy = name;
  setupGuide.notice = null;
  renderBriefView();
  try {
    setupGuide.notice = { step: name, ...(await action()) };
  } catch (error) {
    setupGuide.notice = { step: name, text: error.message, isError: true };
  }
  setupGuide.busy = "";
  await loadState().catch(() => {});
  await loadBriefing({ fresh: true }).catch(() => {});
  await loadSetupStatus();
};

const findQqDatabase = () => runSetupAction("path", async () => {
  const result = await api("/api/settings/detect-qq", { method: "POST" });
  setupGuide.candidates = result.candidates;
  if (result.candidates.length === 0) {
    return { text: "默认位置没有找到 QQ 的数据库。QQ 的设置里能查到聊天文件存在哪个文件夹，把它填到设置页。", isError: true, manual: true };
  }
  const saved = await saveDetectedQqPath(result.candidates[0]);
  if (!saved.ntDbDirExists) {
    return { text: `找到了 QQ ${result.candidates[0].qq}，但它的数据库目录现在打不开。`, isError: true, manual: true };
  }
  return { text: result.candidates.length > 1 ? `找到 ${result.candidates.length} 个 QQ 账号，先用了 QQ ${result.candidates[0].qq}；要换账号点上面的按钮。` : `找到了 QQ ${result.candidates[0].qq}。`, isError: false };
});

const switchQqAccount = (candidate) => runSetupAction("path", async () => {
  const saved = await saveDetectedQqPath(candidate);
  return saved.ntDbDirExists
    ? { text: `换成了 QQ ${candidate.qq}。`, isError: false }
    : { text: `QQ ${candidate.qq} 的数据库目录现在打不开。`, isError: true };
});

const readQqKey = () => runSetupAction("key", async () => {
  const result = await api("/api/settings/keys/auto-detect", { method: "POST", body: "{}" });
  const status = await api("/api/settings");
  if (status.ntqqKeySaved !== true) {
    return { text: "密钥对上了，但没能保存到本机。再点一次试试。", isError: true };
  }
  // The group list needs the key; start reading it right away so step 3 is
  // ready by the time the user gets there.
  await startGroupListRead().catch(() => {});
  return { text: `密钥已保存（从 ${result.candidateCount} 个候选里找到）。`, isError: false };
});

const startGroupListRead = async () => {
  await api("/api/grouplist/refresh", { method: "POST", body: "{}" });
  app.logCursor = 0;
  app.logText = "";
  await pollJobOnce();
  startPolling();
};

// Ticks save one by one without redrawing the list, so the scroll position
// and the box just clicked stay put; the order refreshes on the next search.
const setFollowed = async (groupId, follow, box) => {
  try {
    const result = await api("/api/watchlist", { method: "POST", body: JSON.stringify(follow ? { add: [groupId] } : { remove: [groupId] }) });
    const wasEmpty = (app.state?.watchlist ?? []).length === 0;
    app.state = { ...app.state, watchlist: result.watchlist };
    setupGuide.notice = null;
    if (wasEmpty !== (result.watchlist.length === 0)) {
      renderBriefView(); // step 3 turns done (or back), and the footer changes
    } else {
      box.closest?.(".setup-group")?.classList.toggle("on", follow);
      updateGroupCount();
    }
  } catch (error) {
    box.checked = !follow;
    setupGuide.notice = { step: "groups", text: `没保存上：${error.message}`, isError: true };
    renderBriefView();
  }
  loadRail();
};

// The parts of step 3 that change with each tick, updated in place.
const updateGroupCount = () => {
  const count = (app.state?.watchlist ?? []).length;
  const hint = document.querySelector(".setup-hint");
  if (hint !== null) {
    hint.textContent = groupHintText(count);
  }
  const done = document.querySelector(".setup-step.groups-step .setup-done");
  if (done !== null) {
    done.textContent = `${count} 个`;
  }
};

const groupHintText = (count) => (count > 0
  ? `已选 ${count} 个。以后在左边「关注的群」旁点「管理」随时增减。`
  : "勾选你常看的群，几个就够，以后随时能改。");

const startFirstRefresh = () => runSetupAction("start", async () => {
  await api("/api/background/run-now", { method: "POST", body: JSON.stringify({ force: true }) });
  return null;
});

// Before the first stored message; or, as before this guide existed, when
// setup broke and the window is empty. An older server sends no everStored.
const needsSetupGuide = (data) => {
  const everStored = data.totals.everStored ?? data.totals.textMessages > 0;
  const problem = data.status?.background?.readinessProblem ?? null;
  return !everStored || (problem !== null && data.totals.textMessages === 0);
};

/* ---------- rendering ---------- */

const setupNotice = (step) => {
  const notice = setupGuide.notice;
  if (notice === null || notice.step !== step || !notice.text) {
    return null;
  }
  return el("p", { class: `setup-note ${notice.isError ? "error" : "ok"}` }, notice.text,
    notice.manual ? [" ", el("button", { class: "linklike", type: "button", onclick: () => openView("settings") }, "去设置页填写")] : null);
};

const setupButton = (step, label, busyLabel, onclick, { primary = true } = {}) =>
  el("button", {
    class: `btn small ${primary ? "primary" : ""}`,
    type: "button",
    disabled: setupGuide.busy !== "",
    onclick,
  }, setupGuide.busy === step ? busyLabel : label);

// What a step does, how long it takes and what it costs in disk, and what to
// do if it fails: visible (no hovering) until the step is done, also while a
// step before it is still open.
const setupFacts = (lines) => el("ul", { class: "setup-facts" }, lines.filter(Boolean).map((line) => el("li", {}, line)));

// state: "done" | "now" | "later" (a step before it is not done yet).
// `body` shows while the step is the current one, `after` once it is done.
const setupStep = (number, state, title, doneText, body, after = null, facts = null) =>
  el("li", { class: `setup-step ${state}` },
    el("span", { class: "setup-mark", "aria-hidden": "true" }, state === "done" ? "✓" : String(number)),
    el("div", { class: "setup-body" },
      el("h3", {}, title, state === "done" && doneText ? el("span", { class: "setup-done" }, doneText) : null),
      state === "done" ? null : facts,
      state === "now" ? body : state === "done" ? after : null));

// The manual fallbacks live in 设置; land on the card itself, not the page top.
const openSettingsCard = async (find) => {
  await openSettingsView();
  find()?.scrollIntoView({ block: "start" });
};

const settingsPathCard = () => [...document.querySelectorAll("#view-settings .card")]
  .find((card) => card.querySelector("#settings-paths") !== null) ?? null;

const manualLink = (label, find) =>
  el("button", { class: "linklike", type: "button", onclick: () => openSettingsCard(find) }, label);

const pathStep = (status) => {
  const done = status.ntDbDirExists === true;
  const chips = setupGuide.candidates.length > 1
    ? el("div", { class: "setup-chips" }, setupGuide.candidates.map((candidate) =>
      el("button", {
        class: `chip ${status.ntDbDir === candidate.ntDbDir ? "on" : ""}`,
        type: "button",
        disabled: setupGuide.busy !== "",
        onclick: () => switchQqAccount(candidate),
      }, `QQ ${candidate.qq}`)))
    : null;
  const qq = /[\\/](\d{5,})[\\/]nt_qq/u.exec(status.ntDbDir ?? "")?.[1];
  return setupStep(1, done ? "done" : "now", "找到 QQ 的聊天数据库", qq ? `QQ ${qq}` : "已找到",
    el("div", {},
      setupButton("path", "自动查找", "正在找…", findQqDatabase),
      " ",
      manualLink("找不到？手动指定", settingsPathCard),
      setupNotice("path")),
    chips === null && setupGuide.notice?.step !== "path" ? null : el("div", {}, chips, setupNotice("path")),
    setupFacts([
      "在这台电脑上找 QQ 存聊天记录的文件夹。",
      "几秒钟，这一步不占磁盘。",
      "找不到：QQ 的设置里能查到聊天文件存在哪个文件夹，点「找不到？手动指定」填进去。",
    ]));
};

const keyStep = (status, ready) => setupStep(2, !ready ? "later" : status.ntqqKeySaved ? "done" : "now",
  "读取数据库密钥", "已保存",
  el("div", {},
    setupButton("key", "自动获取密钥", "正在读取，可能要一两分钟…", readQqKey),
    setupNotice("key")),
  setupNotice("key"),
  setupFacts([
    "先打开并登录电脑版 QQ：聊天数据库是加密的，密钥要从运行中的 QQ 内存里读出，验证后加密存在本机。只读，不联网。",
    status.platform === "linux" ? "会弹出系统的密码框：读别的程序的内存需要授权。" : null,
    "一般一两分钟，慢的电脑要几分钟；不占磁盘。",
    ["失败：确认 QQ 开着、登录的是第 1 步那个账号，再点一次。还不行就",
      manualLink("到设置页手动填密钥", () => $("#settings-keys")), "。"],
  ]));

const groupRows = (knownGroups, followed) => {
  const query = setupGuide.search.trim().toLowerCase();
  // Ticked groups first, so what was picked stays in view.
  return knownGroups
    .filter((group) => query.length === 0 || group.groupId.includes(query) || group.name.toLowerCase().includes(query))
    .toSorted((left, right) => Number(followed.has(right.groupId)) - Number(followed.has(left.groupId)))
    .map((group) => el("label", { class: `setup-group ${followed.has(group.groupId) ? "on" : ""}` },
      el("input", {
        type: "checkbox",
        checked: followed.has(group.groupId),
        onchange: (event) => setFollowed(group.groupId, event.target.checked, event.target),
      }),
      el("span", { class: "setup-group-name" }, group.name || group.groupId),
      el("span", { class: "setup-group-id" }, group.groupId)));
};

const groupPicker = () => {
  const knownGroups = app.state?.knownGroups ?? [];
  const followed = new Set((app.state?.watchlist ?? []).map((entry) => entry.groupId));
  const job = app.job?.type === "group-list" ? app.job : null;
  if (job?.status === "running") {
    return el("p", { class: "setup-note" }, "正在读取你加入的群…第一次要先复制一份 QQ 数据库，大约一两分钟。");
  }
  if (knownGroups.length === 0) {
    return el("div", {},
      job !== null && job.status !== "done" ? el("p", { class: "setup-note error" }, `没读到群列表：${job.error ?? "原因未知"}`) : null,
      setupButton("groups", job !== null ? "再试一次" : "读取群列表", "正在开始…", () => runSetupAction("groups", async () => {
        await startGroupListRead();
        return null;
      })));
  }
  // Redraws (the brief page polls) keep the list where it was scrolled to.
  const list = el("div", {
    class: "setup-group-list",
    onscroll: (event) => { setupGuide.listScroll = event.target.scrollTop; },
  }, groupRows(knownGroups, followed));
  requestAnimationFrame(() => { list.scrollTop = setupGuide.listScroll; });
  return el("div", {},
    el("input", {
      type: "text",
      class: "search-box setup-search-input",
      placeholder: `在 ${knownGroups.length} 个群里搜群名或群号`,
      value: setupGuide.search,
      oninput: (event) => {
        setupGuide.search = event.target.value;
        setupGuide.listScroll = 0;
        setChildren(list, groupRows(knownGroups, new Set((app.state?.watchlist ?? []).map((entry) => entry.groupId))));
      },
    }),
    list,
    el("p", { class: "setup-hint" }, groupHintText(followed.size)));
};

// "（现在约 15.1 GB）" once the database is found.
const mirrorSizeText = (status) => (Number.isFinite(status.ntMsgDbBytes) && status.ntMsgDbBytes > 0 ? `（现在约 ${formatBytes(status.ntMsgDbBytes)}）` : "");

const groupStep = (status, ready) => {
  const count = (app.state?.watchlist ?? []).length;
  const body = el("div", {},
    groupPicker(),
    setupNotice("groups"));
  // The picker stays open once a group is ticked, so more can be added.
  const step = setupStep(3, !ready ? "later" : count > 0 ? "done" : "now", "选要看的群", `${count} 个`, body, body, setupFacts([
    "勾选要看的群。后台会定时收这些群的新消息，整理成简报。",
    `第一次要复制一份 QQ 聊天数据库，大约 1-2 分钟。这份副本一直留着，和 QQ 的数据库一样大${mirrorSizeText(status)}；以后每次只更新变了的部分。`,
  ]));
  step.classList.add("groups-step");
  return step;
};

// Background errors arrive as raw messages (SQLite, file paths). Say what it
// means and what happens next; the raw text stays one hover away.
const SETUP_ERROR_HINTS = [
  // SQLCipher reports a wrong key as "file is not a database": check it first.
  [/密钥|SQLITE_NOTADB|file is not a database/iu, "数据库密钥对不上（比如换过账号或重装过 QQ）。到设置页重新「自动获取密钥」。"],
  [/malformed|SQLITE_CORRUPT/iu, "复制下来的 QQ 数据库不完整，多半是 QQ 正在写入。下次刷新会自动重试。"],
  [/被占用|SQLITE_BUSY|database is locked/iu, "数据库副本正被另一个任务使用，等它做完会再收。"],
  [/找不到源数据库|ENOENT/iu, "找不到 QQ 的数据库文件。看看第 1 步的账号对不对，或者 QQ 是否换了存储位置。"],
];

const plainSetupError = (raw) => SETUP_ERROR_HINTS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;

const aiStep = (status) => {
  const ai = aiReadiness(status);
  return setupStep(4, ai.ok ? "done" : "now", "AI 总结（可选）", ai.detail,
    el("div", {},
      el("p", {}, "填一个 AI 服务（DeepSeek、OpenAI 兼容服务或 Grok 订阅），简报里就有每个群在聊什么的总结。不填也能看消息、图片、热点和搜索。消息文字会发给你选的服务，用你自己的额度。"),
      el("button", { class: "btn small", type: "button", onclick: () => openSettingsCard(() => $("#settings-llm")) }, "去设置 AI 服务")));
};

// What goes online, in the same terms as settings.js 安全说明; each item
// names the switch that turns it off where there is one.
const setupOnlineNote = () => el("details", { class: "setup-online" },
  el("summary", {}, "聊天记录只存在这台电脑上。联网时会发生什么？"),
  el("ul", {},
    el("li", {}, linked("检查新版本：打开时和每 6 小时问一次 GitHub，只读版本信息。可以在「设置 → 版本与更新」关掉。")),
    el("li", {}, linked("群头像和群图片：从腾讯的服务器读取。自动抓取群图片可以在「设置 → 群图片」关掉。")),
    el("li", {}, "AI 总结：只有你填了 AI 服务，消息文字才会发给它；不填就不发。")));

// Once the three steps are done, the footer reports what the background
// refresh is really doing; a failed first refresh shows its reason.
const setupFooter = (coreReady) => {
  if (!coreReady) {
    return null;
  }
  const background = briefState.data?.status?.background ?? {};
  if (background.running) {
    return el("div", { class: "setup-foot" },
      el("p", {}, "正在收第一批消息。第一次要先复制一份 QQ 数据库，可能要几分钟；好了这里会自动换成简报。"));
  }
  const [text, label] = background.lastError
    ? [el("span", { class: "setup-note error", title: background.lastError }, `上次没收成：${plainSetupError(background.lastError)}`), "再试一次"]
    : background.lastFinishedAt
      ? ["已经收过一次，你选的群这段时间还没有新消息。有新消息后这里会换成简报。", "现在再收一次"]
      : ["准备好了。后台会每隔一阵自动收新消息；想马上开始就点下面。", "现在开始收消息"];
  return el("div", { class: "setup-foot" },
    el("p", {}, text),
    setupButton("start", label, "正在开始…", startFirstRefresh),
    setupNotice("start"));
};

const setupGuideCard = () => {
  const status = setupGuide.status;
  if (status === null && !ccRemote) {
    if (setupGuide.error === null) {
      loadSetupStatus();
    }
    return el("section", { class: "brief-setup" },
      el("h2", {}, "开始使用"),
      setupGuide.error
        ? el("p", { class: "setup-note error" }, `读取设置失败：${setupGuide.error} `,
          el("button", { class: "linklike", type: "button", onclick: () => { setupGuide.error = null; loadSetupStatus(); } }, "再试一次"))
        : el("p", {}, "正在检查…"));
  }
  // The phone (手机连线) only reads; setup changes this computer, so it is done there.
  if (ccRemote) {
    return el("section", { class: "brief-setup" },
      el("h2", {}, "还没设置好"),
      el("p", {}, "到电脑上打开 ChatLens，在简报页按「开始使用」的几步设置好，手机上就能看了。"));
  }
  const pathReady = status.ntDbDirExists === true;
  const keyReady = pathReady && status.ntqqKeySaved === true;
  const coreReady = keyReady && (app.state?.watchlist ?? []).length > 0;
  return el("section", { class: "brief-setup", "data-testid": "setup-guide" },
    el("h2", {}, "开始使用"),
    el("p", { class: "setup-lead" }, "三步就能用，第四步可选。"),
    el("ol", { class: "setup-steps" },
      pathStep(status),
      keyStep(status, pathReady),
      groupStep(status, keyReady),
      aiStep(status)),
    setupFooter(coreReady),
    setupOnlineNote());
};
