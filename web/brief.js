"use strict";

/* ---------- 简报: the home page ----------
   Everything here was prepared by the background refresh; opening the page
   only reads it. Sections, in the order a returning reader wants them:
   masthead (how much happened) → 和你有关 → 值得一看 (new things, Q&A, hot
   topics) → 好图 → per-group one-liners. */

const briefState = {
  data: null,
  error: null,
  loading: false,
  busy: false,
  notice: null,
  showAllMentions: false,
  imagesShown: null,
  showQuiet: false,
  expanded: {},
  openTopics: new Set(),
  timer: null,
  loadedAt: 0,
  searchText: "",
  openThreads: new Set(),
  watchWord: null,
  watchDraft: "",
  watchError: null,
  watchExpanded: new Set(),
  renderPending: false,
};

const BRIEF_POLL_ACTIVE_MS = 5000;
// Only queued work left (e.g. a long detailed job between refreshes).
const BRIEF_POLL_QUEUED_MS = 30000;
const BRIEF_STALE_MS = 60000;
const BRIEF_MENTION_PREVIEW = 6;
const BRIEF_PANEL_PREVIEW = { things: 5, qa: 4, topics: 4 };
const BRIEF_IMAGE_PREVIEW = 12;
const BRIEF_IMAGE_MORE = 48;
const BRIEF_GROUP_TOPICS = 4;
const BRIEF_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const BRIEF_KIND_LABELS = { model: "模型", tool: "工具", tutorial: "教程", resource: "资源", news: "新闻", event: "活动", other: "新东西" };
const BRIEF_MENTION_LABELS = { at: "@你", reply: "回复你", atAll: "@全体", name: "提到你" };
// What the user can do about an AI account problem (briefing_engine.describeAiError kinds).
const BRIEF_AI_FIXES = {
  balance: "充值后会自动继续，或在设置里换一个 AI 服务。",
  key: "在设置里重新保存 key 或重新登录。",
  "rate-limit": "额度恢复后会自动继续。",
  outage: "服务恢复后会自动继续。",
  network: "网络恢复后会自动继续。",
};

const briefNowUnix = () => Math.floor(Date.now() / 1000);

const briefDateLine = (unix) => {
  const date = new Date((unix + HKT_OFFSET_SECONDS) * 1000);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 星期${BRIEF_WEEKDAYS[date.getUTCDay()]}`;
};

const briefClock = (unix) => unixToHkt(unix).slice(11, 16);

// "今天 14:05" / "昨天 22:10" / "9月21日 08:00"
const briefWhen = (unix) => {
  const day = (value) => unixToHkt(value).slice(0, 10);
  if (day(unix) === day(briefNowUnix())) {
    return `今天 ${briefClock(unix)}`;
  }
  if (day(unix) === day(briefNowUnix() - 86400)) {
    return `昨天 ${briefClock(unix)}`;
  }
  const date = new Date((unix + HKT_OFFSET_SECONDS) * 1000);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${briefClock(unix)}`;
};

const briefAgo = (isoText) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(isoText)) / 1000));
  if (seconds < 90) {
    return "刚刚";
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} 分钟前`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)} 小时前`;
  }
  return `${Math.round(seconds / 86400)} 天前`;
};

const briefNumber = (value) => Number(value ?? 0).toLocaleString("zh-CN");

// Merged summaries often open with their time range ("从9月29日凌晨到30日零点，…"),
// which costs the card its two visible lines. An opening clause made of
// nothing but a date / time range is dropped here (the full text stays in
// the tooltip); anything else in it ("9月30日 GPT-6 发布，…", "凌晨有人发了新模型，…")
// is content and stays.
const BRIEF_DATE_IN_CLAUSE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/u;
const BRIEF_ONLY_TIME = /^(?:从|自|截至|由)?[\d\s年月日号至到~\-—–:：凌晨清早上午中午下午傍晚晚上深夜夜里零点时分次当天今昨前]+$/u;
const briefDropDatePreamble = (text) => {
  const value = String(text ?? "");
  const comma = value.search(/[，,]/u);
  if (comma < 1 || comma > 40) {
    return value;
  }
  const head = value.slice(0, comma).trim();
  const rest = value.slice(comma + 1).trim();
  return BRIEF_DATE_IN_CLAUSE.test(head) && BRIEF_ONLY_TIME.test(head) && rest.length > 0 ? rest : value;
};

const briefOrigin = { view: "brief", label: "简报" };

const briefOpenChatAt = (groupId, groupName, sentAt, rowId) => openMessagesView({
  groupId,
  groupName,
  fromUnix: sentAt - 1800,
  scrollToTime: sentAt,
  scrollToRowIds: rowId ? [rowId] : [],
  origin: briefOrigin,
});

const briefOpenGroup = (group) => openMessagesView({
  groupId: group.groupId,
  groupName: group.name,
  fromLastRead: true,
  origin: briefOrigin,
});

const briefOpenImage = async (image) => {
  try {
    await openKnowledgeDetailByHash(image.hash);
  } catch {
    briefOpenChatAt(image.groupId, image.groupName, image.sentAt, null);
  }
};

/* ---------- data ---------- */

const briefIsActive = () => {
  const data = briefState.data;
  return data !== null && (data.status?.background?.running === true || data.totals.queuedChunks > 0);
};

// Poll only while the background is actually working, so the page fills in
// as chunks get summarized. When idle nothing changes until the next refresh;
// coming back to the tab reloads instead (see the visibilitychange hook).
// Each poll sends the stamp of what is shown and the page is rebuilt only
// when the server says something changed.
const scheduleBriefPoll = () => {
  if (briefState.timer !== null) {
    clearTimeout(briefState.timer);
    briefState.timer = null;
  }
  if (app.view !== "brief" || !briefIsActive()) {
    return;
  }
  const delay = briefState.data?.status?.background?.running === true ? BRIEF_POLL_ACTIVE_MS : BRIEF_POLL_QUEUED_MS;
  briefState.timer = setTimeout(async () => {
    briefState.timer = null;
    if (app.view !== "brief") {
      return;
    }
    if (await loadBriefing()) {
      renderBriefWhenIdle();
    }
  }, delay);
};

const BRIEF_INPUTS = ["brief-search-input", "brief-watch-input"];
const briefIsTyping = () => BRIEF_INPUTS.some((name) => document.activeElement?.classList?.contains(name) === true);

// News from a poll waits while someone types in the page: a redraw would end
// an IME (pinyin) composition half-way. It is drawn when the field is left.
const renderBriefWhenIdle = () => {
  if (briefIsTyping()) {
    briefState.renderPending = true;
    return;
  }
  renderBriefView();
};

document.addEventListener?.("focusout", (event) => {
  if (!briefState.renderPending || app.view !== "brief") {
    return;
  }
  const drawIfIdle = () => {
    if (briefState.renderPending && !briefIsTyping()) {
      renderBriefView();
    }
  };
  // Focus left for a button (「关注」, ×) on mousedown: redrawing now would
  // replace that button before its click lands, so wait for the click.
  if (event.relatedTarget?.tagName === "BUTTON") {
    document.addEventListener("click", () => setTimeout(drawIfIdle, 0), { once: true });
    return;
  }
  // focusout fires before the next element takes focus.
  setTimeout(drawIfIdle, 0);
});

document.addEventListener?.("visibilitychange", async () => {
  if (!document.hidden && app.view === "brief" && Date.now() - briefState.loadedAt > BRIEF_STALE_MS) {
    if (await loadBriefing()) {
      renderBriefWhenIdle();
    }
  }
});

const briefUpdateBadge = () => {
  const count = briefState.data?.mentions?.filter((item) => (item.kind === "at" || item.kind === "reply") && !item.youWereThere).length ?? 0;
  try {
    if (count > 0 && typeof navigator.setAppBadge === "function") {
      navigator.setAppBadge(count);
    } else if (typeof navigator.clearAppBadge === "function") {
      navigator.clearAppBadge();
    }
  } catch {
    // Badging is a nicety of installed apps; ignore where unsupported.
  }
};

// Returns whether there is anything new to draw. fresh: rebuild on the server
// even when nothing seems to have changed (the ↻ button).
const loadBriefing = async ({ fresh = false } = {}) => {
  briefState.loading = true;
  const hadError = briefState.error !== null;
  let changed = true;
  try {
    const known = fresh || briefState.error !== null ? null : briefState.data?.stamp ?? null;
    const payload = await api(known === null ? "/api/briefing" : `/api/briefing?known=${encodeURIComponent(known)}`);
    if (payload?.unchanged === true) {
      changed = hadError;
    } else if (payload?.totals === undefined || !Array.isArray(payload.groups) || payload.highlights === undefined) {
      throw new Error("简报数据不完整（控制台版本与页面不一致？请刷新页面）");
    } else {
      briefState.data = payload;
    }
    briefState.error = null;
    briefState.loadedAt = Date.now();
  } catch (error) {
    briefState.error = error.message;
  } finally {
    briefState.loading = false;
  }
  briefUpdateBadge();
  scheduleBriefPoll();
  return changed;
};

const openBriefView = async () => {
  showView("brief");
  renderBriefView();
  if (!bookmarkState.keysLoaded) {
    loadBookmarkKeys().then(() => renderBriefWhenIdle());
  }
  if (await loadBriefing()) {
    renderBriefView();
  }
};

VIEW_RELOADERS.brief = async () => {
  await loadBriefing({ fresh: true });
  renderBriefView();
};

const briefRunNow = async () => {
  briefState.busy = true;
  briefState.notice = null;
  renderBriefView();
  try {
    const result = await api("/api/background/run-now", { method: "POST", body: JSON.stringify({ force: true }) });
    briefState.notice = result.started ? "开始整理，新消息总结好后会自动出现在这里。" : `暂时无法整理：${result.reason === "running" ? "已经在整理中" : result.reason}`;
  } catch (error) {
    briefState.notice = error.message;
  }
  briefState.busy = false;
  await loadBriefing();
  renderBriefView();
};

const briefMarkSeen = async () => {
  if (!window.confirm("标记为看完了？\n下一份简报只包含从现在开始的新消息（已有的消息和总结都还在「消息」里）。")) {
    return;
  }
  briefState.busy = true;
  renderBriefView();
  try {
    await api("/api/briefing/seen", { method: "POST", body: JSON.stringify({}) });
    briefState.notice = "已看完。新消息到来后会自动整理成下一份简报。";
  } catch (error) {
    briefState.notice = error.message;
  }
  briefState.busy = false;
  await loadBriefing();
  renderBriefView();
};

/* ---------- sections ---------- */

const briefSetupCard = (problem) =>
  el("section", { class: "brief-setup" },
    el("h2", {}, "差一步就能开始"),
    el("p", {}, `${problem}。设置好之后，工具会在后台自动收消息、自动总结，你打开这里就能直接看。`),
    el("ol", {},
      el("li", {}, "设置页：点「自动探测并保存」找到 QQ 数据库"),
      el("li", {}, "打开并登录 QQ，点「自动获取密钥」"),
      el("li", {}, "填一个 AI 服务（可选，没有也能看统计）"),
      el("li", {}, "在「关注群」勾选你常看的群")),
    el("button", { class: "btn primary", onclick: () => openView("settings") }, "去设置"));

const briefStatusLine = (data) => {
  const background = data.status?.background ?? {};
  const pieces = [];
  let tone = "ok";
  if (background.running) {
    pieces.push(el("span", { class: "brief-pulse" }), "正在整理新消息…");
    tone = "busy";
  } else if (background.lastError) {
    pieces.push(`上次刷新出错：${background.lastError}`);
    tone = "risk";
  } else if (background.lastFinishedAt) {
    pieces.push(`${briefAgo(background.lastFinishedAt)}更新`);
  } else {
    pieces.push("等待第一次后台刷新");
  }
  if (!data.status?.llmConfigured) {
    pieces.push(" · 还没配置 AI 总结，下面只有统计");
    tone = tone === "ok" ? "warn" : tone;
  } else if (data.totals.unsummarized > 0 && !background.running) {
    pieces.push(` · 还有 ${briefNumber(data.totals.unsummarized)} 条新消息等凑够一段再总结`);
  } else if (data.totals.textMessages > 0 && !background.running) {
    pieces.push(" · 已全部总结");
  }
  const aiProblem = data.status?.aiProblem ?? null;
  if (aiProblem !== null) {
    pieces.push(
      ` · AI 总结暂停：${aiProblem.text}（${aiProblem.model}，${briefWhen(aiProblem.at)}）。${BRIEF_AI_FIXES[aiProblem.kind] ?? ""}`,
      " ",
      el("button", { class: "linklike", onclick: () => openView("settings") }, "去设置"));
    tone = "risk";
  }
  if (data.totals.failedChunks > 0) {
    const reason = data.totals.failedReasons?.[0]?.text;
    pieces.push(
      ` · ${data.totals.failedChunks} 段总结失败${reason ? `（${reason}）` : ""} `,
      el("button", { class: "linklike", disabled: briefState.busy, onclick: briefRetryFailed }, "重试"));
    tone = tone === "risk" ? tone : "warn";
  }
  const pause = data.status?.pause;
  if (pause?.paused) {
    pieces.push(
      pause.until === null ? " · AI 整理已暂停" : ` · AI 整理暂停到 ${unixToHkt(pause.until).slice(11, 16)}`,
      " ",
      el("button", { class: "linklike", disabled: briefState.busy, onclick: briefResumeAi }, "恢复"));
    tone = tone === "ok" ? "warn" : tone;
  }
  return el("p", { class: `brief-status ${tone}` }, pieces);
};

// Jumps to 回顾 with the query: "哪天聊过这个" straight from the front page.
const briefSearchForm = () => {
  // What is typed survives the page being redrawn while the background works.
  const input = el("input", {
    type: "search",
    class: "brief-search-input",
    placeholder: "搜往日话题：哪天聊过…",
    "aria-label": "搜索往日话题",
    value: briefState.searchText,
    oninput: (event) => { briefState.searchText = event.target.value; },
  });
  return el("form", {
    class: "brief-search",
    role: "search",
    onsubmit: (event) => {
      event.preventDefault();
      if (input.value.trim().length > 0) {
        openReviewView({ query: input.value });
      }
    },
  }, input, el("button", { class: "btn", type: "submit" }, "搜索"));
};

const briefMasthead = (data) => {
  const total = data.totals.textMessages + data.totals.mediaMessages;
  const mentionCount = data.mentions.length;
  const watchCount = (data.watch ?? []).reduce((sum, item) => sum + item.total, 0);
  // Each count jumps to its section.
  const counts = [
    mentionCount > 0 ? [`${mentionCount} 条和你有关`, ".brief-for-you"] : null,
    watchCount > 0 ? [`${watchCount} 处提到你关注的词`, ".brief-watch"] : null,
    data.highlights.newThings.length > 0 ? [`${data.highlights.newThings.length} 个新东西`, ".brief-highlights"] : null,
    data.highlights.qa.length > 0 ? [`${data.highlights.qa.length} 个问答`, ".brief-highlights"] : null,
  ].filter(Boolean);
  return el("section", { class: "brief-mast" },
    el("p", { class: "brief-dateline" }, `${briefDateLine(data.now)} · 自 ${briefWhen(data.windowStart)} 起`),
    total > 0
      ? el("h2", { class: "brief-headline" },
          el("span", { class: "brief-figure" }, briefNumber(data.totals.groups)), " 个群  ",
          el("span", { class: "brief-figure" }, briefNumber(total)), " 条新消息")
      : el("h2", { class: "brief-headline quiet" }, "上次看完之后，还没有新消息"),
    counts.length > 0
      ? el("p", { class: "brief-lede" }, counts.map(([label, selector], index) => [
          index > 0 ? " · " : null,
          el("button", {
            class: "brief-lede-jump",
            type: "button",
            onclick: () => $(`#view-brief ${selector}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
          }, label),
        ]))
      : null,
    briefStatusLine(data),
    el("div", { class: "brief-actions" },
      data.totals.unsummarized > 0 && data.status?.llmConfigured
        ? el("button", {
            class: "btn",
            disabled: briefState.busy || data.status?.background?.running,
            title: data.status?.background?.running ? "后台正在整理，这一轮结束后会接着总结" : "不等凑够一段，现在就把新消息交给 AI 总结",
            onclick: briefRunNow,
          }, "⚡ 现在就总结")
        : null,
      total > 0 ? el("button", { class: "btn", disabled: briefState.busy, onclick: briefMarkSeen }, "✓ 看完了") : null,
      el("button", { class: "btn ghost", onclick: () => openView("run") }, "自定义时间范围…"),
      briefSearchForm()),
    briefState.notice ? el("p", { class: "brief-notice" }, briefState.notice) : null);
};

const BRIEF_MENTION_RANK = { at: 0, reply: 0, atAll: 1, name: 2 };
const BRIEF_THREAD_GAP_SECONDS = 30 * 60;

// Direct @/replies first, and among them the ones you were not around for
// (youWereThere: you had just spoken in that group, e.g. a bot answering your
// command). Consecutive mentions from one person in one group then read as
// one conversation: the newest is shown, the rest fold under it.
const briefMentionThreads = (mentions) => {
  const sorted = [...mentions].sort((left, right) =>
    BRIEF_MENTION_RANK[left.kind] - BRIEF_MENTION_RANK[right.kind]
    || Number(left.youWereThere === true) - Number(right.youWereThere === true)
    || right.sentAt - left.sentAt);
  const threads = [];
  for (const item of sorted) {
    const thread = threads.at(-1);
    const previous = thread?.items.at(-1);
    const continues = previous !== undefined
      && previous.groupId === item.groupId
      && previous.speaker === item.speaker
      && BRIEF_MENTION_RANK[previous.kind] === BRIEF_MENTION_RANK[item.kind]
      && (previous.youWereThere === true) === (item.youWereThere === true)
      && previous.sentAt - item.sentAt <= BRIEF_THREAD_GAP_SECONDS;
    if (continues) {
      thread.items.push(item);
    } else {
      threads.push({ key: `${item.groupId}|${item.rowId}`, items: [item] });
    }
  }
  return threads;
};

const briefMentionThread = (thread) => {
  const [item, ...older] = thread.items;
  const open = briefState.openThreads.has(thread.key);
  const toggle = () => {
    const next = new Set(briefState.openThreads);
    if (open) {
      next.delete(thread.key);
    } else {
      next.add(thread.key);
    }
    briefState.openThreads = next;
    renderBriefView();
  };
  return el("li", { class: `brief-mention ${item.kind}${item.youWereThere ? " was-there" : ""}` },
    el("button", { class: "brief-row-button", onclick: () => briefOpenChatAt(item.groupId, item.groupName, item.sentAt, item.rowId) },
      el("div", { class: "brief-mention-head" },
        el("span", { class: `brief-kind ${item.kind}` }, BRIEF_MENTION_LABELS[item.kind] ?? "和你有关"),
        el("strong", {}, item.speaker),
        el("span", { class: "brief-meta" }, `${item.groupName} · ${briefWhen(item.sentAt)}`),
        older.length > 0 ? el("span", { class: "brief-thread-count" }, `连续 ${thread.items.length} 条`) : null,
        item.youWereThere
          ? el("span", { class: "brief-there", title: "你在这条前后说过话（它之前 1 分半钟内，或之后 10 分钟内），多半已经看到" }, "你当时在聊")
          : null),
      item.quotedMine ? el("p", { class: "brief-quote" }, `你说：${item.quotedMine}`) : null,
      el("p", { class: "brief-mention-text" }, item.text)),
    el("div", { class: "brief-thread-actions" },
      older.length > 0
        ? el("button", { class: "linklike brief-thread-toggle", onclick: toggle }, open ? "收起" : `展开前面 ${older.length} 条`)
        : null),
    open
      ? el("ul", { class: "brief-thread-older" }, older.map((earlier) =>
          el("li", {},
            el("button", { class: "brief-row-button", onclick: () => briefOpenChatAt(earlier.groupId, earlier.groupName, earlier.sentAt, earlier.rowId) },
              el("span", { class: "brief-meta" }, briefClock(earlier.sentAt)),
              earlier.text))))
      : null);
};

const briefMentions = (data) => {
  if (data.mentions.length === 0) {
    return data.identity.known
      ? el("p", { class: "brief-empty-line" }, "这段时间没有人 @ 你或回复你。")
      : null;
  }
  const mentions = data.mentions;
  const threads = briefMentionThreads(mentions);
  const shown = briefState.showAllMentions ? threads : threads.slice(0, BRIEF_MENTION_PREVIEW);
  const hidden = threads.slice(shown.length).reduce((total, thread) => total + thread.items.length, 0);
  return el("section", { class: "brief-section brief-for-you" },
    el("h3", { class: "brief-section-title" }, "和你有关", el("span", { class: "brief-count" }, mentions.length)),
    el("ul", { class: "brief-mention-list" }, shown.map(briefMentionThread)),
    hidden > 0
      ? el("button", {
          class: "btn small ghost",
          onclick: () => {
            briefState.showAllMentions = true;
            renderBriefView();
          },
        }, `再看 ${hidden} 条`)
      : null);
};

/* ---------- 关注的词 ---------- */

const BRIEF_WATCH_PREVIEW = 5;

const briefSaveWatchWords = async (words) => {
  briefState.busy = true;
  renderBriefView();
  try {
    await api("/api/watch-words", { method: "POST", body: JSON.stringify({ words }) });
    briefState.watchError = null;
    briefState.watchDraft = "";
  } catch (error) {
    briefState.watchError = error.message;
  }
  briefState.busy = false;
  await loadBriefing({ fresh: true });
  renderBriefView();
};

// The same switch as 设置 → 后台与通知.
const briefSetWatchNotify = async (enabled) => {
  briefState.busy = true;
  renderBriefView();
  try {
    await api("/api/background", { method: "POST", body: JSON.stringify({ notifyWatchWords: enabled }) });
    briefState.watchError = null;
  } catch (error) {
    briefState.watchError = error.message;
  }
  briefState.busy = false;
  await loadBriefing({ fresh: true });
  renderBriefView();
};

const briefWatchNotifyToggle = (data) =>
  el("label", { class: "brief-watch-notify", title: "有新消息提到这些词时，在桌面通知" },
    el("input", {
      type: "checkbox",
      checked: data.status?.background?.settings?.notifyWatchWords === true,
      disabled: briefState.busy,
      onchange: (event) => briefSetWatchNotify(event.target.checked),
    }),
    "出现时通知我");

const briefWatchForm = (words) => {
  const input = el("input", {
    type: "text",
    class: "brief-watch-input",
    placeholder: "加一个词：模型、画师、工具、作品名…",
    "aria-label": "新的关注词",
    value: briefState.watchDraft,
    oninput: (event) => { briefState.watchDraft = event.target.value; },
  });
  return el("form", {
    class: "brief-watch-form",
    onsubmit: (event) => {
      event.preventDefault();
      const word = input.value.trim();
      if (word !== "") {
        briefState.watchWord = word;
        briefSaveWatchWords([...words, word]);
      }
    },
  }, input, el("button", { class: "btn small", type: "submit", disabled: briefState.busy }, "关注"));
};

// The word marked wherever it appears in the text (case-insensitive).
const briefMarkWord = (text, word) => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*");
  const parts = String(text).split(new RegExp(`(${escaped})`, "iu"));
  return parts.map((part, index) => (index % 2 === 1 ? el("mark", {}, part) : part));
};

const briefWatchHit = (hit, word) =>
  el("li", { class: "brief-watch-hit" },
    el("button", { class: "brief-row-button", onclick: () => briefOpenChatAt(hit.groupId, hit.groupName, hit.sentAt, hit.rowId) },
      el("div", { class: "brief-mention-head" },
        el("strong", {}, hit.speaker),
        el("span", { class: "brief-meta" }, `${hit.groupName} · ${briefWhen(hit.sentAt)}`)),
      el("p", { class: "brief-mention-text" }, briefMarkWord(hit.text, word))));

// The home page's window as a 回顾 search range (whole Beijing days).
const briefWindowRange = () => ({
  searchRange: "custom",
  searchFrom: unixToHkt(briefState.data.windowStart).slice(0, 10),
  searchTo: unixToHkt(Math.floor(Date.now() / 1000)).slice(0, 10),
});

const briefWatchDetail = (item) => {
  if (item.total === 0) {
    return el("p", { class: "brief-empty-line" }, `这段时间还没有人提到「${item.word}」。`,
      " ", el("button", { class: "linklike", onclick: () => openReviewView({ query: item.word }) }, "在回顾里搜以前的"));
  }
  const expanded = briefState.watchExpanded.has(item.word);
  const shown = expanded ? item.latest : item.latest.slice(0, BRIEF_WATCH_PREVIEW);
  const expand = () => {
    briefState.watchExpanded = new Set([...briefState.watchExpanded, item.word]);
    renderBriefView();
  };
  return el("div", { class: "brief-watch-detail" },
    el("p", { class: "brief-watch-groups" }, item.groups.map((group) => `${group.groupName || group.groupId} ${group.count}`).join(" · ")),
    el("ul", { class: "brief-watch-hits" }, shown.map((hit) => briefWatchHit(hit, item.word))),
    el("div", { class: "brief-watch-more" },
      item.latest.length > shown.length
        ? el("button", { class: "btn small ghost", onclick: expand }, `再看 ${item.latest.length - shown.length} 条`)
        : null,
      // The briefing carries the newest ones; 回顾 pages through every mention.
      item.total > item.latest.length
        ? el("button", { class: "linklike", onclick: () => openReviewView({ query: item.word, range: briefWindowRange() }), title: "回顾按关键词搜索（也会搜到包含这个词的更长的词、你自己说的话），条数可能和这里不同" }, "在回顾里看这几天的全部")
        : el("button", { class: "linklike", onclick: () => openReviewView({ query: item.word }) }, "在回顾里搜更早的")));
};

const briefWatch = (data) => {
  const watch = data.watch ?? [];
  const words = watch.map((item) => item.word);
  const error = briefState.watchError ? el("p", { class: "brief-watch-error" }, briefState.watchError) : null;
  if (watch.length === 0) {
    return el("section", { class: "brief-section brief-watch" },
      el("h3", { class: "brief-section-title" }, "关注的词"),
      el("p", { class: "brief-empty-line" }, "关注几个词（模型、画师、工具、你自己的作品名），以后哪个群提到，就列在这里。"),
      briefWatchForm(words),
      error);
  }
  const selected = watch.find((item) => item.word === briefState.watchWord)
    ?? watch.find((item) => item.total > 0)
    ?? watch[0];
  const total = watch.reduce((sum, item) => sum + item.total, 0);
  return el("section", { class: "brief-section brief-watch" },
    el("h3", { class: "brief-section-title" }, "关注的词", el("span", { class: "brief-count" }, total)),
    el("div", { class: "brief-watch-chips" },
      watch.map((item) => el("span", { class: `brief-watch-chip${item === selected ? " active" : ""}${item.total === 0 ? " quiet" : ""}` },
        el("button", {
          class: "brief-watch-pick",
          type: "button",
          "aria-pressed": String(item === selected),
          onclick: () => {
            briefState.watchWord = item.word;
            renderBriefView();
          },
        }, item.word, el("span", { class: "brief-watch-count" }, item.total)),
        el("button", {
          class: "brief-watch-remove",
          type: "button",
          title: `不再关注「${item.word}」`,
          "aria-label": `不再关注 ${item.word}`,
          disabled: briefState.busy,
          onclick: () => briefSaveWatchWords(words.filter((word) => word !== item.word)),
        }, "×"))),
      briefWatchForm(words),
      briefWatchNotifyToggle(data)),
    error,
    briefWatchDetail(selected));
};

// What a star on the briefing saves (see bookmarks.js).
const briefThingBookmark = (item) => ({
  kind: "thing", title: item.name, body: item.detail ?? "", link: item.link ?? "",
  groupId: item.groupId, groupName: item.groupName, speaker: item.speaker ?? "", sentAt: hktToUnix(item.hkt),
});
const briefQaBookmark = (item) => ({
  kind: "qa", title: item.question, body: item.answer ?? "", groupId: item.groupId, groupName: item.groupName,
  speaker: item.answerer || item.asker || "", sentAt: hktToUnix(item.hkt),
});
const briefTopicBookmark = (topic) => ({
  kind: "topic", title: topic.title, groupId: topic.groupId, groupName: topic.groupName,
  body: [topic.summary, ...(topic.details ?? []).map((detail) => `· ${detail}`)].filter(Boolean).join("\n"),
});

const briefNewThing = (item) =>
  el("li", { class: "brief-thing" },
    bookmarkStar(briefThingBookmark(item), renderBriefView),
    el("span", { class: `brief-thing-kind ${item.kind}` }, BRIEF_KIND_LABELS[item.kind] ?? "新东西"),
    el("div", {},
      el("div", { class: "brief-thing-name" },
        item.name,
        safeHref(item.link) ? el("a", { href: safeHref(item.link), target: "_blank", rel: "noopener noreferrer", class: "brief-link", title: item.link }, "↗") : null),
      el("p", {}, item.detail),
      el("span", { class: "brief-meta" }, [item.groupName, item.speaker].filter(Boolean).join(" · "))));

const briefQa = (item) =>
  el("li", { class: `brief-qa ${item.resolved ? "" : "open"}` },
    bookmarkStar(briefQaBookmark(item), renderBriefView),
    el("p", { class: "brief-q" }, item.question),
    el("p", { class: "brief-a" }, item.answer ?? "还没有人回答"),
    el("span", { class: "brief-meta" }, [item.groupName, item.answerer ? `${item.answerer} 回答` : item.asker ? `${item.asker} 问` : ""].filter(Boolean).join(" · ")));

const briefTopicKey = (topic) => `${topic.groupId}|${topic.title}`;

const briefOpenTopicGroup = (topic) => {
  const group = briefState.data.groups.find((item) => item.groupId === topic.groupId);
  if (group) {
    briefOpenGroup(group);
  }
};

// Detailed-level topics carry points and quotes: the row expands in place
// (the chat is one click further). Standard topics open the chat directly.
const briefTopic = (topic) => {
  const hasMore = (topic.details?.length ?? 0) + (topic.evidence?.length ?? 0) > 0;
  const key = briefTopicKey(topic);
  const open = hasMore && briefState.openTopics.has(key);
  return el("li", { class: `brief-topic ${topic.importance} ${open ? "open" : ""}` },
    bookmarkStar(briefTopicBookmark(topic), renderBriefView),
    el("button", {
      class: "brief-row-button",
      "aria-expanded": hasMore ? String(open) : null,
      onclick: () => {
        if (!hasMore) {
          briefOpenTopicGroup(topic);
          return;
        }
        const next = new Set(briefState.openTopics);
        if (open) {
          next.delete(key);
        } else {
          next.add(key);
        }
        briefState.openTopics = next;
        renderBriefView();
      },
    },
      el("span", { class: "brief-meta" }, topic.groupName, hasMore ? el("span", { class: "brief-topic-more" }, open ? "收起" : "展开细节") : null),
      el("strong", {}, topic.title),
      el("p", {}, topic.summary)),
    open
      ? el("div", { class: "brief-topic-detail" },
        topic.details.length > 0 ? el("ul", {}, topic.details.map((item) => el("li", {}, item))) : null,
        topic.evidence.length > 0 ? el("ul", { class: "brief-topic-quotes" }, topic.evidence.map((item) => el("li", {}, item))) : null,
        el("button", { class: "btn small ghost", onclick: () => briefOpenTopicGroup(topic) }, "去群里看"))
      : null);
};

// One bento panel: a short preview so the page stays a quick read, with the
// rest one click away.
const briefPanel = (key, title, items, renderItem) => {
  if (items.length === 0) {
    return null;
  }
  const expanded = briefState.expanded[key] === true;
  const preview = BRIEF_PANEL_PREVIEW[key];
  const shown = expanded ? items : items.slice(0, preview);
  return el("div", { class: `brief-panel ${key}` },
    el("h4", {}, title, el("span", { class: "brief-panel-count" }, items.length)),
    el("ul", {}, shown.map(renderItem)),
    items.length > shown.length
      ? el("button", {
          class: "btn small ghost brief-more",
          onclick: () => {
            briefState.expanded = { ...briefState.expanded, [key]: true };
            renderBriefView();
          },
        }, `展开其余 ${items.length - shown.length} 个`)
      : null);
};

const briefHighlights = (data) => {
  const { newThings, qa, hotTopics } = data.highlights;
  if (newThings.length + qa.length + hotTopics.length === 0) {
    return null;
  }
  return el("section", { class: "brief-section brief-highlights" },
    el("h3", { class: "brief-section-title" }, "值得一看"),
    el("div", { class: "brief-bento" },
      briefPanel("things", "新东西", newThings, briefNewThing),
      briefPanel("qa", "问答", qa, briefQa),
      briefPanel("topics", "大家在聊", hotTopics, briefTopic)));
};

// 图片 (好图 / 全部图片 + multi-select) lives in web/brief_pictures.js.

// Read through in the chat (its read mark is past the window's last message).
const briefGroupSeen = (group) => group.unseen === 0 && group.textMessages + group.mediaMessages > 0;

const briefGroupRow = (group) =>
  el("li", { class: `brief-group${briefGroupSeen(group) ? " seen" : ""}` },
    el("button", { class: "brief-row-button", onclick: () => briefOpenGroup(group) },
      avatarEl(group.name, group.groupId, "", groupAvatarUrl(group.groupId)),
      el("div", { class: "brief-group-body" },
        el("div", { class: "brief-group-head" },
          el("strong", {}, group.name),
          el("span", { class: "brief-meta" },
            `${briefNumber(group.textMessages)} 条`,
            group.mediaMessages > 0 ? ` · ${briefNumber(group.mediaMessages)} 图` : "",
            group.speakers > 0 ? ` · ${group.speakers} 人` : "")),
        Number.isFinite(group.unseen)
          ? el("span", { class: `brief-group-progress${briefGroupSeen(group) ? " done" : ""}` },
            briefGroupSeen(group)
              ? "✓ 在消息里看完了"
              : group.unseen < group.textMessages + group.mediaMessages
                ? `看到一半 · 还有 ${briefNumber(group.unseen)} 条`
                : `还没看 · ${briefNumber(group.unseen)} 条`)
          : null,
        group.summary
          ? el("p", { class: "brief-group-summary", title: group.summary }, briefDropDatePreamble(group.summary))
          : el("p", { class: "brief-group-summary pending" }, group.unsummarized > 0 ? `${briefNumber(group.unsummarized)} 条新消息，攒够一段后自动总结` : "还没有总结"),
        group.topics.length > 0
          ? el("div", { class: "brief-group-topics" },
            group.topics.slice(0, BRIEF_GROUP_TOPICS).map((topic) => el("span", { class: "tag plain" }, topic)),
            group.topics.length > BRIEF_GROUP_TOPICS ? el("span", { class: "tag plain more" }, `+${group.topics.length - BRIEF_GROUP_TOPICS} 个话题`) : null)
          : null)),
    // Read the summary, done with the group: its read mark jumps to the newest
    // message (the same as 「全部标为本工具已查看」 in its chat).
    group.unseen > 0
      ? el("div", { class: "brief-group-actions" },
        el("button", {
          class: "linklike",
          disabled: briefState.busy,
          title: "看过总结就够了：把这个群标为本工具已查看（消息都还在，随时可以打开）",
          onclick: () => briefMarkGroupDone(group),
        }, "标为看完"))
      : null);

const briefMarkGroupDone = async (group) => {
  briefState.busy = true;
  renderBriefView();
  try {
    await api("/api/readmark", { method: "POST", body: JSON.stringify({ groupId: group.groupId, toLatest: true }) });
  } catch (error) {
    briefState.notice = error.message;
  }
  briefState.busy = false;
  await loadBriefing({ fresh: true });
  renderBriefView();
};

const briefGroups = (data) => {
  // Groups still to go through first (busiest first, as the server sends them), then the ones read.
  const active = data.groups.filter((group) => group.textMessages + group.mediaMessages > 0)
    .sort((left, right) => Number(briefGroupSeen(left)) - Number(briefGroupSeen(right)));
  const quiet = data.groups.filter((group) => group.textMessages + group.mediaMessages === 0 && group.watched);
  if (active.length === 0 && quiet.length === 0) {
    return null;
  }
  return el("section", { class: "brief-section" },
    el("h3", { class: "brief-section-title" }, "各群", el("span", { class: "brief-sub" }, "点进去从上次看到的位置继续")),
    el("ul", { class: "brief-group-list" }, active.map(briefGroupRow)),
    quiet.length > 0
      ? el("p", { class: "brief-quiet" },
          briefState.showQuiet ? `没有新消息：${quiet.map((group) => group.name).join("、")}` : `另外 ${quiet.length} 个关注群没有新消息`,
          briefState.showQuiet ? null : el("button", {
            class: "btn small ghost",
            onclick: () => {
              briefState.showQuiet = true;
              renderBriefView();
            },
          }, "看是哪些"))
      : null);
};

const briefRetryFailed = async () => {
  briefState.busy = true;
  renderBriefView();
  try {
    const result = await api("/api/briefing/retry-failed", { method: "POST", body: JSON.stringify({}) });
    briefState.notice = result.requeued > 0
      ? `已把 ${result.requeued} 段重新排队，后台会重新总结${result.started ? "（已开始）" : "（下一次刷新时开始）"}。`
      : "没有需要重试的段。";
  } catch (error) {
    briefState.notice = error.message;
  }
  briefState.busy = false;
  await loadBriefing({ fresh: true });
  renderBriefView();
};

const briefResumeAi = async () => {
  briefState.busy = true;
  renderBriefView();
  try {
    await api("/api/ai/pause", { method: "POST", body: JSON.stringify({ minutes: 0 }) });
    briefState.notice = "AI 整理已恢复，下一次后台刷新会接着总结。";
  } catch (error) {
    briefState.notice = error.message;
  }
  briefState.busy = false;
  await loadBriefing();
  renderBriefView();
};

const briefSpend = (costs) => {
  const entries = Object.entries(costs ?? {}).filter(([, amount]) => amount > 0);
  return entries.length === 0 ? null : entries.map(([currency, amount]) => `${currency === "USD" ? "$" : "¥"}${amount.toFixed(2)}`).join(" + ");
};

const briefFooter = (data) => {
  const background = data.status?.background ?? {};
  const settingsOf = background.settings ?? {};
  const budget = data.status?.budget;
  return el("footer", { class: "brief-footer" },
    settingsOf.enabled === false
      ? "后台刷新已关闭"
      : `后台每 ${settingsOf.intervalMinutes ?? 15} 分钟自动收消息`,
    budget ? ` · 今天 AI 调用 ${budget.used}/${budget.limit}` : "",
    briefSpend(data.status?.spendToday) ? `，约 ${briefSpend(data.status.spendToday)}` : "",
    " · ",
    el("button", { class: "linklike", onclick: () => openView("settings") }, "AI 用量与后台设置"),
    " · ",
    el("button", { class: "linklike", onclick: toggleBriefKeyHelp, title: "j / k 移动 · o 打开 · s 收藏 · Ctrl+K 搜索" }, "键盘快捷键（?）"));
};

const renderBriefView = () => {
  const root = $("#view-brief");
  if (root === null) {
    return;
  }
  const data = briefState.data;
  if (data === null) {
    setChildren(root, el("div", { class: "brief-page" },
      briefState.error
        ? el("div", { class: "notice risk" }, `读取简报失败：${briefState.error}`)
        : el("p", { class: "brief-empty-line" }, "正在读取简报…")));
    return;
  }
  const problem = data.status?.background?.readinessProblem ?? null;
  briefState.renderPending = false;
  // A redraw must not steal the cursor from someone typing (search, 关注词).
  const typing = BRIEF_INPUTS.find((name) => document.activeElement?.classList?.contains(name) === true);
  setChildren(root, el("div", { class: "brief-page" },
    briefState.error ? el("div", { class: "notice risk" }, `刷新失败：${briefState.error}`) : null,
    problem !== null && data.totals.textMessages === 0
      ? briefSetupCard(problem)
      : [
          // On wide screens the per-group list becomes a right-hand column
          // (brief.css); on narrow ones it simply follows the main column.
          el("div", { class: "brief-main" },
            shortcutPromptCard(),
            whatsNewCard(),
            briefMasthead(data),
            briefMentions(data),
            briefWatch(data),
            digestHomeSection(),
            briefHighlights(data),
            briefImages(data)),
          el("aside", { class: "brief-side" }, briefGroups(data)),
          briefFooter(data),
        ]));
  const input = typing === undefined ? null : root.querySelector(`.${typing}`);
  if (input !== null) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  briefKeysRestore();
};
