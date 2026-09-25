"use strict";

/* ---------- 群: one group in depth ----------
   简报 and 回顾 look across all groups; this page stays with one. What it is
   talking about day by day, who is active, who answers questions, what AI
   setups and pictures it shares -- all from data the background already
   stored, so opening it costs no AI calls. */

const GROUP_LAST_KEY = "cc-group-last";
const GROUP_AI_STRIP = 12;
const GROUP_ORIGIN_LABEL = "群";
const HEAT_STEPS = [0, 18, 36, 58, 80, 100];
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const PEOPLE_TABS = [["active", "最能聊"], ["posters", "发图最多"], ["helpers", "最会回答"]];
const TOPICS_PER_DAY = 6;

app.groupPage = { groupId: wallReadPref(GROUP_LAST_KEY, ""), data: null, loading: false, error: null, peopleTab: "active", aiPictures: null, openDays: new Set() };

const replaceGroupPage = (patch) => {
  app.groupPage = { ...app.groupPage, ...patch };
};

const groupChoices = () => {
  const fromRail = railState.data?.groups ?? [];
  if (fromRail.length > 0) {
    return fromRail;
  }
  return (app.state?.watchlist ?? []).map((group) => ({ groupId: group.groupId, name: group.name || group.groupId, unread: 0, mentions: 0 }));
};

const loadGroupPictures = async (groupId) => {
  try {
    const page = await api(`/api/gallery?${new URLSearchParams({ groupId, ai: "1", days: "7", limit: String(GROUP_AI_STRIP) })}`);
    if (app.groupPage.groupId === groupId) {
      replaceGroupPage({ aiPictures: page.items });
      renderGroupView();
    }
  } catch {
    replaceGroupPage({ aiPictures: [] });
  }
};

const loadGroupPage = async (groupId) => {
  replaceGroupPage({ groupId, data: app.groupPage.data?.groupId === groupId ? app.groupPage.data : null, loading: true, error: null, aiPictures: null });
  wallWritePref(GROUP_LAST_KEY, groupId);
  renderGroupView();
  renderRailGroups();
  loadGroupPictures(groupId);
  try {
    const data = await api(`/api/group?groupId=${encodeURIComponent(groupId)}`);
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

/* ---------- small charts ---------- */

const shortDay = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

// 30 days of messages: one series, so no legend; the title names it.
const dailyBars = (daily) => {
  const max = Math.max(1, ...daily.map((row) => row.text + row.media));
  return el("figure", { class: "gp-bars", "aria-label": "最近 30 天每天的消息数" },
    el("div", { class: "gp-bars-plot" },
      el("span", { class: "gp-axis-max" }, briefNumber(max)),
      daily.map((row) => {
        const total = row.text + row.media;
        return el("span", {
          class: total === 0 ? "gp-bar empty" : "gp-bar",
          style: `height:${Math.max(total === 0 ? 0 : 3, (total / max) * 100)}%`,
          title: `${shortDay(row.day)}：${briefNumber(total)} 条（${briefNumber(row.media)} 条图片 / 文件）`,
        });
      })),
    el("figcaption", { class: "gp-axis-days" },
      el("span", {}, shortDay(daily[0].day)),
      el("span", {}, shortDay(daily[Math.floor(daily.length / 2)].day)),
      el("span", {}, "今天")));
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
      busiest.count <= 0 ? "最近 30 天没有消息。" : `最热闹：周${WEEKDAY_LABELS[busiest.weekday]} ${busiest.hour} 点前后（最近 30 天合计）`));
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

const weekChange = (row) => {
  if (row.lastWeek === 0) {
    return row.thisWeek > 0 ? "新" : "";
  }
  const diff = row.thisWeek - row.lastWeek;
  return diff === 0 ? "持平" : `${diff > 0 ? "↑" : "↓"}${Math.abs(diff)}`;
};

/* ---------- sections ---------- */

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
          onchange: (event) => loadGroupPage(event.target.value),
        }, groupChoices().map((group) => el("option", { value: group.groupId, selected: group.groupId === data.groupId }, group.name)))),
      el("p", { class: "gp-head-stats" },
        el("strong", {}, briefNumber(totals.messages)), ` 条消息 · `,
        el("strong", {}, briefNumber(totals.speakers)), ` 人说过话 · `,
        el("strong", {}, briefNumber(totals.pictures)), ` 张图`,
        totals.ai > 0 ? `（${briefNumber(totals.ai)} 张 AI）` : "",
        el("span", { class: "kb-meta" }, `　最近 ${totals.days} 天`,
          totals.firstSentAt ? ` · 本地记录从 ${shortDay(unixToHkt(totals.firstSentAt).slice(0, 10))}起` : ""))),
    el("div", { class: "gp-head-actions" },
      el("button", {
        class: "btn primary",
        type: "button",
        onclick: () => openMessagesView({ groupId: data.groupId, groupName: data.name, fromLastRead: true, origin: groupOrigin() }),
      }, "从上次读到的继续"),
      el("button", {
        class: "btn",
        type: "button",
        onclick: () => {
          replaceGallery({ groupId: data.groupId, sender: "", senderLabel: "", range: null, detail: null });
          openMediaView(true);
        },
      }, "看这个群的图")));
};

const groupBrief = (brief) => {
  if (brief === null || brief.summary === "") {
    return null;
  }
  return el("section", { class: "gp-brief" },
    el("span", { class: "gp-label" }, "现在在聊"),
    el("p", {}, brief.summary),
    brief.topics.length === 0 ? null : el("div", { class: "brief-group-topics" }, brief.topics.map((topic) => el("span", { class: "tag plain" }, topic))));
};

const timelineStart = (item) => hktToUnix(item.start);

const groupTimeline = (timeline) => el("section", { class: "card gp-section" },
  el("h3", {}, "最近在聊", el("span", { class: "kb-meta" }, "　点一条跳到那段消息")),
  timeline.length === 0
    ? el("p", { class: "kb-meta" }, "最近 7 天还没有 AI 总结。后台攒够消息后会自动总结，也可以在「回顾」补齐某一天。")
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
  el("h3", {}, "新东西"),
  el("ul", { class: "gp-list" }, items.map((item) => el("li", {},
    item.kind ? el("span", { class: "kb-badge" }, BRIEF_KIND_LABELS[item.kind] ?? BRIEF_KIND_LABELS.other) : null,
    el("strong", {}, item.name),
    item.detail ? el("p", {}, item.detail) : null,
    safeHref(item.link) ? el("a", { href: safeHref(item.link), target: "_blank", rel: "noreferrer" }, item.link) : null))));

const groupQa = (items) => items.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "问答"),
  el("ul", { class: "gp-list gp-qa" }, items.map((item) => el("li", {},
    el("p", { class: "gp-q" }, el("span", { class: "kb-badge warn" }, "问"), item.question),
    item.answer
      ? el("p", { class: "gp-a" }, el("span", { class: "kb-badge ok" }, "答"), item.answer, item.answerer ? el("span", { class: "kb-meta" }, ` — ${item.answerer}`) : null)
      : el("p", { class: "kb-meta" }, "还没有人回答")))));

const groupLinks = (items) => items.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "分享的链接"),
  el("ul", { class: "gp-list gp-links" }, items.map((item) => el("li", {},
    safeHref(item.url)
      ? el("a", { href: safeHref(item.url), target: "_blank", rel: "noreferrer" }, item.title || item.url)
      : el("span", {}, item.title || item.url),
    item.why ? el("p", {}, item.why) : null))));

const groupActivity = (data) => el("section", { class: "card gp-section" },
  el("h3", {}, "活跃度"),
  el("span", { class: "gp-label" }, "最近 30 天每天的消息"),
  dailyBars(data.daily),
  el("span", { class: "gp-label" }, "一周里什么时候最热闹"),
  weekHeatmap(data.heatmap));

const peopleRows = (data, tab) => {
  if (tab === "posters") {
    return rankRows(data.people.posters, {
      valueOf: (row) => row.count,
      labelOf: (row) => row.name,
      subOf: (row) => (row.ai > 0 ? ` · ${row.ai} AI` : ""),
      onClick: (row) => {
        replaceGallery({ groupId: data.groupId, sender: row.uin || row.name, senderLabel: row.name, range: null, detail: null });
        openMediaView(true);
      },
    });
  }
  if (tab === "helpers") {
    return data.people.helpers.length === 0
      ? el("p", { class: "kb-meta" }, "最近的 AI 总结里还没有记录到谁回答了问题。")
      : rankRows(data.people.helpers, { valueOf: (row) => row.count, labelOf: (row) => row.name, subOf: () => " 次" });
  }
  return rankRows(data.people.active, { valueOf: (row) => row.count, labelOf: (row) => row.name, subOf: () => " 条" });
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
  peopleRows(data, app.groupPage.peopleTab),
  el("p", { class: "kb-meta" }, app.groupPage.peopleTab === "helpers" ? "来自最近 7 天的 AI 总结" : "最近 7 天"));

const groupAiStrip = () => {
  const pictures = app.groupPage.aiPictures;
  if (pictures === null) {
    return el("p", { class: "kb-meta" }, "正在读取 AI 图…");
  }
  if (pictures.length === 0) {
    return el("p", { class: "kb-meta" }, "最近 7 天没有认出来的 AI 图。");
  }
  return el("div", { class: "aigc-related-strip" }, pictures.map((item) => el("button", {
    class: "aigc-related-item",
    type: "button",
    title: `${item.shown?.speaker ?? ""}${item.checkpoint ? ` · ${shortModelName(item.checkpoint)}` : ""}`,
    onclick: () => {
      replaceGallery({ groupId: app.groupPage.groupId, ai: true, sender: "", senderLabel: "", range: null });
      openMediaView(true);
      openGalleryItem(item, -1);
    },
  }, el("img", { src: pictureUrl(item.md5, "thumb"), alt: "", loading: "lazy", decoding: "async" }))));
};

const groupAigc = (data) => {
  const aigc = data.aigc;
  const modelLabels = setupLabels(aigc.models);
  const setupRows = (rows) => rankRows(rows, {
    valueOf: (row) => row.thisWeek,
    labelOf: (row) => modelLabels.get(row.name),
    subOf: (row) => (weekChange(row) ? ` ${weekChange(row)}` : ""),
    onClick: (row) => {
      showView("knowledge");
      replaceKnowledgeTab({ surface: "images", libraryScope: "all", groupId: data.groupId, query: `model:${window.KbTokens.quoteValue(row.name)}` });
      ensureKnowledgeLoaded();
      loadKnowledgeResults();
    },
  });
  return el("section", { class: "card gp-section" },
    el("h3", {}, "AI 绘图"),
    el("span", { class: "gp-label" }, "最近 7 天的 AI 图"),
    groupAiStrip(),
    aigc.models.length === 0
      ? el("p", { class: "kb-meta" }, "咒语库里还没有这个群最近两周的图。")
      : [el("span", { class: "gp-label" }, "常用模型（本周张数 · 和上周比）"), setupRows(aigc.models)],
    aigc.loras.length === 0 ? null : [el("span", { class: "gp-label" }, "常用 LoRA"), rankRows(aigc.loras, {
      valueOf: (row) => row.thisWeek,
      labelOf: (row) => shortModelName(row.name),
      subOf: (row) => (weekChange(row) ? ` ${weekChange(row)}` : ""),
    })],
    aigc.asks.total === 0 ? null : el("p", { class: "kb-meta" }, `最近 ${aigc.days} 天有 ${aigc.asks.total} 次求图 / 求咒语，${aigc.asks.answered} 次有人回了。`));
};

const groupChooser = () => {
  const choices = groupChoices();
  return el("section", { class: "card" },
    el("h2", {}, "选一个群"),
    el("p", { class: "card-sub" }, "看它最近在聊什么、谁最活跃、分享了哪些 AI 图和模型。"),
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
