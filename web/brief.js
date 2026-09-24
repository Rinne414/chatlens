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
  showQuiet: false,
  expanded: {},
  timer: null,
  loadedAt: 0,
};

const BRIEF_POLL_ACTIVE_MS = 5000;
const BRIEF_STALE_MS = 60000;
const BRIEF_MENTION_PREVIEW = 6;
const BRIEF_PANEL_PREVIEW = { things: 5, qa: 4, topics: 4 };
const BRIEF_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const BRIEF_KIND_LABELS = { model: "模型", tool: "工具", tutorial: "教程", resource: "资源", news: "新闻", event: "活动", other: "新东西" };
const BRIEF_MENTION_LABELS = { at: "@你", reply: "回复你", atAll: "@全体", name: "提到你" };

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
const scheduleBriefPoll = () => {
  if (briefState.timer !== null) {
    clearTimeout(briefState.timer);
    briefState.timer = null;
  }
  if (app.view !== "brief" || !briefIsActive()) {
    return;
  }
  briefState.timer = setTimeout(async () => {
    briefState.timer = null;
    if (app.view !== "brief") {
      return;
    }
    await loadBriefing();
    renderBriefView();
  }, BRIEF_POLL_ACTIVE_MS);
};

document.addEventListener?.("visibilitychange", async () => {
  if (!document.hidden && app.view === "brief" && Date.now() - briefState.loadedAt > BRIEF_STALE_MS) {
    await loadBriefing();
    renderBriefView();
  }
});

const briefUpdateBadge = () => {
  const count = briefState.data?.mentions?.filter((item) => item.kind === "at" || item.kind === "reply").length ?? 0;
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

const loadBriefing = async () => {
  briefState.loading = true;
  try {
    const payload = await api("/api/briefing");
    if (payload?.totals === undefined || !Array.isArray(payload.groups) || payload.highlights === undefined) {
      throw new Error("简报数据不完整（控制台版本与页面不一致？请刷新页面）");
    }
    briefState.data = payload;
    briefState.error = null;
    briefState.loadedAt = Date.now();
  } catch (error) {
    briefState.error = error.message;
  } finally {
    briefState.loading = false;
  }
  briefUpdateBadge();
  scheduleBriefPoll();
};

const openBriefView = async () => {
  showView("brief");
  renderBriefView();
  await loadBriefing();
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
  if (data.totals.failedChunks > 0) {
    pieces.push(` · ${data.totals.failedChunks} 段总结失败`);
    tone = "warn";
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
  const input = el("input", { type: "search", class: "brief-search-input", placeholder: "搜往日话题：哪天聊过…", "aria-label": "搜索往日话题" });
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
  const counts = [
    data.mentions.length > 0 ? `${data.mentions.length} 条和你有关` : null,
    data.highlights.newThings.length > 0 ? `${data.highlights.newThings.length} 个新东西` : null,
    data.highlights.qa.length > 0 ? `${data.highlights.qa.length} 个问答` : null,
  ].filter(Boolean);
  return el("section", { class: "brief-mast" },
    el("p", { class: "brief-dateline" }, `${briefDateLine(data.now)} · 自 ${briefWhen(data.windowStart)} 起`),
    total > 0
      ? el("h2", { class: "brief-headline" },
          el("span", { class: "brief-figure" }, briefNumber(data.totals.groups)), " 个群  ",
          el("span", { class: "brief-figure" }, briefNumber(total)), " 条新消息")
      : el("h2", { class: "brief-headline quiet" }, "上次看完之后，还没有新消息"),
    counts.length > 0 ? el("p", { class: "brief-lede" }, counts.join(" · ")) : null,
    briefStatusLine(data),
    el("div", { class: "brief-actions" },
      data.totals.unsummarized > 0 && data.status?.llmConfigured
        ? el("button", { class: "btn", disabled: briefState.busy || data.status?.background?.running, onclick: briefRunNow }, "⚡ 现在就总结")
        : null,
      total > 0 ? el("button", { class: "btn", disabled: briefState.busy, onclick: briefMarkSeen }, "✓ 看完了") : null,
      el("button", { class: "btn ghost", onclick: () => openView("run") }, "自定义时间范围…"),
      briefSearchForm()),
    briefState.notice ? el("p", { class: "brief-notice" }, briefState.notice) : null);
};

const briefMentionItem = (item) =>
  el("li", { class: `brief-mention ${item.kind}` },
    el("button", { class: "brief-row-button", onclick: () => briefOpenChatAt(item.groupId, item.groupName, item.sentAt, item.rowId) },
      el("div", { class: "brief-mention-head" },
        el("span", { class: `brief-kind ${item.kind}` }, BRIEF_MENTION_LABELS[item.kind] ?? "和你有关"),
        el("strong", {}, item.speaker),
        el("span", { class: "brief-meta" }, `${item.groupName} · ${briefWhen(item.sentAt)}`)),
      item.quotedMine ? el("p", { class: "brief-quote" }, `你说：${item.quotedMine}`) : null,
      el("p", { class: "brief-mention-text" }, item.text)));

const briefMentions = (data) => {
  if (data.mentions.length === 0) {
    return data.identity.known
      ? el("p", { class: "brief-empty-line" }, "这段时间没有人 @ 你或回复你。")
      : null;
  }
  // Direct @/replies first; @全体 and name mentions after.
  const rank = { at: 0, reply: 0, atAll: 1, name: 2 };
  const sorted = [...data.mentions].sort((left, right) => rank[left.kind] - rank[right.kind] || right.sentAt - left.sentAt);
  const shown = briefState.showAllMentions ? sorted : sorted.slice(0, BRIEF_MENTION_PREVIEW);
  return el("section", { class: "brief-section brief-for-you" },
    el("h3", { class: "brief-section-title" }, "和你有关", el("span", { class: "brief-count" }, data.mentions.length)),
    el("ul", { class: "brief-mention-list" }, shown.map(briefMentionItem)),
    sorted.length > shown.length
      ? el("button", {
          class: "btn small ghost",
          onclick: () => {
            briefState.showAllMentions = true;
            renderBriefView();
          },
        }, `再看 ${sorted.length - shown.length} 条`)
      : null);
};

const briefNewThing = (item) =>
  el("li", { class: "brief-thing" },
    el("span", { class: `brief-thing-kind ${item.kind}` }, BRIEF_KIND_LABELS[item.kind] ?? "新东西"),
    el("div", {},
      el("div", { class: "brief-thing-name" },
        item.name,
        safeHref(item.link) ? el("a", { href: safeHref(item.link), target: "_blank", rel: "noopener noreferrer", class: "brief-link", title: item.link }, "↗") : null),
      el("p", {}, item.detail),
      el("span", { class: "brief-meta" }, [item.groupName, item.speaker].filter(Boolean).join(" · "))));

const briefQa = (item) =>
  el("li", { class: `brief-qa ${item.resolved ? "" : "open"}` },
    el("p", { class: "brief-q" }, item.question),
    el("p", { class: "brief-a" }, item.answer ?? "还没有人回答"),
    el("span", { class: "brief-meta" }, [item.groupName, item.answerer ? `${item.answerer} 回答` : item.asker ? `${item.asker} 问` : ""].filter(Boolean).join(" · ")));

const briefTopic = (topic) =>
  el("li", { class: `brief-topic ${topic.importance}` },
    el("button", {
      class: "brief-row-button",
      onclick: () => {
        const group = briefState.data.groups.find((item) => item.groupId === topic.groupId);
        if (group) {
          briefOpenGroup(group);
        }
      },
    },
      el("span", { class: "brief-meta" }, topic.groupName),
      el("strong", {}, topic.title),
      el("p", {}, topic.summary)));

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
  return el("section", { class: "brief-section" },
    el("h3", { class: "brief-section-title" }, "值得一看"),
    el("div", { class: "brief-bento" },
      briefPanel("things", "新东西", newThings, briefNewThing),
      briefPanel("qa", "问答", qa, briefQa),
      briefPanel("topics", "大家在聊", hotTopics, briefTopic)));
};

const briefImages = (data) => {
  if (data.images.length === 0) {
    return null;
  }
  return el("section", { class: "brief-section" },
    el("h3", { class: "brief-section-title" }, "好图", el("span", { class: "brief-sub" }, "被求 tag、反复转发的排在前面")),
    el("div", { class: "brief-images" }, data.images.map((image) =>
      el("button", { class: "brief-image", title: `${image.groupName} · ${image.speaker}`, onclick: () => briefOpenImage(image) },
        el("img", { src: knowledgeThumbUrl(image.hash), alt: "", loading: "lazy", decoding: "async" }),
        image.asks > 0 ? el("span", { class: "brief-image-badge" }, `${image.asks} 人求 tag`) : null))));
};

const briefGroupRow = (group) =>
  el("li", { class: "brief-group" },
    el("button", { class: "brief-row-button", onclick: () => briefOpenGroup(group) },
      avatarEl(group.name, group.groupId, "", groupAvatarUrl(group.groupId)),
      el("div", { class: "brief-group-body" },
        el("div", { class: "brief-group-head" },
          el("strong", {}, group.name),
          el("span", { class: "brief-meta" },
            `${briefNumber(group.textMessages)} 条`,
            group.mediaMessages > 0 ? ` · ${briefNumber(group.mediaMessages)} 图` : "",
            group.speakers > 0 ? ` · ${group.speakers} 人` : "")),
        group.summary
          ? el("p", { class: "brief-group-summary" }, group.summary)
          : el("p", { class: "brief-group-summary pending" }, group.unsummarized > 0 ? `${briefNumber(group.unsummarized)} 条新消息，攒够一段后自动总结` : "还没有总结"),
        group.topics.length > 0
          ? el("div", { class: "brief-group-topics" }, group.topics.map((topic) => el("span", { class: "tag plain" }, topic)))
          : null)));

const briefGroups = (data) => {
  const active = data.groups.filter((group) => group.textMessages + group.mediaMessages > 0);
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
    el("button", { class: "linklike", onclick: () => openView("settings") }, "AI 用量与后台设置"));
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
  setChildren(root, el("div", { class: "brief-page" },
    briefState.error ? el("div", { class: "notice risk" }, `刷新失败：${briefState.error}`) : null,
    problem !== null && data.totals.textMessages === 0
      ? briefSetupCard(problem)
      : [
          // On wide screens the per-group list becomes a right-hand column
          // (brief.css); on narrow ones it simply follows the main column.
          el("div", { class: "brief-main" },
            briefMasthead(data),
            briefMentions(data),
            briefHighlights(data),
            briefImages(data)),
          el("aside", { class: "brief-side" }, briefGroups(data)),
          briefFooter(data),
        ]));
};
