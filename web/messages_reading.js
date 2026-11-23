"use strict";

/* ---------- 消息: following a conversation ----------
   What a reply quotes (shown above it, and a click goes to the original), one
   person's messages only, and stepping through the messages that @ you or
   reply to you. A jump away from where you were reading leaves a way back. */

const READING_FLASH_MS = 1600;
// A jump loads from a little before its target: far enough back for context,
// near enough that the target is on the first page even in a busy group.
const READING_LEAD_SECONDS = 120;

const chatReading = {
  // { uin, name }: only this person's messages are shown.
  speaker: null,
  // [{ rowId, sentAt }] oldest first, and how many days they cover; null until loaded.
  mentions: null,
  mentionDays: 0,
  // Where the reader was before a jump: { rowId, sentAt, speaker, q, mediaOnly }.
  back: null,
};

const resetChatReading = () => {
  Object.assign(chatReading, { speaker: null, mentions: null, mentionDays: 0, back: null });
};

// True while what is on screen is not the reader's own place in the chat.
const chatReadingHoldsReadMark = () => chatReading.back !== null || chatReading.speaker !== null;

/* ---------- going to one message ---------- */

const chatNodeOf = (rowId) => [...document.querySelectorAll(".chat-scroll [data-rowid]")].find((node) => node.dataset.rowid === rowId) ?? null;

const flashChatNode = (node) => {
  node.classList.add("msg-origin-hit");
  node.scrollIntoView({ block: "center" });
  setTimeout(() => node.classList.remove("msg-origin-hit"), READING_FLASH_MS);
};

// The message at the top of what is on screen: where "next" and "previous" count from.
const chatReadingAnchor = () => {
  const list = document.querySelector(".chat-scroll");
  if (list === null) {
    return null;
  }
  const top = list.getBoundingClientRect().top;
  const node = [...list.querySelectorAll("[data-rowid]")].find((item) => item.getBoundingClientRect().bottom > top + 4) ?? null;
  return node === null ? null : { rowId: node.dataset.rowid, sentAt: Number(node.dataset.sentat) };
};

// Shows one message: scrolls to it when it is loaded, otherwise loads the
// stretch around it. Filters that would hide it are taken off. remember: keep
// the place left behind so 「回到刚才的位置」 can return to it.
const goToChatMessage = async (target, { remember = true } = {}) => {
  const msg = app.msg;
  const filtered = chatReading.speaker !== null || msg.mediaOnly || msg.q.trim() !== "";
  // Several jumps in a row keep the first place: that is where the reading stopped.
  if (remember && chatReading.back === null) {
    const anchor = chatReadingAnchor();
    chatReading.back = anchor === null ? null : { ...anchor, speaker: chatReading.speaker, q: msg.q, mediaOnly: msg.mediaOnly };
  }
  const loaded = filtered ? null : chatNodeOf(target.rowId);
  if (loaded !== null) {
    flashChatNode(loaded);
    renderChatReadingBar();
    return;
  }
  chatReading.speaker = null;
  msg.mediaOnly = false;
  msg.q = "";
  msg.rangeKey = "jump";
  msg.from = target.sentAt - READING_LEAD_SECONDS;
  msg.to = null;
  msg.items = [];
  msg.selA = null;
  msg.selB = null;
  msg.hasOlder = true;
  msg.scrollToTime = target.sentAt;
  msg.scrollToRowIds = [target.rowId];
  renderMessagesView();
  try {
    await loadMessages(true);
  } catch (error) {
    notifyError(error);
  }
  renderMessagesView();
};

const goBackInChat = async () => {
  const back = chatReading.back;
  if (back === null) {
    return;
  }
  chatReading.back = null;
  const msg = app.msg;
  chatReading.speaker = back.speaker;
  msg.mediaOnly = back.mediaOnly;
  msg.q = back.q;
  msg.rangeKey = "jump";
  msg.from = back.sentAt - READING_LEAD_SECONDS;
  msg.to = null;
  msg.items = [];
  msg.hasOlder = true;
  msg.scrollToTime = back.sentAt;
  msg.scrollToRowIds = [back.rowId];
  renderMessagesView();
  try {
    await loadMessages(true);
  } catch (error) {
    notifyError(error);
  }
  renderMessagesView();
};

/* ---------- what a reply quotes ---------- */

// Above a reply: who and what it answers. A click goes to that message.
const replyQuoteNode = (item) => {
  if (!item.isReply) {
    return null;
  }
  const quoted = item.replyTo;
  if (!quoted) {
    return el("span", { class: "reply-quote lost", title: "被回复的那条在这里找不到：多半是一张图，或者是很早以前的消息" }, "回复了一条消息");
  }
  return el("button", {
    class: "reply-quote",
    type: "button",
    title: `回复的是 ${unixToHkt(quoted.sentAt).slice(5, 16)} 的这条，点一下去看`,
    onclick: (event) => {
      event.stopPropagation();
      goToChatMessage({ rowId: quoted.rowId, sentAt: quoted.sentAt });
    },
  },
  el("strong", {}, quoted.speaker || "有人"),
  el("span", {}, quoted.isMedia === 1 ? mediaLabelText("", quoted.text) : quoted.text.replace(/�/gu, "")));
};

/* ---------- one person's messages ---------- */

const setChatSpeaker = async (speaker) => {
  const msg = app.msg;
  // Stay around the time being read, as far as the new list has it.
  const anchor = chatReadingAnchor();
  chatReading.speaker = speaker;
  msg.items = [];
  msg.selA = null;
  msg.selB = null;
  msg.scrollToTime = anchor?.sentAt ?? null;
  renderMessagesView();
  try {
    await loadMessages(true);
  } catch (error) {
    notifyError(error);
  }
  renderMessagesView();
};

// A speaker's name in the chat: a click shows only that person's messages.
const chatSpeakerName = (item, className) => {
  // Only for a real QQ number: some rows carry none (or "0"), and a filter
  // by that would match nothing the server can tell apart.
  if (!/^\d{5,}$/u.test(String(item.speakerUin ?? ""))) {
    return el("span", { class: className }, item.speaker);
  }
  const only = chatReading.speaker?.uin === item.speakerUin;
  return el("button", {
    class: `${className} chat-speaker-button`,
    type: "button",
    title: only ? "现在只显示这个人的消息；再点一下看所有人" : "只看这个人的消息",
    onclick: (event) => {
      event.stopPropagation();
      setChatSpeaker(only ? null : { uin: item.speakerUin, name: item.speaker });
    },
  }, item.speaker);
};

const chatSpeakerChip = () => {
  const speaker = chatReading.speaker;
  if (speaker === null) {
    return null;
  }
  return el("span", { class: "chat-speaker-chip" },
    `只看 ${speaker.name || speaker.uin} 的消息`,
    el("button", { type: "button", "aria-label": "看所有人的消息", title: "看所有人的消息", onclick: () => setChatSpeaker(null) }, "×"));
};

/* ---------- 上一条 / 下一条 @你 ---------- */

const loadChatMentions = async () => {
  const groupId = app.msg.groupId;
  if (groupId === null) {
    return;
  }
  chatReading.mentions = null;
  try {
    const answer = await api(`/api/messages/mentions?groupId=${groupId}`);
    if (app.msg.groupId !== groupId) {
      return;
    }
    chatReading.mentions = answer.mentions;
    chatReading.mentionDays = answer.days;
  } catch {
    if (app.msg.groupId !== groupId) {
      return;
    }
    // The chat reads the same without the two buttons.
    chatReading.mentions = [];
  }
  renderChatMentionNav();
};

// direction: -1 the one before what is on screen, 1 the one after.
const stepChatMention = (direction) => {
  const mentions = chatReading.mentions ?? [];
  const anchor = chatReadingAnchor();
  if (mentions.length === 0) {
    return;
  }
  const at = anchor?.sentAt ?? (direction === 1 ? 0 : Number.MAX_SAFE_INTEGER);
  // What is on screen now does not count as "next": step past the visible stretch.
  const list = document.querySelector(".chat-scroll");
  const visible = new Set(list === null ? [] : [...list.querySelectorAll("[data-rowid]")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      return box.bottom > frame.top && box.top < frame.bottom;
    })
    .map((node) => node.dataset.rowid));
  const target = direction === 1
    ? mentions.find((item) => item.sentAt >= at && !visible.has(item.rowId))
    : [...mentions].reverse().find((item) => item.sentAt <= at && !visible.has(item.rowId));
  if (target === undefined) {
    notify(direction === 1 ? "后面没有 @你 的消息了。" : "前面没有 @你 的消息了。");
    return;
  }
  goToChatMessage(target);
};

const chatMentionNavNodes = () => {
  const mentions = chatReading.mentions;
  if (mentions === null || mentions.length === 0) {
    return [];
  }
  const title = `近 ${chatReading.mentionDays} 天里这个群有 ${briefNumber(mentions.length)} 条 @你 或回复你的消息`;
  return [
    el("span", { class: "chat-mention-count", title }, `@你 ${briefNumber(mentions.length)}`),
    el("button", { class: "btn small", type: "button", title: "上一条 @你 或回复你的消息", "aria-label": "上一条 @你 的消息", onclick: () => stepChatMention(-1) }, "↑"),
    el("button", { class: "btn small", type: "button", title: "下一条 @你 或回复你的消息", "aria-label": "下一条 @你 的消息", onclick: () => stepChatMention(1) }, "↓"),
  ];
};

const chatMentionNav = () => el("span", { id: "chat-mention-nav", class: "chat-mention-nav" }, chatMentionNavNodes());

const renderChatMentionNav = () => {
  const node = document.getElementById("chat-mention-nav");
  if (node !== null) {
    setChildren(node, chatMentionNavNodes());
  }
};

/* ---------- the way back after a jump ---------- */

const chatReadingBarNodes = () => (chatReading.back === null
  ? []
  : [
    el("button", { class: "btn small primary", type: "button", onclick: goBackInChat }, "↩ 回到刚才的位置"),
    el("button", { class: "btn small", type: "button", "aria-label": "不用回去了", title: "不用回去了", onclick: () => { chatReading.back = null; renderChatReadingBar(); } }, "×"),
  ]);

const chatReadingBar = () => el("div", { id: "chat-reading-bar", class: "chat-reading-bar" }, chatReadingBarNodes());

const renderChatReadingBar = () => {
  const node = document.getElementById("chat-reading-bar");
  if (node !== null) {
    setChildren(node, chatReadingBarNodes());
  }
};
