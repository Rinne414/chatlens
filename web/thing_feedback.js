"use strict";

/* ---------- 简报: 「不重要」 / 「讲错了」 on a thing (src/summary_feedback.js) ----------
   Either takes the thing out of the briefing at once. 不重要 also tells the
   AI, the next time it puts a briefing together, what this reader does not
   want listed. Everything said is listed under 值得知道的事, where it can be
   put back or copied out as text. */

const THING_VERDICTS = { unimportant: "不重要", wrong: "讲错了" };

const thingFeedback = { items: null, open: false };

const loadThingFeedback = async () => {
  try {
    thingFeedback.items = (await api("/api/feedback")).items;
  } catch {
    // The line under the things simply stays away.
    thingFeedback.items = null;
  }
};

const refreshAfterThingFeedback = async () => {
  await Promise.all([loadThingFeedback(), loadBriefThings()]);
  renderBriefView();
};

const sendThingFeedback = async (thing, verdict) => {
  try {
    await api("/api/feedback", { method: "POST", body: JSON.stringify({
      verdict, title: thing.title, takeaway: thing.takeaway, kind: thing.kind, groups: thing.groups.map((group) => group.name),
    }) });
  } catch (error) {
    notifyError(error);
    return;
  }
  dismissBriefThing();
  notify(verdict === "unimportant" ? "已从简报拿掉。以后同一类的事会少列。" : "已从简报拿掉，并记了下来。");
  await refreshAfterThingFeedback();
};

const undoThingFeedback = async (item) => {
  try {
    await api("/api/feedback/delete", { method: "POST", body: JSON.stringify({ id: item.id }) });
  } catch (error) {
    notifyError(error);
    return;
  }
  await refreshAfterThingFeedback();
};

// For sending to whoever maintains the program: what the summaries got wrong or over-rated.
const thingFeedbackText = (items) => items.map((item) => [
  `【${THING_VERDICTS[item.verdict] ?? item.verdict}】${item.title}`,
  item.takeaway ? `  总结：${item.takeaway}` : null,
  `  ${unixToHkt(item.createdAt).slice(0, 16)}${item.groups ? ` · ${item.groups}` : ""}`,
].filter(Boolean).join("\n")).join("\n\n");

const copyThingFeedback = async (items) => {
  try {
    await navigator.clipboard.writeText(thingFeedbackText(items));
    notify("已复制。里面有事情的标题和总结，发给别人之前看一眼。");
  } catch {
    notify("复制失败：浏览器没有给剪贴板权限。", { isError: true });
  }
};

// Under the things: how many were taken out, and the list to put one back.
const thingFeedbackLine = () => {
  if (thingFeedback.items === null) {
    // First draw: fetch, and draw again when it is in.
    thingFeedback.items = [];
    loadThingFeedback().then(() => {
      if (thingFeedback.items !== null && thingFeedback.items.length > 0) {
        renderBriefWhenIdle();
      }
    });
  }
  const items = thingFeedback.items ?? [];
  if (items.length === 0) {
    return null;
  }
  return el("div", { class: "thing-feedback" },
    el("button", {
      class: "linklike", type: "button", "aria-expanded": String(thingFeedback.open),
      onclick: () => {
        thingFeedback.open = !thingFeedback.open;
        renderBriefView();
      },
    }, thingFeedback.open ? "收起" : `你拿掉过 ${items.length} 件事（不重要 / 讲错了）`),
    thingFeedback.open ? [
      " · ",
      el("button", { class: "linklike", type: "button", title: "标题和总结的文字，可以发给维护这个程序的人", onclick: () => copyThingFeedback(items) }, "复制成文字"),
      el("ul", { class: "thing-feedback-list" }, items.map((item) => el("li", {},
        el("span", { class: "tag plain" }, THING_VERDICTS[item.verdict] ?? item.verdict),
        el("span", {}, item.title),
        el("span", { class: "kb-meta" }, briefMoment(item.createdAt)),
        el("button", { class: "linklike", type: "button", onclick: () => undoThingFeedback(item) }, "放回来")))),
    ] : null);
};
