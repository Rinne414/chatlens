"use strict";

const storageState = {
  overview: null,
  measurements: new Map(),
  measuring: new Set(),
  errors: new Map(),
  notice: null,
  requestId: 0,
  // The row whose 「删除」 waits for a second click.
  confirming: null,
};

const STORAGE_SECTIONS = [
  { id: "protected", title: "QQ 的数据和本程序的设置", description: "只能查看，这里没有删除按钮。" },
  { id: "important", title: "本程序存下的消息、图片和进度", description: "长期保存；删掉就找不回，或者要重新整理。" },
  { id: "regenerable", title: "可以重新生成", description: "删掉后，需要时程序会重新做一份。" },
  { id: "history", title: "历史输出", description: "可以删除，但对应的报告、导出文件或图片预览会跟着没有。" },
];

const STORAGE_QQ_IDS = new Set(["qq-account", "qq-databases", "qq-media-cache"]);
const STORAGE_BIG_IDS = new Set(["qq-account", "qq-media-cache", "knowledge-media", "media-removed", "picture-cache"]);

const storagePolicyClass = (policy) => {
  if (policy === "protected") {
    return "protected";
  }
  if (policy === "keep") {
    return "keep";
  }
  if (policy === "cleanup") {
    return "cleanup";
  }
  return "deletable";
};

const storageMeasuredBytes = (itemIds) => itemIds.reduce((total, itemId) => {
  const measurement = storageState.measurements.get(itemId);
  return total + (measurement?.bytes ?? 0);
}, 0);

// A row's name without the bracketed note, for lists in one line.
const storageShortLabel = (label) => label.replace(/（[^）]*）$/u, "");

// This program's own rows (everything but QQ's folders): the bytes counted so
// far and the rows not counted yet, so the headline never passes a partial sum
// off as the total.
const storageToolTotals = (items, measurements, measuring) => {
  const tool = items.filter((item) => !STORAGE_QQ_IDS.has(item.id));
  const missing = tool.filter((item) => !measurements.has(item.id));
  return {
    bytes: tool.reduce((total, item) => total + (measurements.get(item.id)?.bytes ?? 0), 0),
    missing: missing.map((item) => ({ id: item.id, label: storageShortLabel(item.label) })),
    busy: missing.some((item) => measuring.has(item.id)),
  };
};

const storageToolHeadline = (totals) => {
  if (totals.missing.length === 0) {
    return { label: "本程序一共占用", note: "各项都已算好" };
  }
  const names = totals.missing.map((item) => item.label).join("、");
  return {
    label: "本程序至少占用",
    note: totals.busy ? `正在计算，还差 ${totals.missing.length} 项：${names}` : `还有 ${totals.missing.length} 项没算：${names}`,
  };
};

const STORAGE_PENDING_TEXT = {
  manual: "QQ 的文件夹很大，点「计算大小」才算",
  background: "稍后自动计算",
  automatic: "等待计算",
};

const storageMeasurementCell = (item) => {
  const measurement = storageState.measurements.get(item.id);
  const error = storageState.errors.get(item.id);
  if (storageState.measuring.has(item.id)) {
    return el("div", { class: "storage-size measuring" },
      el("strong", {}, "正在计算…"),
      el("span", {}, STORAGE_BIG_IDS.has(item.id) ? "文件很多，可能要一会儿；页面照常能用" : "逐个读取文件大小"));
  }
  if (error !== undefined) {
    return el("div", { class: "storage-size error" },
      el("strong", {}, "计算失败"),
      el("span", { title: error }, error));
  }
  if (measurement === undefined) {
    return el("div", { class: "storage-size pending" },
      el("strong", {}, "未计算"),
      el("span", {}, STORAGE_PENDING_TEXT[item.measurement] ?? STORAGE_PENDING_TEXT.automatic));
  }
  const detail = `${measurement.fileCount.toLocaleString()} 个文件` +
    (measurement.skippedSymlinkCount > 0 ? ` · 跳过 ${measurement.skippedSymlinkCount} 个链接` : "") +
    (measurement.changedPathCount > 0 ? ` · ${measurement.changedPathCount} 项在计算时变化` : "");
  return el("div", { class: "storage-size" },
    el("strong", {}, formatBytes(measurement.bytes)),
    el("span", {}, detail));
};

const storageMeasureCategory = async (category) => {
  if (storageState.measuring.has(category)) {
    return;
  }
  storageState.measuring.add(category);
  storageState.errors.delete(category);
  renderStorageView();
  try {
    const measurement = await api("/api/storage/measure", {
      method: "POST",
      body: JSON.stringify({ category }),
    });
    storageState.measurements.set(category, measurement);
  } catch (error) {
    storageState.errors.set(category, error.message);
  }
  storageState.measuring.delete(category);
  renderStorageView();
};

// One row after another, so the disk is never asked for two big walks at once.
const storageMeasureIds = async (ids, requestId) => {
  for (const id of ids) {
    if (requestId !== storageState.requestId) {
      return;
    }
    await storageMeasureCategory(id);
  }
};

const storageItemIds = (filter) => (storageState.overview?.items ?? []).filter(filter).map((item) => item.id);

// On open: the quick rows every time, then this program's big folders once
// (they keep their size until 「重新计算」). QQ's folders wait for a click.
const storageRefreshAutomatic = async (requestId) => {
  await storageMeasureIds(storageItemIds((item) => item.measurement === "automatic"), requestId);
  await storageMeasureIds(storageItemIds((item) => item.measurement === "background" && !storageState.measurements.has(item.id)), requestId);
};

const storageOpenCategory = async (category) => {
  try {
    await api("/api/storage/open", {
      method: "POST",
      body: JSON.stringify({ category }),
    });
  } catch (error) {
    storageState.notice = { text: error.message, tone: "risk" };
    renderStorageView();
  }
};

// What the second click will delete, said before it happens. bytes: the
// row's measured size, or undefined.
const storageCleanupQuestion = (item, bytes) => {
  const size = bytes === undefined ? "" : `（约 ${formatBytes(bytes)}）`;
  if (item.id === "temporary-files") {
    return `清理全部临时数据库副本${size}？消息库、补扫进度、报告和留存的原图都不受影响；下次扫描可能要重新复制一次数据库。`;
  }
  if (item.id === "run-files") {
    return `删除全部运行产物${size}？历史报告里的图片预览、聊天里嵌的媒体和运行详情可能打不开；消息库和留存的原图不受影响。删了不能恢复。`;
  }
  return `删除全部报告和导出文件${size}？所有报告、导出的媒体和咒语库都会消失，包括存在这里的「另存到文件夹」的图片。删了不能恢复。`;
};

const storageCleanupCategory = async (item) => {
  storageState.confirming = null;
  storageState.notice = { text: `正在清理「${item.label}」…`, tone: "warn" };
  renderStorageView();
  try {
    const result = await api("/api/storage/cleanup", {
      method: "POST",
      body: JSON.stringify({ category: item.cleanupCategory, confirmation: item.cleanupCategory }),
    });
    const diskDelta = result.freeDiskDeltaBytes > 0
      ? `，磁盘可用空间增加 ${formatBytes(result.freeDiskDeltaBytes)}`
      : "";
    const warnings = result.warnings.length > 0 ? `；注意：${result.warnings.join("；")}` : "";
    storageState.notice = {
      text: `已删除 ${formatBytes(result.deletedBytes)}，共 ${result.removedFileCount.toLocaleString()} 个文件${diskDelta}${warnings}`,
      tone: result.warnings.length > 0 ? "warn" : "ok",
    };
    storageState.measurements.clear();
    storageState.errors.clear();
    storageState.overview = await api("/api/storage/overview");
    await loadState();
    renderStorageView();
    await storageRefreshAutomatic(storageState.requestId);
  } catch (error) {
    storageState.notice = { text: error.message, tone: "risk" };
    renderStorageView();
  }
};

const storageSetConfirming = (itemId) => {
  storageState.confirming = itemId;
  renderStorageView();
};

const storageCleanupButton = (item) => {
  if (item.cleanupCategory === null) {
    return null;
  }
  return el("div", { class: "storage-danger" },
    el("button", {
      class: "btn small danger",
      title: item.cleanupAllowed ? item.cleanupImpact : item.cleanupBlockedReason,
      "data-testid": `storage-cleanup-${item.id}`,
      disabled: !item.cleanupAllowed || storageState.confirming === item.id,
      onclick: () => storageSetConfirming(item.id),
    }, item.id === "temporary-files" ? "清理…" : "删除全部…"));
};

const storageActions = (item) => {
  const isMeasured = storageState.measurements.has(item.id);
  const measureButton = el("button", {
    class: "btn small",
    title: item.measurement === "manual" ? "QQ 的文件夹文件很多，可能要几分钟" : "重新读一遍这里的文件大小",
    "data-testid": `storage-measure-${item.id}`,
    disabled: storageState.measuring.has(item.id),
    onclick: () => storageMeasureCategory(item.id),
  }, isMeasured ? "↻ 重新计算" : "↻ 计算大小");
  const openButton = el("button", {
    class: "btn small",
    title: item.openable ? "在文件管理器里打开" : "这个位置现在还不存在",
    "data-testid": `storage-open-${item.id}`,
    disabled: !item.openable,
    onclick: () => storageOpenCategory(item.id),
  }, "打开文件夹");
  return el("div", { class: "storage-actions" }, measureButton, openButton, storageCleanupButton(item));
};

const storageConfirmStrip = (item) => (storageState.confirming !== item.id ? null : el("div", {
  class: "storage-confirm",
  role: "alert",
  "data-testid": `storage-confirm-${item.id}`,
},
el("span", {}, storageCleanupQuestion(item, storageState.measurements.get(item.id)?.bytes)),
el("button", { class: "btn small danger", type: "button", onclick: () => storageCleanupCategory(item) },
  item.id === "temporary-files" ? "确定清理" : "确定删除"),
el("button", { class: "btn small", type: "button", onclick: () => storageSetConfirming(null) }, "不删")));

const storageRow = (item) => el("div", {
  class: "storage-row",
  "data-testid": `storage-row-${item.id}`,
},
el("div", { class: "storage-item" },
  el("strong", {}, item.label),
  el("span", {}, linked(item.description)),
  el("small", {}, linked(item.cleanupImpact))),
el("div", { class: "storage-paths" },
  item.paths.length === 0
    ? el("code", {}, "尚未设置")
    : item.paths.map((itemPath) => el("code", { title: itemPath }, itemPath))),
storageMeasurementCell(item),
el("div", { class: "storage-policy" },
  el("span", { class: `storage-policy-badge ${storagePolicyClass(item.policy)}` }, item.policyLabel),
  item.cleanupBlockedReason !== null && item.cleanupCategory !== null
    ? el("small", {}, item.cleanupBlockedReason)
    : null),
storageActions(item),
storageConfirmStrip(item));

// QQ's total: the whole account folder once it is measured, else its parts.
const storageQqTotal = () => (storageState.measurements.has("qq-account")
  ? { bytes: storageMeasuredBytes(["qq-account"]), note: "整个 QQ 账号文件夹" }
  : { bytes: storageMeasuredBytes(["qq-databases", "qq-media-cache"]), note: storageState.measurements.has("qq-media-cache") ? "聊天数据库 + 媒体缓存（点「全部计算」看整个文件夹）" : "只算了聊天数据库，点「全部计算」看全部" });

const storageToolCell = (overview) => {
  const totals = storageToolTotals(overview.items, storageState.measurements, storageState.measuring);
  const headline = storageToolHeadline(totals);
  return el("div", { class: "storage-summary-cell", "data-testid": "storage-tool-total" },
    el("span", {}, headline.label),
    el("strong", {}, formatBytes(totals.bytes)),
    el("small", {}, headline.note),
    totals.missing.length === 0 || totals.busy
      ? null
      : el("button", {
          class: "btn small storage-summary-action",
          "data-testid": "storage-measure-missing",
          onclick: () => storageMeasureIds(totals.missing.map((item) => item.id), storageState.requestId),
        }, `计算这 ${totals.missing.length} 项`));
};

const storageSummary = (overview) => {
  const qq = storageQqTotal();
  const volumeNodes = overview.volumes.map((volume) =>
    volume.error === null
      ? el("div", { class: "storage-summary-cell" },
          el("span", {}, `${volume.root} 可用空间`),
          el("strong", {}, formatBytes(volume.freeBytes)),
          el("small", {}, `总容量 ${formatBytes(volume.totalBytes)}`))
      : el("div", { class: "storage-summary-cell risk" },
          el("span", {}, `${volume.root || "磁盘"} 状态`),
          el("strong", {}, "无法读取"),
          el("small", { title: volume.error }, volume.error)));
  return el("div", { class: "storage-summary", "data-testid": "storage-summary" },
    storageToolCell(overview),
    el("div", { class: "storage-summary-cell" },
      el("span", {}, "QQ 占用"),
      el("strong", {}, formatBytes(qq.bytes)),
      el("small", {}, qq.note)),
    volumeNodes);
};

const storageSectionNode = (overview, section) => el("section", { class: "storage-section", "aria-labelledby": `storage-section-${section.id}` },
  el("div", { class: "storage-section-head" },
    el("div", {},
      el("h2", { id: `storage-section-${section.id}` }, section.title),
      el("p", {}, section.description))),
  el("div", { class: "storage-table" },
    el("div", { class: "storage-table-head", "aria-hidden": "true" },
      el("span", {}, "数据"),
      el("span", {}, "位置"),
      el("span", {}, "占用"),
      el("span", {}, "能不能删"),
      el("span", {}, "操作")),
    overview.items.filter((item) => item.section === section.id).map(storageRow)));

const storageRemeasureTool = () => {
  const ids = storageItemIds((item) => !STORAGE_QQ_IDS.has(item.id));
  for (const id of ids) {
    storageState.measurements.delete(id);
    storageState.errors.delete(id);
  }
  renderStorageView();
  storageMeasureIds(ids, storageState.requestId);
};

const storageToolbar = () => el("div", { class: "storage-toolbar", "data-testid": "storage-view" },
  el("div", {},
    el("span", {}, "QQ 的文件夹文件多，点「全部计算」或那一行的「计算大小」才算。")),
  el("button", {
    class: "btn small",
    "data-testid": "storage-refresh",
    disabled: storageState.measuring.size > 0,
    onclick: storageRemeasureTool,
  }, "↻ 重新计算本程序占用"),
  el("button", {
    class: "btn small primary",
    "data-testid": "storage-measure-all",
    disabled: storageState.measuring.size > 0,
    title: "逐项计算包括 QQ 文件夹在内的全部占用，可能要几分钟",
    onclick: () => storageMeasureIds(storageItemIds(() => true), storageState.requestId),
  }, "全部计算（含 QQ）"));

const renderStorageView = () => {
  const root = $("#view-storage");
  if (storageState.overview === null) {
    setChildren(root, el("div", { class: "card" }, el("div", { class: "empty" }, "正在读取存储位置…")));
    return;
  }
  const overview = storageState.overview;
  const notice = storageState.notice === null
    ? null
    : el("div", { class: `notice ${storageState.notice.tone}` }, storageState.notice.text);
  setChildren(root,
    storageToolbar(),
    notice,
    storageSummary(overview),
    STORAGE_SECTIONS.map((section) => storageSectionNode(overview, section)));
};

const openStorageView = async () => {
  showView("storage");
  storageState.requestId += 1;
  const requestId = storageState.requestId;
  storageState.notice = null;
  storageState.confirming = null;
  renderStorageView();
  try {
    storageState.overview = await api("/api/storage/overview");
  } catch (error) {
    setChildren($("#view-storage"),
      el("div", { class: "card" }, el("div", { class: "notice risk" }, `读取存储状态失败：${error.message}`)));
    return;
  }
  renderStorageView();
  await storageRefreshAutomatic(requestId);
};
