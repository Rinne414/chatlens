"use strict";

/* ---------- 热点: the same thing going around several groups ----------
   Replaces the old gallery tabs 事件 / 传播 / 对比 with their text-and-picture
   version. Each card is one thing -- a model, a tool, a link, a picture --
   with who brought it up first (事件), when it reached each group (传播) and
   what each group said about it (对比). */

const TRENDS_DAY_CHOICES = [[1, "今天"], [3, "3 天"], [7, "7 天"]];
const TRENDS_KINDS = [["all", "全部"], ["thing", "新东西"], ["link", "链接"], ["picture", "图片"]];
const TRENDS_ORIGIN = { view: "trends", label: "热点" };

app.trends = { days: 3, kind: "all", data: null, loading: false, error: null, open: new Set() };

const replaceTrends = (patch) => {
  app.trends = { ...app.trends, ...patch };
};

const loadTrends = async ({ fresh = false } = {}) => {
  replaceTrends({ loading: true, error: null });
  renderTrendsView();
  try {
    const data = await api(`/api/trends?days=${app.trends.days}${fresh ? "&fresh=1" : ""}`);
    replaceTrends({ data, loading: false });
  } catch (error) {
    replaceTrends({ loading: false, error: error.message });
  }
  renderTrendsView();
};

const openTrendsView = () => {
  showView("trends");
  if (app.trends.data === null || app.trends.data.days !== app.trends.days) {
    loadTrends();
    return;
  }
  renderTrendsView();
};

VIEW_RELOADERS.trends = () => loadTrends({ fresh: true });

const trendWhen = (unix) => briefWhen(unix);

const openTrendChat = (record) => openMessagesView({
  groupId: record.groupId,
  groupName: record.groupName || pictureGroupName(record.groupId),
  fromUnix: record.sentAt - 600,
  scrollToTime: record.sentAt,
  scrollToRowIds: record.rowId ? [record.rowId] : [],
  origin: TRENDS_ORIGIN,
});

const openTrendPicture = (event) => {
  const origin = { ...event.origin, speakerUin: "" };
  openMediaView();
  openGalleryItem({
    md5: event.md5,
    width: 0,
    height: 0,
    size: 0,
    format: 0,
    sticker: false,
    expiresAt: 0,
    lastAt: event.lastAt,
    shown: origin,
    origin,
    groups: event.groupCount,
    posts: event.totalMentions,
    hasThumb: true,
    kept: false,
    gone: false,
    ai: event.ai === true,
    generator: event.generator ?? "",
    checkpoint: "",
    loras: 0,
    asks: 0,
    inLibrary: false,
  }, -1);
};

/* ---------- the spread strip: mentions over time, one dot per group ---------- */

const trendTrack = (event, data) => {
  const span = Math.max(1, data.toUnix - data.fromUnix);
  const max = Math.max(1, ...event.spark);
  const position = (unix) => `${Math.min(100, Math.max(0, ((unix - data.fromUnix) / span) * 100)).toFixed(2)}%`;
  return el("figure", { class: "tr-track", "aria-label": `${event.groupCount} 个群先后提到的时间` },
    el("div", { class: "tr-spark" }, event.spark.map((count) =>
      el("span", { style: `height:${count === 0 ? 0 : Math.max(8, (count / max) * 100)}%`, title: `${count} 次` }))),
    el("div", { class: "tr-dots" }, event.groups.map((record, index) => el("button", {
      class: index === 0 ? "tr-dot first" : "tr-dot",
      type: "button",
      style: `left:${position(record.firstAt)}`,
      title: `${record.groupName || record.groupId}：${trendWhen(record.firstAt)} 第一次提到，共 ${record.mentions} 次`,
      "aria-label": `${record.groupName || record.groupId} ${trendWhen(record.firstAt)}`,
      onclick: () => openTrendChat({ ...record, ...record.sample }),
    }))),
    el("figcaption", { class: "tr-track-axis" },
      el("span", {}, trendWhen(data.fromUnix)),
      el("span", {}, "现在")));
};

const trendCompare = (event) => el("div", { class: "tr-compare" }, event.groups.map((record, index) => el("section", { class: "tr-take" },
  el("header", {},
    el("button", { class: "kb-linkish", type: "button", title: "看这个群里的原消息", onclick: () => openTrendChat({ ...record, ...record.sample }) },
      record.groupName || record.groupId),
    index === 0 ? el("span", { class: "kb-badge ok" }, "首发") : null),
  el("p", { class: "kb-meta" }, `${trendWhen(record.firstAt)} 起 · ${record.mentions} 次 · ${record.speakers} 人`),
  record.take ? el("p", { class: "tr-take-ai" }, record.take) : null,
  event.kind === "picture" || !record.sample?.text
    ? null
    : el("blockquote", {}, el("strong", {}, `${record.sample.speaker || "有人"}：`), record.sample.text))));

const trendTitle = (event) => {
  if (event.kind === "link") {
    const href = safeHref(event.link);
    return href === null ? el("h3", {}, event.title) : el("h3", {}, el("a", { href, target: "_blank", rel: "noreferrer" }, event.title));
  }
  if (event.kind === "picture") {
    return el("h3", {}, `${event.origin.speaker || "有人"}发的${event.ai ? " AI " : ""}图，传到了 ${event.groupCount} 个群`);
  }
  const href = safeHref(event.link);
  return el("h3", {}, event.title,
    href === null ? null : el("a", { class: "tr-title-link", href, target: "_blank", rel: "noreferrer" }, "链接"));
};

const trendCard = (event, data) => {
  const open = app.trends.open.has(event.id);
  const toggle = () => {
    const next = new Set(app.trends.open);
    if (open) {
      next.delete(event.id);
    } else {
      next.add(event.id);
    }
    replaceTrends({ open: next });
    renderTrendsView();
  };
  return el("article", { class: `tr-card ${event.kind}` },
    event.kind === "picture"
      ? el("button", { class: "tr-thumb", type: "button", title: "看这张图和它的传播路径", onclick: () => openTrendPicture(event) },
        el("img", { src: pictureUrl(event.md5, "thumb"), alt: "", loading: "lazy", decoding: "async" }))
      : null,
    el("div", { class: "tr-main" },
      el("div", { class: "tr-head" },
        el("div", { class: "tr-title" },
          el("span", { class: `tr-kind ${event.kind}` }, event.label),
          trendTitle(event)),
        el("div", { class: "tr-reach", title: `${event.totalMentions} 次提及，${event.speakerCount} 个人` },
          el("strong", {}, String(event.groupCount)),
          el("span", {}, "个群"),
          el("small", {}, `${briefNumber(event.totalMentions)} 次 · ${briefNumber(event.speakerCount)} 人`))),
      el("p", { class: "tr-origin" },
        el("span", { class: "kb-badge ok" }, "首发"),
        el("button", { class: "kb-linkish", type: "button", onclick: () => openTrendChat(event.origin) }, event.origin.groupName || event.origin.groupId),
        el("span", { class: "kb-meta" }, ` ${event.origin.speaker || ""} · ${trendWhen(event.firstAt)}`),
        event.kind === "picture" || !event.origin.text ? null : el("q", {}, event.origin.text)),
      trendTrack(event, data),
      (event.related ?? []).length === 0
        ? null
        : el("p", { class: "tr-related" }, el("span", { class: "kb-meta" }, "相关："),
          event.related.map((item) => el("span", { class: "tag plain", title: `${item.groupCount} 个群 · ${item.totalMentions} 次` }, item.title))),
      el("button", { class: "tr-toggle", type: "button", "aria-expanded": String(open), onclick: toggle },
        open ? "收起" : `各群怎么说（${event.groupCount}）`),
      open ? trendCompare(event) : null));
};

const trendsToolbar = (data) => el("div", { class: "gallery-toolbar" },
  el("div", { class: "wall-modes", role: "group", "aria-label": "时间范围" }, TRENDS_DAY_CHOICES.map(([days, label]) => el("button", {
    class: app.trends.days === days ? "wall-mode active" : "wall-mode",
    type: "button",
    "aria-pressed": String(app.trends.days === days),
    onclick: () => {
      replaceTrends({ days, open: new Set() });
      loadTrends();
    },
  }, label))),
  el("div", { class: "wall-modes", role: "group", "aria-label": "类型" }, TRENDS_KINDS.map(([kind, label]) => el("button", {
    class: app.trends.kind === kind ? "wall-mode active" : "wall-mode",
    type: "button",
    "aria-pressed": String(app.trends.kind === kind),
    onclick: () => {
      replaceTrends({ kind });
      renderTrendsView();
    },
  }, label))),
  data === null ? null : el("span", { class: "kb-meta" },
    `看了 ${briefNumber(data.messages)} 条消息和 ${briefNumber(data.summarizedChunks)} 段 AI 总结`));

const renderTrendsView = () => {
  const root = $("#view-trends");
  if (root === null) {
    return;
  }
  const { data, loading, error, kind } = app.trends;
  const events = (data?.events ?? []).filter((event) => kind === "all" || event.kind === kind);
  setChildren(root, el("section", { class: `panel tr-page ${loading ? "is-loading" : ""}` },
    el("p", { class: "tr-intro" }, "同一件事在好几个群里被提到：谁先说的、怎么传开、各群怎么看。"),
    trendsToolbar(data),
    error === null ? null : el("div", { class: "notice risk" }, `读取热点失败：${error}`),
    data === null
      ? el("p", { class: "kb-meta" }, "正在整理…")
      : events.length === 0
        ? el("div", { class: "wall-empty" }, "这段时间没有在几个群里同时出现的东西。可以把时间放宽。")
        : el("div", { class: "tr-list" }, events.map((event) => trendCard(event, data)))));
};
