"use strict";

/* ---------- 设置 → AI 详细度: the detailed job's progress and cost ----------
   After 「用详细模式重做」 the background works through redo and backfill
   chunks; this shows, per day and per group, how far it is and what it has
   used (tokens incl. reasoning, the subscription's list price, any API money),
   plus an estimate for the rest. */

const aiRedoState = { openDays: new Set() };

const aiUsd = (amount) => `US$${(Number(amount) || 0) < 1 ? (Number(amount) || 0).toFixed(3) : (Number(amount) || 0).toFixed(2)}`;

const aiUsageTokens = (usage) => (usage === null ? 0 : usage.promptTokens + usage.completionTokens + usage.reasoningTokens);

// One row's numbers: chunks done/queued, messages, tokens, list price, money.
const aiRedoCells = (label, rows) => {
  const queued = rows.reduce((total, row) => total + row.queuedChunks, 0);
  const detailed = rows.reduce((total, row) => total + row.detailedChunks, 0);
  const messages = rows.reduce((total, row) => total + row.messages, 0);
  const tokens = rows.reduce((total, row) => total + aiUsageTokens(row.usage), 0);
  const listUsd = rows.reduce((total, row) => total + (row.usage?.subscriptionListUsd ?? 0), 0);
  const money = rows.reduce((totals, row) => {
    for (const [currency, amount] of Object.entries(row.usage?.cost ?? {})) {
      totals[currency] = (totals[currency] ?? 0) + amount;
    }
    return totals;
  }, {});
  return [
    el("td", {}, label),
    el("td", {}, `${detailed} / ${queued}`),
    el("td", {}, briefNumber(messages)),
    el("td", {}, tokens > 0 ? aiTokens(tokens) : "—"),
    el("td", {}, listUsd > 0 ? aiUsd(listUsd) : "—"),
    el("td", {}, aiMoney(money)),
  ];
};

const aiRedoTable = (rows) => {
  const byDay = new Map();
  for (const row of rows) {
    byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  }
  const body = [];
  for (const [day, dayRows] of byDay) {
    const open = aiRedoState.openDays.has(day);
    body.push(el("tr", {
      class: "ai-redo-day",
      onclick: () => {
        const next = new Set(aiRedoState.openDays);
        if (open) {
          next.delete(day);
        } else {
          next.add(day);
        }
        aiRedoState.openDays = next;
        renderSettingsView();
      },
    }, aiRedoCells(`${open ? "▾" : "▸"} ${day.slice(5)}（${dayRows.length} 个群）`, dayRows)));
    if (open) {
      body.push(...dayRows.map((row) => el("tr", { class: "ai-redo-group" }, aiRedoCells(row.groupName, [row]))));
    }
  }
  return el("table", { class: "ai-table ai-redo-table" },
    el("thead", {}, el("tr", {}, ["日期 / 群", "详细段 / 待做", "消息", "token（含推理）", "订阅原价", "API 费用"].map((head) => el("th", {}, head)))),
    el("tbody", {}, body));
};

const aiRedoReport = (report) => {
  if (!report?.job) {
    return null;
  }
  const { job, spent, remaining, perMessage } = report;
  const spentTokens = spent.promptTokens + spent.completionTokens + spent.reasoningTokens;
  return el("div", { class: "ai-redo" },
    el("p", { class: "card-sub", style: "margin:10px 0 4px" },
      `${job.fromDay} – ${job.toDay}：重做 ${job.redoChunks} 段已有摘要，补齐 ${job.backfillChunks} 段没摘要过的消息（${briefNumber(job.backfillMessages)} 条）。`,
      `后台每次刷新处理一批（新消息优先），Grok 不能用时自动暂停，不会改用付费 API。`),
    el("div", { class: "ai-tiles" },
      el("div", { class: "ai-tile" },
        el("span", { class: "ai-tile-label" }, "已用"),
        el("strong", { class: "ai-tile-value" }, aiTokens(spentTokens)),
        el("span", { class: "ai-tile-meta" }, `${spent.calls} 次 · 输入 ${aiTokens(spent.promptTokens)} · 输出 ${aiTokens(spent.completionTokens)} · 推理 ${aiTokens(spent.reasoningTokens)}`),
        el("span", { class: "ai-tile-meta" }, `订阅原价约 ${aiUsd(spent.subscriptionListUsd)}${Object.keys(spent.cost).length > 0 ? ` · API ${aiMoney(spent.cost)}` : ""}`)),
      el("div", { class: "ai-tile emphasis" },
        el("span", { class: "ai-tile-label" }, "预计还需"),
        el("strong", { class: "ai-tile-value" }, remaining.chunks === 0 ? "已完成" : aiTokens(remaining.tokens)),
        el("span", { class: "ai-tile-meta" }, remaining.chunks === 0
          ? "所有段都已是详细模式（Grok 拒绝总结的保留原摘要）"
          : `${remaining.chunks} 段 · ${briefNumber(remaining.messages)} 条消息 · 订阅原价约 ${aiUsd(remaining.listUsd)}`),
        el("span", { class: "ai-tile-meta" }, perMessage.measured ? "按这次已完成部分的实测平均估算" : "按试跑实测（每条约 122 token）估算，跑一阵后会更准"))),
    aiRedoTable(report.rows));
};
