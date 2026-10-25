"use strict";

// 笔记库: the day, group and overview pages and the table view (.base) of the
// topics. Same conventions as src/vault_render.js: prose through ctx.p(),
// names as written, long lists folded instead of cut.

const { inlineText } = require("./vault_note_io");
const {
  RECENT_DAYS, dayOf, minuteOf, kindLabel, categoryLabel, wikiLink, groupLink, topicLink, openLink, foldedList, firstSentence,
  markdownUrl, hostPath, topicSummary, mentionsSince,
} = require("./vault_render");
const { bestDetail } = require("./things_index");

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const OVERVIEW_LINES = 20;
const MANY_MENTIONS = 5;
const NAMES_IN_LINE = 6;
const LOOSE_DETAIL_CHARS = 50;
const SUMMARY_IN_LINE = 40;
const DAY_SECONDS = 86400;
// What day and group notes counted before there were topics.
const FORMER_KEYS = ["thing_count"];

const weekday = (day) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];

const clock = (text) => String(text ?? "").slice(11, 16);

const groupByName = (ctx, name) => {
  const groupId = ctx.groupIdByName.get(name);
  return groupId === undefined ? inlineText(name) : groupLink(ctx, groupId);
};

const groupNamesLine = (ctx, names) => (Array.isArray(names) && names.length > 0 ? `（${names.map((name) => groupByName(ctx, name)).join("、")}）` : "");

// "A、B、C 等 12 个": the first few names of a list.
const someNames = (ctx, things) => `${things.slice(0, NAMES_IN_LINE).map((thing) => inlineText(thing.name)).join("、")}${things.length > NAMES_IN_LINE ? ctx.p(` 等 ${things.length} 个`) : ""}`;

const folded = (title, lines) => (lines.length === 0 ? [] : ["", `> [!note]- ${title}`, ...lines.map((line) => `> ${line}`)]);

/* ---------- day ---------- */

const digestSections = (ctx, digest) => {
  if (digest === null) {
    return [];
  }
  const list = (value) => (Array.isArray(value) ? value : []);
  return [
    ...(digest.headline ? [`> [!abstract] ${inlineText(ctx.p(digest.headline))}`, ""] : []),
    ...(list(digest.highlights).length > 0 ? [
      `## ${ctx.p("重点")}`,
      ...list(digest.highlights).map((item) => `- **${inlineText(ctx.p(item.title))}**：${inlineText(ctx.p(item.detail))}${groupNamesLine(ctx, item.groups)}`),
      "",
    ] : []),
    ...(list(digest.crossGroup).length > 0 ? [
      `## ${ctx.p("好几个群都在聊")}`,
      ...list(digest.crossGroup).map((item) => `- **${inlineText(ctx.p(item.topic))}**：${inlineText(ctx.p(item.detail))}${groupNamesLine(ctx, item.groups)}`),
      "",
    ] : []),
  ];
};

// A topic that day: how many groups, and the things under it that first came
// up that day.
const dayTopicLine = (ctx, entry, day) => {
  const isNew = dayOf(entry.topic.firstAt) === day;
  const fresh = entry.things.filter((thing) => dayOf(thing.firstAt) === day && !entry.topic.core.includes(thing));
  return [
    `- ${topicLink(ctx, entry.topic)}`,
    categoryLabel(ctx, entry.topic.category),
    ctx.p(`${entry.groupIds.size} 个群`),
    ...(isNew ? [`**${ctx.p("第一次出现")}**`] : []),
  ].join(" · ") + (fresh.length > 0 && !isNew ? ctx.p(` · 新：${someNames(ctx, fresh)}`) : "");
};

// A thing of the day that has no topic note: its name and what was said.
const looseLine = (ctx, entry) => {
  const mention = entry.thing.mentions.find((item) => dayOf(item.sentAt) === entry.day) ?? bestDetail(entry.thing);
  const detail = firstSentence(mention.detail, LOOSE_DETAIL_CHARS);
  return `- **${inlineText(entry.thing.name)}** · ${kindLabel(ctx, entry.thing.kind)}${detail ? `：${inlineText(ctx.p(detail))}` : ""}${openLink(ctx, mention.groupId, mention.sentAt)}`;
};

const dayGroupSection = (ctx, group, oneLine) => [
  `### ${groupLink(ctx, group.groupId)} · ${ctx.p(`${group.messages} 条消息`)}`,
  ...(oneLine ? [inlineText(ctx.p(oneLine)), ""] : []),
  ...foldedList(ctx, group.topics.map((topic) => {
    const span = clock(topic.start) ? `${clock(topic.start)}${clock(topic.end) && clock(topic.end) !== clock(topic.start) ? `–${clock(topic.end)}` : ""} ` : "";
    return `- ${span}**${inlineText(ctx.p(topic.title))}**：${inlineText(ctx.p(topic.summary))}`;
  }), (count) => ctx.p(`更早的 ${count} 段`)),
  ...folded(ctx.p(`问答（${group.answers.length}）`), group.answers.map((answer) =>
    `- ${minuteOf(answer.sentAt).slice(11)} **${ctx.p("问")}** ${inlineText(ctx.p(answer.question))} → ${inlineText(ctx.p(answer.answer))}${openLink(ctx, group.groupId, answer.sentAt)}`)),
  ...folded(ctx.p(`链接（${group.links.length}）`), group.links.map((link) =>
    `- [${inlineText(link.title || hostPath(link.url))}](${markdownUrl(link.url)})${link.why ? `：${inlineText(ctx.p(link.why))}` : ""}`)),
  "",
];

const renderDay = (ctx, { id, entry }) => {
  const { day, digest } = entry;
  const oneLines = new Map((Array.isArray(digest?.groups) ? digest.groups : []).map((item) => [item.group, item.oneLine]));
  const openQuestions = Array.isArray(digest?.openQuestions) ? digest.openQuestions : [];
  const messages = entry.groups.reduce((total, group) => total + group.messages, 0);
  const managed = [
    ["chatlens", id],
    ["type", ctx.p("日报")],
    ["date", day],
    ["messages", messages],
    ["group_count", entry.groups.length],
    ["topic_count", entry.topics.length],
  ];
  const body = [
    `# ${day}（${ctx.p(`周${weekday(day)}`)}）`,
    "",
    ...digestSections(ctx, digest),
    ...(entry.topics.length > 0 ? [
      `## ${ctx.p(`提到的主题（${entry.topics.length}）`)}`,
      ...foldedList(ctx, entry.topics.map((item) => dayTopicLine(ctx, item, day)), (count) => ctx.p(`另外 ${count} 个`)),
      "",
    ] : []),
    ...(entry.loose.length > 0 ? [
      `## ${ctx.p(`零散提到（${entry.loose.length}）`)}`,
      ...foldedList(ctx, entry.loose.map((thing) => looseLine(ctx, { thing, day })), (count) => ctx.p(`另外 ${count} 个`)),
      "",
    ] : []),
    ...(openQuestions.length > 0 ? [
      `## ${ctx.p("还没人回答")}`,
      ...openQuestions.map((item) => `- ${inlineText(ctx.p(item.question))}${item.group ? `（${groupByName(ctx, item.group)}）` : ""}`),
      "",
    ] : []),
    `## ${ctx.p(`各群（${entry.groups.length}）`)}`,
    "",
    ...entry.groups.flatMap((group) => dayGroupSection(ctx, group, oneLines.get(ctx.groupNames.get(group.groupId)))),
    ...(digest?.summary ? folded(ctx.p("当天总览全文"), [inlineText(ctx.p(digest.summary))]) : []),
  ];
  return { managed, body: body.join("\n"), drop: FORMER_KEYS };
};

/* ---------- group ---------- */

const renderGroup = (ctx, { id, entry }) => {
  const managed = [
    ["chatlens", id],
    ["type", ctx.p("群")],
    ["messages", entry.messages],
    ["first_day", entry.firstDay ?? ""],
    ["last_day", entry.lastDay ?? ""],
    ["topic_count", entry.topics.length],
  ];
  const body = [
    ctx.p(`本地存了 ${entry.messages} 条消息${entry.firstDay ? `，从 ${entry.firstDay} 到 ${entry.lastDay}` : ""}；AI 整理过其中 ${entry.days.length} 天。`),
    "",
    `## ${ctx.p(`常聊的主题（${entry.topics.length}）`)}`,
    ...(entry.topics.length > 0
      ? foldedList(ctx, entry.topics.map((item) =>
        `- ${topicLink(ctx, item.topic)} · ${categoryLabel(ctx, item.topic.category)} · ${ctx.p(`在这个群 ${item.count} 次`)} · ${ctx.p("最近")} ${dayOf(item.lastAt)}`), (count) => ctx.p(`另外 ${count} 个`))
      : [ctx.p("还没有。")]),
    "",
    `## ${ctx.p(`每天（${entry.days.length} 天，最新在上）`)}`,
    ...foldedList(ctx, entry.days.map((item) =>
      `- ${ctx.dayTarget.has(item.day) ? wikiLink(ctx.dayTarget.get(item.day), item.day) : item.day} · ${ctx.p(`${item.messages} 条消息 · ${item.topics} 段话题`)}`), (count) => ctx.p(`更早的 ${count} 天`)),
  ];
  return { managed, body: body.join("\n"), drop: FORMER_KEYS };
};

/* ---------- overview ---------- */

const topicLine = (ctx, topic, extra = "") => {
  const summary = topicSummary(topic, ctx.consensusOf(topic));
  return `- ${topicLink(ctx, topic)} · ${categoryLabel(ctx, topic.category)} · ${ctx.p(`${topic.groups.length} 个群 · ${topic.mentions.length} 次`)}${extra}${summary ? ` — ${inlineText(ctx.p(firstSentence(summary, SUMMARY_IN_LINE)))}` : ""}`;
};

const recentGroupCount = (topic, since) => new Set(topic.mentions.filter((mention) => mention.sentAt >= since).map((mention) => mention.groupId)).size;

const overviewLists = (ctx, topics, nowUnix) => {
  const since = nowUnix - RECENT_DAYS * DAY_SECONDS;
  const listed = topics.filter((topic) => !ctx.isIgnored(topic));
  const hot = listed.filter((topic) => topic.lastAt >= since)
    .map((topic) => ({ topic, recent: recentGroupCount(topic, since), count: mentionsSince(topic.mentions, since) }))
    .sort((left, right) => right.recent - left.recent || right.count - left.count)
    .slice(0, OVERVIEW_LINES);
  const freshTopics = listed.filter((topic) => topic.firstAt >= since)
    .sort((left, right) => right.groups.length - left.groups.length || right.mentions.length - left.mentions.length);
  const freshItems = listed.filter((topic) => topic.firstAt < since)
    .map((topic) => ({ topic, things: topic.members.filter((member) => member.role !== "main" && member.thing.firstAt >= since).map((member) => member.thing) }))
    .filter((entry) => entry.things.length > 0)
    .sort((left, right) => right.things.length - left.things.length);
  const unsourced = listed.flatMap((topic) => topic.members.map((member) => ({ topic, thing: member.thing })))
    .filter((entry) => entry.thing.links.length === 0 && entry.thing.mentions.length >= MANY_MENTIONS)
    .sort((left, right) => right.thing.mentions.length - left.thing.mentions.length);
  return { hot, freshTopics, freshItems, unsourced };
};

const renderOverview = (ctx, { id, topics, days, groupCount, coverage, nowUnix, baseTarget, pendingTopics }) => {
  const { hot, freshTopics, freshItems, unsourced } = overviewLists(ctx, topics, nowUnix);
  const managed = [
    ["chatlens", id],
    ["type", ctx.p("总览")],
    ["updated", minuteOf(nowUnix)],
  ];
  const body = [
    ctx.p(`更新于 ${minuteOf(nowUnix)} · ${topics.length} 个主题 · ${days.length} 天日报 · ${groupCount} 个群`),
    "",
    ...(coverage.unsummarized > 0 ? [
      `> [!warning] ${ctx.p(`还有 ${coverage.unsummarized} 条消息没让 AI 整理过（共 ${coverage.messages} 条），这些天里提到的东西还不在这里。在 ChatLens 的 设置 → Obsidian 笔记库 里可以整理旧消息。`)}`,
      "",
    ] : []),
    ...(pendingTopics > 0 ? [
      `> [!info] ${ctx.p(`还有 ${pendingTopics} 个新提到的东西没分进主题，下次自动刷新时 AI 会分。`)}`,
      "",
    ] : []),
    `## ${ctx.p(`最近 ${RECENT_DAYS} 天，最多群在讲`)}`,
    ...(hot.length > 0 ? hot.map((item) => topicLine(ctx, item.topic, ctx.p(` · 这 ${RECENT_DAYS} 天 ${item.recent} 个群`))) : [ctx.p("这几天没有。")]),
    "",
    `## ${ctx.p(`最近 ${RECENT_DAYS} 天新冒出来的`)}`,
    ...(freshTopics.length > 0
      ? [`**${ctx.p(`新主题（${freshTopics.length}）`)}**`, ...foldedList(ctx, freshTopics.map((topic) => topicLine(ctx, topic)), (count) => ctx.p(`另外 ${count} 个`)), ""]
      : []),
    ...(freshItems.length > 0
      ? [`**${ctx.p("已有主题里的新东西")}**`, ...foldedList(ctx, freshItems.map((entry) => `- ${topicLink(ctx, entry.topic)}：${someNames(ctx, entry.things)}`), (count) => ctx.p(`另外 ${count} 个主题`)), ""]
      : []),
    ...(freshTopics.length === 0 && freshItems.length === 0 ? [ctx.p("这几天没有。"), ""] : []),
    `## ${ctx.p(`传得多、但没人贴出处（${unsourced.length}）`)}`,
    ctx.p("这些东西被提到很多次，却没有人贴过它的链接：先当传闻看。"),
    ...foldedList(ctx, unsourced.map((entry) => `- **${inlineText(entry.thing.name)}**（${topicLink(ctx, entry.topic)}）· ${ctx.p(`${entry.thing.mentions.length} 次 · ${entry.thing.groups.length} 个群`)}`), (count) => ctx.p(`另外 ${count} 个`)),
    "",
    `## ${ctx.p("全部主题")}`,
    `![[${baseTarget}]]`,
    "",
    `## ${ctx.p("最近的日报")}`,
    ...days.slice(0, RECENT_DAYS).map((day) => `- ${wikiLink(ctx.dayTarget.get(day), day)}`),
  ];
  return { managed, body: body.join("\n") };
};

/* ---------- table view of the topics ---------- */

// First line of the .base ChatLens writes. Changing the views in Obsidian
// rewrites the file without it, so a file that still has it is ChatLens's even
// when the record of what was written last is lost.
const BASE_MARKER = "# chatlens: 表格视图由 ChatLens 生成；在 Obsidian 里改过视图之后，ChatLens 就不再改这个文件。";

const baseFile = (ctx, topicsFolder) => {
  const column = (key, label) => [`  ${key}:`, `    displayName: ${JSON.stringify(ctx.p(label))}`];
  const view = (name, { sort, filter = null, groupBy = null, order }) => [
    "  - type: table",
    `    name: ${JSON.stringify(ctx.p(name))}`,
    ...(filter === null ? [] : ["    filters:", "      and:", `        - ${filter}`]),
    ...(groupBy === null ? [] : ["    groupBy:", `      property: ${groupBy}`, "      direction: ASC"]),
    "    order:",
    ...order.map((key) => `      - ${key}`),
    "    sort:",
    `      - property: ${sort}`,
    "        direction: DESC",
  ];
  const columns = ["file.name", "category", "summary", "mentions_7d", "group_count", "items", "last_seen"];
  return [
    BASE_MARKER,
    "filters:",
    "  and:",
    `    - file.inFolder(${JSON.stringify(topicsFolder)})`,
    "    - file.ext == \"md\"",
    `    - type == ${JSON.stringify(ctx.p("主题"))}`,
    // Not "ignore != true": how != treats a note without the property is not
    // documented, and every note but the ignored ones lacks it.
    "    - not:",
    "        - ignore == true",
    "properties:",
    ...column("file.name", "主题"),
    ...column("note.category", "类别"),
    ...column("note.summary", "是什么"),
    ...column("note.mentions_7d", "近 7 天"),
    ...column("note.group_count", "群"),
    ...column("note.mentions", "提到"),
    ...column("note.items", "下面的东西"),
    ...column("note.first_seen", "第一次"),
    ...column("note.last_seen", "最近"),
    "views:",
    ...view("最近热度", { sort: "mentions_7d", order: columns }),
    ...view("按类别", { sort: "group_count", groupBy: "category", order: columns }),
    ...view("最多群在讲", { sort: "group_count", order: columns }),
    ...view("刚冒出来", { sort: "first_seen", order: ["file.name", "category", "summary", "group_count", "first_seen"] }),
    ...view("有共识", { sort: "group_count", filter: "consensus == true", order: columns }),
    "",
  ].join("\n");
};

module.exports = { renderDay, renderGroup, renderOverview, baseFile, BASE_MARKER };
