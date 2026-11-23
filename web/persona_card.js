"use strict";

/* ---------- 个人页: 角色卡 (src/persona_card.js) ----------
   Who the person is and how they talk, written by the AI from their own
   words, every point with the chat lines it rests on, and a blind test of
   how well the card imitates them. Made only when asked for. */

const PERSONA_POLL_MS = 3000;
const PERSONA_STEPS = {
  material: () => "整理 TA 的发言",
  observe: (done, total) => `AI 在读 TA 的发言（第 ${done + 1} / ${total} 批）`,
  compose: () => "AI 在写角色卡",
  test: () => "盲测：让 AI 照着卡回复，再让另一次 AI 分辨真假",
};
const PERSONA_KINDS = [
  ["stances", "看法和立场", (item) => [el("strong", {}, item.topic), "：", item.view]],
  ["attitudes", "对不同的人", (item) => ["对 ", el("strong", {}, item.toward), "：", item.how]],
  ["humor", "怎么开玩笑", (item) => [item.kind]],
  ["interests", "常聊的东西", (item) => [item.what]],
  ["facts", "关于自己", (item) => [item.fact]],
];

const personaUi = { uin: null, data: null, error: null, timer: null, open: new Set(), busy: false };

const personaIsRunningFor = (uin) => personaUi.data?.job?.status === "running" && personaUi.data.job.meta?.uin === uin;

const loadPersona = async (uin) => {
  if (personaUi.uin !== uin) {
    Object.assign(personaUi, { uin, data: null, error: null, open: new Set() });
  }
  clearTimeout(personaUi.timer);
  try {
    const data = await api(`/api/persona?uin=${uin}`);
    if (personaUi.uin !== uin) {
      return;
    }
    Object.assign(personaUi, { data, error: null });
  } catch (error) {
    if (personaUi.uin !== uin) {
      return;
    }
    personaUi.error = error.message;
  }
  renderGroupView();
  // Only while a card is being made, and only while its page is open.
  if (personaUi.data?.job?.status === "running" && app.view === "group" && app.groupPage.person === uin) {
    personaUi.timer = setTimeout(() => loadPersona(uin), PERSONA_POLL_MS);
  }
};

const startPersona = async (person, again) => {
  const ok = await confirmInPage(
    `${again ? "重新生成" : "生成"} ${person.name} 的角色卡？\nAI 会读 TA 最近 180 天在所有群的发言（最多约 600 段），这些聊天原文会发给你在设置里配置的 AI 服务，大约 9 次调用，要几分钟。`,
    { confirmLabel: again ? "重新生成" : "生成" });
  if (!ok) {
    return;
  }
  personaUi.busy = true;
  renderGroupView();
  try {
    await api("/api/persona", { method: "POST", body: JSON.stringify({ uin: person.uin, name: person.name }) });
  } catch (error) {
    notifyError(error);
  }
  personaUi.busy = false;
  await loadPersona(person.uin);
};

const deletePersonaCard = async (person) => {
  if (!await confirmInPage(`删掉 ${person.name} 的角色卡？\n只删这张卡，聊天记录不受影响；之后可以再生成。`, { confirmLabel: "删掉", danger: true })) {
    return;
  }
  try {
    await api("/api/persona/delete", { method: "POST", body: JSON.stringify({ uin: person.uin }) });
  } catch (error) {
    notifyError(error);
  }
  await loadPersona(person.uin);
};

const copyPersonaText = async (card) => {
  try {
    await navigator.clipboard.writeText(card.text);
    notify("已复制。可以贴到任何 AI 对话里当作人设。");
  } catch {
    notify("复制失败：浏览器没有给剪贴板权限。", { isError: true });
  }
};

const personaProgress = (job) => {
  const line = [...(job.logTail ?? [])].reverse().find((item) => /persona step=/u.test(item)) ?? "";
  const match = /persona step=(\w+) (\d+)\/(\d+)/u.exec(line);
  const step = match === null ? null : PERSONA_STEPS[match[1]];
  return step ? step(Number(match[2]), Number(match[3])) : "准备中";
};

// One line of the chats a point rests on; click to see it in the chat.
const personaEvidenceLine = (item) => el("li", {},
  el("button", {
    class: "px-row persona-line", type: "button", title: "在聊天里看这一条",
    onclick: () => pxOpenChatAt(item),
  },
    item.said === undefined
      ? el("span", { class: "px-text" }, item.text)
      : el("span", { class: "px-text" }, el("span", { class: "kb-meta" }, `${item.partnerName}：${item.said}　→　`), item.reply),
    el("span", { class: "kb-meta" }, `${item.groupName} · ${briefMoment(item.sentAt)}`)));

const personaPoint = (card, key, item, render) => {
  const lines = item.ids.map((id) => card.evidence?.[id]).filter(Boolean);
  const open = personaUi.open.has(key);
  return el("li", { class: "persona-point" },
    el("div", {}, render(item),
      lines.length === 0 ? null : el("button", {
        class: "linklike persona-why", type: "button", "aria-expanded": String(open),
        onclick: () => {
          if (open) {
            personaUi.open.delete(key);
          } else {
            personaUi.open.add(key);
          }
          renderGroupView();
        },
      }, open ? "收起依据" : `依据 ${lines.length} 条`)),
    open ? el("ol", { class: "px-recent" }, lines.map(personaEvidenceLine)) : null);
};

const personaTest = (test) => {
  if (!test || test.asked === 0) {
    return el("p", { class: "kb-meta" }, test?.error ? `盲测没有跑成：${test.error}` : "盲测没有跑：TA 可用来出题的回复不够。");
  }
  const open = personaUi.open.has("test");
  return el("div", { class: "persona-test" },
    el("p", {},
      el("strong", {}, "盲测"), `　拿 ${test.asked} 句写卡时没给 AI 看过的真实回复，让 AI 只照这张卡回同一句话，再让另一次 AI 分辨哪句是真人发的：认出了 `,
      el("strong", {}, `${test.spotted} / ${test.asked}`), " 句。",
      el("span", { class: "kb-meta" }, "认出一半左右说明真假难分；全认出来说明这张卡还不像 TA。"),
      " ",
      el("button", {
        class: "linklike", type: "button", "aria-expanded": String(open),
        onclick: () => {
          if (open) {
            personaUi.open.delete("test");
          } else {
            personaUi.open.add("test");
          }
          renderGroupView();
        },
      }, open ? "收起题目" : "看每一题")),
    open ? el("ol", { class: "persona-questions" }, test.questions.map((question) => el("li", {},
      el("p", { class: "kb-meta" }, `${question.groupName} · ${question.partnerName}：${question.said}`),
      el("p", {}, el("span", { class: "tag plain" }, "真人"), " ", question.real),
      el("p", {}, el("span", { class: "tag plain" }, "照卡写的"), " ", question.written),
      el("p", { class: "kb-meta" }, question.judgedReal ? "被认出来了" : "没被认出来", question.why ? `：${question.why}` : "")))) : null);
};

const personaCardBody = (card, person) => {
  const real = card.card;
  return [
    el("p", { class: "persona-one" }, real.oneLine),
    el("p", { class: "persona-portrait" }, real.portrait),
    el("div", { class: "persona-voice" },
      el("span", { class: "gp-label" }, "说话方式"),
      el("p", {}, el("strong", {}, "语气　"), real.voice.tone),
      el("p", {}, el("strong", {}, "句子　"), real.voice.sentences),
      real.voice.catchphrases.length === 0 ? null : el("p", {}, el("strong", {}, "常用的词句　"),
        real.voice.catchphrases.map((phrase) => el("span", { class: "tag plain" }, phrase)))),
    PERSONA_KINDS.map(([kind, title, render]) => (real[kind].length === 0 ? null : el("div", { class: "persona-kind" },
      el("span", { class: "gp-label" }, title),
      el("ul", {}, real[kind].map((item, index) => personaPoint(card, `${kind}-${index}`, item, render)))))),
    real.examples.length === 0 ? null : el("div", { class: "persona-kind" },
      el("span", { class: "gp-label" }, "最像 TA 的真实对话"),
      el("ol", { class: "px-recent" }, real.examples.map((id) => card.evidence?.[id]).filter(Boolean).map(personaEvidenceLine))),
    personaTest(card.test),
    el("p", { class: "kb-meta" },
      `生成于 ${briefMoment(card.builtAt)} · ${card.model} · 读了 TA 最近 ${card.days} 天的 ${briefNumber(card.stats.exchanges)} 段对话和 ${briefNumber(card.stats.monologues)} 段长发言，来自 ${card.stats.groups} 个群`,
      card.stats.leftOut > 0 ? `（还有 ${briefNumber(card.stats.leftOut)} 段没读完）` : "",
      card.failedBatches > 0 ? `；有 ${card.failedBatches} 批 AI 没读成` : "", "。这是 AI 的归纳，不等于 TA 本人。"),
    el("div", { class: "gp-head-actions" },
      el("button", { class: "btn", type: "button", onclick: () => copyPersonaText(card) }, "复制成人设文字"),
      el("button", { class: "btn", type: "button", disabled: personaUi.busy, onclick: () => startPersona(person, true) }, "重新生成"),
      el("button", { class: "btn ghost", type: "button", onclick: () => deletePersonaCard(person) }, "删掉这张卡")),
  ];
};

const personaSection = (data) => {
  const { person } = data;
  if (personaUi.uin !== person.uin) {
    // First draw of this person's page: fetch, and draw again when it is in.
    loadPersona(person.uin);
  }
  const state = personaUi.uin === person.uin ? personaUi.data : null;
  const job = state?.job ?? null;
  const mine = job !== null && job.meta?.uin === person.uin;
  const body = () => {
    // A failed check while a card is already on screen leaves the card there.
    if (state === null) {
      return el("p", { class: "kb-meta" }, personaUi.uin === person.uin && personaUi.error ? `角色卡没读到：${personaUi.error}` : "读取中…");
    }
    if (personaIsRunningFor(person.uin)) {
      return el("p", { class: "bg-status busy" }, `正在生成：${personaProgress(job)}。可以先去别的页面，回来还在。`);
    }
    const failed = mine && job.status === "failed" ? el("div", { class: "notice risk" }, `上次没有生成成功：${job.error}`) : null;
    if (state.card !== null) {
      return [failed, personaCardBody(state.card, person)];
    }
    const other = job?.status === "running" ? `正在生成 ${job.meta?.name || "另一个人"} 的角色卡，等它完成才能生成这一张。` : null;
    return [
      failed,
      el("p", {}, "让 AI 读 TA 最近 180 天在所有群的发言，写出 TA 是怎样的人：看法和立场、对不同的人怎么说话、怎么开玩笑、说话习惯，每一条都附上依据的聊天原文，最后做一次盲测看这张卡像不像。"),
      el("p", { class: "kb-meta" }, "会把 TA 的聊天原文（最多约 600 段）发给你在设置里配置的 AI 服务，大约 9 次调用。卡只存在这台电脑上。"),
      !state.llmConfigured ? el("p", { class: "kb-meta" }, "还没有配置 AI 服务：先到「设置」登录 Grok 或保存 API key。") : null,
      other ? el("p", { class: "kb-meta" }, other) : null,
      el("button", {
        class: "btn primary", type: "button", disabled: personaUi.busy || !state.llmConfigured || other !== null,
        onclick: () => startPersona(person, false),
      }, "生成角色卡"),
    ];
  };
  return el("section", { class: "card gp-section persona-card" },
    el("h3", {}, "角色卡", el("span", { class: "kb-meta" }, "　AI 从 TA 自己的话里归纳 · 所有群")),
    body());
};

VIEW_LEAVE_HOOKS.push(() => clearTimeout(personaUi.timer));
