"use strict";

/* ---------- 简报 → 值得知道的事 ----------
   The window's hot topics of every followed group, merged into things worth
   knowing (src/brief_things.js): a bubble map of the ones that carry the
   weight, then the same ranked with the outcome first. The long tail and
   small talk are folded, never dropped. A thing opens to what each group
   said about it, with the way into that group's chat. The old per-section
   lists (新东西 / 问答 / 大家在聊) stay one click away under 全部明细. */

const BRIEF_THINGS_POLL_MS = 5000;
// The map and the open list carry the things that hold this share of the
// total weight; everything lighter is one "其他" bubble and a folded list.
const BRIEF_HEAD_WEIGHT_SHARE = 0.6;
const BRIEF_HEAD_MIN = 6;
const BRIEF_DETAIL_KEY = "cc-brief-details-open";
const BRIEF_GROUPS_SHOWN = 3;
const BRIEF_AUTO_REASONS = {
  "no-ai": "还没有设置 AI 服务",
  "auto-off": "设置里关了 AI 自动总结",
  paused: "AI 整理暂停中",
  "money-budget": "今天的 AI 预算用完了",
};

// again: a load was asked for while one ran (重新整理 just started a merge).
const briefThings = { data: null, error: "", loading: false, again: false, poll: null, stamp: "", showTail: false, showChat: false };

const briefThingId = (thing) => `b|${thing.key}`;

/* --- loading --- */

const stopBriefThingsPoll = () => {
  if (briefThings.poll !== null) {
    clearTimeout(briefThings.poll);
    briefThings.poll = null;
  }
};

// What the section shows: a poll that changes none of it draws nothing (a
// merge polls every 5 s for minutes; each redraw could eat a click).
const briefThingsShown = () => JSON.stringify([briefThings.error, briefThings.data?.job?.status ?? null, briefThings.data?.job?.error ?? null,
  briefThings.data?.createdAt ?? null, briefThings.data?.unsorted ?? null, briefThings.data?.topicCount ?? null, briefThings.data?.auto ?? null,
  (briefThings.data?.things ?? []).map((thing) => `${thing.key}:${thing.weight}`).join(",")]);

const loadBriefThings = async () => {
  if (briefThings.loading) {
    briefThings.again = true;
    return;
  }
  briefThings.loading = true;
  briefThings.again = false;
  stopBriefThingsPoll();
  const before = briefThings.data === null ? null : briefThingsShown();
  try {
    briefThings.data = await api("/api/brief/things");
    briefThings.error = "";
    if (briefThings.data.job?.status === "running" && app.view === "brief") {
      briefThings.poll = setTimeout(loadBriefThings, BRIEF_THINGS_POLL_MS);
    }
  } catch (error) {
    briefThings.error = error.message;
  }
  briefThings.loading = false;
  if (app.view === "brief" && briefThingsShown() !== before) {
    renderBriefWhenIdle();
  }
  if (briefThings.again) {
    loadBriefThings();
  }
};

const remakeBriefThings = async () => {
  try {
    await api("/api/brief/things", { method: "POST", body: "{}" });
  } catch (error) {
    briefThings.error = error.message;
    renderBriefView();
    return;
  }
  loadBriefThings();
};

/* --- what goes on the map --- */

// The heaviest things up to BRIEF_HEAD_WEIGHT_SHARE of all weight (at least
// BRIEF_HEAD_MIN); small talk is never part of the head.
const splitBriefThings = (things) => {
  const worth = things.filter((thing) => thing.kind !== "chat");
  const chat = things.filter((thing) => thing.kind === "chat");
  const total = worth.reduce((sum, thing) => sum + thing.weight, 0);
  let carried = 0;
  const head = [];
  for (const thing of worth) {
    if (head.length >= BRIEF_HEAD_MIN && carried >= total * BRIEF_HEAD_WEIGHT_SHARE) {
      break;
    }
    head.push(thing);
    carried += thing.weight;
  }
  return { head, tail: worth.slice(head.length), chat };
};

// The light things as one grey bubble: big enough to see and click, never
// bigger than a middling thing of the head.
const otherBubble = (tail, chat, head) => {
  const rest = [...tail, ...chat];
  if (rest.length === 0) {
    return null;
  }
  const middle = head[Math.floor(head.length / 2)]?.weight ?? 1;
  return {
    key: "__other__",
    kind: "chat",
    title: tail.length > 0 ? `其他 ${tail.length} 件小事${chat.length > 0 ? "和闲聊" : ""}` : `闲聊 ${chat.length} 项`,
    takeaway: "",
    messages: rest.reduce((sum, thing) => sum + thing.messages, 0),
    groups: [],
    weight: Math.min(middle, rest.reduce((sum, thing) => sum + thing.weight, 0)),
    isOther: true,
  };
};

const briefThingFacts = (thing) => (thing.isOther
  ? `约 ${briefNumber(thing.messages)} 条`
  : `${thing.groups.length} 个群 · 约 ${briefNumber(thing.messages)} 条`);

// Opens the folded rest of the list: the light things, or the small talk
// when there are no light things.
const openBriefOther = () => {
  const data = briefThings.data;
  const { tail } = splitBriefThings(data?.things ?? []);
  briefThings.showTail = true;
  briefThings.showChat = briefThings.showChat || tail.length === 0;
  renderBriefView();
  requestAnimationFrame(() => document.querySelector(".brief-things-rest")?.scrollIntoView({ behavior: "smooth", block: "start" }));
};

/* --- the list --- */

const briefThingGroups = (thing) => {
  const names = thing.groups.slice(0, BRIEF_GROUPS_SHOWN).map((group) => group.name);
  return names.length === 0 ? "" : ` · ${names.join("、")}${thing.groups.length > names.length ? ` 等` : ""}`;
};

const briefThingRow = (thing) => el("button", {
  class: `thing-row thing-${thing.kind}`,
  type: "button",
  ...thingHoverProps(briefThingId(thing)),
  onclick: () => openBriefThing(thing),
},
el("span", { class: "thing-row-head" },
  el("span", { class: "thing-kind" }, THING_KINDS[thing.kind].label),
  el("strong", {}, thing.title),
  thingStatus(thing)),
thing.takeaway ? el("span", { class: "thing-takeaway" }, thing.takeaway) : null,
el("span", { class: "gp-topic-facts" }, briefThingFacts(thing), briefThingGroups(thing),
  thing.watched.length > 0 ? el("span", { class: "thing-watched" }, ` · 关注的词：${thing.watched.join("、")}`) : null));

const briefFoldButton = (open, label, toggle) => el("button", { class: "kb-facet-more", type: "button", "aria-expanded": String(open), onclick: toggle }, label);

const briefThingList = ({ head, tail, chat }) => el("div", { class: "thing-list" },
  head.map(briefThingRow),
  tail.length === 0 ? null : el("div", { class: "brief-things-tail brief-things-rest" },
    briefFoldButton(briefThings.showTail, briefThings.showTail ? "收起小事" : `还有 ${tail.length} 件分量较轻的事`, () => {
      briefThings.showTail = !briefThings.showTail;
      renderBriefView();
    }),
    briefThings.showTail ? tail.map(briefThingRow) : null),
  chat.length === 0 ? null : el("div", { class: "brief-things-tail brief-things-rest" },
    briefFoldButton(briefThings.showChat, briefThings.showChat ? "收起闲聊" : `闲聊 ${chat.length} 项（约 ${briefNumber(chat.reduce((sum, thing) => sum + thing.messages, 0))} 条）`, () => {
      briefThings.showChat = !briefThings.showChat;
      renderBriefView();
    }),
    briefThings.showChat ? chat.map(briefThingRow) : null));

/* --- one thing, opened --- */

const briefThingState = { thing: null };

const briefThingSource = (source) => el("div", { class: "brief-thing-source" },
  el("strong", {}, source.title),
  source.summary ? el("p", {}, source.summary) : null,
  source.details.length > 0 ? el("ul", {}, source.details.map((detail) => el("li", {}, detail))) : null,
  source.evidence.length > 0 ? el("div", { class: "brief-thing-quotes" }, source.evidence.map((quote) => el("q", {}, quote))) : null);

const briefThingGroupBlock = (thing, group) => el("section", { class: "brief-thing-group" },
  el("div", { class: "brief-thing-group-head" },
    avatarEl(group.name, group.groupId, "", groupAvatarUrl(group.groupId)),
    el("strong", {}, group.name),
    el("span", { class: "kb-meta" }, `约 ${briefNumber(group.messages)} 条`),
    // Not dismissed first: its history.back() would land after the new page
    // opened and bring 简报 back. Leaving the page closes the layer, and back
    // opens this thing again (VIEW_STEP_RESTORERS.brief).
    el("span", { class: "brief-thing-group-actions" },
      el("button", {
        class: "btn small",
        type: "button",
        onclick: () => briefOpenGroup({ groupId: group.groupId, name: group.name }),
      }, "看这个群的消息"),
      el("button", {
        class: "btn small desktop-action",
        type: "button",
        onclick: () => openGroupView(group.groupId),
      }, "群页"))),
  thing.sources.filter((source) => source.groupId === group.groupId).map(briefThingSource));

const renderBriefThingLayer = () => {
  document.getElementById("brief-thing-layer")?.remove();
  const { thing } = briefThingState;
  if (thing === null || app.view !== "brief") {
    return;
  }
  const layer = el("div", {
    id: "brief-thing-layer",
    class: "kb-overlay view-layer",
    tabindex: "-1",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        dismissBriefThing();
      }
    },
    onkeydown: (event) => {
      if (event.key === "Escape") {
        dismissBriefThing();
      }
    },
  },
  el("div", { class: "kb-overlay-panel gp-topic-panel", role: "dialog", "aria-label": thing.title },
    el("div", { class: "kb-overlay-head" },
      el("h3", { class: "gp-topic-title" }, thing.title),
      el("button", { class: "btn small", type: "button", onclick: dismissBriefThing }, "关闭")),
    el("p", { class: "thing-lead" },
      el("span", { class: `thing-kind thing-${thing.kind}` }, THING_KINDS[thing.kind].label), " ", thing.takeaway, " ", thingStatus(thing)),
    el("p", { class: "kb-meta" }, `${briefThingFacts(thing)}${thing.watched.length > 0 ? ` · 关注的词：${thing.watched.join("、")}` : ""}`),
    thing.groups.map((group) => briefThingGroupBlock(thing, group))));
  document.body.append(layer);
  layer.focus();
};

const closeBriefThing = () => {
  briefThingState.thing = null;
  renderBriefThingLayer();
};

const dismissBriefThing = () => dismissOverlay(closeBriefThing);

const openBriefThing = (thing) => {
  briefThingState.thing = thing;
  renderBriefThingLayer();
  openOverlayEntry({ kind: "brief-thing", key: thing.key }, closeBriefThing);
};

// Back (or forward) to 简报 with a thing open: the things the page still
// holds have it.
VIEW_STEP_RESTORERS.brief = (step, overlay) => {
  openBriefView();
  const thing = overlay?.kind === "brief-thing" ? (briefThings.data?.things ?? []).find((item) => item.key === overlay.key) : undefined;
  if (thing !== undefined) {
    openBriefThing(thing);
  }
};

/* --- the section --- */

const briefThingsHeadLine = (data) => {
  const job = data.job;
  const parts = [];
  if (data.createdAt) {
    parts.push(`${briefClock(data.createdAt)} 整理 · ${data.madeFromTopics} 个话题 · ${data.model}`);
  }
  // Topics new or rewritten since the merge are on neither the map nor the
  // list (the things show their topics as they were): say so instead of
  // passing an old merge off as the whole window.
  const newer = data.things !== null && Number(data.unsorted) > 0 ? `之后各群总结有更新，${data.unsorted} 个话题还没整理进来` : null;
  if (job?.status === "running") {
    parts.push(data.things === null ? "正在整理…" : "正在按新的话题重新整理，好了自动换");
  } else if (data.auto !== "on" && data.stale) {
    parts.push(...(newer === null ? [] : [newer]), `${BRIEF_AUTO_REASONS[data.auto] ?? "现在不会自动整理"}，有新话题时不会自动更新`);
  } else if (newer !== null) {
    parts.push(data.auto === "on" ? `${newer}，攒够了会自动重新整理` : newer);
  }
  return parts.join(" · ");
};

const briefThingsBody = (data) => {
  if (data.things === null) {
    if (data.topicCount === 0) {
      return el("p", { class: "brief-empty-line" }, data.auto === "on"
        ? "这段时间各群还没有整理好的话题。后台总结出来、攒到几个话题后，这里会自动整理。"
        : "这段时间各群还没有整理好的话题。");
    }
    if (data.job?.status === "running") {
      return el("p", { class: "brief-empty-line" }, `正在把 ${data.topicCount} 个群话题整理成几件事，通常要几分钟。`);
    }
    // The phone only reads: making things changes this computer's store.
    return el("div", {},
      el("p", { class: "brief-empty-line" }, `${data.topicCount} 个群话题还没整理。整理会调用一次你设置的 AI 服务（读各群话题的标题和摘要，不读原始消息）。`),
      ccRemote
        ? el("p", { class: "kb-meta" }, "到电脑上的 ChatLens 点「现在整理」。")
        : el("button", { class: "btn small primary", type: "button", onclick: remakeBriefThings }, "现在整理"));
  }
  const parts = splitBriefThings(data.things);
  const other = otherBubble(parts.tail, parts.chat, parts.head);
  return el("div", { class: "thing-section" },
    thingMap([...parts.head, ...(other === null ? [] : [other])], {
      idOf: (thing) => (thing.isOther ? "b|__other__" : briefThingId(thing)),
      factsOf: briefThingFacts,
      onOpen: (thing) => (thing.isOther ? openBriefOther() : openBriefThing(thing)),
      caption: "各群这段时间值得知道的事，越大越重要",
      weightNote: "越大越重要：几个群在聊、聊了多少、重要程度和你关注的词都算",
    }),
    briefThingList(parts));
};

const briefThingsSection = () => {
  const stamp = briefState.data?.stamp ?? "";
  // A changed briefing may mean new topics: look again (the server decides
  // whether that is enough to make the things anew).
  if (briefThings.stamp !== stamp && !briefThings.loading) {
    briefThings.stamp = stamp;
    queueMicrotask(loadBriefThings);
  }
  const data = briefThings.data;
  if (data === null) {
    return briefThings.error
      ? el("section", { class: "brief-section brief-things" },
        el("h3", { class: "brief-section-title" }, "值得知道的事"),
        el("p", { class: "setup-note error" }, `读取失败：${briefThings.error}`))
      : null;
  }
  const failed = data.job?.status === "failed" ? el("p", { class: "setup-note error" }, `上次整理没成功：${data.job.error}`) : null;
  return el("section", { class: "brief-section brief-things" },
    el("div", { class: "brief-things-head" },
      el("h3", { class: "brief-section-title" }, "值得知道的事",
        data.things === null ? null : el("span", { class: "brief-count" }, data.things.filter((thing) => thing.kind !== "chat").length)),
      el("span", { class: "kb-meta" }, briefThingsHeadLine(data)),
      data.job?.status === "running" || data.topicCount === 0 ? null : el("button", { class: "linklike desktop-action", type: "button", onclick: remakeBriefThings }, "重新整理")),
    briefThings.error ? el("p", { class: "setup-note error" }, briefThings.error) : null,
    failed,
    briefThingsBody(data));
};

// The old lists, folded under the things once there are things to read.
const briefDetailsFolded = (data) => {
  const { newThings, qa, hotTopics } = data.highlights;
  if (!briefThings.data?.things) {
    return briefHighlights(data);
  }
  const open = wallReadPref(BRIEF_DETAIL_KEY, "0") === "1";
  return el("section", { class: "brief-section brief-details-fold" },
    briefFoldButton(open, open ? "收起全部明细" : `全部明细：新东西 ${newThings.length} · 问答 ${qa.length} · 大家在聊 ${hotTopics.length}`, () => {
      wallWritePref(BRIEF_DETAIL_KEY, open ? "0" : "1");
      renderBriefView();
    }),
    open ? briefHighlights(data) : null);
};

VIEW_LEAVE_HOOKS.push(() => {
  stopBriefThingsPoll();
  briefThingState.thing = null;
  // Look again when the page is opened next.
  briefThings.stamp = "";
});
