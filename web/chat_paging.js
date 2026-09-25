"use strict";

/* ---------- chat paging: insert and drop pages without rebuilding ---------- */
// Loaded by index.html right after messages.js. The chat keeps at most
// CHAT_WINDOW messages (messages.js); a page loaded at one end is inserted
// next to its sentinel and as many messages are dropped at the far end, while
// the message the reader is looking at stays where it is on screen.

const chatCountText = () => `${app.msg.items.length} 条${app.msg.hasMore || app.msg.hasOlder ? "+" : ""}`;

const holdsMessages = (node) => node.matches("[data-rowid]") || node.querySelector("[data-rowid]") !== null;

// Removes the nodes of messages the window dropped, walking the top-level
// nodes from one end. Day headers, gaps and the unread divider that only
// introduced dropped messages go with them; a speaker group straddling the
// edge loses just its dropped bubbles. Returns the removed message nodes.
const trimChatDom = (list, droppedIds, fromStart) => {
  const removed = [];
  if (droppedIds.size === 0) {
    return removed;
  }
  const top = list.querySelector(".load-sentinel-top");
  const bottom = list.querySelector(".load-sentinel");
  let pending = [];
  let node = fromStart ? top.nextElementSibling : bottom.previousElementSibling;
  while (node !== null && node !== top && node !== bottom) {
    const next = fromStart ? node.nextElementSibling : node.previousElementSibling;
    if (!holdsMessages(node)) {
      pending.push(node);
      node = next;
      continue;
    }
    const messages = node.matches("[data-rowid]") ? [node] : [...node.querySelectorAll("[data-rowid]")];
    const gone = messages.filter((message) => droppedIds.has(message.dataset.rowid));
    removed.push(...gone);
    if (gone.length < messages.length) {
      for (const message of gone) {
        message.remove();
      }
      const head = node.querySelector(".bg-head time");
      const first = node.querySelector("[data-rowid]");
      if (fromStart && head !== null && first !== null) {
        head.textContent = shortTime(Number(first.dataset.sentat));
      }
      break;
    }
    for (const extra of pending) {
      extra.remove();
    }
    pending = [];
    node.remove();
    node = next;
  }
  // Nodes after the last kept message only introduced dropped ones.
  if (!fromStart) {
    for (const extra of pending) {
      extra.remove();
    }
  }
  return removed;
};

// After dropping from the top, the first message still needs its day header.
const ensureLeadingDay = (list) => {
  const first = app.msg.items[0];
  if (first === undefined) {
    return;
  }
  let after = list.querySelector(".load-sentinel-top");
  for (let node = after.nextElementSibling; node !== null && !holdsMessages(node); node = node.nextElementSibling) {
    if (node.classList.contains("msg-day")) {
      return;
    }
    if (node.id === "unread-divider") {
      after = node;
    }
  }
  after.after(el("div", { class: "msg-day" }, unixToHkt(first.sentAt).slice(0, 10)));
};

// Keeps the message the reader is looking at where it is on screen while
// nodes are inserted or removed around it.
const withScrollAnchor = (list, change) => {
  const listTop = list.getBoundingClientRect().top;
  const anchor = [...list.querySelectorAll("[data-rowid]")].find((node) => node.getBoundingClientRect().bottom > listTop);
  const before = anchor?.getBoundingClientRect().top;
  change();
  if (anchor !== undefined && anchor.isConnected && list.offsetHeight > 0) {
    // Rects are in zoomed pixels (the UI zoom setting), scrollTop is not.
    const scale = list.getBoundingClientRect().height / list.offsetHeight;
    list.scrollTop += (anchor.getBoundingClientRect().top - before) / scale;
  }
};

const observeRead = (nodes) => {
  for (const node of nodes) {
    msgObservers.read?.observe(node);
  }
};

const unobserveRead = (nodes) => {
  for (const node of nodes) {
    msgObservers.read?.unobserve(node);
  }
};

const refreshChatChrome = (list) => {
  const msg = app.msg;
  list.querySelector(".load-sentinel-top").hidden = !(msg.hasOlder && msg.items.length > 0);
  list.querySelector(".load-sentinel").hidden = !msg.hasMore;
  const count = document.querySelector(".chat-count");
  if (count !== null) {
    count.textContent = chatCountText();
  }
};

// Older page at the top, newest dropped at the bottom.
const prependChatPage = (list, { added, dropped }) => {
  const msg = app.msg;
  const top = list.querySelector(".load-sentinel-top");
  const oldFirst = msg.items[added.length];
  const { nodes, messageNodes } = buildChatNodes(added);
  if (nodes.some((node) => node.id === "unread-divider")) {
    list.querySelector("#unread-divider")?.remove();
  }
  // The old first message's leading day header / gap are recomputed here.
  const lastDay = added.length > 0 ? unixToHkt(added.at(-1).sentAt).slice(0, 10) : "";
  let oldHead = top.nextElementSibling;
  while (oldHead !== null && !holdsMessages(oldHead)) {
    const next = oldHead.nextElementSibling;
    if (oldHead.classList.contains("msg-gap") || (oldHead.classList.contains("msg-day") && oldHead.textContent === lastDay)) {
      oldHead.remove();
    }
    oldHead = next;
  }
  top.after(...nodes);
  if (oldHead !== null && oldFirst !== undefined && added.length > 0 && coverageGapBetween(added.at(-1).sentAt, oldFirst.sentAt)) {
    oldHead.before(el("div", { class: "msg-gap" }, "⚠ 这段时间之间可能存在未扫描的消息"));
  }
  unobserveRead(trimChatDom(list, new Set(dropped.map((item) => item.rowId)), false));
  observeRead(messageNodes);
};

// Newer page at the bottom, oldest dropped at the top.
const appendChatPage = (list, { added, dropped }) => {
  const msg = app.msg;
  const bottom = list.querySelector(".load-sentinel");
  const prev = msg.items[msg.items.length - added.length - 1] ?? null;
  const lastTop = bottom.previousElementSibling;
  const openBody = msg.style !== "compact" && lastTop?.classList.contains("bubble-group") ? lastTop.querySelector(".bg-col") : null;
  const dividerPlaced = msg.dividerAt === null
    || list.querySelector("#unread-divider") !== null
    || (prev !== null && prev.sentAt > msg.dividerAt);
  const { nodes, messageNodes } = buildChatNodes(added, { prev, openBody, dividerPlaced });
  bottom.before(...nodes);
  unobserveRead(trimChatDom(list, new Set(dropped.map((item) => item.rowId)), true));
  ensureLeadingDay(list);
  observeRead(messageNodes);
};

// Puts a loaded page into the list it was loaded for. If a full render
// replaced that list meanwhile, render again so the new list has the page.
const applyChatPage = (list, page, where) => {
  if (!list.isConnected) {
    renderMessagesView();
    return;
  }
  if (page.added.length > 0 || page.dropped.length > 0) {
    withScrollAnchor(list, () => (where === "top" ? prependChatPage(list, page) : appendChatPage(list, page)));
  }
  refreshChatChrome(list);
  // Re-observing reports the sentinel's current state, so a page that did
  // not fill the view loads the next one.
  const sentinel = list.querySelector(where === "top" ? ".load-sentinel-top" : ".load-sentinel");
  const observer = where === "top" ? msgObservers.scrollUp : msgObservers.scroll;
  observer?.unobserve(sentinel);
  observer?.observe(sentinel);
};

const setupChatObservers = (listNode) => {
  msgObservers.scroll?.disconnect();
  msgObservers.scrollUp?.disconnect();
  msgObservers.read?.disconnect();

  // Scroll-up loader: after a time-jump or "从上次已读" it reaches the
  // messages older than the window start, and reloads pages the window dropped.
  msgObservers.scrollUp = new IntersectionObserver(async (entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || !app.msg.hasOlder || app.msg.loading) {
      return;
    }
    let page;
    try {
      page = await loadOlderMessages();
    } catch {
      return;
    }
    applyChatPage(listNode, page, "top");
  }, { root: listNode, rootMargin: "200px" });
  msgObservers.scrollUp.observe(listNode.querySelector(".load-sentinel-top"));

  msgObservers.scroll = new IntersectionObserver(async (entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || !app.msg.hasMore || app.msg.loading) {
      return;
    }
    let page;
    try {
      page = await loadMessages(false);
    } catch {
      return;
    }
    applyChatPage(listNode, page, "bottom");
  }, { root: listNode, rootMargin: "200px" });
  msgObservers.scroll.observe(listNode.querySelector(".load-sentinel"));

  msgObservers.read = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const { sentat, rowid } = entry.target.dataset;
        scheduleAutoRead(Number(sentat), rowid ?? "");
      }
    }
  }, { root: listNode, threshold: 0.5 });
  observeRead(listNode.querySelectorAll("[data-sentat]"));
};
