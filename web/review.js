"use strict";

/* ---------- 回顾: any past day, and "哪天聊过这个" ----------
   Everything here is read from the AI summaries the background briefing
   already made, so browsing and searching cost nothing. A day that was never
   summarized can be 补齐: its messages join the background briefing queue. */

const REVIEW_ORIGIN = { view: "review", label: "回顾" };
const REVIEW_TIMELINE_PREVIEW = 6;
const REVIEW_PANEL_PREVIEW = 6;
const REVIEW_POLL_MS = 8000;
const REVIEW_POLL_LIMIT = 90;
const REVIEW_CALENDAR_DAYS = 365;
const REVIEW_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const REVIEW_HIT_LABELS = { topic: "话题", newThing: "新东西", qa: "问答", timeline: "时间线", summary: "摘要" };

const reviewState = {
  calendar: null,
  month: null,
  day: null,
  data: null,
  ticket: 0,
  loading: false,
  busy: false,
  error: null,
  notice: null,
  query: "",
  results: null,
  resultsOpen: false,
  searching: false,
  expanded: {},
  pollTimer: null,
  polls: 0,
};

/* ---------- dates (Beijing days as "YYYY-MM-DD") ---------- */

const reviewToday = () => unixToHkt(Math.floor(Date.now() / 1000)).slice(0, 10);

const reviewShiftDay = (day, delta) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
};

const reviewDayUnix = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / 1000 - HKT_OFFSET_SECONDS;
};

const reviewShortDay = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
const reviewDayLabel = (day) => briefDateLine(reviewDayUnix(day) + 43200);
const reviewClock = (unix) => unixToHkt(unix).slice(11, 16);

/* ---------- loading ---------- */

const loadReviewCalendar = async () => {
  const today = reviewToday();
  reviewState.calendar = await api(`/api/review/calendar?from=${reviewShiftDay(today, -REVIEW_CALENDAR_DAYS)}&to=${today}`);
};

const loadReviewDay = async (day, { silent = false } = {}) => {
  reviewState.ticket += 1;
  const ticket = reviewState.ticket;
  reviewState.day = day;
  reviewState.month = day.slice(0, 7);
  if (!silent) {
    reviewState.loading = true;
    renderReviewView();
  }
  try {
    const data = await api(`/api/review/day?day=${day}`);
    if (ticket !== reviewState.ticket) {
      return;
    }
    const drained = (reviewState.data?.day === day && reviewState.data.totals.queued > 0) && data.totals.queued === 0;
    reviewState.data = data;
    reviewState.error = null;
    if (drained) {
      reviewState.notice = "补齐完成。";
      await loadReviewCalendar();
    }
  } catch (error) {
    reviewState.error = error.message;
  } finally {
    reviewState.loading = false;
  }
  renderReviewView();
  scheduleReviewPoll();
};

// While a backfilled day is queued, re-read it so summaries appear as the
// background finishes them. Bounded, and only while this view is open.
const scheduleReviewPoll = () => {
  clearTimeout(reviewState.pollTimer);
  reviewState.pollTimer = null;
  const queued = reviewState.data?.totals.queued ?? 0;
  if (queued === 0 || app.view !== "review" || reviewState.polls >= REVIEW_POLL_LIMIT) {
    reviewState.polls = 0;
    return;
  }
  reviewState.pollTimer = setTimeout(() => {
    reviewState.polls += 1;
    if (app.view === "review" && reviewState.day !== null) {
      loadReviewDay(reviewState.day, { silent: true });
    }
  }, REVIEW_POLL_MS);
};

const reviewDefaultDay = () => {
  const days = reviewState.calendar?.days ?? [];
  const yesterday = reviewShiftDay(reviewToday(), -1);
  return days.some((entry) => entry.day === yesterday) ? yesterday : days.at(-1)?.day ?? reviewToday();
};

const openReviewView = async (preset = {}) => {
  showView("review");
  renderReviewView();
  try {
    if (reviewState.calendar === null) {
      await loadReviewCalendar();
    }
  } catch (error) {
    reviewState.error = error.message;
    renderReviewView();
    return;
  }
  if (typeof preset.query === "string" && preset.query.trim().length > 0) {
    await runReviewSearch(preset.query);
  }
  await loadReviewDay(preset.day ?? reviewState.day ?? reviewDefaultDay());
};

const reviewPickDay = (day) => {
  reviewState.resultsOpen = false;
  reviewState.notice = null;
  reviewState.expanded = {};
  loadReviewDay(day);
  $("#view-review")?.scrollIntoView?.({ block: "start" });
};

const reviewToggle = (key) => {
  reviewState.expanded = { ...reviewState.expanded, [key]: !reviewState.expanded[key] };
  renderReviewView();
};

const reviewOpenChat = (groupId, groupName, sentAt, rowId) => openMessagesView({
  groupId,
  groupName,
  fromUnix: sentAt - 1800,
  scrollToTime: sentAt,
  scrollToRowIds: rowId ? [rowId] : [],
  origin: REVIEW_ORIGIN,
});

/* ---------- search ---------- */

const runReviewSearch = async (query) => {
  reviewState.query = String(query ?? "").trim();
  if (reviewState.query.length === 0) {
    reviewState.results = null;
    reviewState.resultsOpen = false;
    renderReviewView();
    return;
  }
  reviewState.searching = true;
  renderReviewView();
  try {
    reviewState.results = await api(`/api/review/search?q=${encodeURIComponent(reviewState.query)}`);
    reviewState.resultsOpen = true;
    reviewState.error = null;
  } catch (error) {
    reviewState.error = error.message;
  } finally {
    reviewState.searching = false;
  }
  renderReviewView();
};

const reviewSearchBar = () => {
  const input = el("input", {
    type: "search",
    class: "review-search-input",
    placeholder: "搜话题、模型名、关键词：哪天聊过？",
    value: reviewState.query,
    "aria-label": "搜索往日话题",
  });
  const results = reviewState.results;
  return el("form", {
    class: "review-search",
    role: "search",
    onsubmit: (event) => {
      event.preventDefault();
      runReviewSearch(input.value);
    },
  },
  input,
  el("button", { class: "btn primary", type: "submit", disabled: reviewState.searching }, reviewState.searching ? "搜索中…" : "搜索"),
  results !== null && !reviewState.resultsOpen
    ? el("button", {
        class: "btn ghost",
        type: "button",
        onclick: () => {
          reviewState.resultsOpen = true;
          renderReviewView();
        },
      }, `← 回到「${reviewState.query}」的结果`)
    : null);
};

// Wraps each occurrence of a search term in <mark> (DOM nodes, never HTML).
const reviewMark = (text, terms) => {
  const source = String(text ?? "");
  const lower = source.toLowerCase();
  const parts = [];
  let index = 0;
  while (index < source.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const at = lower.indexOf(term, index);
      if (at !== -1 && (next === -1 || at < next)) {
        next = at;
        length = term.length;
      }
    }
    if (next === -1 || length === 0) {
      parts.push(source.slice(index));
      break;
    }
    parts.push(source.slice(index, next), el("mark", {}, source.slice(next, next + length)));
    index = next + length;
  }
  return parts;
};

const reviewDayChips = (byDay) =>
  el("div", { class: "review-day-chips" }, byDay.slice(0, 40).map((entry) =>
    el("button", { class: "chip", onclick: () => reviewPickDay(entry.day), title: `看 ${reviewShortDay(entry.day)} 的整理` },
      reviewShortDay(entry.day), el("span", { class: "review-chip-count" }, entry.count))));

const reviewHitMeta = (hit) => `${hit.groupName} · ${reviewShortDay(hit.day)} ${reviewClock(hit.sentAt)}`;

const reviewSummaryHit = (hit, terms) =>
  el("li", { class: "review-hit" },
    el("button", { class: "brief-row-button", onclick: () => reviewOpenChat(hit.groupId, hit.groupName, hit.sentAt) },
      el("div", { class: "review-hit-head" },
        el("span", { class: `review-kind ${hit.kind}` }, REVIEW_HIT_LABELS[hit.kind] ?? "摘要"),
        hit.title ? el("strong", {}, reviewMark(hit.title, terms)) : null),
      hit.text ? el("p", {}, reviewMark(hit.text, terms)) : null,
      el("span", { class: "brief-meta" }, reviewHitMeta(hit))),
    el("button", { class: "linklike review-hit-day", onclick: () => reviewPickDay(hit.day) }, "看这天的整理 →"));

const reviewMessageHit = (hit, terms) =>
  el("li", { class: "review-hit message" },
    el("button", { class: "brief-row-button", onclick: () => reviewOpenChat(hit.groupId, hit.groupName, hit.sentAt, hit.rowId) },
      el("div", { class: "review-hit-head" }, el("strong", {}, hit.speaker), el("span", { class: "brief-meta" }, reviewHitMeta(hit))),
      el("p", {}, reviewMark(hit.text, terms))));

const reviewResults = () => {
  const { terms, summaries, messages } = reviewState.results;
  const empty = summaries.total === 0 && messages.total === 0;
  return el("section", { class: "review-results" },
    el("header", { class: "review-results-head" },
      el("h2", {}, `「${reviewState.query}」`),
      el("p", { class: "brief-meta" }, empty
        ? "AI 整理和原文里都没有找到。换个说法，或者只输入一个关键词试试。"
        : `AI 整理里 ${briefNumber(summaries.total)} 处 · 原文里 ${briefNumber(messages.total)} 条（按日期从新到旧）`)),
    summaries.total > 0
      ? el("section", { class: "brief-section" },
          el("h3", { class: "brief-section-title" }, "AI 整理里", el("span", { class: "brief-sub" }, "点一条看当时的聊天，点日期看那天的整理")),
          reviewDayChips(summaries.byDay),
          el("ul", { class: "review-hit-list" }, summaries.items.map((hit) => reviewSummaryHit(hit, terms))))
      : null,
    messages.total > 0
      ? el("section", { class: "brief-section" },
          el("h3", { class: "brief-section-title" }, "原文里", el("span", { class: "brief-sub" }, messages.total > messages.items.length ? `最近 ${messages.items.length} 条` : "")),
          reviewDayChips(messages.byDay),
          el("ul", { class: "review-hit-list" }, messages.items.map((hit) => reviewMessageHit(hit, terms))))
      : null);
};

/* ---------- one day ---------- */

const reviewEstimate = (costs, messages) => {
  const entries = Object.entries(costs ?? {}).filter(([, amount]) => amount > 0);
  if (entries.length === 0) {
    return null;
  }
  return entries.map(([currency, amount]) => {
    const value = (amount * messages) / 1000;
    const sign = currency === "USD" ? "$" : "¥";
    return value < 0.01 ? `不到 ${sign}0.01` : `${sign}${value.toFixed(2)}`;
  }).join(" + ");
};

const reviewBackfill = async (data, estimate) => {
  const calls = data.status.backfillChunks;
  const question = `补齐 ${reviewShortDay(data.day)} 的 AI 总结？\n\n约 ${calls} 次 AI 调用${estimate ? `，按你最近的用量预计 ${estimate}` : ""}。\n后台几分钟内做完，做完后这页会自动更新。`;
  if (!window.confirm(question)) {
    return;
  }
  reviewState.busy = true;
  renderReviewView();
  try {
    const result = await api("/api/review/backfill", { method: "POST", body: JSON.stringify({ day: data.day }) });
    reviewState.notice = result.chunks === 0
      ? "这天没有需要补齐的消息。"
      : result.started
        ? `已排队 ${result.chunks} 段（${briefNumber(result.messages)} 条），后台正在总结…`
        : `已排队 ${result.chunks} 段。后台正在忙别的，会在下一轮刷新时补上。`;
  } catch (error) {
    reviewState.notice = error.message;
  }
  reviewState.busy = false;
  await loadReviewDay(data.day, { silent: true });
};

const reviewBackfillAction = (data) => {
  const { totals, status } = data;
  if (totals.backfillable === 0) {
    return totals.uncovered > 0 && data.day === reviewToday()
      ? el("p", { class: "brief-meta" }, "今天剩下的新消息由后台简报自动总结。")
      : null;
  }
  if (!status.llmConfigured) {
    return el("p", { class: "brief-meta" }, `还有 ${briefNumber(totals.backfillable)} 条没有 AI 整理。配置 AI 服务后可以补齐。`);
  }
  const estimate = reviewEstimate(status.perThousandCost, totals.backfillable);
  return el("div", { class: "review-backfill" },
    el("span", {}, `还有 ${briefNumber(totals.backfillable)} 条没有 AI 整理`),
    el("button", {
      class: "btn small primary",
      disabled: reviewState.busy || status.pause?.paused,
      onclick: () => reviewBackfill(data, estimate),
    }, "补齐这天的总结"),
    el("span", { class: "brief-meta" }, status.pause?.paused
      ? "AI 整理已暂停，恢复后才能补齐"
      : `约 ${status.backfillChunks} 次 AI 调用${estimate ? `，约 ${estimate}` : ""}`));
};

const reviewCoverage = (data) => {
  const { totals } = data;
  const share = (count) => `${((count / totals.textMessages) * 100).toFixed(1)}%`;
  return el("div", { class: "review-coverage" },
    el("div", {
      class: "review-coverage-bar",
      role: "img",
      "aria-label": `AI 已整理 ${totals.summarized} 条，排队 ${totals.queued} 条，未整理 ${totals.uncovered} 条`,
    },
    el("span", { class: "done", style: `width:${share(totals.summarized)}` }),
    el("span", { class: "queued", style: `width:${share(totals.queued)}` })),
    el("p", { class: "review-coverage-text" },
      `AI 已整理 ${briefNumber(totals.summarized)} / ${briefNumber(totals.textMessages)} 条文字消息`,
      totals.queued > 0 ? `，${briefNumber(totals.queued)} 条正在排队` : ""),
    reviewBackfillAction(data));
};

const reviewNeighbor = (day, direction) => {
  const days = (reviewState.calendar?.days ?? []).map((entry) => entry.day);
  return direction < 0 ? days.filter((item) => item < day).at(-1) ?? null : days.find((item) => item > day) ?? null;
};

const reviewDayHead = (data) => {
  const { totals } = data;
  const total = totals.textMessages + totals.mediaMessages;
  const previous = reviewNeighbor(data.day, -1);
  const next = reviewNeighbor(data.day, 1);
  return el("section", { class: "brief-mast review-mast" },
    el("div", { class: "review-mast-top" },
      el("p", { class: "brief-dateline" }, reviewDayLabel(data.day), data.day === reviewToday() ? " · 今天" : ""),
      el("div", { class: "review-day-nav" },
        el("button", { class: "btn small ghost", disabled: previous === null, onclick: () => reviewPickDay(previous) }, "‹ 前一天"),
        el("button", { class: "btn small ghost", disabled: next === null, onclick: () => reviewPickDay(next) }, "后一天 ›"))),
    total > 0
      ? el("h2", { class: "brief-headline" },
          el("span", { class: "brief-figure" }, briefNumber(totals.groups)), " 个群  ",
          el("span", { class: "brief-figure" }, briefNumber(total)), " 条消息")
      : el("h2", { class: "brief-headline quiet" }, "这天没有记录到消息"),
    totals.textMessages > 0 ? reviewCoverage(data) : null,
    reviewState.notice ? el("p", { class: "brief-notice" }, reviewState.notice) : null);
};

const reviewPanel = (key, title, items, renderItem) => {
  if (items.length === 0) {
    return null;
  }
  const expanded = reviewState.expanded[`panel:${key}`] === true;
  const shown = expanded ? items : items.slice(0, REVIEW_PANEL_PREVIEW);
  return el("div", { class: `brief-panel ${key}` },
    el("h4", {}, title, el("span", { class: "brief-panel-count" }, items.length)),
    el("ul", {}, shown.map(renderItem)),
    items.length > shown.length
      ? el("button", { class: "btn small ghost brief-more", onclick: () => reviewToggle(`panel:${key}`) }, `展开其余 ${items.length - shown.length} 个`)
      : null);
};

const reviewHighlights = (data) => {
  const { newThings, qa } = data.highlights;
  if (newThings.length + qa.length === 0) {
    return null;
  }
  return el("section", { class: "brief-section" },
    el("h3", { class: "brief-section-title" }, "这天的收获"),
    el("div", { class: "brief-bento review-bento" },
      reviewPanel("things", "新东西", newThings, briefNewThing),
      reviewPanel("qa", "问答", qa, briefQa)));
};

// A group's day as one time-ordered list: the AI timeline entries, or the
// chunk's summary where the model gave no timeline.
const reviewEntries = (group) =>
  group.sections.flatMap((section) => (section.timeline.length > 0
    ? section.timeline.map((item) => ({
        at: item.startSentAt,
        time: [item.start, item.end].filter(Boolean).map((text) => String(text).slice(11, 16)).join("–"),
        title: item.title,
        text: item.summary,
      }))
    : [{
        at: section.startSentAt,
        time: `${reviewClock(section.startSentAt)}–${reviewClock(section.endSentAt)}`,
        title: "",
        text: section.summary,
      }])).sort((left, right) => left.at - right.at);

const reviewEntry = (group, entry) =>
  el("li", { class: "review-tl" },
    el("button", { class: "brief-row-button", onclick: () => reviewOpenChat(group.groupId, group.name, entry.at), title: "看当时的聊天" },
      el("span", { class: "review-tl-time" }, entry.time),
      el("div", { class: "review-tl-body" },
        entry.title ? el("strong", {}, entry.title) : null,
        el("p", {}, entry.text))));

const reviewGroupStatus = (group, hasEntries) => {
  if (!hasEntries) {
    return el("p", { class: "review-group-empty" }, group.queued > 0 ? "正在排队总结…" : group.textMessages === 0 ? "这天只有图片和表情。" : "这天的消息还没有 AI 整理。");
  }
  return group.uncovered > 0 ? el("p", { class: "brief-meta" }, `另有 ${briefNumber(group.uncovered)} 条还没整理`) : null;
};

const reviewGroup = (group) => {
  const entries = reviewEntries(group);
  const expanded = reviewState.expanded[group.groupId] === true;
  const shown = expanded ? entries : entries.slice(0, REVIEW_TIMELINE_PREVIEW);
  const topics = [...new Set(group.topics.map((topic) => topic.title))].slice(0, 8);
  return el("article", { class: "review-group" },
    el("header", { class: "review-group-head" },
      avatarEl(group.name, group.groupId, "", groupAvatarUrl(group.groupId)),
      el("div", { class: "review-group-title" },
        el("strong", {}, group.name),
        el("span", { class: "brief-meta" },
          `${briefNumber(group.textMessages)} 条`,
          group.mediaMessages > 0 ? ` · ${briefNumber(group.mediaMessages)} 图` : "",
          ` · ${group.speakers} 人 · ${reviewClock(group.firstSentAt)}–${reviewClock(group.lastSentAt)}`)),
      el("button", { class: "btn small", onclick: () => reviewOpenChat(group.groupId, group.name, group.firstSentAt) }, "看当天原文")),
    topics.length > 0 ? el("div", { class: "brief-group-topics" }, topics.map((title) => el("span", { class: "tag plain" }, title))) : null,
    entries.length > 0 ? el("ol", { class: "review-timeline" }, shown.map((entry) => reviewEntry(group, entry))) : null,
    entries.length > shown.length || expanded
      ? el("button", { class: "btn small ghost", onclick: () => reviewToggle(group.groupId) }, expanded ? "收起" : `展开其余 ${entries.length - shown.length} 段`)
      : null,
    reviewGroupStatus(group, entries.length > 0));
};

const reviewDayContent = () => {
  const data = reviewState.data;
  if (data === null) {
    return el("p", { class: "brief-meta" }, reviewState.loading ? "正在读取…" : "");
  }
  return el("div", { class: `review-day ${reviewState.loading ? "loading" : ""}` },
    reviewDayHead(data),
    reviewHighlights(data),
    data.groups.length > 0
      ? el("section", { class: "brief-section" },
          el("h3", { class: "brief-section-title" }, "各群这天聊了什么", el("span", { class: "brief-sub" }, "点任意一段看当时的聊天")),
          el("div", { class: "review-groups" }, data.groups.map(reviewGroup)))
      : null);
};

/* ---------- calendar ---------- */

const reviewCalLabel = (day, info) => (info
  ? `${reviewDayLabel(day)} · ${briefNumber(info.textMessages + info.mediaMessages)} 条 · ${info.groups} 个群${info.summarized ? " · 已有 AI 整理" : ""}`
  : `${reviewDayLabel(day)} · 没有记录`);

const reviewShiftMonth = (delta) => {
  const [year, month] = (reviewState.month ?? reviewToday().slice(0, 7)).split("-").map(Number);
  reviewState.month = new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 7);
  renderReviewView();
};

// Bar length = that day's message volume (one hue; length reads more exactly
// than shade). "AI" marks days with summaries, so it is never colour alone.
const reviewCalCell = (day, info, max, readout) =>
  el("button", {
    class: ["review-cal-day", day === reviewState.day ? "on" : "", day === reviewToday() ? "today" : "", info ? "" : "empty"].join(" "),
    disabled: !info,
    "aria-pressed": String(day === reviewState.day),
    "aria-label": reviewCalLabel(day, info),
    onclick: () => reviewPickDay(day),
    onmouseenter: () => { readout.textContent = reviewCalLabel(day, info); },
    onfocus: () => { readout.textContent = reviewCalLabel(day, info); },
  },
  el("span", { class: "review-cal-num" }, String(Number(day.slice(8)))),
  info?.summarized ? el("span", { class: "review-cal-ai" }, "AI") : null,
  info ? el("span", { class: "review-cal-bar", style: `width:${Math.max(8, Math.round(((info.textMessages + info.mediaMessages) / max) * 100))}%` }) : null);

const reviewCalendar = () => {
  const calendar = reviewState.calendar;
  if (calendar === null) {
    return null;
  }
  const month = reviewState.month ?? reviewToday().slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const byDay = new Map(calendar.days.map((entry) => [entry.day, entry]));
  const max = Math.max(1, ...calendar.days.map((entry) => entry.textMessages + entry.mediaMessages));
  const lead = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const selected = reviewState.day;
  const readout = el("p", { class: "review-cal-readout", "aria-live": "polite" },
    selected ? reviewCalLabel(selected, byDay.get(selected)) : "");
  const days = Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  return el("section", { class: "review-cal", "aria-label": "按日期回顾" },
    el("header", { class: "review-cal-head" },
      el("button", { class: "btn small ghost", "aria-label": "上个月", disabled: month <= (calendar.firstDay ?? month).slice(0, 7), onclick: () => reviewShiftMonth(-1) }, "‹"),
      el("strong", {}, `${year} 年 ${monthNumber} 月`),
      el("button", { class: "btn small ghost", "aria-label": "下个月", disabled: month >= reviewToday().slice(0, 7), onclick: () => reviewShiftMonth(1) }, "›")),
    el("div", { class: "review-cal-grid" },
      REVIEW_WEEKDAYS.map((weekday) => el("span", { class: "review-cal-wd", "aria-hidden": "true" }, weekday)),
      Array.from({ length: lead }, () => el("span", { class: "review-cal-pad" })),
      days.map((day) => reviewCalCell(day, byDay.get(day), max, readout))),
    readout,
    el("p", { class: "review-cal-legend" },
      el("span", { class: "review-cal-legend-bar" }), "条越长消息越多",
      el("span", { class: "review-cal-ai" }, "AI"), "已有 AI 整理"),
    calendar.firstDay
      ? el("p", { class: "brief-meta" }, `本地记录从 ${reviewShortDay(calendar.firstDay)} 开始。更早的日子可以用「自定义时间范围总结」读进来。`)
      : null);
};

const renderReviewView = () => {
  const root = $("#view-review");
  if (root === null) {
    return;
  }
  const showResults = reviewState.resultsOpen && reviewState.results !== null;
  setChildren(root, el("div", { class: "review-page" },
    reviewSearchBar(),
    reviewState.error ? el("div", { class: "notice risk review-error" }, reviewState.error) : null,
    el("div", { class: "review-main" }, showResults ? reviewResults() : reviewDayContent()),
    el("aside", { class: "review-side" }, reviewCalendar())));
};
