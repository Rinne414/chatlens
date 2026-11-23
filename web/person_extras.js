"use strict";

/* ---------- 个人页: more about the person (src/person_extras.js) ----------
   你和 TA, the names they used, what they keep saying, the questions they
   answered. Loaded beside the profile; the page shows without it meanwhile. */

const PX_ANSWERS_PREVIEW = 5;
const PX_PHRASES_PREVIEW = 12;

const loadPersonExtras = async () => {
  const key = personRequestKey();
  const range = groupRangeUnix();
  const params = new URLSearchParams({ uin: key.uin, fromUnix: String(range.fromUnix), toUnix: String(range.toUnix) });
  if (!key.all) {
    params.set("groupId", key.groupId);
  }
  try {
    const extras = await api(`/api/person/extras?${params}`);
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personExtras: extras, personExtrasError: null });
      renderGroupView();
    }
  } catch (error) {
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personExtras: null, personExtrasError: error.message });
      renderGroupView();
    }
  }
};

// The extras on screen belong to the person on screen (a slow answer for the
// one before is dropped by personRequestIsCurrent; this covers the gap).
const personExtrasFor = (data) => {
  const extras = app.groupPage.personExtras;
  const groupId = app.groupPage.personAll ? null : app.groupPage.groupId;
  return extras !== null && extras !== undefined && extras.uin === data.person.uin && extras.groupId === groupId ? extras : null;
};

const pxOpenChatAt = (item) => openMessagesView({
  groupId: item.groupId,
  groupName: item.groupName ?? personGroupName(item.groupId),
  fromUnix: (item.sentAt ?? item.startAt) - 600,
  scrollToTime: item.sentAt ?? item.startAt,
  ...(item.rowId ? { scrollToRowIds: [item.rowId] } : {}),
  origin: groupOrigin(),
});

const personWithMe = (data) => {
  const extras = personExtrasFor(data);
  if (extras === null || extras.withMe === null || data.person.isSelf) {
    return null;
  }
  const { toMe, fromMe, recent } = extras.withMe;
  return el("section", { class: "card gp-section px-with-me" },
    el("h3", {}, "你和 TA", el("span", { class: "kb-meta" }, "　所选时间 · 回复或 @")),
    toMe + fromMe === 0
      ? el("p", { class: "kb-meta" }, "这段时间你们没有互相回复或 @ 过。")
      : [
          el("p", { class: "px-counts" },
            "TA 找你 ", el("strong", {}, briefNumber(toMe)), " 次 · 你找 TA ", el("strong", {}, briefNumber(fromMe)), " 次"),
          el("ol", { class: "px-recent" }, recent.map((item) => el("li", {},
            el("button", { class: "px-row", type: "button", title: "在聊天里看这一条", onclick: () => pxOpenChatAt(item) },
              el("span", { class: `px-way ${item.direction}` }, item.direction === "toMe" ? "TA → 你" : "你 → TA"),
              el("span", { class: "px-text" }, item.isMedia === 1 ? "［图片 / 文件］" : item.text),
              el("span", { class: "kb-meta" }, `${app.groupPage.personAll ? `${item.groupName} · ` : ""}${briefMoment(item.sentAt)}`))))),
        ]);
};

const personNames = (data) => {
  const extras = personExtrasFor(data);
  if (extras === null || extras.names.length < 2) {
    return null;
  }
  return el("section", { class: "card gp-section" },
    el("h3", {}, "TA 用过的名字", el("span", { class: "kb-meta" }, `　所选时间 · ${extras.names.length} 个`)),
    el("ol", { class: "px-names" }, extras.names.map((item) => el("li", {},
      el("strong", {}, item.name),
      el("span", { class: "kb-meta" },
        `${shortDay(unixToHkt(item.firstAt).slice(0, 10))} – ${shortDay(unixToHkt(item.lastAt).slice(0, 10))} · ${briefNumber(item.messages)} 条`)))));
};

const personPhrases = (data) => {
  const extras = personExtrasFor(data);
  if (extras === null || extras.phrases.length === 0) {
    return null;
  }
  return el("section", { class: "card gp-section" },
    el("h3", {}, "TA 常说的话", el("span", { class: "kb-meta" }, "　所选时间里一字不差说过 3 次以上的短句")),
    expandable("pxPhrases", extras.phrases, PX_PHRASES_PREVIEW, (shown) => el("div", { class: "px-phrases" },
      shown.map((item) => el("span", { class: "tag plain", title: `最近一次 ${briefMoment(item.lastAt)}` }, item.text, el("small", {}, ` ×${item.times}`)))), "句"));
};

const personAnswers = (data) => {
  const extras = personExtrasFor(data);
  if (extras === null || extras.answers.length === 0) {
    return null;
  }
  return el("section", { class: "card gp-section" },
    el("h3", {}, "TA 回答过的问题", el("span", { class: "kb-meta" }, "　AI 总结里记在 TA 名下的 · 点开看当时的聊天")),
    expandable("pxAnswers", extras.answers, PX_ANSWERS_PREVIEW, (shown) => el("ol", { class: "px-answers" }, shown.map((item) => el("li", {},
      el("button", { class: "px-answer", type: "button", onclick: () => pxOpenChatAt(item) },
        el("strong", {}, item.question),
        el("span", {}, item.answer),
        el("span", { class: "kb-meta" }, `${app.groupPage.personAll ? `${item.groupName} · ` : ""}${briefMoment(item.endAt)}`))))), "个"));
};

// For the left column (under the trend) and the right column.
const personExtrasMain = (data) => [personWithMe(data), personAnswers(data)];
const personExtrasSide = (data) => [
  personPhrases(data),
  personNames(data),
  app.groupPage.personExtrasError
    ? el("p", { class: "kb-meta" }, `「你和 TA」、常说的话、用过的名字、回答过的问题没读到：${app.groupPage.personExtrasError}`)
    : null,
];

/* ---------- 我的页面 ---------- */

// The reader's own page across every group. A person page is a step of a
// group's page, so it opens from the group the reader spoke in most.
const openMyPage = async () => {
  try {
    const me = await api("/api/person/me");
    if (me.uin === null || me.groupId === null) {
      notify("还不知道哪个是你：你在关注的群里发过言之后，这里才有内容。");
      return;
    }
    openPersonAcross(me.uin, me.groupId);
  } catch (error) {
    notifyError(error);
  }
};
