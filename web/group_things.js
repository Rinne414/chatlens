"use strict";

/* ---------- 群 → 在聊什么 → 重要的事 (trial) ----------
   A group's day as a few things worth knowing (src/topic_things.js): a map of
   bubbles sized by weight and coloured by kind on top, the same things
   ranked below with the outcome first, small talk folded. One LLM call makes
   a day's things, only when asked. Clicking a thing opens it like a topic
   (group_topic.js): its parts, the people, every message. */

const TOPIC_MODE_KEY = "cc-group-topic-mode";
const THINGS_POLL_MS = 3000;
const groupThings = { key: "", day: "", data: null, loading: false, error: "", poll: null, showChat: false };

// The trial reads /api/group/things, which the phone (手机连线) may not.
const topicMode = () => (!ccRemote && wallReadPref(TOPIC_MODE_KEY, "time") === "things" ? "things" : "time");

const setTopicMode = (mode) => {
  stopThingsPoll();
  // A fresh look-up when coming back, so a finished job shows.
  groupThings.key = "";
  wallWritePref(TOPIC_MODE_KEY, mode);
  renderGroupView();
};

const topicModeSwitch = () => el("div", { class: "gp-order desktop-action", role: "group", "aria-label": "怎么看" },
  [["time", "按时间"], ["things", "重要的事（试用）"]].map(([mode, label]) => el("button", {
    class: `chip ${topicMode() === mode ? "on" : ""}`,
    type: "button",
    "aria-pressed": String(topicMode() === mode),
    onclick: () => setTopicMode(mode),
  }, label)));

/* --- loading --- */

const stopThingsPoll = () => {
  if (groupThings.poll !== null) {
    clearTimeout(groupThings.poll);
    groupThings.poll = null;
  }
};

const loadThings = async (day) => {
  const groupId = app.groupPage.groupId;
  const key = `${groupId}|${day}`;
  groupThings.key = key;
  groupThings.day = day;
  groupThings.loading = true;
  stopThingsPoll();
  try {
    const data = await api(`/api/group/things?${new URLSearchParams({ groupId, day })}`);
    if (groupThings.key === key) {
      groupThings.data = data;
      groupThings.error = "";
      if (data.job?.status === "running" && topicMode() === "things") {
        groupThings.poll = setTimeout(() => loadThings(day), THINGS_POLL_MS);
      }
    }
  } catch (error) {
    groupThings.error = error.message;
  }
  groupThings.loading = false;
  if (app.view === "group" && groupThings.key === key && topicMode() === "things") {
    renderGroupView();
  }
};

const makeThings = async () => {
  try {
    await api("/api/group/things", { method: "POST", body: JSON.stringify({ groupId: app.groupPage.groupId, day: groupThings.day }) });
  } catch (error) {
    groupThings.error = error.message;
    renderGroupView();
    return;
  }
  loadThings(groupThings.day);
};

const thingId = (thing) => `${thing.firstAt}|${thing.title}`;

const bubbleMap = (things) => thingMap(things, {
  idOf: thingId,
  factsOf: (thing) => `${thing.messages} 条 · ${thing.people} 人`,
  onOpen: (thing) => openThing(thing),
  caption: "这一天的事，越大越重要",
  weightNote: "越大越重要：参与的人、消息、时长和你关注的词都算",
});

/* --- the ranked list --- */

const thingTime = (thing) => {
  const from = unixToHkt(thing.firstAt).slice(11, 16);
  const to = unixToHkt(thing.lastAt).slice(11, 16);
  return from === to ? from : `${from}–${to}`;
};

const thingFacts = (thing) => [
  `${thing.messages} 条`,
  `${thing.people} 人`,
  thing.parts.length > 1 ? `${thing.parts.length} 段` : null,
  thingTime(thing),
].filter(Boolean).join(" · ");

const thingRow = (thing) => el("button", {
  class: `thing-row thing-${thing.kind}`,
  type: "button",
  ...thingHoverProps(thingId(thing)),
  onclick: () => openThing(thing),
},
el("span", { class: "thing-row-head" },
  el("span", { class: "thing-kind" }, THING_KINDS[thing.kind].label),
  el("strong", {}, thing.title),
  thingStatus(thing)),
thing.takeaway ? el("span", { class: "thing-takeaway" }, thing.takeaway) : null,
el("span", { class: "gp-topic-facts" }, thingFacts(thing),
  thing.watched.length > 0 ? el("span", { class: "thing-watched" }, ` · 关注的词：${thing.watched.join("、")}`) : null));

const thingList = (things) => {
  const worth = things.filter((thing) => thing.kind !== "chat");
  const chat = things.filter((thing) => thing.kind === "chat");
  const chatMessages = chat.reduce((total, thing) => total + thing.messages, 0);
  return el("div", { class: "thing-list" },
    worth.map(thingRow),
    chat.length === 0 ? null : el("button", {
      class: "kb-facet-more",
      type: "button",
      onclick: () => {
        groupThings.showChat = !groupThings.showChat;
        renderGroupView();
      },
    }, groupThings.showChat ? "收起闲聊" : `还有闲聊 ${chat.length} 项（${chatMessages} 条）`),
    groupThings.showChat ? chat.map(thingRow) : null);
};

const openThing = (thing) => openTopicDetail({
  title: thing.title,
  summary: "",
  lead: el("p", { class: "thing-lead" }, el("span", { class: `thing-kind thing-${thing.kind}` }, THING_KINDS[thing.kind].label), " ", thing.takeaway, " ", thingStatus(thing)),
  ranges: thing.ranges,
  parts: thing.parts,
  stats: {
    startAt: thing.ranges[0].startAt,
    endAt: thing.ranges.at(-1).endAt,
    firstAt: thing.firstAt,
    lastAt: thing.lastAt,
    messages: thing.messages,
    people: thing.people,
    speakers: thing.speakers,
  },
});

/* --- the section --- */

const thingDays = (timeline) => timeline.map((day) => day.day);

const thingsBody = () => {
  const data = groupThings.data;
  if (groupThings.error) {
    return el("div", {},
      el("p", { class: "setup-note error" }, groupThings.error),
      el("button", { class: "btn small", type: "button", onclick: () => loadThings(groupThings.day) }, "再试一次"));
  }
  if (data === null || groupThings.loading && data.day !== groupThings.day) {
    return el("p", { class: "kb-meta" }, "正在读取…");
  }
  if (data.job?.status === "running") {
    return el("p", { class: "kb-meta" }, `AI 正在把这天的 ${data.topicCount} 段对话整理成几件事，通常一两分钟…`);
  }
  if (data.things === null) {
    return el("div", { class: "thing-empty" },
      data.job?.status === "failed" ? el("p", { class: "setup-note error" }, `上次没整理成：${data.job.error}`) : null,
      el("p", {}, `这天有 ${data.topicCount} 段对话。整理后会合成几件值得知道的事，按重要程度排好，闲聊折起来。`),
      el("button", { class: "btn small primary", type: "button", disabled: data.topicCount === 0, onclick: makeThings }, "整理这一天"),
      el("p", { class: "kb-meta" }, "会调用一次你设置的 AI 服务（读这天各段的标题和摘要，不读原始消息）。"));
  }
  const failed = data.job?.status === "failed" ? el("p", { class: "setup-note error" }, `重新整理没成功，下面还是上次的结果：${data.job.error}`) : null;
  const changed = data.unsorted > 0 || data.lost > 0;
  return el("div", {},
    failed,
    bubbleMap(data.things),
    thingList(data.things),
    el("p", { class: "kb-meta thing-foot" },
      `由 ${data.madeFromTopics} 段对话整理 · ${data.model}`,
      changed ? ` · 之后这天有 ${data.unsorted} 段还没整理进来${data.lost > 0 ? `、${data.lost} 段已被改写` : ""} ` : " ",
      el("button", { class: "linklike", type: "button", onclick: makeThings }, changed ? "重新整理" : "重新整理这天")));
};

const thingsSection = (timeline) => {
  const days = thingDays(timeline);
  const key = `${app.groupPage.groupId}|${groupThings.day}`;
  if (!days.includes(groupThings.day) || groupThings.key !== key) {
    const day = days.includes(groupThings.day) ? groupThings.day : days[0];
    groupThings.data = null;
    groupThings.showChat = false;
    queueMicrotask(() => loadThings(day));
    groupThings.day = day;
    groupThings.key = `${app.groupPage.groupId}|${day}`;
  }
  return el("div", { class: "thing-section" },
    el("div", { class: "thing-days", role: "group", "aria-label": "哪一天" },
      days.map((day) => el("button", {
        class: `chip ${groupThings.day === day ? "on" : ""}`,
        type: "button",
        onclick: () => {
          groupThings.data = null;
          groupThings.showChat = false;
          loadThings(day);
          renderGroupView();
        },
      }, shortDay(day)))),
    thingsBody());
};

VIEW_LEAVE_HOOKS.push(stopThingsPoll);
