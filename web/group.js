"use strict";

/* ---------- 群: one group in depth ----------
   简报 and 回顾 look across all groups; this page stays with one, for any
   dates: what it talked about day by day, who is active, who answers
   questions, what AI setups and pictures it shares -- all from data the
   background already stored, so opening it costs no AI calls. Every list is
   complete: sections show the first few and open to the rest. */

const GROUP_LAST_KEY = "cc-group-last";
const GROUP_AI_STRIP = 12;
const GROUP_ORIGIN_LABEL = "群";
const HEAT_STEPS = [0, 18, 36, 58, 80, 100];
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const PEOPLE_TABS = [["active", "最能聊"], ["posters", "发图最多"], ["helpers", "最会回答"]];
const TOPICS_PER_DAY = 6;
const LIST_PREVIEW = 8;
const RANK_PREVIEW = 10;
const GROUP_PRESETS = [["today", "今天"], ["yesterday", "昨天"], ["7d", "7 天"], ["30d", "30 天"]];
const DAY = 86400;

app.groupPage = {
  groupId: wallReadPref(GROUP_LAST_KEY, ""),
  range: { preset: "7d", fromDay: null, toDay: null },
  data: null,
  loading: false,
  error: null,
  peopleTab: "active",
  aiPictures: null,
  openDays: new Set(),
  expanded: new Set(),
};

const replaceGroupPage = (patch) => {
  app.groupPage = { ...app.groupPage, ...patch };
};

/* ---------- the date range ---------- */

const todayDay = () => unixToHkt(Math.floor(Date.now() / 1000)).slice(0, 10);
const dayStartUnix = (day) => hktToUnix(`${day} 00:00`);
const shiftDay = (day, days) => unixToHkt(dayStartUnix(day) + days * DAY + 3600).slice(0, 10);

// [fromUnix, toUnix) for the page's range.
const groupRangeUnix = () => {
  const { preset, fromDay, toDay } = app.groupPage.range;
  const now = Math.floor(Date.now() / 1000);
  const today = todayDay();
  if (preset === "today") {
    return { fromUnix: dayStartUnix(today), toUnix: now + 60 };
  }
  if (preset === "yesterday") {
    return { fromUnix: dayStartUnix(shiftDay(today, -1)), toUnix: dayStartUnix(today) };
  }
  if (preset === "custom" && fromDay !== null && toDay !== null) {
    return { fromUnix: dayStartUnix(fromDay), toUnix: dayStartUnix(toDay) + DAY };
  }
  return { fromUnix: now - (preset === "30d" ? 30 : 7) * DAY, toUnix: now + 60 };
};

const groupRangeDays = () => {
  const { fromUnix, toUnix } = groupRangeUnix();
  return { fromDay: unixToHkt(fromUnix).slice(0, 10), toDay: unixToHkt(toUnix - 1).slice(0, 10) };
};

const groupRangeLabel = () => {
  const preset = GROUP_PRESETS.find(([key]) => key === app.groupPage.range.preset);
  if (preset !== undefined) {
    return preset[0] === "7d" || preset[0] === "30d" ? `最近 ${preset[1]}` : preset[1];
  }
  const { fromDay, toDay } = groupRangeDays();
  return fromDay === toDay ? shortDay(fromDay) : `${shortDay(fromDay)} – ${shortDay(toDay)}`;
};

const setGroupRange = (range) => {
  replaceGroupPage({ range, openDays: new Set(), expanded: new Set() });
  loadGroupPage(app.groupPage.groupId);
};

const groupChoices = () => {
  const fromRail = railState.data?.groups ?? [];
  if (fromRail.length > 0) {
    return fromRail;
  }
  return (app.state?.watchlist ?? []).map((group) => ({ groupId: group.groupId, name: group.name || group.groupId, unread: 0, mentions: 0 }));
};

/* ---------- loading ---------- */

const loadGroupPictures = async (groupId, range) => {
  try {
    const params = new URLSearchParams({ groupId, ai: "1", fromUnix: String(range.fromUnix), toUnix: String(range.toUnix), limit: String(GROUP_AI_STRIP) });
    const page = await api(`/api/gallery?${params}`);
    if (app.groupPage.groupId === groupId) {
      replaceGroupPage({ aiPictures: page });
      renderGroupView();
    }
  } catch {
    replaceGroupPage({ aiPictures: { total: 0, items: [] } });
  }
};

const loadGroupPage = async (groupId) => {
  const range = groupRangeUnix();
  replaceGroupPage({ groupId, data: app.groupPage.data?.groupId === groupId ? app.groupPage.data : null, loading: true, error: null, aiPictures: null });
  wallWritePref(GROUP_LAST_KEY, groupId);
  renderGroupView();
  renderRailGroups();
  loadGroupPictures(groupId, range);
  try {
    const params = new URLSearchParams({ groupId, fromUnix: String(range.fromUnix), toUnix: String(range.toUnix) });
    const data = await api(`/api/group?${params}`);
    if (app.groupPage.groupId === groupId) {
      replaceGroupPage({ data, loading: false });
    }
  } catch (error) {
    replaceGroupPage({ loading: false, error: error.message });
  }
  renderGroupView();
};

// No group given: reopen the last one, or show the chooser.
const openGroupView = (groupId) => {
  showView("group");
  const target = groupId ?? app.groupPage.groupId;
  if (/^\d+$/u.test(String(target ?? ""))) {
    if (groupId !== undefined && groupId !== app.groupPage.groupId) {
      replaceGroupPage({ openDays: new Set(), expanded: new Set() });
    }
    loadGroupPage(String(target));
    return;
  }
  renderGroupView();
};

VIEW_RELOADERS.group = () => openGroupView(app.groupPage.groupId || undefined);
VIEW_LEAVE_HOOKS.push(() => queueMicrotask(renderRailGroups));

const groupOrigin = () => ({ view: "group", label: GROUP_ORIGIN_LABEL });

const openGroupChatAt = (unix) => openMessagesView({
  groupId: app.groupPage.groupId,
  groupName: app.groupPage.data?.name ?? "",
  fromUnix: unix - 600,
  scrollToTime: unix,
  origin: groupOrigin(),
});

const openGroupGallery = (patch) => {
  const range = groupRangeUnix();
  replaceGallery({ groupId: app.groupPage.groupId, sender: "", senderLabel: "", range, detail: null, ...patch });
  openMediaView(true);
};

/* ---------- expandable sections ---------- */

const toggleGroupExpanded = (id) => {
  const expanded = new Set(app.groupPage.expanded);
  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }
  replaceGroupPage({ expanded });
  renderGroupView();
};

// The first `preview` items, and a button for the rest.
const expandable = (id, items, preview, render, unit = "条") => {
  const open = app.groupPage.expanded.has(id);
  return [
    render(open ? items : items.slice(0, preview)),
    items.length > preview
      ? el("button", { class: "kb-facet-more gp-more", type: "button", onclick: () => toggleGroupExpanded(id) },
        open ? "收起" : `显示全部 ${briefNumber(items.length)} ${unit}`)
      : null,
  ];
};

/* ---------- small charts ---------- */

const shortDay = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

// One series (messages per day), so no legend; the title names it. A bar is a
// button: clicking it shows that day. Bars inside the chosen range are marked.
const dailyBars = (daily) => {
  const max = Math.max(1, ...daily.map((row) => row.text + row.media));
  const { fromDay, toDay } = groupRangeDays();
  return el("figure", { class: "gp-bars", "aria-label": "每天的消息数" },
    el("div", { class: "gp-bars-plot" },
      el("span", { class: "gp-axis-max" }, briefNumber(max)),
      daily.map((row) => {
        const total = row.text + row.media;
        const inRange = row.day >= fromDay && row.day <= toDay;
        return el("button", {
          class: ["gp-bar", total === 0 ? "empty" : "", inRange ? "in-range" : ""].join(" "),
          type: "button",
          style: `height:${Math.max(total === 0 ? 4 : 6, (total / max) * 100)}%`,
          title: `${shortDay(row.day)}：${briefNumber(total)} 条（${briefNumber(row.media)} 条图片 / 文件）。点击只看这天`,
          "aria-label": `${shortDay(row.day)} ${total} 条`,
          onclick: () => setGroupRange({ preset: "custom", fromDay: row.day, toDay: row.day }),
        });
      })),
    el("figcaption", { class: "gp-axis-days" },
      el("span", {}, shortDay(daily[0].day)),
      el("span", {}, shortDay(daily[Math.floor(daily.length / 2)].day)),
      el("span", {}, shortDay(daily[daily.length - 1].day))));
};

const heatLevel = (count, max) => (count === 0 ? 0 : Math.min(HEAT_STEPS.length - 1, 1 + Math.floor((count / max) * (HEAT_STEPS.length - 2))));

const busiestSlot = (grid) => {
  let best = { weekday: 0, hour: 0, count: -1 };
  grid.forEach((row, weekday) => row.forEach((count, hour) => {
    if (count > best.count) {
      best = { weekday, hour, count };
    }
  }));
  return best;
};

// Weekday x hour, one hue from light to dark (magnitude).
const weekHeatmap = (grid) => {
  const max = Math.max(1, ...grid.flat());
  const busiest = busiestSlot(grid);
  return el("figure", { class: "gp-heat", "aria-label": "一周里各时段的消息数" },
    el("div", { class: "gp-heat-grid" },
      el("span"),
      [0, 6, 12, 18].map((hour) => el("span", { class: "gp-heat-hour", style: `grid-column:${hour + 2} / span 6` }, `${hour} 点`)),
      grid.map((row, weekday) => [
        el("span", { class: "gp-heat-day" }, `周${WEEKDAY_LABELS[weekday]}`),
        row.map((count, hour) => el("span", {
          class: `gp-heat-cell l${heatLevel(count, max)}`,
          title: `周${WEEKDAY_LABELS[weekday]} ${hour}:00–${hour + 1}:00：${briefNumber(count)} 条`,
        })),
      ])),
    el("figcaption", { class: "kb-meta" },
      busiest.count <= 0 ? "这段时间没有消息。" : `最热闹：周${WEEKDAY_LABELS[busiest.weekday]} ${busiest.hour} 点前后`));
};

const rankRows = (rows, { valueOf, labelOf, subOf = () => "", onClick = null }) => {
  const max = Math.max(1, ...rows.map(valueOf));
  return el("ol", { class: "gp-rank" }, rows.map((row) => el("li", {},
    el(onClick === null ? "span" : "button", {
      class: "gp-rank-name",
      type: onClick === null ? undefined : "button",
      title: labelOf(row),
      onclick: onClick === null ? undefined : () => onClick(row),
    }, labelOf(row)),
    el("span", { class: "gp-rank-bar" }, el("span", { style: `width:${(valueOf(row) / max) * 100}%` })),
    el("span", { class: "gp-rank-value" }, briefNumber(valueOf(row)), subOf(row) ? el("small", {}, subOf(row)) : null))));
};

// Two setups can share a file name in different folders; those keep one
// folder level so the rows stay distinguishable.
const setupLabels = (rows) => {
  const counts = new Map();
  for (const row of rows) {
    counts.set(shortModelName(row.name), (counts.get(shortModelName(row.name)) ?? 0) + 1);
  }
  return new Map(rows.map((row) => {
    const short = shortModelName(row.name);
    return [row.name, counts.get(short) > 1 ? row.name.split(/[\\/]/u).slice(-2).join("/").replace(/\.(safetensors|ckpt|pt)$/iu, "") : short];
  }));
};

const periodChange = (row) => {
  if (row.previous === 0) {
    return row.current > 0 ? "新" : "";
  }
  const diff = row.current - row.previous;
  return diff === 0 ? "持平" : `${diff > 0 ? "↑" : "↓"}${Math.abs(diff)}`;
};

/* ---------- sections ---------- */

const groupRangeControl = () => {
  const { fromDay, toDay } = groupRangeDays();
  const today = todayDay();
  const custom = app.groupPage.range.preset === "custom";
  return el("div", { class: "gp-range" },
    el("div", { class: "wall-modes", role: "group", "aria-label": "时间范围" }, GROUP_PRESETS.map(([preset, label]) => el("button", {
      class: app.groupPage.range.preset === preset ? "wall-mode active" : "wall-mode",
      type: "button",
      "aria-pressed": String(app.groupPage.range.preset === preset),
      onclick: () => setGroupRange({ preset, fromDay: null, toDay: null }),
    }, label))),
    el("span", { class: custom ? "trends-dates active" : "trends-dates" },
      el("input", { type: "date", value: fromDay, max: today, "aria-label": "开始日期", onchange: (event) => {
        if (event.target.value !== "" && event.target.value <= toDay) {
          setGroupRange({ preset: "custom", fromDay: event.target.value, toDay });
        }
      } }),
      el("span", {}, "至"),
      el("input", { type: "date", value: toDay, max: today, "aria-label": "结束日期", onchange: (event) => {
        if (event.target.value !== "" && event.target.value >= fromDay) {
          setGroupRange({ preset: "custom", fromDay, toDay: event.target.value });
        }
      } })),
    el("span", { class: "kb-meta" }, "也可以点下面柱状图里的某一天"));
};

const groupHeader = (data) => {
  const totals = data.totals;
  return el("section", { class: "card gp-head" },
    avatarEl(data.name, data.groupId, undefined, groupAvatarUrl(data.groupId)),
    el("div", { class: "gp-head-main" },
      el("div", { class: "gp-head-title" },
        el("h2", {}, data.name),
        el("select", {
          class: "kb-select",
          "aria-label": "换一个群",
          onchange: (event) => openGroupView(event.target.value),
        }, groupChoices().map((group) => el("option", { value: group.groupId, selected: group.groupId === data.groupId }, group.name)))),
      el("p", { class: "gp-head-stats" },
        el("span", { class: "gp-range-label" }, groupRangeLabel()), " ",
        el("strong", {}, briefNumber(totals.messages)), " 条消息 · ",
        el("strong", {}, briefNumber(totals.speakers)), " 人说过话 · ",
        el("strong", {}, briefNumber(totals.pictures)), " 张图",
        totals.ai > 0 ? `（${briefNumber(totals.ai)} 张 AI）` : "",
        totals.firstSentAt ? el("span", { class: "kb-meta" }, `　本地记录从 ${shortDay(unixToHkt(totals.firstSentAt).slice(0, 10))}起`) : null),
      groupRangeControl()),
    el("div", { class: "gp-head-actions" },
      el("button", {
        class: "btn primary",
        type: "button",
        onclick: () => openMessagesView({ groupId: data.groupId, groupName: data.name, fromLastRead: true, origin: groupOrigin() }),
      }, "从上次读到的继续"),
      el("button", { class: "btn", type: "button", onclick: () => openGroupGallery({}) }, "看这段时间的图")));
};

// The group's current brief only describes "now", so it shows only while the
// range reaches today.
const groupBrief = (brief) => {
  if (brief === null || brief.summary === "" || groupRangeDays().toDay !== todayDay()) {
    return null;
  }
  return el("section", { class: "gp-brief" },
    el("span", { class: "gp-label" }, "现在在聊"),
    el("p", {}, brief.summary),
    brief.topics.length === 0 ? null : el("div", { class: "brief-group-topics" }, brief.topics.map((topic) => el("span", { class: "tag plain" }, topic))));
};

const timelineStart = (item) => hktToUnix(item.start);

const groupTimeline = (timeline) => el("section", { class: "card gp-section" },
  el("h3", {}, "在聊什么", el("span", { class: "kb-meta" }, "　点一条跳到那段消息")),
  timeline.length === 0
    ? el("p", { class: "kb-meta" }, "这段时间还没有 AI 总结。后台攒够消息后会自动总结，也可以在「回顾」补齐某一天。")
    : timeline.map((day) => el("div", { class: "gp-day" },
      el("h4", {}, shortDay(day.day)),
      el("ol", {}, (app.groupPage.openDays.has(day.day) ? day.items : day.items.slice(0, TOPICS_PER_DAY)).map((item) => {
        const start = timelineStart(item);
        return el("li", {},
          el(start === null ? "div" : "button", {
            class: "gp-topic",
            type: start === null ? undefined : "button",
            onclick: start === null ? undefined : () => openGroupChatAt(start),
          },
          start === null ? null : el("span", { class: "gp-topic-time" }, unixToHkt(start).slice(11, 16)),
          el("strong", {}, item.title),
          item.summary ? el("span", { class: "gp-topic-sum" }, item.summary) : null));
      })),
      day.items.length > TOPICS_PER_DAY && !app.groupPage.openDays.has(day.day)
        ? el("button", {
          class: "kb-facet-more",
          type: "button",
          onclick: () => {
            replaceGroupPage({ openDays: new Set([...app.groupPage.openDays, day.day]) });
            renderGroupView();
          },
        }, `这天还有 ${day.items.length - TOPICS_PER_DAY} 个话题`)
        : null)));

const groupNewThings = (items) => items.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "新东西", el("span", { class: "kb-meta" }, `　${briefNumber(items.length)} 条`)),
  expandable("newThings", items, LIST_PREVIEW, (shown) => el("ul", { class: "gp-list" }, shown.map((item) => el("li", {},
    item.kind ? el("span", { class: "kb-badge" }, BRIEF_KIND_LABELS[item.kind] ?? BRIEF_KIND_LABELS.other) : null,
    el("strong", {}, item.name),
    item.detail ? el("p", {}, item.detail) : null,
    safeHref(item.link) ? el("a", { href: safeHref(item.link), target: "_blank", rel: "noreferrer" }, item.link) : null)))));

const groupQa = (items) => items.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "问答", el("span", { class: "kb-meta" }, `　${briefNumber(items.length)} 条`)),
  expandable("qa", items, LIST_PREVIEW, (shown) => el("ul", { class: "gp-list gp-qa" }, shown.map((item) => el("li", {},
    el("p", { class: "gp-q" }, el("span", { class: "kb-badge warn" }, "问"), item.question),
    item.answer
      ? el("p", { class: "gp-a" }, el("span", { class: "kb-badge ok" }, "答"), item.answer, item.answerer ? el("span", { class: "kb-meta" }, ` — ${item.answerer}`) : null)
      : el("p", { class: "kb-meta" }, "还没有人回答"))))));

const groupLinks = (items) => items.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "分享的链接", el("span", { class: "kb-meta" }, `　${briefNumber(items.length)} 条`)),
  expandable("links", items, LIST_PREVIEW, (shown) => el("ul", { class: "gp-list gp-links" }, shown.map((item) => el("li", {},
    safeHref(item.url)
      ? el("a", { href: safeHref(item.url), target: "_blank", rel: "noreferrer" }, item.title || item.url)
      : el("span", {}, item.title || item.url),
    item.why ? el("p", {}, item.why) : null)))));

const groupActivity = (data) => el("section", { class: "card gp-section" },
  el("h3", {}, "活跃度"),
  el("span", { class: "gp-label" }, "每天的消息（深色是所选时间）"),
  dailyBars(data.daily),
  el("span", { class: "gp-label" }, "一周里什么时候最热闹（所选时间）"),
  weekHeatmap(data.heatmap));

const peopleRows = (data, tab) => {
  if (tab === "posters") {
    return expandable("posters", data.people.posters, RANK_PREVIEW, (shown) => rankRows(shown, {
      valueOf: (row) => row.count,
      labelOf: (row) => row.name,
      subOf: (row) => (row.ai > 0 ? ` · ${row.ai} AI` : ""),
      onClick: (row) => openGroupGallery({ sender: row.uin || row.name, senderLabel: row.name }),
    }), "人");
  }
  if (tab === "helpers") {
    return data.people.helpers.length === 0
      ? el("p", { class: "kb-meta" }, "这段时间的 AI 总结里还没有记录到谁回答了问题。")
      : expandable("helpers", data.people.helpers, RANK_PREVIEW, (shown) => rankRows(shown, { valueOf: (row) => row.count, labelOf: (row) => row.name, subOf: () => " 次" }), "人");
  }
  return expandable("active", data.people.active, RANK_PREVIEW, (shown) => rankRows(shown, { valueOf: (row) => row.count, labelOf: (row) => row.name, subOf: () => " 条" }), "人");
};

const groupPeople = (data) => el("section", { class: "card gp-section" },
  el("div", { class: "gp-section-head" },
    el("h3", {}, "这个群的人"),
    el("div", { class: "wall-modes", role: "group", "aria-label": "排行方式" }, PEOPLE_TABS.map(([tab, label]) => el("button", {
      class: app.groupPage.peopleTab === tab ? "wall-mode active" : "wall-mode",
      type: "button",
      "aria-pressed": String(app.groupPage.peopleTab === tab),
      onclick: () => {
        replaceGroupPage({ peopleTab: tab });
        renderGroupView();
      },
    }, label)))),
  peopleRows(data, app.groupPage.peopleTab));

const groupAiStrip = () => {
  const pictures = app.groupPage.aiPictures;
  if (pictures === null) {
    return el("p", { class: "kb-meta" }, "正在读取 AI 图…");
  }
  if (pictures.items.length === 0) {
    return el("p", { class: "kb-meta" }, "这段时间没有认出来的 AI 图。");
  }
  return [
    el("div", { class: "aigc-related-strip" }, pictures.items.map((item) => el("button", {
      class: "aigc-related-item",
      type: "button",
      title: `${item.shown?.speaker ?? ""}${item.checkpoint ? ` · ${shortModelName(item.checkpoint)}` : ""}`,
      onclick: () => {
        openGroupGallery({ ai: true });
        openGalleryItem(item, -1);
      },
    }, el("img", { src: pictureUrl(item.md5, "thumb"), alt: "", loading: "lazy", decoding: "async" })))),
    pictures.total > pictures.items.length
      ? el("button", { class: "kb-facet-more gp-more", type: "button", onclick: () => openGroupGallery({ ai: true }) },
        `在画廊看全部 ${briefNumber(pictures.total)} 张 →`)
      : null,
  ];
};

const groupAigc = (data) => {
  const aigc = data.aigc;
  const modelLabels = setupLabels(aigc.models);
  const loraLabels = setupLabels(aigc.loras);
  const openInLibrary = (field, name) => {
    showView("knowledge");
    replaceKnowledgeTab({ surface: "images", libraryScope: "all", groupId: data.groupId, query: `${field}:${window.KbTokens.quoteValue(name)}` });
    ensureKnowledgeLoaded();
    loadKnowledgeResults();
  };
  const setupRows = (id, rows, labels, field) => expandable(id, rows, RANK_PREVIEW, (shown) => rankRows(shown, {
    valueOf: (row) => row.current,
    labelOf: (row) => labels.get(row.name),
    subOf: (row) => (periodChange(row) ? ` ${periodChange(row)}` : ""),
    onClick: (row) => openInLibrary(field, row.name),
  }), "个");
  return el("section", { class: "card gp-section" },
    el("h3", {}, "AI 绘图"),
    el("span", { class: "gp-label" }, "这段时间的 AI 图"),
    groupAiStrip(),
    aigc.models.length === 0
      ? el("p", { class: "kb-meta" }, "咒语库里没有这个群这段时间的图。")
      : [el("span", { class: "gp-label" }, "用到的模型（张数 · 和之前同样长的时间比）"), setupRows("models", aigc.models, modelLabels, "model")],
    aigc.loras.length === 0 ? null : [el("span", { class: "gp-label" }, "用到的 LoRA"), setupRows("loras", aigc.loras, loraLabels, "lora")],
    aigc.asks.total === 0 ? null : el("p", { class: "kb-meta" }, `这段时间有 ${aigc.asks.total} 次求图 / 求咒语，${aigc.asks.answered} 次有人回了。`));
};

const groupChooser = () => {
  const choices = groupChoices();
  return el("section", { class: "card" },
    el("h2", {}, "选一个群"),
    el("p", { class: "card-sub" }, "看它在聊什么、谁最活跃、分享了哪些 AI 图和模型，时间可以随意选。"),
    choices.length === 0
      ? el("p", { class: "kb-meta" }, "还没有关注的群。到「设置 → 关注的群」添加。")
      : el("div", { class: "gp-choices" }, choices.map((group) => el("button", {
        class: "gp-choice",
        type: "button",
        onclick: () => openGroupView(group.groupId),
      },
      avatarEl(group.name, group.groupId, undefined, groupAvatarUrl(group.groupId)),
      el("span", { class: "gp-choice-name" }, group.name),
      group.unread > 0 ? el("span", { class: "rail-unread" }, railUnreadText(group.unread)) : null))));
};

const renderGroupView = () => {
  const root = $("#view-group");
  if (root === null) {
    return;
  }
  const page = app.groupPage;
  if (!/^\d+$/u.test(String(page.groupId ?? ""))) {
    setChildren(root, groupChooser());
    return;
  }
  if (page.data === null) {
    setChildren(root, page.error
      ? el("div", { class: "notice risk" }, `读取这个群失败：${page.error}`)
      : el("p", { class: "kb-meta" }, "正在读取…"));
    return;
  }
  const data = page.data;
  setChildren(root, el("div", { class: `gp-page ${page.loading ? "is-loading" : ""}` },
    groupHeader(data),
    groupBrief(data.brief),
    el("div", { class: "gp-grid" },
      el("div", { class: "gp-col" }, groupTimeline(data.timeline), groupQa(data.qa), groupNewThings(data.newThings), groupLinks(data.links)),
      el("div", { class: "gp-col" }, groupActivity(data), groupPeople(data), groupAigc(data)))));
};
