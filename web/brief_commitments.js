"use strict";

/* ---------- 简报: 答应过的事 ----------
   Things I said I would do, things someone asked me to do, and things someone
   said they would do for me (src/commitments.js finds them during the
   background refresh). Each stays here until it is ticked off or taken off
   the list, whatever the briefing's own time window is. */

const COMMITMENT_PREVIEW = 6;
const COMMITMENT_KIND_LABELS = { promise: "我答应的", asked: "找我的", owed: "答应我的" };
const COMMITMENT_SIDES = [
  ["mine", "我要做的", (item) => item.kind !== "owed"],
  ["theirs", "别人答应我的", (item) => item.kind === "owed"],
];

const briefCommitments = {
  data: null,
  loading: false,
  // Sides shown in full, and whether the finished ones are open.
  expanded: new Set(),
  showDone: false,
  // The one just taken off the list, so it can be put back at once.
  justDropped: null,
  // Counts every answer wanted from the server: an older one arriving late is ignored.
  request: 0,
};

const commitmentsShown = () => JSON.stringify([
  (briefCommitments.data?.open ?? []).map((item) => `${item.groupId}|${item.rowId}`),
  (briefCommitments.data?.done ?? []).map((item) => `${item.groupId}|${item.rowId}`),
]);

const loadBriefCommitments = async () => {
  if (briefCommitments.loading) {
    return;
  }
  briefCommitments.loading = true;
  briefCommitments.request += 1;
  const request = briefCommitments.request;
  const before = commitmentsShown();
  try {
    const data = await api("/api/commitments");
    // A tick made while this was on its way already brought a newer list.
    if (request === briefCommitments.request) {
      briefCommitments.data = data;
    }
  } catch {
    // The rest of the briefing does not wait on this list; it is asked for again next time.
  }
  briefCommitments.loading = false;
  if (app.view === "brief" && commitmentsShown() !== before) {
    renderBriefWhenIdle();
  }
};

const setCommitmentStatus = async (item, status) => {
  briefCommitments.request += 1;
  const request = briefCommitments.request;
  try {
    const data = await api("/api/commitments/status", {
      method: "POST",
      body: JSON.stringify({ groupId: item.groupId, rowId: item.rowId, status }),
    });
    if (request === briefCommitments.request) {
      briefCommitments.data = data;
    }
    briefCommitments.justDropped = status === "dropped" ? item : null;
  } catch (error) {
    notifyError(error);
  }
  renderBriefView();
};

const commitmentRow = (item, { done = false } = {}) => el("li", { class: done ? "brief-commitment done" : `brief-commitment ${item.kind}` },
  el("button", {
    class: "brief-commitment-tick",
    type: "button",
    title: done ? "还没做完，放回去" : "做完了",
    "aria-label": done ? `放回去：${item.what}` : `做完了：${item.what}`,
    "aria-pressed": String(done),
    onclick: () => setCommitmentStatus(item, done ? "open" : "done"),
  }, done ? "✓" : ""),
  el("button", {
    class: "brief-row-button brief-commitment-body",
    type: "button",
    title: "在消息里看这句话",
    onclick: () => briefOpenChatAt(item.groupId, item.groupName, item.sentAt, item.rowId),
  },
  el("div", { class: "brief-mention-head" },
    el("strong", { class: "brief-commitment-what" }, item.what),
    el("span", { class: "brief-kind" }, COMMITMENT_KIND_LABELS[item.kind] ?? ""),
    el("span", { class: "brief-meta" }, [item.who, item.groupName, briefWhen(item.sentAt)].filter((part) => part).join(" · "))),
  el("p", { class: "brief-quote" }, item.quote)),
  done
    ? null
    : el("button", {
      class: "linklike brief-commitment-drop",
      type: "button",
      title: "这不是要做的事，从这里拿掉",
      onclick: () => setCommitmentStatus(item, "dropped"),
    }, "不算"));

const commitmentSide = ([key, title, belongs], open) => {
  const items = open.filter(belongs);
  if (items.length === 0) {
    return null;
  }
  const all = briefCommitments.expanded.has(key);
  const shown = all ? items : items.slice(0, COMMITMENT_PREVIEW);
  return el("div", { class: "brief-commitment-side" },
    el("h4", { class: "brief-commitment-title" }, title, el("span", { class: "brief-count" }, items.length)),
    el("ul", { class: "brief-mention-list" }, shown.map((item) => commitmentRow(item))),
    items.length > shown.length
      ? el("button", {
        class: "btn small ghost",
        type: "button",
        onclick: () => {
          briefCommitments.expanded = new Set([...briefCommitments.expanded, key]);
          renderBriefView();
        },
      }, `再看 ${items.length - shown.length} 条`)
      : null);
};

const commitmentDropped = () => {
  const item = briefCommitments.justDropped;
  if (item === null) {
    return null;
  }
  return el("p", { class: "brief-commitment-undo", role: "status" },
    `已拿掉「${item.what}」`,
    el("button", { class: "linklike", type: "button", onclick: () => setCommitmentStatus(item, "open") }, "放回来"));
};

const commitmentDone = (done) => {
  if (done.length === 0) {
    return null;
  }
  return el("div", { class: "brief-commitment-done" },
    el("button", {
      class: "linklike",
      type: "button",
      "aria-expanded": String(briefCommitments.showDone),
      onclick: () => {
        briefCommitments.showDone = !briefCommitments.showDone;
        renderBriefView();
      },
    }, briefCommitments.showDone ? "收起做完的" : `做完的 ${done.length} 件`),
    briefCommitments.showDone
      ? el("ul", { class: "brief-mention-list" }, done.map((item) => commitmentRow(item, { done: true })))
      : null);
};

// Nothing is drawn until something was found: a briefing with no promises in
// it looks the way it always did.
const briefCommitmentsSection = () => {
  const data = briefCommitments.data;
  if (data === null || (data.open.length === 0 && data.done.length === 0 && briefCommitments.justDropped === null)) {
    return null;
  }
  return el("section", { class: "brief-section brief-commitments" },
    el("h3", { class: "brief-section-title" }, "答应过的事",
      data.open.length > 0 ? el("span", { class: "brief-count" }, data.open.length) : null),
    data.open.length === 0 ? el("p", { class: "brief-empty-line" }, "现在没有还没做的。") : null,
    COMMITMENT_SIDES.map((side) => commitmentSide(side, data.open)),
    commitmentDropped(),
    commitmentDone(data.done));
};
