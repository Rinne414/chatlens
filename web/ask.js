"use strict";

/* ---------- 问群聊: ask a question about the chat history ----------
   The server finds the relevant messages locally, then the AI answers from
   those messages only and cites them; each citation opens that moment in the
   chat. Earlier questions stay in the history list. */

const ASK_POLL_MS = 2500;
const ASK_ORIGIN = { view: "ask", label: "问群聊" };
const ASK_CONFIDENCE = { high: "记录里有明确答案", medium: "有相关讨论，不完全确定", low: "只有零星线索" };
const ASK_RANGES = [[0, "全部"], [7, "最近 7 天"], [30, "最近 30 天"], [90, "最近 90 天"]];
const ASK_CITATION_PREVIEW = 8;

const askState = {
  history: [],
  pageSize: 50,
  hasMore: false,
  current: null,
  job: null,
  error: null,
  draft: "",
  rangeDays: 0,
  pollTimer: null,
  showAllCitations: false,
};

const askRangeDays = (days) => (days === 0
  ? { fromDay: null, toDay: null }
  : { fromDay: digestShiftDay(digestToday(), -(days - 1)), toDay: digestToday() });

const loadAskStatus = async ({ append = false } = {}) => {
  try {
    const offset = append ? askState.history.length : 0;
    const result = await api(`/api/ask?offset=${offset}`);
    askState.job = result.job;
    askState.pageSize = result.pageSize;
    askState.history = append ? [...askState.history, ...result.history] : result.history;
    askState.hasMore = result.history.length === result.pageSize;
    askState.error = null;
  } catch (error) {
    askState.error = error.message;
  }
};

const askRunning = () => askState.job?.status === "running";

const askSchedulePoll = () => {
  if (askState.pollTimer !== null || !askRunning()) {
    return;
  }
  askState.pollTimer = setTimeout(async () => {
    askState.pollTimer = null;
    const before = askState.job?.id;
    await loadAskStatus();
    if (!askRunning() && askState.job?.id === before) {
      if (askState.job.status === "done") {
        askState.current = askState.job.result;
        askState.showAllCitations = false;
      } else if (askState.job.status === "failed") {
        askState.error = askState.job.error;
      }
    }
    if (app.view === "ask") {
      renderAskView();
    }
    askSchedulePoll();
  }, ASK_POLL_MS);
};

const submitAsk = async (question) => {
  const text = String(question ?? "").trim();
  if (text.length === 0 || askRunning()) {
    return;
  }
  askState.draft = text;
  askState.error = null;
  try {
    askState.job = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: text, ...askRangeDays(askState.rangeDays) }) });
  } catch (error) {
    askState.error = error.message;
  }
  renderAskView();
  askSchedulePoll();
};

const openAskItem = async (id) => {
  try {
    const item = await api(`/api/ask/item?id=${id}`);
    askState.current = { id: item.id, askedAt: item.askedAt, ...item.result };
    askState.showAllCitations = false;
    askState.error = null;
  } catch (error) {
    askState.error = error.message;
  }
  renderAskView();
};

const deleteAskItem = async (id) => {
  try {
    await api("/api/ask/delete", { method: "POST", body: JSON.stringify({ id }) });
    if (askState.current?.id === id) {
      askState.current = null;
    }
    // Dropped in place: reloading went back to page 1 and folded the older
    // questions the user had opened. The next page's offset (history.length)
    // still matches the list the server now has.
    askState.history = askState.history.filter((item) => item.id !== id);
  } catch (error) {
    askState.error = error.message;
  }
  renderAskView();
};

const openAskView = async () => {
  showView("ask");
  renderAskView();
  await loadAskStatus();
  if (askState.current === null && askState.job?.status === "done") {
    askState.current = askState.job.result;
  }
  renderAskView();
  askSchedulePoll();
};

/* ---------- rendering ---------- */

const askForm = () => {
  const input = el("textarea", {
    class: "ask-input",
    rows: 3,
    placeholder: "例如：上周大家推荐的 Flux LoRA 是哪个？ / 群里谁说过 3090 显存不够怎么办？ / 9 月那次聚餐最后定在哪天？",
    oninput: (event) => { askState.draft = event.target.value; },
    onkeydown: (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitAsk(event.target.value);
      }
    },
  });
  input.value = askState.draft;
  return el("div", { class: "ask-form" },
    input,
    el("div", { class: "row", style: "flex-wrap:wrap" },
      el("span", { class: "card-sub", style: "margin:0" }, "范围："),
      ASK_RANGES.map(([days, label]) => el("button", {
        class: `chip ${askState.rangeDays === days ? "on" : ""}`,
        onclick: () => {
          askState.rangeDays = days;
          renderAskView();
        },
      }, label)),
      el("button", { class: "btn primary", disabled: askRunning(), onclick: () => submitAsk(input.value) }, askRunning() ? "正在找…" : "问"),
      el("span", { class: "brief-meta ask-key-hint" }, "Ctrl + Enter 发送")),
    askRunning()
      ? el("p", { class: "brief-meta ask-progress" }, `正在查「${askState.job.meta?.question ?? ""}」：先在聊天记录里找相关消息，再让 AI 整理回答…`)
      : null);
};

const askCitation = (citation) =>
  el("li", {},
    el("button", {
      class: "ask-citation",
      title: "打开当时的聊天",
      onclick: () => openMessagesView({
        groupId: citation.groupId,
        groupName: citation.groupName,
        fromUnix: citation.sentAt - 1800,
        scrollToTime: citation.sentAt,
        scrollToRowIds: citation.rowId ? [citation.rowId] : [],
        origin: ASK_ORIGIN,
      }),
    },
    el("span", { class: "brief-meta" }, `#${citation.ref} · ${citation.groupName} · ${unixToHkt(citation.sentAt).slice(5, 16)} · ${citation.speaker}`),
    el("span", { class: "ask-citation-text" }, citation.text)));

// Each keyword searches only its newest messages (200, or 600 at the
// detailed level); when that cut anything off, say how many there are and how
// far back the search reached. Older answers never had these fields.
const askFoundText = (stats) => {
  if (!stats) {
    return null;
  }
  const read = `读了其中 ${briefNumber(stats.hitsUsed)} 处的上下文`;
  if (stats.capped !== true) {
    return `找到 ${briefNumber(stats.matchedMessages)} 条相关消息，${read}`;
  }
  return `相关消息共 ${briefNumber(stats.totalMatches)} 条，搜了最新的 ${briefNumber(stats.matchedMessages)} 条（${unixToHkt(stats.searchedFrom).slice(0, 10)} 以后），${read}`;
};

const askOlderHint = (result) => (result.stats?.capped === true
  ? el("p", { class: "brief-meta ask-older-hint" }, "更早的相关消息没有读到。想问更早的事：在问题里写上时间（如「去年五月」），或者选好时间范围再问。")
  : null);

const askScopeLine = (result) => {
  const scope = result.scope ?? {};
  const when = scope.fromDay || scope.toDay ? `${scope.fromDay ?? "最早"} 到 ${scope.toDay ?? "现在"}` : "全部时间";
  const parts = [
    result.keywords?.length > 0 ? `关键词：${result.keywords.join("、")}` : null,
    when,
    scope.groups?.length > 0 ? `群：${scope.groups.join("、")}` : null,
    askFoundText(result.stats),
    result.model ? `${result.model}${result.detail === "detailed" ? " · 详细" : ""}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
};

const askResult = () => {
  const result = askState.current;
  if (result === null) {
    return el("div", { class: "ask-empty" },
      el("p", {}, "问任何关于群聊历史的问题。AI 会先在本机的聊天记录里找相关消息，再只根据找到的内容回答，并标出每句话的出处。"),
      el("p", { class: "brief-meta" }, "记录里没有的事它会直说没找到，不会编。"));
  }
  const citations = result.citations ?? [];
  const shown = askState.showAllCitations ? citations : citations.slice(0, ASK_CITATION_PREVIEW);
  return el("article", { class: "ask-result" },
    el("h3", { class: "ask-question" }, result.question),
    el("div", { class: "row", style: "flex-wrap:wrap;margin-bottom:8px" },
      el("span", { class: `tag ${result.confidence === "high" ? "" : "plain"}` }, ASK_CONFIDENCE[result.confidence] ?? ""),
      result.found === false ? el("span", { class: "tag plain" }, "没找到直接相关的内容") : null),
    el("div", { class: "ask-answer" }, result.answer),
    el("p", { class: "brief-meta" }, askScopeLine(result)),
    askOlderHint(result),
    citations.length > 0
      ? el("section", { class: "ask-citations" },
        el("h4", {}, "出处", el("span", { class: "brief-panel-count" }, citations.length), el("span", { class: "brief-sub" }, "点一条打开当时的聊天")),
        el("ul", {}, shown.map(askCitation)),
        citations.length > shown.length
          ? el("button", { class: "btn small ghost", onclick: () => { askState.showAllCitations = true; renderAskView(); } }, `展开其余 ${citations.length - shown.length} 条`)
          : null)
      : null,
    (result.followUps ?? []).length > 0
      ? el("div", { class: "row ask-follow", style: "flex-wrap:wrap" },
        el("span", { class: "card-sub", style: "margin:0" }, "接着问："),
        result.followUps.map((question) => el("button", { class: "chip", disabled: askRunning(), onclick: () => submitAsk(question) }, question)))
      : null);
};

const askHistory = () =>
  el("section", { class: "ask-history" },
    el("h4", {}, "问过的问题"),
    askState.history.length === 0
      ? el("p", { class: "brief-meta" }, "还没有。")
      : el("ul", {}, askState.history.map((item) => el("li", { class: askState.current?.id === item.id ? "on" : "" },
        el("button", { class: "ask-history-row", onclick: () => openAskItem(item.id) },
          el("span", {}, item.question),
          el("span", { class: "brief-meta" }, unixToHkt(item.askedAt).slice(5, 16))),
        el("button", { class: "ask-history-delete", title: "删除这条记录", "aria-label": "删除这条记录", onclick: () => deleteAskItem(item.id) }, "×")))),
    askState.hasMore
      ? el("button", { class: "btn small ghost", onclick: async () => { await loadAskStatus({ append: true }); renderAskView(); } }, "更早的问题")
      : null);

const renderAskView = () => {
  const root = $("#view-ask");
  if (root === null) {
    return;
  }
  setChildren(root, el("div", { class: "ask-page" },
    el("div", { class: "ask-main" },
      askForm(),
      askState.error ? el("div", { class: "notice risk" }, askState.error) : null,
      askResult()),
    el("aside", { class: "ask-side" }, askHistory())));
};
