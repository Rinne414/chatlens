"use strict";

// 笔记库: the markdown of one topic's note (src/vault_pages.js has the day,
// group and overview pages). Everything is written in the store's language
// (Simplified) and passed through ctx.p(), which converts prose when the
// vault is Traditional; group and people names stay as written.

const { inlineText } = require("./vault_note_io");
const { bestDetail, clipText } = require("./things_index");

const KIND_LABELS = { model: "模型", tool: "工具", resource: "资源", news: "新闻", tutorial: "教程", event: "活动", other: "其他" };
const CATEGORY_LABELS = {
  image: "图像模型",
  video: "视频和语音模型",
  llm: "语言模型",
  coding: "AI 编程和 Agent",
  creative: "生图和训练工具",
  app: "软件和服务",
  site: "网站和社区",
  news: "新闻和活动",
  other: "其他",
};
// The sections of a topic note, in this order; "main" members are the topic
// itself under other names and are not listed.
const ROLE_SECTIONS = [
  ["version", "版本"],
  ["derived", "LoRA 和微调"],
  ["tool", "插件和工具"],
  ["guide", "工作流和教程"],
  ["work", "作品和资讯"],
  ["other", "其他"],
];
// The first lines of a long list are open, the rest folded: nothing is cut,
// and a note with 500 mentions still reads from the top.
const OPEN_LINES = 15;
const SUMMARY_CHARS = 120;
const ITEM_DETAIL_CHARS = 60;
const TOP_PEOPLE = 5;
const RECENT_DAYS = 7;
const DAY_SECONDS = 86400;
const BEIJING_OFFSET_SECONDS = 8 * 3600;

const beijing = (unix) => new Date((unix + BEIJING_OFFSET_SECONDS) * 1000).toISOString();
const dayOf = (unix) => beijing(unix).slice(0, 10);
const minuteOf = (unix) => beijing(unix).slice(0, 16).replace("T", " ");

const kindLabel = (ctx, kind) => ctx.p(KIND_LABELS[kind] ?? KIND_LABELS.other);
const categoryLabel = (ctx, category) => ctx.p(CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other);

// A label inside [[target|label]] cannot hold | or ]].
const linkLabel = (text) => String(text ?? "").replace(/\|/gu, "｜").replace(/\]\]/gu, "］］").replace(/\s+/gu, " ").trim();

const wikiLink = (target, label) => `[[${target}|${linkLabel(label)}]]`;

const groupLink = (ctx, groupId) => {
  const name = ctx.groupNames.get(groupId) ?? groupId;
  const target = ctx.groupTarget.get(groupId);
  return target === undefined ? inlineText(name) : wikiLink(target, name);
};

const topicLink = (ctx, topic) => {
  const target = ctx.topicTarget.get(topic.key);
  return target === undefined ? inlineText(ctx.p(topic.name)) : wikiLink(target, ctx.p(topic.name));
};

// A plain http link back to that moment of the chat in ChatLens.
const chatUrl = (ctx, groupId, sentAt) => `${ctx.serverUrl}/?chat=${encodeURIComponent(groupId)}&at=${sentAt}`;

const openLink = (ctx, groupId, sentAt) => (ctx.serverUrl ? ` · [${ctx.p("打开")}](${chatUrl(ctx, groupId, sentAt)})` : "");

// Lines that are all open up to OPEN_LINES, the rest in a folded callout.
const foldedList = (ctx, lines, foldTitle) => {
  if (lines.length <= OPEN_LINES) {
    return lines;
  }
  const rest = lines.slice(OPEN_LINES);
  return [...lines.slice(0, OPEN_LINES), "", `> [!note]- ${foldTitle(rest.length)}`, ...rest.map((line) => `> ${line}`)];
};

const firstSentence = (text, limit = SUMMARY_CHARS) => {
  const plain = String(text ?? "").replace(/\s+/gu, " ").trim();
  const end = plain.search(/[。！？!?]/u);
  return clipText(end >= 0 ? plain.slice(0, end + 1) : plain, limit);
};

// A URL that is safe inside markdown's (...): spaces, CJK and parentheses encoded.
const markdownUrl = (url) => encodeURI(decodeURISafe(url)).replace(/\(/gu, "%28").replace(/\)/gu, "%29");

function decodeURISafe(url) {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

const hostPath = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./u, "")}${parsed.pathname.replace(/\/$/u, "")}`;
  } catch {
    return url;
  }
};

const LINK_LABEL_CHARS = 48;

const sourceLink = (link) => `[${inlineText(clipText(hostPath(link.url), LINK_LABEL_CHARS))}](${markdownUrl(link.url)})`;

// The link that names the thing: the most posted, then the shortest
// (github.com/a/b over .../blob/main/assets/x.webp).
const bestLink = (links) => [...links].sort((left, right) => right.count - left.count || left.key.length - right.key.length)[0];

const mentionsSince = (mentions, since) => mentions.filter((mention) => mention.sentAt >= since).length;

// What the topic is, in one line: the consensus, else what the AI said when
// it named the topic, else what it said its main thing is (a thing that is a
// topic of its own has no topic line), else the best thing the chat said
// about it -- which tells who mentioned it rather than what it is.
const topicSummary = (topic, consensus) => consensus?.result.what
  || topic.what
  || topic.members.find((member) => member.role === "main" && member.what)?.what
  || firstSentence(bestDetail(topic.core[0] ?? topic.members[0].thing)?.detail);

/* ---------- one topic ---------- */

const consensusBlock = (ctx, topic, consensus) => {
  if (consensus === null) {
    return [
      `> [!info] ${ctx.p("是什么")}`,
      `> ${inlineText(ctx.p(topicSummary(topic, null) || "（群里没说清楚）"))}`,
      ">",
      `> ${ctx.p(topic.groups.length >= ctx.consensusMinGroups
        ? "AI 还没把各群的说法整理成共识，之后自动刷新时会整理。"
        : `只有 ${topic.groups.length} 个群提到；${ctx.consensusMinGroups} 个以上的群在讲时，AI 会把说法整理成「群里的共识」。`)}`,
    ];
  }
  const { result } = consensus;
  return [
    `> [!summary] ${ctx.p("群里的共识")}`,
    `> ${inlineText(ctx.p(result.what))}`,
    ...(result.points.length > 0 ? [">", ...result.points.map((point) => `> - ${inlineText(ctx.p(point))}`)] : []),
    ...(result.unsure.length > 0 ? [">", `> **${ctx.p("还没定论")}**`, ...result.unsure.map((point) => `> - ${inlineText(ctx.p(point))}`)] : []),
    ">",
    `> ${ctx.p(`AI 根据最近 ${consensus.usedMentions} 次提到、${consensus.usedAnswers} 个问答整理（当时共 ${consensus.mentionCount} 次提到），${dayOf(consensus.madeAt)}。`)}`,
  ];
};

const sourceLines = (ctx, topic, vaultNotes) => {
  const links = [...topic.links].sort((left, right) => right.count - left.count || left.key.length - right.key.length)
    .map((link) => `${sourceLink(link)}${link.count > 1 ? ` ×${link.count}` : ""}`);
  const own = [...new Set(topic.members.flatMap(({ thing }) => thing.links).map((link) => vaultNotes.get(link.key)).filter(Boolean))];
  const people = new Map();
  topic.mentions.filter((mention) => mention.speaker !== "").forEach((mention) => people.set(mention.speaker, (people.get(mention.speaker) ?? 0) + 1));
  const top = [...people].sort((left, right) => right[1] - left[1]).slice(0, TOP_PEOPLE);
  return [
    `**${ctx.p("出处")}**：${links.length > 0 ? links.join(" · ") : ctx.p("群里没人贴过它本身的链接，说法未经核实。")}`,
    ...(own.length > 0 ? [`**${ctx.p("你的库里")}**：${own.map((target) => `[[${target}]]`).join(" · ")}`] : []),
    ...(top.length > 0 ? [`**${ctx.p("谁在讲")}**：${top.map(([name, count]) => `${inlineText(name)} ${count}`).join(" · ")}`] : []),
  ];
};

// One line per thing under the topic: what it is, how widely it came up, its
// link, and where the newest mention is in the chat.
const memberLine = (ctx, { thing, what }) => {
  const newest = thing.mentions[0];
  const about = what || firstSentence(bestDetail(thing)?.detail, ITEM_DETAIL_CHARS);
  return [
    `- **${inlineText(thing.name)}**${about ? ` — ${inlineText(ctx.p(about))}` : ""}`,
    ctx.p(`${thing.groups.length} 个群 · ${thing.mentions.length} 次`),
    dayOf(thing.lastAt),
    ...(thing.links.length > 0 ? [sourceLink(bestLink(thing.links))] : []),
  ].join(" · ") + openLink(ctx, newest.groupId, newest.sentAt);
};

const memberSections = (ctx, topic) => ROLE_SECTIONS.flatMap(([role, title]) => {
  const members = topic.members.filter((member) => member.role === role);
  return members.length === 0 ? [] : [
    `## ${ctx.p(`${title}（${members.length}）`)}`,
    ...foldedList(ctx, members.map((member) => memberLine(ctx, member)), (count) => ctx.p(`另外 ${count} 个`)),
    "",
  ];
});

const answerLine = (ctx, answer) =>
  `- ${dayOf(answer.sentAt)} · ${groupLink(ctx, answer.groupId)} · **${ctx.p("问")}** ${inlineText(ctx.p(answer.question))} → ${inlineText(ctx.p(answer.answer))}${openLink(ctx, answer.groupId, answer.sentAt)}`;

// A mention of a member that is not the topic itself says which one.
const mentionLine = (ctx, topic, mention) => {
  const isCore = topic.core.includes(mention.thing);
  const label = isCore ? "" : `**${inlineText(mention.thing.name)}**：`;
  return `- ${minuteOf(mention.sentAt)} · ${groupLink(ctx, mention.groupId)}${mention.speaker ? ` · ${inlineText(mention.speaker)}` : ""}：${label}${inlineText(ctx.p(mention.detail || mention.name))}${openLink(ctx, mention.groupId, mention.sentAt)}`;
};

// managed frontmatter + body of a topic's note.
const renderTopic = (ctx, { topic, consensus, answers, aliases, vaultNotes, id, nowUnix }) => {
  const listed = topic.members.filter((member) => member.role !== "main");
  const managed = [
    ["chatlens", id],
    ["type", ctx.p("主题")],
    ["category", categoryLabel(ctx, topic.category)],
    ["summary", ctx.p(topicSummary(topic, consensus))],
    ["aliases", aliases],
    ["items", listed.length],
    ["mentions", topic.mentions.length],
    ["mentions_7d", mentionsSince(topic.mentions, nowUnix - RECENT_DAYS * DAY_SECONDS)],
    ["group_count", topic.groups.length],
    ["groups", topic.groups.map((group) => groupLink(ctx, group.groupId))],
    ["first_seen", dayOf(topic.firstAt)],
    ["last_seen", dayOf(topic.lastAt)],
    ["source", topic.links.length > 0 ? bestLink(topic.links).url : ""],
    ["consensus", consensus !== null],
  ];
  const body = [
    ...consensusBlock(ctx, topic, consensus),
    "",
    ...sourceLines(ctx, topic, vaultNotes),
    "",
    ...memberSections(ctx, topic),
    `## ${ctx.p(`问答（${answers.length}）`)}`,
    ...(answers.length > 0
      ? foldedList(ctx, answers.map((answer) => answerLine(ctx, answer)), (count) => ctx.p(`更早的 ${count} 个问答`))
      : [ctx.p("还没有提到它的、有答案的问答。")]),
    "",
    `## ${ctx.p(`群里怎么说（${topic.mentions.length} 次 · ${topic.groups.length} 个群 · 最新在上）`)}`,
    ...foldedList(ctx, topic.mentions.map((mention) => mentionLine(ctx, topic, mention)), (count) => ctx.p(`更早的 ${count} 次`)),
    "",
    // How to correct the AI from here (src/vault_identity.js readPins).
    `*${ctx.p("分错了？把一个名字加进 aliases，它就归到这个主题；从 aliases 删掉一个名字，它就离开这个主题。")}*`,
  ];
  return { managed, body: body.join("\n") };
};

// A note ChatLens no longer writes that holds the user's own words (a thing
// note from before topics, or a topic since folded into another): it keeps
// them and points at where the thing lives now.
const renderRetired = (ctx, { id, into }) => ({
  managed: [["chatlens", id], ["type", ctx.p("已合并")]],
  body: [
    `> [!note] ${ctx.p("这则笔记 ChatLens 不再更新")}${into === null ? "" : `${ctx.p("，内容现在在")} ${topicLink(ctx, into)}`}`,
    `> ${ctx.p("下面「我的笔记」里你写的内容还在这里；需要的话可以搬过去，之后删掉这则笔记即可。")}`,
  ].join("\n"),
});

module.exports = {
  KIND_LABELS,
  CATEGORY_LABELS,
  OPEN_LINES,
  RECENT_DAYS,
  dayOf,
  minuteOf,
  kindLabel,
  categoryLabel,
  wikiLink,
  linkLabel,
  groupLink,
  topicLink,
  openLink,
  foldedList,
  firstSentence,
  markdownUrl,
  hostPath,
  topicSummary,
  mentionsSince,
  renderTopic,
  renderRetired,
};
