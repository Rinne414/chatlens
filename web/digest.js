"use strict";

/* ---------- 每日总览 / 周报 / 月报 ----------
   AI-written digests over what the briefing already summarized. The briefing
   home shows today's (or yesterday's) overview; 回顾 shows the selected day's
   overview and lists the weekly and monthly reports. Writing one runs in the
   background (a child process); this file starts it and polls. */

const DIGEST_POLL_MS = 4000;
const DIGEST_PREVIEW = 5;
const DIGEST_KIND_LABELS = { day: "每日总览", week: "周报", month: "月报" };
const DIGEST_IMPORTANCE_LABELS = { high: "重要", medium: "", low: "" };
const DIGEST_RECENT_WEEKS = 8;
const DIGEST_RECENT_MONTHS = 6;
// A shown digest is re-read after this long: the background may have
// written a newer one meanwhile.
const DIGEST_STALE_MS = 5 * 60 * 1000;

const digestState = { entries: {}, lists: { week: null, month: null }, job: null, pollTimer: null, expanded: new Set(), notice: null };

const digestKey = (kind, period) => `${kind}:${period}`;

/* ---------- periods (Beijing) ---------- */

const digestDayUnix = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000 - HKT_OFFSET_SECONDS;
const digestDayOf = (unix) => unixToHkt(unix).slice(0, 10);
const digestToday = () => digestDayOf(Math.floor(Date.now() / 1000));
const digestShiftDay = (day, delta) => digestDayOf(digestDayUnix(day) + delta * 86400 + 3600);

const digestMondayOf = (day) => {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return digestShiftDay(day, -weekday);
};

const digestRecentPeriods = (kind) => {
  const today = digestToday();
  if (kind === "week") {
    const monday = digestMondayOf(today);
    return Array.from({ length: DIGEST_RECENT_WEEKS }, (_, index) => digestShiftDay(monday, -7 * index));
  }
  const [year, month] = today.split("-").map(Number);
  return Array.from({ length: DIGEST_RECENT_MONTHS }, (_, index) => new Date(Date.UTC(year, month - 1 - index, 1)).toISOString().slice(0, 7));
};

const digestPeriodLabel = (kind, period) => {
  if (kind === "day") {
    const today = digestToday();
    const prefix = period === today ? "今天 · " : period === digestShiftDay(today, -1) ? "昨天 · " : "";
    return `${prefix}${Number(period.slice(5, 7))}月${Number(period.slice(8, 10))}日`;
  }
  if (kind === "week") {
    const sunday = digestShiftDay(period, 6);
    const current = period === digestMondayOf(digestToday());
    return `${current ? "本周 · " : ""}${Number(period.slice(5, 7))}/${Number(period.slice(8, 10))} – ${Number(sunday.slice(5, 7))}/${Number(sunday.slice(8, 10))}`;
  }
  return `${period === digestToday().slice(0, 7) ? "本月 · " : ""}${period.slice(0, 4)} 年 ${Number(period.slice(5, 7))} 月`;
};

/* ---------- loading and generating ---------- */

const digestRerender = () => {
  if (app.view === "brief") {
    renderBriefView();
  } else if (app.view === "review") {
    renderReviewView();
  }
};

const loadDigest = async (kind, period) => {
  const key = digestKey(kind, period);
  digestState.entries = { ...digestState.entries, [key]: { ...(digestState.entries[key] ?? {}), loading: true } };
  try {
    const result = await api(`/api/digest?kind=${kind}&period=${period}`);
    digestState.entries = { ...digestState.entries, [key]: { digest: result.digest, llmConfigured: result.llmConfigured, loading: false, error: null, loadedAt: Date.now() } };
    digestState.job = result.job;
  } catch (error) {
    digestState.entries = { ...digestState.entries, [key]: { digest: null, loading: false, error: error.message, loadedAt: Date.now() } };
  }
  digestRerender();
  digestSchedulePoll();
};

const loadDigestList = async (kind) => {
  try {
    const result = await api(`/api/digests?kind=${kind}`);
    digestState.lists = { ...digestState.lists, [kind]: result.items };
    digestState.job = result.job;
  } catch (error) {
    digestState.notice = { text: error.message, isError: true };
  }
  digestRerender();
};

const digestJobRunning = (kind, period) => digestState.job?.status === "running"
  && (kind === undefined || (digestState.job.meta?.kind === kind && digestState.job.meta?.period === period));

// While a digest is being written, poll; when it ends, reload what it wrote.
const digestSchedulePoll = () => {
  if (digestState.pollTimer !== null || !digestJobRunning()) {
    return;
  }
  digestState.pollTimer = setTimeout(async () => {
    digestState.pollTimer = null;
    const { kind, period } = digestState.job.meta;
    try {
      const result = await api(`/api/digest?kind=${kind}&period=${period}`);
      digestState.job = result.job;
      if (!digestJobRunning()) {
        digestState.entries = { ...digestState.entries, [digestKey(kind, period)]: { digest: result.digest, llmConfigured: result.llmConfigured, loading: false, error: null, loadedAt: Date.now() } };
        digestState.notice = result.job?.status === "failed" ? { text: `生成失败：${result.job.error}`, isError: true } : null;
        if (kind !== "day") {
          await loadDigestList(kind);
        }
      }
    } catch (error) {
      digestState.notice = { text: error.message, isError: true };
    }
    digestRerender();
    digestSchedulePoll();
  }, DIGEST_POLL_MS);
};

const generateDigest = async (kind, period) => {
  try {
    digestState.job = await api("/api/digest/generate", { method: "POST", body: JSON.stringify({ kind, period }) });
    digestState.notice = null;
  } catch (error) {
    digestState.notice = { text: error.message, isError: true };
  }
  digestRerender();
  digestSchedulePoll();
};

/* ---------- rendering ---------- */

const digestGroupsLine = (groups) => ((groups ?? []).length > 0
  ? el("span", { class: "digest-groups" }, groups.map((group) => el("span", { class: "tag plain" }, group)))
  : null);

// A list with a short preview and the rest one click away (no hard caps).
const digestList = (key, title, items, renderItem) => {
  if ((items ?? []).length === 0) {
    return null;
  }
  const open = digestState.expanded.has(key);
  const shown = open ? items : items.slice(0, DIGEST_PREVIEW);
  return el("div", { class: "digest-block" },
    el("h4", {}, title, el("span", { class: "brief-panel-count" }, items.length)),
    el("ul", {}, shown.map(renderItem)),
    items.length > shown.length
      ? el("button", {
          class: "btn small ghost",
          onclick: () => {
            digestState.expanded = new Set([...digestState.expanded, key]);
            digestRerender();
          },
        }, `展开其余 ${items.length - shown.length} 条`)
      : null);
};

const digestTitledItem = (title, detail, extra = null) =>
  el("li", {}, el("strong", {}, title), el("p", {}, detail), extra);

// Stars as on the briefing (bookmarks.js); digest items name their groups, not one group.
const digestStar = (item) => bookmarkStar(item, () => renderCurrentView());

const digestNewThing = (item) =>
  el("li", { class: "digest-savable" },
    digestStar({ kind: "thing", title: item.name, body: item.detail ?? "", link: item.link ?? "", groupName: (item.groups ?? []).join("、") }),
    el("strong", {}, item.name, safeHref(item.link) ? el("a", { href: safeHref(item.link), target: "_blank", rel: "noopener noreferrer", class: "brief-link" }, " ↗") : null),
    el("p", {}, item.detail),
    digestGroupsLine(item.groups));

const digestMeta = (digest) => {
  const when = unixToHkt(digest.generatedAt).slice(5, 16);
  const stats = digest.summary.stats ?? {};
  const basis = digest.kind === "day"
    ? `基于 ${stats.groups ?? 0} 个群的 ${stats.chunks ?? 0} 段摘要`
    : `基于 ${stats.days ?? 0} 天的每日总览`;
  return `${basis} · ${when} 生成 · ${digest.model}${digest.detail === "detailed" ? " · 详细" : ""}${digest.complete ? "" : " · 这段时间还没结束"}`;
};

const digestDayBody = (digest, keyPrefix) => {
  const summary = digest.summary;
  return [
    digestList(`${keyPrefix}:highlights`, "重点", summary.highlights, (item) =>
      el("li", { class: "digest-savable" },
        digestStar({ kind: "topic", title: item.title, body: item.detail ?? "", groupName: (item.groups ?? []).join("、") }),
        el("strong", {}, item.importance === "high" ? `★ ${item.title}` : item.title),
        el("p", {}, item.detail),
        digestGroupsLine(item.groups))),
    digestList(`${keyPrefix}:cross`, "多个群都在聊", summary.crossGroup, (item) => digestTitledItem(item.topic, item.detail, digestGroupsLine(item.groups))),
    digestList(`${keyPrefix}:things`, "新东西", summary.newThings, digestNewThing),
    digestList(`${keyPrefix}:open`, "没人回答的问题", summary.openQuestions, (item) =>
      el("li", {}, el("p", {}, item.question), item.group ? el("span", { class: "brief-meta" }, item.group) : null)),
    digestList(`${keyPrefix}:groups`, "各群一句话", summary.groups, (item) => el("li", {}, el("strong", {}, item.group), el("p", {}, item.oneLine))),
  ];
};

const digestPeriodBody = (digest, keyPrefix) => {
  const summary = digest.summary;
  const volumes = summary.stats?.volumes ?? [];
  return [
    digestList(`${keyPrefix}:trends`, "走向", summary.trends, (item) => digestTitledItem(item.title, item.detail)),
    digestList(`${keyPrefix}:highlights`, "重点", summary.highlights, (item) =>
      digestTitledItem(item.title, item.detail, el("span", { class: "brief-meta" }, [...(item.groups ?? []), ...(item.days ?? []).map((day) => day.slice(5))].join(" · ")))),
    digestList(`${keyPrefix}:groups`, "各群", summary.groups, (item) => digestTitledItem(item.group, item.summary)),
    digestList(`${keyPrefix}:things`, "新东西", summary.newThings, digestNewThing),
    digestList(`${keyPrefix}:qa`, "值得保存的问答", summary.bestQa, (item) =>
      el("li", {}, el("strong", {}, item.question), el("p", {}, item.answer), item.group ? el("span", { class: "brief-meta" }, item.group) : null)),
    digestList(`${keyPrefix}:volumes`, "消息量", volumes, (item) =>
      el("li", { class: "digest-volume" }, el("span", {}, item.groupName), el("strong", {}, briefNumber(item.messages)))),
  ];
};

const digestActions = (kind, period, entry) => {
  const running = digestJobRunning(kind, period);
  const busyElsewhere = digestJobRunning() && !running;
  const hasDigest = entry?.digest != null;
  const label = hasDigest ? "重新生成" : `生成${DIGEST_KIND_LABELS[kind]}`;
  return el("div", { class: "row digest-actions" },
    el("button", {
      class: `btn small ${hasDigest ? "" : "primary"}`,
      disabled: running || busyElsewhere || entry?.llmConfigured === false,
      onclick: () => generateDigest(kind, period),
    }, running ? "正在生成…" : label),
    running ? el("span", { class: "brief-meta" }, digestState.job.logTail?.at(-1) ?? "AI 正在写，稍等一两分钟…") : null,
    busyElsewhere ? el("span", { class: "brief-meta" }, "另一份总览正在生成，稍后再试。") : null,
    entry?.llmConfigured === false ? el("span", { class: "brief-meta" }, "还没有配置 AI 服务。") : null,
    digestState.notice ? el("span", { class: "brief-meta", style: `color:var(${digestState.notice.isError ? "--risk" : "--ok"})` }, digestState.notice.text) : null);
};

// One digest (any kind) with its header, body and generate button.
const digestCard = (kind, period, { title, headerExtra = null, emptyText } = {}) => {
  const key = digestKey(kind, period);
  const entry = digestState.entries[key];
  if (entry === undefined || (!entry.loading && Date.now() - (entry.loadedAt ?? 0) > DIGEST_STALE_MS)) {
    loadDigest(kind, period);
  }
  const digest = entry?.digest ?? null;
  return el("section", { class: `brief-section digest-card digest-${kind}` },
    el("h3", { class: "brief-section-title" }, title ?? DIGEST_KIND_LABELS[kind], el("span", { class: "brief-sub" }, digestPeriodLabel(kind, period)), headerExtra),
    entry?.error ? el("div", { class: "notice risk" }, entry.error) : null,
    digest === null
      ? el("p", { class: "brief-empty-line" }, entry?.loading ? "正在读取…" : emptyText ?? "还没有生成。")
      : el("div", { class: "digest-body" },
        digest.summary.headline ? el("p", { class: "digest-headline" }, digest.summary.headline) : null,
        digest.summary.summary ? el("p", { class: "digest-summary" }, digest.summary.summary) : null,
        el("div", { class: "digest-grid" }, kind === "day" ? digestDayBody(digest, key) : digestPeriodBody(digest, key)),
        el("p", { class: "brief-meta digest-meta" }, digestMeta(digest))),
    digestActions(kind, period, entry));
};

/* ---------- the briefing home: today / yesterday ---------- */

const digestHomeState = { day: null };

const digestHomeSection = () => {
  const today = digestToday();
  const day = digestHomeState.day ?? today;
  const pick = (value) => el("button", {
    class: `chip ${day === value ? "on" : ""}`,
    onclick: () => {
      digestHomeState.day = value;
      renderBriefView();
    },
  }, value === today ? "今天" : "昨天");
  return digestCard("day", day, {
    title: "各群总览",
    headerExtra: el("span", { class: "digest-switch" }, pick(today), pick(digestShiftDay(today, -1))),
    emptyText: day === today
      ? "今天的跨群总览还没写。点下面的按钮，AI 会把今天各群已整理的内容汇成一份。"
      : "昨天的总览会在后台自动生成；也可以现在就生成。",
  });
};

/* ---------- 回顾: the report list ---------- */

const digestReportList = (kind, onPick, selected) => {
  if (digestState.lists[kind] === null) {
    loadDigestList(kind);
  }
  const stored = new Map((digestState.lists[kind] ?? []).map((item) => [item.period, item]));
  return el("section", { class: "digest-reports" },
    el("h4", {}, kind === "week" ? "周报" : "月报"),
    el("ul", {}, digestRecentPeriods(kind).map((period) => {
      const item = stored.get(period);
      return el("li", {},
        el("button", {
          class: `digest-report-row ${selected === digestKey(kind, period) ? "on" : ""}`,
          onclick: () => onPick(kind, period),
        },
        el("span", {}, digestPeriodLabel(kind, period)),
        el("span", { class: "brief-meta" }, item ? item.headline || "已生成" : "未生成 · 点开可生成")));
    })));
};
