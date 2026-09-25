"use strict";

/* ---------- left rail: followed groups + background status ----------
   The rail used to hold only the page list. Now it answers "anything new,
   anything for me?" from every page: each followed group with its unread
   count and a mark when someone @-ed or replied to you (click to open that
   group's page), and a small status card for the background work. */

const RAIL_POLL_MS = 60 * 1000;
const RAIL_GROUP_KEY = "cc-rail-groups-open";

const railState = { data: null, error: null, started: false, groupsOpen: wallReadPref(RAIL_GROUP_KEY, "1") !== "0" };

const railAgo = (unix) => {
  if (!Number.isFinite(unix) || unix <= 0) {
    return "";
  }
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
};

const railUnreadText = (count) => (count > 99 ? "99+" : String(count));

const railGroupRow = (group, cap) =>
  el("button", {
    class: `rail-group ${app.view === "group" && app.groupPage?.groupId === group.groupId ? "active" : ""}`,
    type: "button",
    title: `${group.name}${group.mentions > 0 ? `（有 ${group.mentions} 条 @你 或回复你）` : ""}`,
    onclick: () => openGroupView(group.groupId),
  },
  avatarEl(group.name, group.groupId, "sm", groupAvatarUrl(group.groupId)),
  el("span", { class: "rail-group-name" }, group.name),
  group.mentions > 0 ? el("span", { class: "rail-at", "aria-label": `${group.mentions} 条 @你` }, "@") : null,
  group.unread > 0 ? el("span", { class: "rail-unread", title: `${group.unread >= cap ? `${cap}+` : group.unread} 条本工具还没看过` }, railUnreadText(group.unread)) : null);

const renderRailGroups = () => {
  const node = $("#rail-groups");
  if (node === null) {
    return;
  }
  const groups = railState.data?.groups ?? [];
  if (groups.length === 0) {
    setChildren(node);
    return;
  }
  setChildren(node,
    el("button", {
      class: "rail-section-head",
      type: "button",
      "aria-expanded": String(railState.groupsOpen),
      onclick: () => {
        railState.groupsOpen = !railState.groupsOpen;
        wallWritePref(RAIL_GROUP_KEY, railState.groupsOpen ? "1" : "0");
        renderRailGroups();
      },
    }, el("span", {}, "关注的群"), el("span", { class: "rail-caret" }, railState.groupsOpen ? "▾" : "▸")),
    railState.groupsOpen
      ? el("div", { class: "rail-group-list" }, groups.map((group) => railGroupRow(group, railState.data.maxCounted)))
      : null);
};

const railBackgroundLine = (data) => {
  const background = data.background;
  if (data.pause?.paused) {
    return { tone: "paused", text: "AI 总结已暂停" };
  }
  if (!background.enabled) {
    return { tone: "paused", text: "后台刷新已关闭" };
  }
  if (background.running) {
    return { tone: "running", text: "正在更新…" };
  }
  if (background.lastError) {
    return { tone: "error", text: `上次更新出错（${railAgo(background.lastFinishedAt)}）` };
  }
  return { tone: "ok", text: background.lastFinishedAt ? `${railAgo(background.lastFinishedAt)}更新` : "还没更新过" };
};

const renderRailStatus = () => {
  const node = $("#rail-status");
  if (node === null) {
    return;
  }
  const data = railState.data;
  if (data === null) {
    setChildren(node, railState.error ? el("p", { class: "rail-status-line error" }, "状态读取失败") : null);
    return;
  }
  const line = railBackgroundLine(data);
  setChildren(node,
    el("button", {
      class: `rail-status-line ${line.tone}`,
      type: "button",
      title: "后台刷新与通知设置",
      onclick: () => openView("settings"),
    }, el("span", { class: "rail-dot" }), line.text),
    el("p", { class: "rail-today" },
      `今天 ${briefNumber(data.today.messages)} 条消息 · ${briefNumber(data.today.pictures)} 张图`,
      data.today.aiPictures > 0 ? `（${briefNumber(data.today.aiPictures)} 张 AI）` : ""),
    data.expiringSoon > 0
      ? el("button", {
        class: "rail-expiring",
        type: "button",
        title: "这些 AI 图的原图还没存到电脑，腾讯过期后就找不回来",
        onclick: () => openView("backup"),
      }, `${briefNumber(data.expiringSoon)} 张 AI 原图快过期`)
      : null);
};

const renderRail = () => {
  renderRailGroups();
  renderRailStatus();
};

const loadRail = async () => {
  if (document.visibilityState !== "hidden") {
    try {
      const data = await api("/api/rail");
      // An older server (or a failed upgrade) answers without these; the rail
      // then stays quiet instead of throwing on every poll.
      if (!Array.isArray(data?.groups) || typeof data.background !== "object" || typeof data.today !== "object") {
        throw new Error("状态格式不对");
      }
      railState.data = data;
      railState.error = null;
    } catch (error) {
      railState.data = null;
      railState.error = error.message;
    }
    renderRail();
  }
};

// Called once at boot; hidden tabs skip the poll (see loadRail).
const startRail = () => {
  loadRail();
  if (!railState.started) {
    railState.started = true;
    setInterval(loadRail, RAIL_POLL_MS);
  }
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadRail();
  }
});
