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
const REVIEW_HIT_LABELS = { topic: "话题", newThing: "新东西", link: "链接", qa: "问答", timeline: "时间线", summary: "摘要" };
// The two libraries: one kind of thing from the AI's notes, listed without a
// search word, searchable with one. (search state: reviewState.library)
const REVIEW_LIBRARIES = {
  qa: { title: "问答库", hint: "群里有人问过、AI 整理记下来的问题", placeholder: "在问答里搜：留空就列出全部" },
  resource: { title: "资源库", hint: "群里提到的新东西和分享的链接", placeholder: "在资源里搜：留空就列出全部" },
};
const REVIEW_QA_FILTERS = [["all", "全部"], ["answered", "有回答的"], ["open", "没人回答的"]];

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
  // "all" | "7" | "30" | "custom" (searchFrom..searchTo, both days included).
  searchRange: "all",
  // null: the ordinary search. "qa" | "resource": that library.
  library: null,
  // Other ways of saying the search words, from the AI (「换几种说法再搜」), and whether it is being asked.
  also: [],
  expanding: false,
  qaFilter: "all",
  searchFrom: null,
  searchTo: null,
  searchTicket: 0,
  // Which results' day chips show every day, not just the newest 40.
  dayChipsOpen: new Set(),
  results: null,
  resultsOpen: false,
  searching: false,
  expanded: {},
  pollTimer: null,
  polls: 0,
  // A weekly / monthly report open in the main column: { kind, period }.
  report: null,
  // The 「正在读取」 line shown while the page has nothing else (see reviewIdle).
  waitLine: null,
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
  const library = REVIEW_LIBRARIES[preset.library] === undefined ? null : preset.library;
  if (library !== null || (typeof preset.query === "string" && preset.query.trim().length > 0)) {
    // A search opened from another page brings its own range (all time unless
    // it says otherwise), never the one last picked here. A library opens on
    // the last 30 days: all of it at once is a long list to put together.
    Object.assign(reviewState, { searchRange: library === null ? "all" : "30", library, qaFilter: "all" }, preset.range ?? {});
    await runReviewSearch(preset.query ?? "");
    await loadReviewDay(preset.day ?? reviewState.day ?? reviewDefaultDay());
    return;
  }
  const loading = loadReviewDay(preset.day ?? reviewState.day ?? reviewDefaultDay());
  markViewStep(reviewStepNow());
  await loading;
};

/* ---------- back and forward between a day, a report and a search ---------- */

// What the main column shows, as a history step.
const reviewStepNow = () => {
  if (reviewState.resultsOpen && reviewState.results !== null) {
    return { search: reviewState.query, ...(reviewState.library === null ? {} : { library: reviewState.library }) };
  }
  return reviewState.report === null ? { day: reviewState.day } : { report: reviewState.report };
};

// One day to another is like turning a page of the calendar: it replaces the
// entry, so back leaves the calendar instead of walking through every day.
const markReviewStep = () => {
  const step = reviewStepNow();
  markViewStep(step, { replace: step.day !== undefined && currentEntry()?.step?.day !== undefined });
};

const reviewPickReport = (kind, period) => {
  reviewState.report = { kind, period };
  reviewState.resultsOpen = false;
  markReviewStep();
  renderReviewView();
};

const reviewPickDay = (day) => {
  reviewState.report = null;
  reviewState.resultsOpen = false;
  reviewState.notice = null;
  reviewState.expanded = {};
  reviewState.day = day;
  markReviewStep();
  loadReviewDay(day);
  $("#view-review")?.scrollIntoView?.({ block: "start" });
};

const reviewBackToDay = () => goBackTo((prev) => prev.view === "review" && prev.step?.day === reviewState.day, () => {
  reviewState.report = null;
  markReviewStep();
  renderReviewView();
});

const reviewBackToResults = () => goBackTo((prev) => prev.view === "review" && prev.step?.search === reviewState.query && (prev.step?.library ?? null) === reviewState.library, () => {
  reviewState.resultsOpen = true;
  markReviewStep();
  renderReviewView();
});

VIEW_STEP_RESTORERS.review = (step) => {
  const library = step?.library ?? null;
  if (typeof step?.search === "string" && (step.search !== "" || library !== null)) {
    if (reviewState.results !== null && reviewState.query === step.search && reviewState.library === library) {
      reviewState.resultsOpen = true;
      showView("review");
      renderReviewView();
      return;
    }
    openReviewView({ query: step.search, library });
    return;
  }
  reviewState.resultsOpen = false;
  reviewState.report = step?.report ?? null;
  openReviewView(typeof step?.day === "string" ? { day: step.day } : {});
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

/* ---------- search, over all time / the last 7 or 30 days / chosen days ---------- */

const REVIEW_SEARCH_RANGES = [["all", "全部时间"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["custom", "选日期…"]];

// Whole Beijing days, today included.
const reviewSearchRangeUnix = () => {
  const range = reviewState.searchRange;
  if (range === "7" || range === "30") {
    return { fromUnix: reviewDayUnix(reviewShiftDay(reviewToday(), 1 - Number(range))), toUnix: null };
  }
  if (range === "custom") {
    return { fromUnix: reviewDayUnix(reviewState.searchFrom), toUnix: reviewDayUnix(reviewShiftDay(reviewState.searchTo, 1)) };
  }
  return { fromUnix: null, toUnix: null };
};

const reviewSearchParams = (extra = {}) => {
  const params = new URLSearchParams({
    q: reviewState.query,
    ...(reviewState.library === null ? {} : { library: reviewState.library }),
    ...(reviewState.library === "qa" && reviewState.qaFilter !== "all" ? { answered: reviewState.qaFilter === "answered" ? "yes" : "no" } : {}),
    ...(reviewState.library === null && reviewState.also.length > 0 ? { also: reviewState.also.join("\n") } : {}),
    ...extra,
  });
  const { fromUnix, toUnix } = reviewSearchRangeUnix();
  if (fromUnix !== null) {
    params.set("fromUnix", String(fromUnix));
  }
  if (toUnix !== null) {
    params.set("toUnix", String(toUnix));
  }
  return params;
};

const setReviewSearchRange = (patch) => {
  Object.assign(reviewState, patch);
  if (reviewState.searchRange === "custom" && reviewState.searchFrom === null) {
    reviewState.searchTo = reviewToday();
    reviewState.searchFrom = reviewShiftDay(reviewState.searchTo, -29);
  }
  runReviewSearch(reviewState.query);
};

const reviewSearchRangeControl = () => {
  const range = reviewState.searchRange;
  return el("div", { class: "review-search-range" },
    el("div", { class: "wall-modes", role: "group", "aria-label": "搜索的时间范围" }, REVIEW_SEARCH_RANGES.map(([key, label]) => el("button", {
      class: `wall-mode ${range === key ? "active" : ""}`,
      type: "button",
      "aria-pressed": String(range === key),
      onclick: () => setReviewSearchRange({ searchRange: key }),
    }, label))),
    range === "custom"
      ? el("span", { class: "trends-dates active" },
        el("input", { type: "date", value: reviewState.searchFrom, "aria-label": "开始日期", onchange: (event) => {
          const value = event.target.value;
          if (value !== "") {
            setReviewSearchRange({ searchFrom: value, searchTo: value > reviewState.searchTo ? value : reviewState.searchTo });
          }
        } }),
        el("span", {}, "至"),
        el("input", { type: "date", value: reviewState.searchTo, "aria-label": "结束日期", onchange: (event) => {
          const value = event.target.value;
          if (value !== "") {
            setReviewSearchRange({ searchTo: value, searchFrom: value < reviewState.searchFrom ? value : reviewState.searchFrom });
          }
        } }))
      : null);
};

const runReviewSearch = async (query) => {
  // A quick second search (another range chip, or clearing the box) outruns
  // the first; only the latest one's answer is shown.
  reviewState.searchTicket += 1;
  const ticket = reviewState.searchTicket;
  // Other words go with the words they were made for.
  if (String(query ?? "").trim() !== reviewState.query) {
    reviewState.also = [];
  }
  reviewState.query = String(query ?? "").trim();
  // A library lists everything when nothing is typed; the ordinary search needs a word.
  if (reviewState.query.length === 0 && reviewState.library === null) {
    reviewState.results = null;
    reviewState.resultsOpen = false;
    reviewState.searching = false;
    markReviewStep();
    renderReviewView();
    return;
  }
  reviewState.searching = true;
  reviewState.summaryShown = REVIEW_HIT_STEP;
  reviewState.dayChipsOpen = new Set();
  renderReviewView();
  try {
    const results = await api(`/api/review/search?${reviewSearchParams()}`);
    if (ticket !== reviewState.searchTicket) {
      return;
    }
    reviewState.results = results;
    reviewState.resultsOpen = true;
    reviewState.error = null;
    // Only while 回顾 is still the page shown: else it would label another page's entry.
    if (app.view === "review") {
      markReviewStep();
    }
  } catch (error) {
    if (ticket !== reviewState.searchTicket) {
      return;
    }
    reviewState.error = error.message;
  }
  reviewState.searching = false;
  renderReviewView();
};

const reviewSearchBar = () => {
  const input = el("input", {
    type: "search",
    class: "review-search-input",
    placeholder: REVIEW_LIBRARIES[reviewState.library]?.placeholder ?? "搜话题、模型名、关键词：哪天聊过？",
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
  reviewLibraryButtons(input),
  results !== null && !reviewState.resultsOpen
    ? el("button", {
        class: "btn ghost",
        type: "button",
        onclick: reviewBackToResults,
      }, `← 回到${reviewResultsName()}的结果`)
    : null);
};

// 「问答库」「资源库」 beside the search: the one that is open is pressed, and
// pressing it again goes back to the ordinary search.
const reviewLibraryButtons = (input) => Object.entries(REVIEW_LIBRARIES).map(([key, library]) => el("button", {
  class: reviewState.library === key ? "btn active" : "btn",
  type: "button",
  title: library.hint,
  "aria-pressed": String(reviewState.library === key),
  onclick: () => {
    const opening = reviewState.library !== key;
    const wasOrdinary = reviewState.library === null;
    Object.assign(reviewState, { library: opening ? key : null, qaFilter: "all" });
    // A library opens on the last 30 days (all of it is a long list); leaving
    // it gives the ordinary search its own range back.
    if (opening && wasOrdinary) {
      reviewState.rangeBeforeLibrary = reviewState.searchRange;
      if (reviewState.searchRange === "all") {
        reviewState.searchRange = "30";
      }
    } else if (!opening && reviewState.rangeBeforeLibrary) {
      reviewState.searchRange = reviewState.rangeBeforeLibrary;
      reviewState.rangeBeforeLibrary = null;
    }
    // What is on screen belongs to the other list.
    reviewState.results = null;
    runReviewSearch(input.value);
  },
}, library.title));

// "「flux」" / "问答库" / "问答库里的「flux」"
const reviewResultsName = () => {
  const library = REVIEW_LIBRARIES[reviewState.library]?.title ?? null;
  if (library === null) {
    return `「${reviewState.query}」`;
  }
  return reviewState.query === "" ? library : `${library}里的「${reviewState.query}」`;
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

const REVIEW_DAY_CHIPS_PREVIEW = 40;

// kind: "summaries" | "messages", which list's days (each opens on its own).
const reviewDayChips = (byDay, kind) => {
  const shown = reviewState.dayChipsOpen.has(kind) ? byDay : byDay.slice(0, REVIEW_DAY_CHIPS_PREVIEW);
  return el("div", { class: "review-day-chips" },
    shown.map((entry) =>
      el("button", { class: "chip", onclick: () => reviewPickDay(entry.day), title: `看 ${reviewShortDay(entry.day)} 的整理` },
        reviewShortDay(entry.day), el("span", { class: "review-chip-count" }, entry.count))),
    byDay.length > shown.length
      ? el("button", {
          class: "chip review-chip-more",
          onclick: () => {
            reviewState.dayChipsOpen = new Set([...reviewState.dayChipsOpen, kind]);
            renderReviewView();
          },
        }, `还有 ${byDay.length - shown.length} 天…`)
      : null);
};

const reviewHitMeta = (hit) => `${hit.groupName} · ${reviewShortDay(hit.day)} ${reviewClock(hit.sentAt)}`;

// Who asked and who answered (a question), or who brought it up (a thing).
const reviewHitPeople = (hit) => {
  if (hit.kind === "qa") {
    return [hit.asker ? `${hit.asker} 问` : null, hit.answered ? (hit.answerer ? `${hit.answerer} 答` : null) : "没人回答"].filter(Boolean).join(" · ");
  }
  return hit.by ? `${hit.by} 提到` : "";
};

const reviewSummaryHit = (hit, terms) => {
  const people = reviewHitPeople(hit);
  return el("li", { class: "review-hit" },
    el("button", { class: "brief-row-button", onclick: () => reviewOpenChat(hit.groupId, hit.groupName, hit.sentAt) },
      el("div", { class: "review-hit-head" },
        el("span", { class: `review-kind ${hit.kind}` }, REVIEW_HIT_LABELS[hit.kind] ?? "摘要"),
        hit.title ? el("strong", {}, reviewMark(hit.title, terms)) : null),
      hit.text ? el("p", {}, reviewMark(hit.text, terms)) : null,
      el("span", { class: "brief-meta" }, people ? `${people} · ` : "", reviewHitMeta(hit))),
    hit.url ? el("a", { class: "review-hit-url", href: hit.url, target: "_blank", rel: "noopener noreferrer", title: "在浏览器里打开这个链接" }, hit.url) : null,
    el("button", { class: "linklike review-hit-day", onclick: () => reviewPickDay(hit.day) }, "看这天的整理 →"));
};

const reviewMessageHit = (hit, terms) =>
  el("li", { class: "review-hit message" },
    el("button", { class: "brief-row-button", onclick: () => reviewOpenChat(hit.groupId, hit.groupName, hit.sentAt, hit.rowId) },
      el("div", { class: "review-hit-head" }, el("strong", {}, hit.speaker), el("span", { class: "brief-meta" }, reviewHitMeta(hit))),
      el("p", {}, reviewMark(hit.text, terms))));

const REVIEW_HIT_STEP = 50;

// More raw-message hits: the next page from the server, appended.
const loadMoreReviewMessages = async () => {
  const results = reviewState.results;
  const ticket = reviewState.searchTicket;
  try {
    const page = await api(`/api/review/search?${reviewSearchParams({ messageOffset: results.messages.items.length, more: "1" })}`);
    if (ticket !== reviewState.searchTicket) {
      return;
    }
    reviewState.results = { ...results, messages: { ...results.messages, items: [...results.messages.items, ...page.messages.items] } };
  } catch (error) {
    reviewState.error = error.message;
  }
  renderReviewView();
};

// The next page of a library from the server, appended and shown.
const loadMoreLibraryHits = async () => {
  const results = reviewState.results;
  const ticket = reviewState.searchTicket;
  try {
    const page = await api(`/api/review/search?${reviewSearchParams({ summaryOffset: results.summaries.items.length })}`);
    if (ticket !== reviewState.searchTicket) {
      return;
    }
    // New notes may have come in since the first page and pushed the list down:
    // what is already listed is not listed twice, and the count is the newest one.
    const key = (hit) => `${hit.chunkId}|${hit.kind}|${hit.title}`;
    const listed = new Set(results.summaries.items.map(key));
    const fresh = page.summaries.items.filter((hit) => !listed.has(key(hit)));
    const items = [...results.summaries.items, ...fresh];
    reviewState.results = { ...results, summaries: { ...page.summaries, total: fresh.length === 0 ? items.length : Math.max(page.summaries.total, items.length), items } };
    reviewState.summaryShown = (reviewState.summaryShown ?? REVIEW_HIT_STEP) + REVIEW_HIT_STEP;
  } catch (error) {
    reviewState.error = error.message;
  }
  renderReviewView();
};

// 「换几种说法再搜」: asks the AI how else the chats may have said it, then
// searches for any of those words as well.
const REVIEW_EXPAND_POLL_MS = 1200;
const REVIEW_EXPAND_TRIES = 50;

const expandReviewSearch = async () => {
  const query = reviewState.query;
  reviewState.expanding = true;
  renderReviewView();
  try {
    await api("/api/review/expand", { method: "POST", body: JSON.stringify({ q: query }) });
    let job = null;
    for (let tries = 0; tries < REVIEW_EXPAND_TRIES; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, REVIEW_EXPAND_POLL_MS));
      job = (await api("/api/review/expand")).job;
      if (job === null || job.status !== "running") {
        break;
      }
    }
    if (job?.status === "failed") {
      throw new Error(job.error ?? "AI 没有回答");
    }
    if (job?.status !== "done") {
      throw new Error("AI 太久没有回答，稍后再试。");
    }
    // The reader may have searched for something else meanwhile.
    if (reviewState.query === query && reviewState.library === null) {
      if (job.result.terms.length === 0) {
        notify("AI 没有想到别的说法。");
      } else {
        reviewState.also = job.result.terms;
        reviewState.expanding = false;
        await runReviewSearch(query);
        return;
      }
    }
  } catch (error) {
    notifyError(error);
  }
  reviewState.expanding = false;
  renderReviewView();
};

// Under the results' heading: the button, or the words that were added.
const reviewExpandLine = () => {
  if (reviewState.library !== null || reviewState.query === "") {
    return null;
  }
  if (reviewState.also.length > 0) {
    return el("p", { class: "brief-meta review-also" }, "也搜了：", reviewState.also.join("、"), " ",
      el("button", {
        class: "linklike", type: "button",
        onclick: () => {
          reviewState.also = [];
          runReviewSearch(reviewState.query);
        },
      }, "只搜我输入的"));
  }
  return el("p", { class: "brief-meta review-also" },
    el("button", {
      class: "linklike", type: "button", disabled: reviewState.expanding,
      title: "群里可能用了别的说法（简称、英文名、外号）：让 AI 想几个，再一起搜。会调用一次你设置的 AI 服务，只发送你输入的搜索词。",
      onclick: expandReviewSearch,
    }, reviewState.expanding ? "AI 在想别的说法…" : "没找到想要的？换几种说法再搜"));
};

const moreHitsButton = (label, onclick) => el("button", { class: "btn small review-more", type: "button", onclick }, label);

const reviewResults = () => {
  const { terms, summaries, messages } = reviewState.results;
  const summaryShown = reviewState.summaryShown ?? REVIEW_HIT_STEP;
  const empty = summaries.total === 0 && messages.total === 0;
  const library = REVIEW_LIBRARIES[reviewState.library] ?? null;
  const listed = summaries.items;
  // A library comes a page at a time: the rest is still on the server.
  const waiting = summaries.total - listed.length;
  const emptyLine = () => {
    if (library !== null) {
      return reviewState.searchRange === "all" ? "AI 整理里还没有这一类内容。" : "这段时间里没有。换成「全部时间」试试。";
    }
    return reviewState.searchRange === "all"
      ? "AI 整理和原文里都没有找到。换个说法，或者只输入一个关键词试试。"
      : "这段时间里没有找到。换成「全部时间」，或者换个说法试试。";
  };
  return el("section", { class: "review-results" },
    el("header", { class: "review-results-head" },
      el("h2", {}, reviewResultsName()),
      reviewSearchRangeControl(),
      reviewExpandLine(),
      reviewState.library === "qa"
        ? el("div", { class: "wall-modes", role: "group", "aria-label": "只看" }, REVIEW_QA_FILTERS.map(([key, label]) => el("button", {
          class: `wall-mode ${reviewState.qaFilter === key ? "active" : ""}`,
          type: "button",
          "aria-pressed": String(reviewState.qaFilter === key),
          onclick: () => {
            reviewState.qaFilter = key;
            runReviewSearch(reviewState.query);
          },
        }, label)))
        : null,
      el("p", { class: "brief-meta" }, empty
        ? emptyLine()
        : library !== null
          ? `${library.hint} · ${briefNumber(summaries.total)} 条（按日期从新到旧）`
          : `AI 整理里 ${briefNumber(summaries.total)} 处 · 原文里 ${briefNumber(messages.total)} 条（按日期从新到旧）`)),
    summaries.total > 0
      ? el("section", { class: "brief-section" },
          library !== null ? null : el("h3", { class: "brief-section-title" }, "AI 整理里", el("span", { class: "brief-sub" }, "点一条看当时的聊天，点日期看那天的整理")),
          reviewDayChips(summaries.byDay, "summaries"),
          el("ul", { class: "review-hit-list" }, listed.slice(0, summaryShown).map((hit) => reviewSummaryHit(hit, terms))),
          listed.length <= summaryShown && waiting > 0
            ? moreHitsButton(`再显示更多（还有 ${briefNumber(waiting)} 条）`, loadMoreLibraryHits)
            : null,
          listed.length > summaryShown
            ? moreHitsButton(`再显示 ${Math.min(REVIEW_HIT_STEP, listed.length - summaryShown)} 处（共 ${briefNumber(summaries.total)} 处）`, () => {
              reviewState.summaryShown = summaryShown + REVIEW_HIT_STEP;
              renderReviewView();
            })
            : null)
      : null,
    messages.total > 0
      ? el("section", { class: "brief-section" },
          el("h3", { class: "brief-section-title" }, "原文里", el("span", { class: "brief-sub" }, `已显示 ${briefNumber(messages.items.length)} / ${briefNumber(messages.total)} 条`)),
          reviewDayChips(messages.byDay, "messages"),
          el("ul", { class: "review-hit-list" }, messages.items.map((hit) => reviewMessageHit(hit, terms))),
          messages.total > messages.items.length
            ? moreHitsButton(`再显示更多（还有 ${briefNumber(messages.total - messages.items.length)} 条）`, loadMoreReviewMessages)
            : null)
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
  if (!await confirmInPage(question)) {
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
    if (totals.uncovered === 0 || data.day !== reviewToday()) {
      return null;
    }
    // 简报 knows whether refresh and 自动 AI 总结 are on; before it loaded, say nothing.
    if (briefState.data === null) {
      return null;
    }
    return el("p", { class: "brief-meta" }, briefAutoSummaryOn(briefState.data)
      ? "今天剩下的新消息由后台简报自动总结。"
      : linked("今天剩下的新消息不会自动总结：后台刷新或自动 AI 总结关着（在「设置 → 后台与通知」打开）。"));
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
    digestCard("day", data.day, { title: "这天的各群总览", emptyText: "这一天还没有跨群总览。有 AI 摘要的日子都可以生成。" }),
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

// The main column holds nothing yet (the day is still loading or did not
// load, and no search or report is open): the report lists use that space.
const reviewMainIsEmpty = () => reviewState.data === null && reviewState.report === null && !(reviewState.resultsOpen && reviewState.results !== null);

const reviewIdle = () => {
  // One line for the whole wait: a redraw puts the same node back, so its count is not restarted.
  if (reviewState.error !== null) {
    reviewState.waitLine = null;
  } else if (reviewState.waitLine === null) {
    reviewState.waitLine = el("p", { class: "brief-loading" }, waiting("正在读取这一天…"));
  }
  return el("div", { class: "review-idle" },
    reviewState.waitLine,
    el("div", { class: "review-idle-lists" },
      digestReportList("week", reviewPickReport, null),
      digestReportList("month", reviewPickReport, null)));
};

const reviewMainContent = (showResults, report) => {
  if (showResults) {
    return reviewResults();
  }
  if (report !== null) {
    return el("div", { class: "review-report" },
      el("button", { class: "btn small ghost", onclick: reviewBackToDay }, "‹ 回到这一天"),
      digestCard(report.kind, report.period, { emptyText: "还没有生成。点下面的按钮，缺的每日总览会先补上，再写成报告。" }));
  }
  return reviewMainIsEmpty() ? reviewIdle() : reviewDayContent();
};

const renderReviewView = () => {
  const root = $("#view-review");
  if (root === null) {
    return;
  }
  const showResults = reviewState.resultsOpen && reviewState.results !== null;
  const report = reviewState.report;
  const idle = !showResults && reviewMainIsEmpty();
  const main = reviewMainContent(showResults, report);
  if (!idle) {
    reviewState.waitLine = null;
  }
  const selected = report === null ? null : digestKey(report.kind, report.period);
  // While the reports sit in the main column the side holds only the calendar.
  const side = idle
    ? [reviewCalendar()]
    : [reviewCalendar(), digestReportList("week", reviewPickReport, selected), digestReportList("month", reviewPickReport, selected)];
  const hasSide = side.some((part) => part !== null);
  setChildren(root, el("div", { class: `review-page ${hasSide ? "" : "no-side"}` },
    reviewSearchBar(),
    reviewState.error ? el("div", { class: "notice risk review-error" }, reviewState.error) : null,
    el("div", { class: "review-main" }, main),
    hasSide ? el("aside", { class: "review-side" }, side) : null));
};
