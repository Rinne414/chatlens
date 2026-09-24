"use strict";

/* ---------- 备份: save what matters to the PC before cleaning QQ ----------
   Scan first (counts, sizes, what the PC does not have), then save. Everything
   is read from the PC QQ cache; nothing in QQ is ever deleted or changed. */

const BACKUP_POLL_MS = 1500;
const BACKUP_CATEGORY_OPTIONS = [
  { key: "aiImages", label: "AI 图", hint: "图片文件里带生成参数，另存一份咒语 .txt" },
  { key: "askedImages", label: "被求过的图", hint: "群里有人求过咒语或原图，附上求图和回复记录" },
  { key: "images", label: "其他图片", hint: "普通图片和截图" },
  { key: "videos", label: "视频", hint: "" },
  { key: "files", label: "文件", hint: "群文件、压缩包、文档" },
  { key: "voice", label: "语音", hint: "" },
  { key: "stickers", label: "表情包", hint: "" },
  { key: "logs", label: "聊天记录", hint: "每个群每天一个文本文件，图片处写上备份里的位置" },
];
const BACKUP_RANGE_PRESETS = [[7, "最近 7 天"], [30, "最近 30 天"], [90, "最近 90 天"]];
const BACKUP_SAMPLE_NOTES = { thumb: "（只有缩略图）", compressed: "（只有压缩版，不是原图）", missing: "（电脑上没有）" };
const BACKUP_KIND_ORDER = [["image", "图片"], ["video", "视频"], ["file", "文件"], ["audio", "语音"], ["emoji", "表情"]];

const backupState = {
  setup: null,
  selected: null,
  fromDay: null,
  toDay: null,
  categories: null,
  remote: true,
  // Set once the user ticks/unticks the box, so a reload keeps their choice.
  remoteChosen: false,
  targetDir: "",
  job: null,
  report: null,
  error: null,
  timer: null,
};

const backupToday = () => unixToHkt(Math.floor(Date.now() / 1000)).slice(0, 10);
const backupDaysAgo = (days) => unixToHkt(Math.floor(Date.now() / 1000) - days * 86400).slice(0, 10);

const backupBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }
  return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
};

const openBackupView = async () => {
  showView("backup");
  renderBackupView();
  try {
    const setup = await api("/api/backup/setup");
    backupState.setup = setup;
    backupState.report = backupState.report ?? setup.lastReport;
    backupState.selected = backupState.selected ?? new Set(setup.groups.filter((group) => group.watched).map((group) => group.groupId));
    backupState.categories = backupState.categories ?? { ...setup.categories };
    backupState.remote = backupState.remoteChosen ? backupState.remote : setup.remote;
    backupState.targetDir = backupState.targetDir || setup.targetDir;
    backupState.fromDay = backupState.fromDay ?? backupDaysAgo(29);
    backupState.toDay = backupState.toDay ?? backupToday();
    backupState.error = null;
  } catch (error) {
    backupState.error = error.message;
  }
  renderBackupView();
  loadExpiringPictures().then(() => {
    if (app.view === "backup") {
      renderBackupView();
    }
  });
  pollBackupJob();
};

/* ---------- running a scan / save ---------- */

const pollBackupJob = async () => {
  clearTimeout(backupState.timer);
  try {
    const snapshot = await api("/api/job?cursor=0");
    const job = snapshot.job?.type === "backup" ? snapshot.job : null;
    const finished = backupState.job?.status === "running" && job !== null && job.status !== "running";
    backupState.job = job;
    if (finished) {
      backupState.report = (await api("/api/backup/report")).report;
      backupState.error = job.status === "failed" ? job.error ?? "备份失败" : null;
    }
  } catch (error) {
    backupState.error = error.message;
  }
  if (app.view === "backup") {
    renderBackupView();
  }
  if (backupState.job?.status === "running") {
    backupState.timer = setTimeout(pollBackupJob, BACKUP_POLL_MS);
  }
};

const startBackup = async (mode) => {
  if (mode === "save" && !window.confirm(`把选中的内容保存到：\n${backupState.targetDir}\n\n已经备份过的文件会跳过，不会覆盖或删除任何东西。`)) {
    return;
  }
  try {
    await api("/api/backup/start", {
      method: "POST",
      body: JSON.stringify({
        mode,
        groupIds: [...backupState.selected],
        fromDay: backupState.fromDay,
        toDay: backupState.toDay,
        categories: backupState.categories,
        remote: backupState.remote,
        targetDir: backupState.targetDir,
      }),
    });
    backupState.error = null;
    backupState.job = { status: "running", label: mode === "save" ? "备份到电脑" : "扫描备份范围", stages: [] };
  } catch (error) {
    backupState.error = error.message;
  }
  renderBackupView();
  pollBackupJob();
};

/* ---------- the form ---------- */

const backupGroupPicker = () => {
  const groups = backupState.setup.groups;
  const toggle = (groupId, on) => {
    const next = new Set(backupState.selected);
    if (on) {
      next.add(groupId);
    } else {
      next.delete(groupId);
    }
    backupState.selected = next;
    renderBackupView();
  };
  const setAll = (ids) => {
    backupState.selected = new Set(ids);
    renderBackupView();
  };
  return el("fieldset", { class: "backup-field" },
    el("legend", {}, `群（已选 ${backupState.selected.size}）`),
    el("div", { class: "backup-inline" },
      el("button", { class: "btn small", type: "button", onclick: () => setAll(groups.filter((group) => group.watched).map((group) => group.groupId)) }, "只选关注的群"),
      el("button", { class: "btn small", type: "button", onclick: () => setAll(groups.map((group) => group.groupId)) }, "全选"),
      el("button", { class: "btn small", type: "button", onclick: () => setAll([]) }, "全不选")),
    el("div", { class: "backup-groups" }, groups.map((group) => el("label", { class: "backup-group" },
      el("input", { type: "checkbox", checked: backupState.selected.has(group.groupId), onchange: (event) => toggle(group.groupId, event.target.checked) }),
      el("span", { class: "backup-group-name" }, group.name, group.watched ? el("span", { class: "backup-star", title: "关注的群" }, "★") : null),
      el("span", { class: "brief-meta" }, group.firstSentAt
        ? `${briefNumber(group.messages)} 条 · ${unixToHkt(group.firstSentAt).slice(5, 10)} 起`
        : "本地还没有记录")))));
};

const backupRangePicker = () => {
  const setRange = (fromDay, toDay) => {
    backupState.fromDay = fromDay;
    backupState.toDay = toDay;
    renderBackupView();
  };
  const firstSeen = Math.min(...backupState.setup.groups.map((group) => group.firstSentAt ?? Infinity));
  return el("fieldset", { class: "backup-field" },
    el("legend", {}, "时间"),
    el("div", { class: "backup-inline" },
      BACKUP_RANGE_PRESETS.map(([days, label]) => el("button", {
        class: `chip ${backupState.fromDay === backupDaysAgo(days - 1) && backupState.toDay === backupToday() ? "on" : ""}`,
        type: "button",
        onclick: () => setRange(backupDaysAgo(days - 1), backupToday()),
      }, label)),
      Number.isFinite(firstSeen)
        ? el("button", { class: "chip", type: "button", onclick: () => setRange(unixToHkt(firstSeen).slice(0, 10), backupToday()) }, "全部本地记录")
        : null),
    el("div", { class: "backup-inline" },
      el("label", {}, "从 ", el("input", { type: "date", value: backupState.fromDay, onchange: (event) => { backupState.fromDay = event.target.value; } })),
      el("label", {}, "到 ", el("input", { type: "date", value: backupState.toDay, onchange: (event) => { backupState.toDay = event.target.value; } }))),
    el("p", { class: "brief-meta" }, "扫描时会把这段时间的消息从电脑 QQ 重新读一遍，所以本地记录之前的日子也能备份。"));
};

const backupCategoryPicker = () =>
  el("fieldset", { class: "backup-field" },
    el("legend", {}, "内容"),
    el("div", { class: "backup-categories" }, BACKUP_CATEGORY_OPTIONS.map((option) => el("label", { class: "backup-category" },
      el("input", {
        type: "checkbox",
        checked: backupState.categories[option.key] === true,
        onchange: (event) => { backupState.categories = { ...backupState.categories, [option.key]: event.target.checked }; },
      }),
      el("span", {}, el("strong", {}, option.label), option.hint ? el("small", {}, option.hint) : null)))));

const backupTargetPicker = () =>
  el("fieldset", { class: "backup-field" },
    el("legend", {}, "保存到"),
    el("input", {
      class: "backup-target",
      type: "text",
      value: backupState.targetDir,
      spellcheck: "false",
      "aria-label": "备份文件夹",
      oninput: (event) => { backupState.targetDir = event.target.value; },
    }),
    el("label", { class: "backup-remote" },
      el("input", { type: "checkbox", checked: backupState.remote, onchange: (event) => { backupState.remote = event.target.checked; backupState.remoteChosen = true; } }),
      el("span", {}, "从 QQ 图片服务器补下载：电脑上没有原图的群图片",
        el("small", {}, "按图片 md5 下载并校验，只对群图片有效，旧图可能已失效。会产生外网请求。"))));

const backupForm = () => {
  const running = backupState.job?.status === "running";
  const ready = backupState.selected.size > 0 && backupState.targetDir.trim().length > 0;
  return el("section", { class: "card backup-form" },
    el("div", { class: "backup-form-grid" },
      backupGroupPicker(),
      el("div", { class: "backup-form-side" }, backupRangePicker(), backupCategoryPicker(), backupTargetPicker())),
    el("div", { class: "backup-actions" },
      el("button", { class: "btn", disabled: running || !ready, onclick: () => startBackup("scan") }, "① 扫描：看看有多少、缺什么"),
      el("button", { class: "btn primary", disabled: running || !ready, onclick: () => startBackup("save") }, "② 保存到电脑"),
      el("span", { class: "brief-meta" }, "可以直接保存；先扫描只是为了先看数量和电脑上缺哪些。")));
};

/* ---------- progress and report ---------- */

const backupProgress = () => {
  const job = backupState.job;
  if (job?.status !== "running") {
    return null;
  }
  return el("section", { class: "card backup-progress", "aria-live": "polite" },
    el("strong", {}, el("span", { class: "brief-pulse" }), ` ${job.label ?? "正在备份"}…`),
    el("ol", { class: "backup-stages" }, (job.stages ?? []).map((stage) => el("li", { class: stage.status }, stage.label))));
};

const backupVerdict = (report) => {
  const saved = report.mode === "save";
  const gaps = report.totals.thumbOnly + (report.totals.compressed ?? 0) + report.totals.missing;
  if (report.totals.total === 0) {
    return el("div", { class: "backup-verdict empty" }, el("strong", {}, "这段时间选中的群里没有要备份的文件"),
      el("p", {}, report.categories?.logs ? "聊天记录照常保存。" : "换个时间范围或多选几个群试试。"));
  }
  if (gaps === 0) {
    return el("div", { class: "backup-verdict safe" },
      el("strong", {}, saved ? "✓ 都已经备份到电脑，可以放心清理这段时间的 QQ 记录" : "✓ 电脑上都有原文件，保存后就可以放心清理"),
      el("p", {}, "清理请在 QQ 里自己操作；本工具不会删除 QQ 里的任何东西。"));
  }
  return el("div", { class: "backup-verdict check" },
    el("strong", {}, `⚠ 还有 ${briefNumber(gaps)} 个文件电脑上没有原文件`,
      gaps > report.totals.missing ? `（${briefNumber(gaps - report.totals.missing)} 个只有缩略图或压缩版${saved ? "，已先存下" : ""}）` : ""),
    el("p", {}, "清理手机前：",
      report.remoteCandidates > 0 && !report.remote
        ? `先勾选下面的「从 QQ 图片服务器补下载」再保存一次（${briefNumber(report.remoteCandidates)} 张可以试）；`
        : "",
      "还缺的，在电脑 QQ 里点开这些图片 / 视频（点开大图才会下载原文件），再扫描一次；实在找不到的，请在手机上另存。"));
};

const backupTiles = (report) => {
  const totals = report.totals;
  const tile = (label, value, tone = "") => el("div", { class: `backup-tile ${tone}` }, el("span", {}, label), el("strong", {}, value));
  return el("div", { class: "backup-tiles" },
    tile(report.mode === "save" ? "这次存下原文件" : "有原文件", briefNumber(Math.max(0, totals.saved - totals.thumbOnly - (totals.compressed ?? 0)))),
    tile("之前已备份", briefNumber(totals.already)),
    tile("只有缩略图 / 压缩版", briefNumber(totals.thumbOnly + (totals.compressed ?? 0)), totals.thumbOnly + (totals.compressed ?? 0) > 0 ? "warn" : ""),
    tile("电脑上没有", briefNumber(totals.missing), totals.missing > 0 ? "risk" : ""),
    report.mode === "scan"
      ? tile("需要空间", `${backupBytes(report.pendingBytes)}${report.freeBytes !== null ? ` / 剩 ${backupBytes(report.freeBytes)}` : ""}`,
        report.freeBytes !== null && report.pendingBytes > report.freeBytes ? "risk" : "")
      : tile("总大小", backupBytes(totals.bytes)));
};

const backupKindCell = (counts) => {
  if (counts === undefined) {
    return el("td", { class: "muted" }, "—");
  }
  const gaps = counts.missing + counts.thumbOnly + (counts.compressed ?? 0);
  return el("td", { title: `共 ${counts.total}，之前已备份 ${counts.already}，只有缩略图 ${counts.thumbOnly}，压缩版 ${counts.compressed ?? 0}，没有 ${counts.missing}` },
    `${briefNumber(counts.total)}`, gaps > 0 ? el("span", { class: "backup-gap" }, ` 缺 ${gaps}`) : null);
};

const backupGroupTable = (report) =>
  el("table", { class: "ai-table backup-table" },
    el("thead", {}, el("tr", {}, ["群", ...BACKUP_KIND_ORDER.map(([, label]) => label), "AI 图", "被求过", "聊天记录", ""].map((head) => el("th", {}, head)))),
    el("tbody", {},
      report.groups.map((group) => el("tr", {},
        el("td", {}, group.groupName || group.groupId),
        BACKUP_KIND_ORDER.map(([kind]) => backupKindCell(group.byKind[kind])),
        el("td", {}, briefNumber(group.ai)),
        el("td", {}, briefNumber(group.asked)),
        el("td", {}, group.logDays > 0 ? `${group.logDays} 天` : "—"),
        el("td", {}, group.verdict === "safe" ? el("span", { class: "backup-ok" }, "可清理") : el("span", { class: "backup-gap" }, "先处理缺的")))),
      (report.emptyGroups ?? []).map((group) => el("tr", { class: "muted" },
        el("td", {}, group.groupName || group.groupId),
        BACKUP_KIND_ORDER.map(() => el("td", {}, "—")),
        el("td", {}, "—"), el("td", {}, "—"),
        el("td", {}, group.logDays > 0 ? `${group.logDays} 天` : "—"),
        el("td", {}, "没有文件")))));

const backupMissingList = (report) => {
  const groups = report.groups.filter((group) => group.missingSamples.length > 0);
  if (groups.length === 0) {
    return null;
  }
  return el("details", { class: "backup-missing" },
    el("summary", {}, "看看缺的是哪些（每个群最多列 30 个）"),
    groups.map((group) => el("div", {},
      el("strong", {}, group.groupName || group.groupId),
      el("ul", {}, group.missingSamples.map((sample) => el("li", {},
        `${sample.hkt.slice(0, 16)} · ${sample.speaker} · ${KIND_LABELS[sample.kind] ?? sample.kind}${BACKUP_SAMPLE_NOTES[sample.status] ?? ""}`))))));
};

const backupReport = () => {
  const report = backupState.report;
  if (report === null || report === undefined) {
    return null;
  }
  const range = `${unixToHkt(report.fromUnix).slice(0, 10)} ~ ${unixToHkt(report.toUnix - 1).slice(0, 10)}`;
  return el("section", { class: "card backup-report" },
    el("div", { class: "backup-report-head" },
      el("h2", {}, report.mode === "save" ? "备份结果" : "扫描结果"),
      el("span", { class: "brief-meta" }, `${range} · ${report.groupIds.length} 个群 · ${briefWhen(Math.floor(Date.parse(report.createdAt) / 1000))}`),
      report.mode === "save"
        ? el("button", { class: "btn small", onclick: () => api("/api/backup/open-folder", { method: "POST", body: "{}" }).catch((error) => alert(error.message)) }, "打开备份文件夹")
        : null),
    backupVerdict(report),
    backupTiles(report),
    report.groups.length + (report.emptyGroups ?? []).length > 0 ? el("div", { class: "backup-table-wrap" }, backupGroupTable(report)) : null,
    backupMissingList(report));
};

const renderBackupView = () => {
  const root = $("#view-backup");
  if (root === null) {
    return;
  }
  if (backupState.setup === null) {
    setChildren(root, backupState.error
      ? el("div", { class: "notice risk" }, backupState.error)
      : el("p", { class: "brief-meta" }, "正在读取…"));
    return;
  }
  setChildren(root, el("div", { class: "backup-page" },
    el("section", { class: "backup-intro" },
      el("h2", {}, "清理 QQ 之前，先把有用的存到电脑"),
      el("p", {}, "选好群和时间，工具会从电脑版 QQ 的本地缓存里把图片、视频、文件和聊天记录按「群 / 年-月」存到你的文件夹，AI 图还会带上咒语和参数；再次运行只补新的。"),
      el("p", { class: "backup-tip" }, el("strong", {}, "先知道一件事："), "电脑 QQ 只保存你在电脑上看过的图：划过去只存一张预览图，点开看大图才存原图，QQ 没有「全部自动下载」的开关。没看过的群图片，保存时会「从 QQ 图片服务器补下载」，按 md5 取回原图（太旧的图服务器上可能已经没有了；不想联网可以在下面取消）。工具只读取，从不删除或修改 QQ 里的任何东西。")),
    renderExpiringPictures(),
    backupState.setup.ntDataConfigured ? null : el("div", { class: "notice risk" }, "还没有设置 QQ 的 nt_data 目录，请先到「设置」自动探测路径。"),
    backupState.error ? el("div", { class: "notice risk" }, backupState.error) : null,
    backupForm(),
    backupProgress(),
    backupReport()));
};
