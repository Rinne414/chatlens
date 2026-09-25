"use strict";

/* ---------- 消息: what the plain QQ-style list and chat do not show ----------
   The group list's topics and "new for you" filters, the marks on messages
   addressed to you or asking something, and the chat's side panel with the
   group's AI summary for the stretch being read. */


// Marks in the chat: a message addressed to you (an @ or a reply to one of
// your messages), or a question someone asked. A question is only a hint -- a
// line of some length ending in a question mark.
const QUESTION_END = /[?？]\s*$/u;
const MIN_QUESTION_CHARS = 6;

const addressedToMe = (item) => {
  const mine = app.msg.selfUins;
  if (item.isSelf === 1 || mine.length === 0) {
    return false;
  }
  return String(item.atUins ?? "").split(",").some((uin) => mine.includes(uin)) || mine.includes(item.replyToUin);
};

const looksLikeQuestion = (item) =>
  item.isMedia !== 1 && item.isSelf !== 1 && item.text.length >= MIN_QUESTION_CHARS && QUESTION_END.test(item.text);

const markClasses = (item) => [addressedToMe(item) ? "to-me" : null, looksLikeQuestion(item) ? "question" : null].filter(Boolean);

// Filters on what is new since your read mark (see /api/inbox-extras).
const INBOX_FILTERS = [
  ["all", "全部", () => true],
  ["mentions", "有人 @我", (extra) => extra.mentions > 0],
  ["ai", "有新 AI 图", (extra) => extra.newAi > 0],
  ["qa", "有问答", (extra) => extra.qa > 0],
];

const loadInboxExtras = async () => {
  const groupIds = (app.msg.overview?.groups ?? []).map((group) => group.groupId);
  if (groupIds.length === 0) {
    return;
  }
  try {
    app.msg.extras = await api(`/api/inbox-extras?groupIds=${groupIds.join(",")}`);
  } catch {
    // The list works without the extras; it just shows less.
    app.msg.extras = null;
  }
  if (app.view === "messages" && app.msg.mode === "inbox") {
    renderInbox();
  }
};

const inboxBadges = (extra) => [
  extra.mentions > 0 ? el("span", { class: "inbox-flag at", title: "有人 @你 或回复你" }, `@你 ${extra.mentions}`) : null,
  extra.newAi > 0 ? el("span", { class: "inbox-flag ai", title: "上次看过之后的新 AI 图" }, `AI 图 ${extra.newAi}`) : null,
];

/* ---------- side panel: the group's AI summary for this stretch ---------- */

const PANEL_MIN_SECONDS = 24 * 3600;

const toggleMediaOnly = async () => {
  const msg = app.msg;
  msg.mediaOnly = !msg.mediaOnly;
  msg.items = [];
  msg.selA = null;
  msg.selB = null;
  renderMessagesView();
  try {
    await loadMessages(true);
  } catch (error) {
    alert(error.message);
  }
  renderMessagesView();
};

const loadChatPanel = async () => {
  const msg = app.msg;
  const groupId = msg.groupId;
  const first = msg.items[0]?.sentAt ?? msg.from ?? nowUnix() - PANEL_MIN_SECONDS;
  const params = new URLSearchParams({
    groupId,
    fromUnix: String(Math.min(first, nowUnix() - PANEL_MIN_SECONDS)),
    toUnix: String(nowUnix() + 60),
  });
  try {
    const result = await api(`/api/group/timeline?${params}`);
    if (app.msg.groupId === groupId) {
      msg.panelItems = result.items;
    }
  } catch {
    msg.panelItems = [];
  }
  renderChatPanel();
};

const toggleChatPanel = () => {
  const msg = app.msg;
  msg.panel = !msg.panel;
  try {
    localStorage.setItem("cc-msg-panel", msg.panel ? "1" : "0");
  } catch {
    // The choice still applies to this session.
  }
  renderMessagesView();
  if (msg.panel && msg.panelItems === null) {
    loadChatPanel();
  }
};

// Scrolls to a loaded message, or reloads the chat around that time.
const scrollChatTo = (unix) => {
  const list = document.querySelector(".chat-scroll");
  const firstLoaded = app.msg.items[0]?.sentAt ?? Infinity;
  const hit = list === null || unix < firstLoaded
    ? undefined
    : [...list.querySelectorAll("[data-sentat]")].find((node) => Number(node.dataset.sentat) >= unix);
  if (hit === undefined) {
    jumpToTime(unixToHkt(unix).slice(0, 16));
    return;
  }
  hit.scrollIntoView({ block: "start" });
  hit.classList.add("msg-origin-hit");
};

const chatPanelBody = () => {
  const items = app.msg.panelItems;
  return [
    el("h3", {}, "本群摘要"),
    el("p", { class: "card-sub" }, "AI 总结的一段段对话，点一条跳过去。"),
    items === null
      ? el("p", { class: "kb-meta" }, "正在读取…")
      : items.length === 0
        ? el("p", { class: "kb-meta" }, "这段时间还没有 AI 总结。")
        : el("ol", { class: "chat-panel-list" }, items.map((item) => el("li", {},
          el("button", { type: "button", onclick: () => scrollChatTo(item.startAt) },
            el("time", {}, unixToHkt(item.startAt).slice(5, 16)),
            el("strong", {}, item.title),
            item.summary ? el("span", {}, item.summary) : null)))),
  ];
};

const renderChatPanel = () => {
  const node = document.getElementById("chat-panel");
  if (node !== null) {
    setChildren(node, chatPanelBody());
  }
};
