"use strict";

/* ---------- 简报: 你在意的事 (src/interests.js) ----------
   A sentence about what the reader wants to hear of; the AI looks for it in
   the groups' new topics after each refresh. Under 关注的词 on the briefing:
   each sentence with what was found, and the box to write another. */

const INTEREST_HITS_PREVIEW = 3;

const briefInterests = { data: null, error: null, adding: false, busy: false, open: new Set() };

const loadBriefInterests = async () => {
  try {
    briefInterests.data = (await api("/api/interests")).interests;
    briefInterests.error = null;
  } catch (error) {
    briefInterests.error = error.message;
  }
};

const addBriefInterest = async (input) => {
  const text = input.value.trim();
  if (text === "" || briefInterests.busy) {
    return;
  }
  briefInterests.busy = true;
  try {
    await api("/api/interests", { method: "POST", body: JSON.stringify({ text }) });
    briefInterests.adding = false;
    await loadBriefInterests();
    notify("记下了。下次后台刷新时 AI 开始找，最近三天的话题也会看一遍。");
  } catch (error) {
    notifyError(error);
  }
  briefInterests.busy = false;
  renderBriefView();
};

const removeBriefInterest = async (interest) => {
  if (!await confirmInPage(`不再找「${interest.text}」？\n已经找到的 ${interest.hits.length} 条也会一起拿掉。`, { confirmLabel: "不找了" })) {
    return;
  }
  try {
    await api("/api/interests/delete", { method: "POST", body: JSON.stringify({ id: interest.id }) });
    await loadBriefInterests();
  } catch (error) {
    notifyError(error);
  }
  renderBriefView();
};

const briefInterestHit = (hit) => el("li", {},
  el("button", {
    class: "brief-row-button", type: "button", title: "看当时的聊天",
    onclick: () => openMessagesView({ groupId: hit.groupId, groupName: hit.groupName, fromUnix: hit.sentAt - 600, scrollToTime: hit.sentAt, origin: { view: "brief", label: "简报" } }),
  },
    el("strong", {}, hit.title),
    hit.summary ? el("span", { class: "interest-summary" }, hit.summary) : null,
    el("span", { class: "brief-meta" }, `${hit.groupName} · ${briefMoment(hit.sentAt)}${hit.why ? ` · ${hit.why}` : ""}`)));

const briefInterestBlock = (interest) => {
  const open = briefInterests.open.has(interest.id);
  const shown = open ? interest.hits : interest.hits.slice(0, INTEREST_HITS_PREVIEW);
  return el("div", { class: "interest" },
    el("div", { class: "interest-head" },
      el("strong", {}, interest.text),
      el("span", { class: "brief-count" }, String(interest.hits.length)),
      el("button", { class: "linklike", type: "button", "aria-label": `不再找「${interest.text}」`, title: "不再找这件事", onclick: () => removeBriefInterest(interest) }, "×")),
    interest.hits.length === 0
      ? el("p", { class: "brief-meta" }, "还没有找到。后台刷新时才会去找。")
      : el("ul", { class: "interest-hits" }, shown.map(briefInterestHit)),
    interest.hits.length > INTEREST_HITS_PREVIEW
      ? el("button", {
        class: "kb-facet-more", type: "button", "aria-expanded": String(open),
        onclick: () => {
          if (open) {
            briefInterests.open.delete(interest.id);
          } else {
            briefInterests.open.add(interest.id);
          }
          renderBriefView();
        },
      }, open ? "收起" : `显示全部 ${interest.hits.length} 条`)
      : null);
};

const briefInterestForm = () => {
  const input = el("input", {
    type: "text", class: "brief-watch-input interest-input", maxlength: "120",
    placeholder: "用一句话写你在意什么，例如：有人分享新的 LoRA 训练教程",
    "aria-label": "你在意的事",
  });
  return el("form", {
    class: "brief-watch-form",
    onsubmit: (event) => {
      event.preventDefault();
      addBriefInterest(input);
    },
  }, input, el("button", { class: "btn small", type: "submit", disabled: briefInterests.busy }, "让 AI 帮我盯"));
};

const briefInterestsSection = (data) => {
  if (briefInterests.data === null && briefInterests.error === null) {
    // First draw: fetch, and draw again when it is in.
    briefInterests.data = [];
    loadBriefInterests().then(renderBriefWhenIdle);
  }
  const interests = briefInterests.data ?? [];
  const aiReady = data.status?.llmConfigured === true;
  if (interests.length === 0 && !briefInterests.adding) {
    // Nothing written yet: one quiet line, not a section.
    return aiReady && !ccRemote ? el("p", { class: "brief-empty-line interest-invite" },
      el("button", {
        class: "linklike", type: "button",
        title: "关注的词只找那个词；这里写一句话，AI 按意思找，每次刷新多一次 AI 调用",
        onclick: () => {
          briefInterests.adding = true;
          renderBriefView();
        },
      }, "＋ 让 AI 帮你盯一件事")) : null;
  }
  return el("section", { class: "brief-section brief-interests" },
    el("h3", { class: "brief-section-title" }, "你在意的事",
      el("span", { class: "brief-sub" }, "AI 每次刷新时从各群的新话题里找")),
    briefInterests.error ? el("p", { class: "brief-meta" }, `没读到：${briefInterests.error}`) : null,
    interests.map(briefInterestBlock),
    ccRemote ? null : briefInterestForm(),
    aiReady ? null : el("p", { class: "brief-meta" }, "还没有配置 AI 服务，暂时不会去找。"));
};
