"use strict";

/* ---------- group pictures fetched from Tencent ----------
   Thumbnails in chat, a viewer that fetches a bigger copy when opened,
   the settings card, and the "expiring soon" list on the backup page.
   /picture is a plain <img> URL (no API token). Saving and settings go
   through /api/pictures, which does send the token. */

const PICTURE_MD5 = /^[a-f0-9]{32}$/u;
const PICTURE_BUDGETS = [2, 5, 10, 20, 50, 100];
const KEEP_TEXT = {
  kept: "原图已保存到本机。",
  gone: "腾讯服务器已经删除这张图。",
  "no-rkey": "拿不到 QQ 的图片钥匙，请确认 QQ 正在运行。",
  unavailable: "暂时下载不到这张图。",
  "not-found": "没有这张图的记录。",
};
const RKEY_TEXT = {
  "no-qq": "QQ 没有在运行，开着 QQ 才能拿到图片钥匙。",
  "no-permission": "没有权限读取 QQ 的内存。",
  "no-pictures": "还没有可用来试钥匙的图片记录。",
  "none-found": "QQ 在运行，但没有读到图片钥匙。",
  "none-valid": "读到的钥匙都已失效，过一会儿会再试。",
  "scan-failed": "读取 QQ 内存失败。",
};
const PASS_LABELS = { ok: "成功", plain: "不是 AI 图", gone: "已删除", failed: "失败" };
const PASS_STEPS = { ai: "AI 检查", previews: "AI 预览", keep: "留原图", thumbs: "缩略图" };

const pictureUi = {
  status: null,
  error: null,
  notice: null,
  busy: false,
  expiring: undefined,
  expiringError: null,
  viewer: null,
  poll: null,
};

const pictureUrl = (md5, size = "thumb") =>
  `/picture?md5=${encodeURIComponent(String(md5))}&size=${encodeURIComponent(size)}`;

const formatByteSize = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 ** 3) {
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

const pictureGroupName = (groupId) => {
  const id = String(groupId ?? "");
  const found = [...(app.state?.watchlist ?? []), ...(app.state?.knownGroups ?? [])]
    .find((entry) => String(entry.groupId) === id);
  return found?.name || id;
};

const daysUntilExpiry = (expiresAt) => {
  const unix = Number(expiresAt);
  if (!Number.isFinite(unix) || unix <= 0) {
    return null;
  }
  return Math.max(0, Math.floor((unix - Math.floor(Date.now() / 1000)) / 86400));
};

const rkeySummary = (rkey) => {
  if (rkey?.ready) {
    return "图片钥匙可用。";
  }
  if (rkey?.scanning) {
    return "正在从 QQ 读取图片钥匙…";
  }
  return RKEY_TEXT[rkey?.problem] ?? "还没有图片钥匙。";
};

const passSummary = (pass) => {
  if (pass?.running) {
    return "正在抓取…";
  }
  if (pass?.error) {
    return `上次出错：${pass.error}`;
  }
  const parts = Object.keys(PASS_STEPS).flatMap((label) => {
    const bag = pass?.done?.[label] ?? {};
    const counts = Object.entries(bag)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${PASS_LABELS[key] ?? key} ${count}`);
    return counts.length === 0 ? [] : [`${PASS_STEPS[label]}：${counts.join("、")}`];
  });
  if (parts.length === 0) {
    return pass?.finishedAt ? "上次没有新的图片要抓。" : "还没有抓过。";
  }
  return `上次：${parts.join("，")}`;
};

const loadPictureStatus = async () => {
  try {
    pictureUi.status = await api("/api/pictures/status");
    pictureUi.error = null;
  } catch (error) {
    pictureUi.error = error.message;
  }
};

const loadExpiringPictures = async () => {
  try {
    pictureUi.expiring = await api("/api/pictures/expiring");
    pictureUi.expiringError = null;
  } catch (error) {
    pictureUi.expiringError = error.message;
  }
};

const savePictureSettings = async (patch) => {
  pictureUi.busy = true;
  pictureUi.notice = null;
  try {
    const result = await api("/api/pictures/settings", { method: "POST", body: JSON.stringify(patch) });
    if (pictureUi.status !== null) {
      pictureUi.status = { ...pictureUi.status, settings: result.settings };
    }
    pictureUi.notice = { text: "已保存。", isError: false };
  } catch (error) {
    pictureUi.notice = { text: error.message, isError: true };
  }
  pictureUi.busy = false;
  await loadPictureStatus();
  if (app.view === "settings") {
    renderSettingsView();
  }
};

const schedulePicturePoll = () => {
  clearTimeout(pictureUi.poll);
  if (pictureUi.status?.pass?.running !== true || app.view !== "settings") {
    return;
  }
  pictureUi.poll = setTimeout(async () => {
    await loadPictureStatus();
    if (app.view === "settings") {
      renderSettingsView();
    }
    schedulePicturePoll();
  }, 2000);
};

const runPicturePass = async () => {
  pictureUi.busy = true;
  pictureUi.notice = null;
  try {
    await api("/api/pictures/run", { method: "POST", body: "{}" });
    pictureUi.notice = { text: "已开始抓取。QQ 要开着，NT 图片才拿得到钥匙。", isError: false };
  } catch (error) {
    pictureUi.notice = { text: error.message, isError: true };
  }
  pictureUi.busy = false;
  await loadPictureStatus();
  if (app.view === "settings") {
    renderSettingsView();
  }
  schedulePicturePoll();
};

const keepOnePicture = async (md5) => {
  const result = await api("/api/pictures/keep", { method: "POST", body: JSON.stringify({ md5s: [md5] }) });
  const status = result.results?.[0]?.status ?? "unavailable";
  return { status, text: KEEP_TEXT[status] ?? "没有保存。" };
};

const downloadPictureWorkflow = async (md5) => {
  const response = await fetch(`/api/pictures/workflow?md5=${encodeURIComponent(md5)}`, {
    headers: { "x-cc-token": TOKEN },
  });
  if (!response.ok) {
    let message = "这张图没有保存的工作流。";
    try {
      const payload = await response.json();
      if (typeof payload.error === "string" && payload.error.length > 0) {
        message = payload.error;
      }
    } catch {
      // A non-JSON error body still uses the fallback sentence.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${md5}-workflow.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

/* ---------- viewer ---------- */

const closePictureViewer = () => {
  document.getElementById("picture-viewer")?.remove();
  pictureUi.viewer = null;
};

const pictureViewerActions = (viewer) => {
  const notice = el("p", { class: "card-sub picture-viewer-notice" }, viewer.notice);
  return el("div", { class: "picture-viewer-actions" },
    viewer.size === "original"
      ? null
      : el("button", {
        class: "btn small primary",
        disabled: viewer.gone || viewer.busy,
        onclick: () => {
          pictureUi.viewer = { ...viewer, size: "original", notice: "正在向腾讯取原图…" };
          renderPictureViewer();
        },
      }, "查看原图"),
    viewer.kept
      ? el("span", { class: "tag" }, "原图已留存")
      : el("button", {
        class: "btn small",
        disabled: viewer.gone || viewer.busy,
        onclick: async () => {
          pictureUi.viewer = { ...pictureUi.viewer, busy: true, notice: "正在保存原图…" };
          renderPictureViewer();
          try {
            const kept = await keepOnePicture(viewer.md5);
            pictureUi.viewer = {
              ...pictureUi.viewer,
              busy: false,
              kept: kept.status === "kept",
              notice: kept.text,
            };
          } catch (error) {
            pictureUi.viewer = { ...pictureUi.viewer, busy: false, notice: error.message };
          }
          renderPictureViewer();
        },
      }, "保存原图"),
    viewer.probe === "ai"
      ? el("button", {
        class: "btn small",
        onclick: () => downloadPictureWorkflow(viewer.md5).catch((error) => alert(error.message)),
      }, "下载工作流")
      : null,
    notice);
};

const renderPictureViewer = () => {
  const viewer = pictureUi.viewer;
  document.getElementById("picture-viewer")?.remove();
  if (viewer === null) {
    return;
  }
  const days = daysUntilExpiry(viewer.expiresAt);
  const meta = [
    viewer.width > 0 ? `${viewer.width}×${viewer.height}` : "",
    viewer.bytes > 0 ? formatByteSize(viewer.bytes) : "",
    days === null ? "" : `腾讯还将保留约 ${days} 天`,
  ].filter((part) => part.length > 0).join(" · ");
  const image = viewer.gone
    ? el("div", { class: "picture-viewer-missing" }, "腾讯服务器已经删除这张图。")
    : el("img", {
      src: pictureUrl(viewer.md5, viewer.size),
      alt: "图片",
      onload: () => {
        if (pictureUi.viewer?.notice !== "正在向腾讯取原图…") {
          return;
        }
        pictureUi.viewer = { ...pictureUi.viewer, notice: "" };
        const node = document.querySelector("#picture-viewer .picture-viewer-notice");
        if (node !== null) {
          node.textContent = "";
        }
      },
      onerror: () => {
        pictureUi.viewer = { ...pictureUi.viewer, notice: "这张图暂时打不开。" };
        const node = document.querySelector("#picture-viewer .picture-viewer-notice");
        if (node !== null) {
          node.textContent = pictureUi.viewer.notice;
        }
      },
    });
  document.body.append(el("div", {
    id: "picture-viewer",
    class: "picture-viewer",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        closePictureViewer();
      }
    },
  },
  image,
  el("div", { class: "picture-viewer-side" },
    el("div", { class: "row" },
      el("strong", {}, viewer.probe === "ai" ? "AI 图" : "群图片"),
      el("button", { class: "btn small", onclick: closePictureViewer }, "关闭")),
    meta.length > 0 ? el("p", { class: "card-sub" }, meta) : null,
    el("p", { class: "card-sub" }, viewer.md5),
    pictureViewerActions(viewer))));
};

const openPictureViewer = (picture) => {
  if (!PICTURE_MD5.test(String(picture?.md5 ?? ""))) {
    return;
  }
  pictureUi.viewer = {
    md5: String(picture.md5),
    size: "preview",
    kept: picture.kept === 1 || picture.kept === true,
    probe: picture.probe ?? "",
    width: Number(picture.width) || 0,
    height: Number(picture.height) || 0,
    bytes: Number(picture.size) || 0,
    expiresAt: Number(picture.expiresAt) || 0,
    gone: picture.gone === 1 || picture.gone === true,
    notice: "",
    busy: false,
  };
  renderPictureViewer();
};

/* ---------- settings card ---------- */

const pictureKeepToggle = (group, selected) =>
  el("label", { class: "picture-keep" },
    el("input", {
      type: "checkbox",
      checked: selected,
      disabled: pictureUi.busy,
      onchange: (event) => {
        const current = new Set(pictureUi.status?.settings?.keepAllGroups ?? []);
        if (event.target.checked) {
          current.add(group.groupId);
        } else {
          current.delete(group.groupId);
        }
        savePictureSettings({ keepAllGroups: [...current] });
      },
    }),
    el("span", {}, group.name || group.groupId));

const renderPictureSettingsCard = () => {
  const status = pictureUi.status;
  const notice = el("span", { style: "font-size:13px" });
  if (pictureUi.notice !== null) {
    settingsFeedback(notice, pictureUi.notice.text, pictureUi.notice.isError);
  }
  if (pictureUi.error !== null && status === null) {
    return el("div", { class: "card" },
      el("h2", {}, "群图片"),
      el("div", { class: "notice risk" }, `读取失败：${pictureUi.error}`));
  }
  if (status === null) {
    return el("div", { class: "card" }, el("h2", {}, "群图片"), el("p", { class: "card-sub" }, "正在读取…"));
  }
  const settings = status.settings ?? {};
  const usage = status.usage ?? {};
  const watchlist = app.state?.watchlist ?? [];
  const kept = new Set((settings.keepAllGroups ?? []).map(String));
  return el("div", { class: "card" },
    el("h2", {}, "群图片"),
    el("p", { class: "card-sub" },
      "电脑 QQ 只有在你点开图片时才保存原图。开启后，工具会在腾讯还留着文件的 31 天里自动保存缩略图；你在消息里点开时再取大图。带生成参数的图会记下咒语、参数和完整工作流，并留一张较大的预览（腾讯给的尺寸，最宽 1280px，PNG 每张约 1–3 MB）。原图默认不留，除非点「保存原图」，或在下面勾选「每张都留原图」。空间到上限时，先清普通图的缩略图，再从最旧的 AI 图预览清起；已保存的原图不会被清。"),
    el("p", { class: "card-sub" },
      `缩略图 ${usage.thumbs ?? 0} 张（${formatByteSize(usage.thumbBytes)}） · 预览 ${usage.previews ?? 0} 张（${formatByteSize(usage.previewBytes)}） · 临时原图 ${usage.cached ?? 0} 张 · 已留存原图 ${usage.kept ?? 0} 张（${formatByteSize(usage.keptBytes)}） · 上限 ${settings.budgetGB ?? 10} GB`),
    el("p", { class: "card-sub" },
      `${rkeySummary(status.rkey)} ${passSummary(status.pass)} 还缺缩略图 ${status.pending?.thumbs ?? 0} 张，还没检查是不是 AI 图 ${status.pending?.probes ?? 0} 张，AI 图还缺预览 ${status.pending?.previews ?? 0} 张。今天已下载 ${formatByteSize(status.trafficToday)}。`),
    status.pass?.note === "no-rkey"
      ? el("div", { class: "notice warn" }, "这次没拿到图片钥匙。缩略图里走旧地址的还能下，其余要等 QQ 开着再试。")
      : null,
    el("div", { class: "bg-grid" },
      el("label", { class: "bg-toggle" },
        el("input", {
          type: "checkbox",
          checked: settings.enabled === true,
          disabled: pictureUi.busy,
          onchange: (event) => savePictureSettings({ enabled: event.target.checked }),
        }),
        el("span", {}, el("strong", {}, "自动抓取群图片"), el("small", {}, "每次刷新之后跑一小段")))),
    el("div", { class: "row", style: "margin-top:12px" },
      el("span", { style: "font-size:13px" }, "图片空间上限"),
      el("select", {
        disabled: pictureUi.busy,
        onchange: (event) => savePictureSettings({ budgetGB: Number(event.target.value) }),
      }, (status.budgets ?? PICTURE_BUDGETS).map((gb) =>
        el("option", { value: String(gb), selected: gb === settings.budgetGB }, `${gb} GB`))),
      el("button", {
        class: "btn small",
        disabled: pictureUi.busy || settings.enabled !== true,
        onclick: () => runPicturePass(),
      }, "现在抓取"),
      notice),
    el("p", { class: "card-sub", style: "margin:12px 0 6px" }, "每张都留原图的群（只列关注群）："),
    watchlist.length === 0
      ? el("p", { class: "card-sub" }, "还没有关注群。")
      : el("div", { class: "picture-keeps" }, watchlist.map((group) => pictureKeepToggle(group, kept.has(String(group.groupId))))));
};

/* ---------- backup: AI originals about to disappear ---------- */

const expiringRow = (item) =>
  el("div", { class: "backup-expiring-row" },
    el("button", {
      class: "backup-expiring-thumb",
      title: "打开",
      onclick: () => openPictureViewer({ ...item, probe: "ai" }),
    }, el("img", { src: pictureUrl(item.md5, "thumb"), alt: "", loading: "lazy" })),
    el("div", {},
      el("strong", {}, pictureGroupName(item.groupId)),
      el("p", { class: "card-sub" },
        `${item.daysLeft === 0 ? "今天就会从腾讯删掉" : `大约还剩 ${item.daysLeft} 天`} · ${formatByteSize(item.size)}`)),
    el("button", {
      class: "btn small",
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const kept = await keepOnePicture(item.md5);
          button.textContent = kept.status === "kept" ? "已保存" : kept.text;
          if (kept.status === "kept") {
            await loadExpiringPictures();
            if (app.view === "backup") {
              renderBackupView();
            }
          }
        } catch (error) {
          button.disabled = false;
          button.textContent = error.message;
        }
      },
    }, "保存原图"));

const renderExpiringPictures = () => {
  if (pictureUi.expiringError !== null && pictureUi.expiring === undefined) {
    return el("section", { class: "card" },
      el("h2", {}, "即将过期的 AI 原图"),
      el("div", { class: "notice risk" }, pictureUi.expiringError));
  }
  if (pictureUi.expiring === undefined) {
    return el("section", { class: "card" },
      el("h2", {}, "即将过期的 AI 原图"),
      el("p", { class: "card-sub" }, "正在读取…"));
  }
  const items = pictureUi.expiring.items ?? [];
  return el("section", { class: "card" },
    el("h2", {}, "即将过期的 AI 原图"),
    el("p", { class: "card-sub" },
      "这些图的咒语已经记下，原图还在腾讯服务器上，但没有留在本机。超过 31 天腾讯会删掉，QQ 也找不回来。",
      pictureUi.expiring.soon > 0 ? ` 其中 ${pictureUi.expiring.soon} 张会在 7 天内过期。` : ""),
    items.length === 0
      ? el("p", { class: "card-sub" }, "现在没有待保存的 AI 原图。")
      : el("div", { class: "backup-expiring" }, items.slice(0, 40).map(expiringRow),
        (pictureUi.expiring.total ?? items.length) > 40
          ? el("p", { class: "card-sub" }, `还有 ${(pictureUi.expiring.total ?? items.length) - 40} 张，先保存上面这些。`)
          : null));
};

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pictureUi.viewer !== null) {
    event.stopImmediatePropagation();
    closePictureViewer();
  }
});
