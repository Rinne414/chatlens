"use strict";

/* ---------- 群 → 在聊什么: one topic ----------
   Each AI timeline topic shows when it ran, for how long, how many messages
   and people, and who spoke most (src/topic_stats.js). Clicking it opens the
   topic: the whole summary, everyone who took part, every message of it
   (paged), an AI summary of just this stretch on request, and the way into
   the chat at that moment. The list can read newest first or in order. */

const TOPIC_ORDER_KEY = "cc-group-topic-order";
const TOPIC_PAGE_SIZE = 200;
const TOPIC_SUMMARY_POLL_MS = 1500;
const TOPIC_NAMES_SHOWN = 3;

// rangeIndex: which of the item's stretches the next page reads (a thing of
// 重要的事 can be several stretches of the day).
const groupTopic = { item: null, messages: [], hasMore: false, rangeIndex: 0, loading: false, error: "", summary: null, poll: null };

const topicRanges = (item) => item.ranges ?? [{ startAt: item.stats.startAt, endAt: item.stats.endAt }];

/* --- order --- */

const topicOrder = () => (wallReadPref(TOPIC_ORDER_KEY, "newest") === "oldest" ? "oldest" : "newest");

const setTopicOrder = (order) => {
  wallWritePref(TOPIC_ORDER_KEY, order);
  renderGroupView();
};

// The server sends days and topics newest first.
const orderedTimeline = (timeline) => (topicOrder() === "newest"
  ? timeline
  : [...timeline].reverse().map((day) => ({ ...day, items: [...day.items].reverse() })));

const topicOrderSwitch = () => el("div", { class: "gp-order", role: "group", "aria-label": "话题顺序" },
  [["newest", "最新在上"], ["oldest", "从早到晚"]].map(([order, label]) => el("button", {
    class: `chip ${topicOrder() === order ? "on" : ""}`,
    type: "button",
    "aria-pressed": String(topicOrder() === order),
    onclick: () => setTopicOrder(order),
  }, label)));

/* --- facts line --- */

const topicDuration = (seconds) => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) {
    return "不到 1 分钟";
  }
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分` : ""}`;
};

// From the first to the last message the store has for it; the AI's own
// minutes when none were stored.
const topicSpan = (item) => {
  const stats = item.stats;
  const from = stats.firstAt ?? stats.startAt;
  const to = stats.lastAt ?? stats.endAt - 60;
  const fromText = unixToHkt(from).slice(11, 16);
  const toText = unixToHkt(to).slice(11, 16);
  return { text: fromText === toText ? fromText : `${fromText}–${toText}`, seconds: Math.max(0, to - from) };
};

const topicFacts = (item) => {
  const stats = item.stats;
  if (stats.messages === 0) {
    return "这段没有存下来的消息";
  }
  return [topicDuration(topicSpan(item).seconds), `${stats.messages} 条`, `${stats.people} 人`].join(" · ");
};

const topicWho = (item) => {
  const names = item.stats.speakers.slice(0, TOPIC_NAMES_SHOWN).map((speaker) => speaker.name);
  if (names.length === 0) {
    return null;
  }
  return `${names.join("、")}${item.stats.people > names.length ? ` 等 ${item.stats.people} 人` : ""}`;
};

/* --- the row in the list --- */

const topicRow = (item) => {
  if (item.stats === undefined) {
    return el("div", { class: "gp-topic" },
      el("strong", {}, item.title),
      item.summary ? el("span", { class: "gp-topic-sum" }, item.summary) : null);
  }
  const who = topicWho(item);
  return el("button", {
    class: "gp-topic",
    type: "button",
    title: "看这个话题的全部消息和参与的人",
    onclick: () => openTopicDetail(item),
  },
  el("span", { class: "gp-topic-time" }, topicSpan(item).text),
  el("strong", {}, item.title),
  item.summary ? el("span", { class: "gp-topic-sum" }, item.summary) : null,
  el("span", { class: "gp-topic-facts" }, topicFacts(item), who ? el("span", { class: "gp-topic-who" }, ` · ${who}`) : null));
};

/* --- detail layer --- */

const topicKey = (item) => `${item.stats.startAt}|${item.title}`;

// One page of a stretch, continuing after the last message read from it.
const fetchTopicPage = (range) => {
  const last = groupTopic.messages.at(-1);
  const inRange = last !== undefined && last.sentAt >= range.startAt && last.sentAt < range.endAt;
  const params = new URLSearchParams({
    groupId: app.groupPage.groupId,
    from: String(range.startAt),
    to: String(range.endAt),
    limit: String(TOPIC_PAGE_SIZE),
    ...(inRange ? { afterSentAt: String(last.sentAt), afterRowId: String(last.rowId) } : {}),
  });
  return api(`/api/messages?${params}`);
};

// About one page per click; a stretch read to its end goes on to the next.
const loadTopicMessages = async () => {
  const { item } = groupTopic;
  if (item === null || groupTopic.loading) {
    return;
  }
  groupTopic.loading = true;
  renderTopicLayer();
  const ranges = topicRanges(item);
  try {
    let read = 0;
    let more = true;
    while (more && read < TOPIC_PAGE_SIZE && groupTopic.item === item) {
      const page = await fetchTopicPage(ranges[groupTopic.rangeIndex]);
      if (groupTopic.item !== item) {
        break;
      }
      const seen = new Set(groupTopic.messages.map((message) => message.rowId));
      const fresh = page.messages.filter((message) => !seen.has(message.rowId));
      groupTopic.messages = [...groupTopic.messages, ...fresh];
      read += fresh.length;
      if (page.hasMore !== true && groupTopic.rangeIndex < ranges.length - 1) {
        groupTopic.rangeIndex += 1;
      } else if (page.hasMore !== true) {
        more = false;
      }
    }
    if (groupTopic.item === item) {
      groupTopic.hasMore = more;
      groupTopic.error = "";
    }
  } catch (error) {
    if (groupTopic.item === item) {
      groupTopic.error = error.message;
    }
  }
  // A load for a topic that was closed or replaced leaves the new one alone.
  if (groupTopic.item === item) {
    groupTopic.loading = false;
    renderTopicLayer();
  }
};

const stopTopicSummaryPoll = () => {
  if (groupTopic.poll !== null) {
    clearInterval(groupTopic.poll);
    groupTopic.poll = null;
  }
};

// One AI summary of exactly this stretch, through the same quick summary the
// chat's 选段总结 uses.
const summarizeTopic = async () => {
  const { item } = groupTopic;
  groupTopic.summary = { status: "running" };
  renderTopicLayer();
  try {
    await api("/api/quick-summary", {
      method: "POST",
      body: JSON.stringify({ groupId: app.groupPage.groupId, fromUnix: item.stats.startAt, toUnix: item.stats.endAt - 1 }),
    });
  } catch (error) {
    if (groupTopic.item === item) {
      groupTopic.summary = { status: "failed", error: error.message };
      renderTopicLayer();
    }
    return;
  }
  stopTopicSummaryPoll();
  groupTopic.poll = setInterval(async () => {
    if (groupTopic.item !== item) {
      stopTopicSummaryPoll();
      return;
    }
    try {
      const job = (await api("/api/quick-summary")).job;
      if (job === null || job.status === "running") {
        return;
      }
      stopTopicSummaryPoll();
      groupTopic.summary = job.status === "done" && job.result !== null
        ? { status: "done", result: job.result }
        : { status: "failed", error: job.error ?? "原因未知" };
    } catch (error) {
      stopTopicSummaryPoll();
      groupTopic.summary = { status: "failed", error: error.message };
    }
    renderTopicLayer();
  }, TOPIC_SUMMARY_POLL_MS);
};

const topicSummaryBlock = () => {
  const summary = groupTopic.summary;
  if (summary === null) {
    return el("button", { class: "btn small", type: "button", onclick: summarizeTopic }, "让 AI 详细总结这一段");
  }
  if (summary.status === "running") {
    return el("p", { class: "kb-meta" }, "AI 正在读这一段…（通常 10-30 秒）");
  }
  if (summary.status === "failed") {
    return el("div", {},
      el("p", { class: "setup-note error" }, `总结没成功：${summary.error}`),
      el("button", { class: "btn small", type: "button", onclick: summarizeTopic }, "再试一次"));
  }
  return el("div", { class: "gp-topic-ai" }, el("span", { class: "gp-label" }, "AI 详细总结"), quickSummaryResultNodes(summary.result));
};

const topicPeople = (item) => {
  const counts = new Map();
  for (const message of groupTopic.messages) {
    counts.set(message.speaker || "（未知）", (counts.get(message.speaker || "（未知）") ?? 0) + 1);
  }
  const people = counts.size > 0 && !groupTopic.hasMore
    ? [...counts].sort((left, right) => right[1] - left[1]).map(([name, messages]) => ({ name, messages }))
    : item.stats.speakers;
  return el("div", { class: "gp-topic-people" },
    people.map((person) => el("span", { class: "tag plain" }, `${person.name} ${person.messages}`)),
    groupTopic.hasMore || counts.size === 0
      ? el("span", { class: "kb-meta" }, item.stats.people > people.length ? `等 ${item.stats.people} 人` : "")
      : null);
};

// The stretches a thing of 重要的事 was made from, each with the AI's own words.
const topicParts = (item) => ((item.parts ?? []).length < 2 ? null : el("div", { class: "gp-topic-parts" },
  el("span", { class: "gp-label" }, `由 ${item.parts.length} 段对话合成`),
  el("ol", {}, item.parts.map((part) => el("li", {},
    el("span", { class: "gp-topic-msg-time" }, unixToHkt(part.startAt).slice(11, 16)),
    el("div", {}, el("strong", {}, part.title), part.summary ? el("span", { class: "gp-topic-sum" }, part.summary) : null))))));

const topicMessageRow = (message) => {
  const pictures = Array.isArray(message.pictures) ? message.pictures.filter((picture) => PICTURE_MD5.test(String(picture?.md5 ?? ""))) : [];
  return el("li", { class: "gp-topic-msg" },
    el("span", { class: "gp-topic-msg-time" }, unixToHkt(message.sentAt).slice(11, 16)),
    el("div", {},
      el("strong", {}, message.speaker || "（未知）"),
      message.text ? el("span", { class: "gp-topic-msg-text" }, message.text) : null,
      pictures.length > 0
        ? el("div", { class: "gp-topic-msg-pics" }, pictures.map((picture) => el("button", {
          class: "gp-topic-pic",
          type: "button",
          title: "看大图",
          onclick: () => openPictureViewer(picture),
        }, el("img", { src: pictureUrl(picture.md5), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }))))
        : message.isMedia === 1 && !message.text ? el("span", { class: "kb-meta" }, `[${message.mediaKinds || "媒体"}]`) : null));
};

const topicMessages = () => el("div", { class: "gp-topic-msgs" },
  el("span", { class: "gp-label" }, `这段的消息（${groupTopic.item.stats.messages} 条）`),
  el("ol", {}, groupTopic.messages.map(topicMessageRow)),
  groupTopic.error ? el("p", { class: "setup-note error" }, `读取消息失败：${groupTopic.error}`) : null,
  groupTopic.loading
    ? el("p", { class: "kb-meta" }, "正在读取…")
    : groupTopic.hasMore || groupTopic.error
      ? el("button", { class: "btn small", type: "button", onclick: loadTopicMessages }, groupTopic.error ? "再试一次" : "再读更多")
      : null);

const topicPanel = (item) => el("div", { class: "kb-overlay-panel gp-topic-panel", role: "dialog", "aria-label": item.title },
  el("div", { class: "kb-overlay-head" },
    el("h3", { class: "gp-topic-title" }, item.title),
    el("button", { class: "btn small", type: "button", onclick: dismissTopicDetail }, "关闭")),
  el("p", { class: "kb-meta" }, `${shortDay(unixToHkt(item.stats.startAt).slice(0, 10))} ${topicSpan(item).text} · ${topicFacts(item)}`),
  item.lead ?? null,
  item.summary ? el("p", { class: "gp-topic-full" }, item.summary) : null,
  topicParts(item),
  topicPeople(item),
  el("div", { class: "row" },
    // The quick summary reads one stretch; a thing of several shows its parts instead.
    topicRanges(item).length === 1 ? topicSummaryBlock() : null,
    el("button", {
      class: "btn small",
      type: "button",
      // Not dismissed first: its history.back() would land after the chat
      // opened and bring the page back. Leaving the page closes the layer,
      // and back from the chat opens this topic again.
      onclick: () => openGroupChatAt(item.stats.firstAt ?? item.stats.startAt),
    }, "在聊天里打开")),
  topicMessages());

const renderTopicLayer = () => {
  const old = document.getElementById("gp-topic-layer");
  const scroll = old?.querySelector(".gp-topic-panel")?.scrollTop ?? 0;
  // Esc listens on the layer itself: a redraw (messages arrived, 再读更多)
  // must hand the focus on, or it falls to the page and Esc does nothing.
  const keepsFocus = old === null || old.contains(document.activeElement) || document.activeElement === document.body;
  old?.remove();
  const { item } = groupTopic;
  if (item === null || app.view !== "group") {
    return;
  }
  const layer = el("div", {
    id: "gp-topic-layer",
    class: "kb-overlay view-layer",
    tabindex: "-1",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        dismissTopicDetail();
      }
    },
    onkeydown: (event) => {
      // A picture opened from here is on top: its own Esc closes only it.
      if (event.key === "Escape" && pictureUi.viewer === null) {
        dismissTopicDetail();
      }
    },
  }, topicPanel(item));
  document.body.append(layer);
  layer.querySelector(".gp-topic-panel").scrollTop = scroll;
  if (keepsFocus) {
    layer.focus();
  }
};

const closeTopicDetail = () => {
  stopTopicSummaryPoll();
  groupTopic.item = null;
  groupTopic.messages = [];
  groupTopic.summary = null;
  renderTopicLayer();
};

const dismissTopicDetail = () => dismissOverlay(closeTopicDetail);

const openTopicDetail = (item) => {
  stopTopicSummaryPoll();
  Object.assign(groupTopic, { item, messages: [], hasMore: false, rangeIndex: 0, loading: false, error: "", summary: null });
  renderTopicLayer();
  openOverlayEntry({ kind: "topic", key: topicKey(item) }, closeTopicDetail);
  loadTopicMessages();
};

// Back (or forward) to a topic that was open: found again in the group's
// timeline the page still holds.
const reopenTopicDetail = (key) => {
  const item = (app.groupPage.data?.timeline ?? []).flatMap((day) => day.items).find((entry) => entry.stats !== undefined && topicKey(entry) === key);
  if (item !== undefined) {
    openTopicDetail(item);
  }
};

VIEW_LEAVE_HOOKS.push(() => {
  stopTopicSummaryPoll();
  groupTopic.item = null;
});
