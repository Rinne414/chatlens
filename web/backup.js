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
const BACKUP_PRESETS = [
  { id: "ai", label: "AI 图 + 被求过的图 + 聊天记录", hint: "推荐：最常要找回的东西，占地方最少", keys: ["aiImages", "askedImages", "logs"] },
  { id: "media", label: "所有图片和视频", hint: "外加聊天记录", keys: ["aiImages", "askedImages", "images", "videos", "logs"] },
  { id: "all", label: "全部", hint: "包括文件、语音和表情包", keys: BACKUP_CATEGORY_OPTIONS.map((option) => option.key) },
  { id: "logs", label: "只存聊天记录", hint: "每个群每天一个文本文件", keys: ["logs"] },
];
const BACKUP_RESCUE_BATCH = 5;
const BACKUP_RESCUE_TILE = 96;

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
  rescue: null,
  picked: new Set(),
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
    el("legend", {}, el("span", { class: "backup-step" }, "1"), `选群（已选 ${backupState.selected.size}）`),
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
    el("legend", {}, el("span", { class: "backup-step" }, "2"), "时间"),
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

const presetMatches = (preset) =>
  BACKUP_CATEGORY_OPTIONS.every((option) => (backupState.categories[option.key] === true) === preset.keys.includes(option.key));

const backupPresets = () => el("div", { class: "backup-presets" }, BACKUP_PRESETS.map((preset) => el("button", {
  class: presetMatches(preset) ? "backup-preset on" : "backup-preset",
  type: "button",
  "aria-pressed": String(presetMatches(preset)),
  onclick: () => {
    backupState.categories = Object.fromEntries(BACKUP_CATEGORY_OPTIONS.map((option) => [option.key, preset.keys.includes(option.key)]));
    renderBackupView();
  },
}, el("strong", {}, preset.label), el("small", {}, preset.hint))));

const backupCategoryPicker = () =>
  el("fieldset", { class: "backup-field" },
    el("legend", {}, el("span", { class: "backup-step" }, "3"), "存哪些"),
    backupPresets(),
    el("div", { class: "backup-categories" }, BACKUP_CATEGORY_OPTIONS.map((option) => el("label", { class: "backup-category" },
      el("input", {
        type: "checkbox",
        checked: backupState.categories[option.key] === true,
        onchange: (event) => {
          backupState.categories = { ...backupState.categories, [option.key]: event.target.checked };
          renderBackupView();
        },
      }),
      el("span", {}, el("strong", {}, option.label), option.hint ? el("small", {}, option.hint) : null)))));

const backupTargetPicker = () =>
  el("fieldset", { class: "backup-field" },
    el("legend", {}, el("span", { class: "backup-step" }, "4"), "保存到"),
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
      el("button", { class: "btn primary", disabled: running || !ready, onclick: () => startBackup("save") }, "保存到电脑"),
      el("button", { class: "btn", disabled: running || !ready, onclick: () => startBackup("scan") }, "先扫描看看"),
      el("span", { class: "brief-meta" }, "扫描只统计有多少、电脑上缺哪些，不写入任何文件；可以跳过直接保存。")));
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
    el("summary", {}, "看看缺的是哪些"),
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
      el("h2", {}, "把群里的图和聊天记录存到电脑"),
      el("p", {}, "QQ 里没点开过的图，原图只在腾讯服务器上留 31 天；存到电脑的才一直是你的。这里做两件事：先救快过期的 AI 原图，再按群和时间整批备份。"),
      el("details", { class: "backup-explain" },
        el("summary", {}, "这页具体在做什么？"),
        el("p", {}, "整批备份会从电脑版 QQ 的本地缓存里，把图片、视频、文件和聊天记录按「群 / 年-月」存到你选的文件夹，AI 图另存一份咒语和参数；再次运行只补新的，不会重复。"),
        el("p", {}, "电脑 QQ 只保存你在电脑上看过的图：划过去只存一张预览图，点开看大图才存原图，QQ 没有「全部自动下载」的开关。没看过的群图片，保存时会「从 QQ 图片服务器补下载」，按 md5 取回原图（太旧的图服务器上可能已经没有了；不想联网可以在下面取消）。"),
        el("p", {}, "工具只读取，从不删除或修改 QQ 里的任何东西。清理 QQ 请在 QQ 里自己操作。"))),
    backupStatusTiles(),
    backupState.setup.ntDataConfigured ? null : el("div", { class: "notice risk" }, "还没有设置 QQ 的 nt_data 目录，请先到「设置」自动探测路径。"),
    backupState.error ? el("div", { class: "notice risk" }, backupState.error) : null,
    backupRescue(),
    el("h2", { class: "backup-section-title" }, "整批备份"),
    backupForm(),
    backupProgress(),
    backupReport()));
};

/* ---------- top: status at a glance ---------- */

const backupLastRun = () => {
  const report = backupState.report;
  if (report === null || report === undefined) {
    return { value: "还没备份过", sub: "在下面选好群和内容，保存一次" };
  }
  const when = briefWhen(Math.floor(Date.parse(report.createdAt) / 1000));
  const files = Math.max(0, report.totals.saved - report.totals.thumbOnly - (report.totals.compressed ?? 0));
  return report.mode === "save"
    ? { value: when, sub: `存下 ${briefNumber(files)} 个原文件 · ${report.groupIds.length} 个群` }
    : { value: when, sub: `只扫描过，还没保存（${briefNumber(report.totals.total)} 个文件）` };
};

const backupStatusTiles = () => {
  const expiring = pictureUi.expiring;
  const last = backupLastRun();
  const tile = (label, value, sub, tone = "", onClick = null) => el(onClick === null ? "div" : "button", {
    class: `backup-status ${tone}`,
    type: onClick === null ? undefined : "button",
    onclick: onClick ?? undefined,
  }, el("span", {}, label), el("strong", {}, value), el("small", {}, sub));
  return el("div", { class: "backup-status-row" },
    expiring === undefined
      ? tile("快过期的 AI 原图", "…", "正在读取")
      : tile("快过期的 AI 原图", briefNumber(expiring.total ?? 0),
        (expiring.soon ?? 0) > 0 ? `其中 ${briefNumber(expiring.soon)} 张 7 天内被腾讯删除` : "7 天内没有要过期的",
        (expiring.soon ?? 0) > 0 ? "warn" : "",
        () => document.getElementById("backup-rescue")?.scrollIntoView({ behavior: "smooth", block: "start" })),
    tile("上次备份", last.value, last.sub),
    tile("保存到", backupState.targetDir.split(/[\\/]/u).filter(Boolean).pop() || "未设置", backupState.targetDir || "在下面第 4 步填写"));
};

/* ---------- rescue: AI originals about to disappear ---------- */

const backupRescueProgressText = () => {
  const rescue = backupState.rescue;
  if (rescue === null) {
    return "";
  }
  const tail = rescue.failed > 0 ? `，${rescue.failed} 张没取到` : "";
  return rescue.running
    ? `正在保存 ${rescue.done} / ${rescue.total}（已存 ${rescue.kept} 张${tail}）…`
    : `这批完成：存下 ${rescue.kept} 张${tail}。`;
};

const rescueAllExpiring = async () => {
  const items = pictureUi.expiring?.items ?? [];
  backupState.rescue = { running: true, stop: false, done: 0, kept: 0, failed: 0, total: items.length };
  renderBackupView();
  for (let start = 0; start < items.length && !backupState.rescue.stop; start += BACKUP_RESCUE_BATCH) {
    const md5s = items.slice(start, start + BACKUP_RESCUE_BATCH).map((item) => item.md5);
    try {
      const result = await api("/api/pictures/keep", { method: "POST", body: JSON.stringify({ md5s }) });
      const kept = result.tally?.kept ?? 0;
      backupState.rescue = { ...backupState.rescue, kept: backupState.rescue.kept + kept, failed: backupState.rescue.failed + md5s.length - kept };
    } catch {
      backupState.rescue = { ...backupState.rescue, failed: backupState.rescue.failed + md5s.length };
    }
    backupState.rescue = { ...backupState.rescue, done: Math.min(items.length, start + md5s.length) };
    const node = document.getElementById("backup-rescue-progress");
    if (node !== null) {
      node.textContent = backupRescueProgressText();
    }
  }
  backupState.rescue = { ...backupState.rescue, running: false };
  await loadExpiringPictures();
  if (app.view === "backup") {
    renderBackupView();
  }
};

// Re-renders only the rescue card, so the form below keeps its state.
const rerenderRescue = () => {
  document.getElementById("backup-rescue")?.replaceWith(backupRescue());
};

const setRescuePicked = (picked) => {
  backupState.picked = picked;
  rerenderRescue();
};

// A single tick changes its tile in place; only the selection row re-draws.
const toggleRescuePick = (md5, tile) => {
  const next = new Set(backupState.picked);
  const picked = !next.has(md5);
  if (picked) {
    next.add(md5);
  } else {
    next.delete(md5);
  }
  backupState.picked = next;
  tile?.classList.toggle("picked", picked);
  tile?.querySelector(".wall-pick")?.classList.toggle("picked", picked);
  const items = pictureUi.expiring?.items ?? [];
  document.getElementById("backup-rescue-select")?.replaceWith(backupRescueSelection(items));
};

const backupRescueTile = (item) => {
  const picked = backupState.picked.has(item.md5);
  return el("div", { class: picked ? "backup-rescue-tile picked" : "backup-rescue-tile" },
    el("button", {
      class: "backup-rescue-open",
      type: "button",
      title: `${pictureGroupName(item.groupId)} · ${formatByteSize(item.size)}`,
      onclick: () => openPictureViewer({ ...item, probe: "ai" }),
    }, el("img", { src: pictureUrl(item.md5, "thumb"), alt: "", loading: "lazy", decoding: "async" })),
    el("span", { class: item.daysLeft <= 7 ? "wall-badge expiring" : "wall-badge" }, item.daysLeft === 0 ? "今天过期" : `${item.daysLeft} 天`),
    el("label", { class: picked ? "wall-pick picked" : "wall-pick", title: "选中以便导出", onclick: (event) => event.stopPropagation() },
      el("input", { type: "checkbox", checked: picked, "aria-label": "选中这张图", onchange: (event) => toggleRescuePick(item.md5, event.target.closest(".backup-rescue-tile")) })));
};

const backupRescueSelection = (items) => {
  const count = backupState.picked.size;
  return el("div", { class: "backup-rescue-select", id: "backup-rescue-select" },
    el("button", { class: "btn small", type: "button", onclick: () => setRescuePicked(new Set(items.map((item) => item.md5))) },
      `全选（${briefNumber(items.length)} 张）`),
    count === 0 ? null : el("button", { class: "btn small", type: "button", onclick: () => setRescuePicked(new Set()) }, "清除"),
    el("button", {
      class: "btn small primary",
      type: "button",
      disabled: count === 0 || pictureExport.running,
      title: "把原图复制到 reports 下的新文件夹，附咒语 .txt",
      onclick: () => runPictureExport([...backupState.picked], "backup"),
    }, `导出所选到文件夹（${briefNumber(count)}）`),
    pictureExportStatus("backup"));
};

const backupRescue = () => {
  const expiring = pictureUi.expiring;
  if (expiring === undefined) {
    return pictureUi.expiringError === null ? null : el("div", { class: "notice risk" }, pictureUi.expiringError);
  }
  const items = expiring.items ?? [];
  const rescue = backupState.rescue;
  return el("section", { class: "card backup-rescue", id: "backup-rescue" },
    el("div", { class: "backup-rescue-head" },
      el("div", {},
        el("h2", {}, "先救快过期的 AI 原图"),
        el("p", { class: "card-sub" }, "咒语已经记下了，但原图还只在腾讯服务器上。过期顺序从左到右，点图可以先看一眼。")),
      items.length === 0
        ? null
        : rescue?.running
          ? el("button", { class: "btn", type: "button", onclick: () => { backupState.rescue = { ...backupState.rescue, stop: true }; } }, "停下")
          : el("button", { class: "btn primary", type: "button", onclick: rescueAllExpiring },
            `全部保存（${briefNumber(items.length)} 张）`)),
    rescue === null ? null : el("p", { id: "backup-rescue-progress", class: "backup-rescue-progress", "aria-live": "polite" }, backupRescueProgressText()),
    items.length === 0 ? null : backupRescueSelection(items),
    items.length === 0
      ? el("p", { class: "backup-ok" }, "✓ 现在没有待保存的 AI 原图。")
      : el("div", { class: "backup-rescue-scroll" }, imageWall({
        key: "rescue",
        entries: items.map((item) => ({ kind: "tile", ratio: 1, item })),
        mode: "grid",
        targetSize: BACKUP_RESCUE_TILE,
        gap: 8,
        scrollerSelector: ".backup-rescue-scroll",
        renderEntry: (entry) => backupRescueTile(entry.item),
      })));
};
