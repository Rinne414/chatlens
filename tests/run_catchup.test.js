"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { summarizeCatchup } = require("../src/run_catchup");

test("builds a same-page card from a digest plus per-group LLM summaries", () => {
  const card = summarizeCatchup({
    runId: "qq-time-last-24h-abc",
    textMessages: 120,
    mediaMessages: 9,
    firstHkt: "2026-08-20 10:06:58",
    lastHkt: "2026-08-21 10:05:20",
    digest: { overview: "甲群：模型讨论；乙群：LoRA" },
    groups: [
      {
        groupId: "1",
        name: "测试群甲",
        llmSummary: {
          summary: "在讨论 Grok 和 K2。",
          topics: [{ title: "模型对比", importance: "high" }, { title: "闲聊", importance: "low" }],
          actions: [
            { status: "open", owner: "Alice", task: "发一套 LoRA" },
            { status: "resolved", owner: "Bob", task: "已经传了" },
          ],
          risks: [{ severity: "high", risk: "有人提到自伤" }],
        },
      },
    ],
  });

  assert.equal(card.runId, "qq-time-last-24h-abc");
  assert.equal(card.headline, "甲群：模型讨论；乙群：LoRA");
  assert.equal(card.firstHkt, "2026-08-20 10:06:58");
  assert.equal(card.lastHkt, "2026-08-21 10:05:20");
  assert.equal(card.llmMode, "used");
  assert.equal(card.groups[0].summary, "在讨论 Grok 和 K2。");
  assert.equal(card.groups[0].source, "llm");
  assert.deepEqual(card.groups[0].topics, ["模型对比"]);
  assert.equal(card.groups[0].openActions.length, 1);
  assert.equal(card.groups[0].openActions[0].task, "发一套 LoRA");
  assert.equal(card.groups[0].moreOpenActions, 0);
  assert.equal(card.openActionCount, 1);
  assert.equal(card.riskCount, 1);
  assert.equal(card.scan, undefined);
});

test("falls back to the first group's LLM summary when there is no digest", () => {
  const card = summarizeCatchup({
    runId: "qq-one",
    textMessages: 10,
    mediaMessages: 0,
    digest: null,
    groups: [{
      groupId: "2",
      name: "单群",
      llmSummary: { summary: "只有这一句。", topics: [], actions: [], risks: [] },
    }],
  });

  assert.match(card.headline, /只有这一句/u);
});

test("returns null when there is nothing to show and no scan coverage to judge", () => {
  assert.equal(summarizeCatchup(null), null);
  assert.equal(summarizeCatchup({ runId: "x", groups: [] }), null);
});

test("states a definite empty window when the scan is complete", () => {
  const card = summarizeCatchup({
    runId: "qq-empty-complete",
    textMessages: 0,
    mediaMessages: 0,
    groups: [],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });
  assert.equal(card.scan.status, "complete");
  assert.equal(card.scan.coverageRatio, 1);
  assert.equal(card.scan.missingSeconds, 0);
  assert.equal(card.headline, "这次范围内没有消息。");
  assert.equal(card.groups.length, 0);
  assert.doesNotMatch(card.headline, /可能/u);

  const filtered = summarizeCatchup({
    runId: "qq-empty-complete-filtered",
    textMessages: 0,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "空群",
      textMessages: 0,
      mediaMessages: 0,
      llmSummary: null,
      localTopics: [],
    }],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });
  assert.equal(filtered.headline, "这次范围内没有消息。");
  assert.equal(filtered.groups.length, 0);
  assert.equal(filtered.emptyGroupCount, 1);
});

test("does not treat an empty-window LLM filler as something to catch up on", () => {
  const card = summarizeCatchup({
    runId: "qq-empty-llm-filler",
    textMessages: 0,
    mediaMessages: 0,
    digest: {
      overview: "空群: 群内暂无消息，无法生成摘要。；测试群丙: 本时段没有可归纳的文本消息。",
      groups: [
        {
          groupId: "1",
          name: "空群",
          textMessages: 0,
          mediaMessages: 0,
          summary: "群内暂无消息，无法生成摘要。",
        },
        {
          groupId: "2",
          name: "测试群丙",
          textMessages: 0,
          mediaMessages: 0,
          summary: "本时段没有可归纳的文本消息。",
        },
      ],
    },
    groups: [
      {
        groupId: "1",
        name: "空群",
        textMessages: 0,
        mediaMessages: 0,
        llmSummary: {
          summary: "群内暂无消息，无法生成摘要。",
          topics: [{ title: "无", importance: "high" }],
          actions: [{ status: "open", owner: "", task: "幻觉待办" }],
          risks: [{ severity: "low", risk: "幻觉风险" }],
        },
      },
      {
        groupId: "2",
        name: "测试群丙",
        textMessages: 0,
        mediaMessages: 0,
        llmSummary: { summary: "本时段没有可归纳的文本消息。" },
      },
    ],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });

  assert.equal(card.headline, "这次范围内没有消息。");
  assert.equal(card.groups.length, 0);
  assert.equal(card.emptyGroupCount, 2);
  assert.equal(card.openActionCount, 0);
  assert.equal(card.riskCount, 0);
  assert.doesNotMatch(card.headline, /暂无消息|无法生成摘要|没有可归纳/u);
});

test("keeps busy groups and reports empty ones instead of stuffing filler into the headline", () => {
  const card = summarizeCatchup({
    runId: "qq-mixed-empty",
    textMessages: 40,
    mediaMessages: 3,
    digest: {
      overview: "乙群女仆咖啡厅: 在讨论 LoRA。；空群: 群内暂无消息，无法生成摘要。",
      groups: [
        {
          groupId: "1",
          name: "乙群女仆咖啡厅",
          textMessages: 40,
          mediaMessages: 3,
          summary: "在讨论 LoRA。",
        },
        {
          groupId: "2",
          name: "空群",
          textMessages: 0,
          mediaMessages: 0,
          summary: "群内暂无消息，无法生成摘要。",
        },
      ],
    },
    groups: [
      {
        groupId: "1",
        name: "乙群女仆咖啡厅",
        textMessages: 40,
        mediaMessages: 3,
        llmSummary: { summary: "在讨论 LoRA。", topics: [], actions: [], risks: [] },
      },
      {
        groupId: "2",
        name: "空群",
        textMessages: 0,
        mediaMessages: 0,
        llmSummary: { summary: "群内暂无消息，无法生成摘要。" },
      },
    ],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });

  assert.equal(card.headline, "乙群女仆咖啡厅: 在讨论 LoRA。");
  assert.equal(card.groups.length, 1);
  assert.equal(card.groups[0].name, "乙群女仆咖啡厅");
  assert.equal(card.emptyGroupCount, 1);
  assert.doesNotMatch(card.headline, /暂无消息|无法生成摘要/u);
});

test("strips empty-group names out of a digest overview string when digest.groups is absent", () => {
  const card = summarizeCatchup({
    runId: "qq-overview-only",
    textMessages: 10,
    mediaMessages: 0,
    digest: { overview: "单群: 只有这一句。；空群: 群内暂无消息，无法生成摘要。" },
    groups: [
      {
        groupId: "1",
        name: "单群",
        textMessages: 10,
        llmSummary: { summary: "只有这一句。", topics: [], actions: [], risks: [] },
      },
      {
        groupId: "2",
        name: "空群",
        textMessages: 0,
        mediaMessages: 0,
        llmSummary: { summary: "群内暂无消息，无法生成摘要。" },
      },
    ],
    scanCoverage: { status: "partial", coverageRatio: 0.5, missingSeconds: 120 },
  });

  assert.equal(card.headline, "单群: 只有这一句。");
  assert.equal(card.emptyGroupCount, 1);
  assert.doesNotMatch(card.headline, /空群/u);
});

test("keeps a card when the scan missed the window even if no messages landed", () => {
  const partial = summarizeCatchup({
    runId: "qq-empty-partial",
    textMessages: 0,
    mediaMessages: 0,
    groups: [],
    scanCoverage: { status: "partial", coverageRatio: 0.4, missingSeconds: 3600 },
  });
  assert.equal(partial.scan.status, "partial");
  assert.equal(partial.scan.coverageRatio, 0.4);
  assert.equal(partial.scan.missingSeconds, 3600);
  assert.match(partial.headline, /扫描并不完整/u);
  assert.doesNotMatch(partial.headline, /这次范围内没有消息/u);
  assert.equal(partial.groups.length, 0);

  const unknown = summarizeCatchup({
    runId: "qq-empty-unknown",
    groups: [],
    scanCoverage: { status: "unknown" },
  });
  assert.equal(unknown.scan.status, "unknown");
  assert.match(unknown.headline, /无法判断/u);
  assert.doesNotMatch(unknown.headline, /这次范围内没有消息/u);

  const none = summarizeCatchup({
    runId: "qq-empty-none",
    groups: [],
    scanCoverage: { status: "none" },
  });
  assert.equal(none.scan.status, "none");
  assert.match(none.headline, /没有有效扫描/u);
});

test("does not claim the window is empty when messages exist but no group card survived", () => {
  const card = summarizeCatchup({
    runId: "qq-counts-no-groups",
    textMessages: 4,
    mediaMessages: 0,
    groups: [],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });
  assert.equal(card.headline, "这段没有归纳出主题。");
  assert.doesNotMatch(card.headline, /没有消息/u);
});

test("passes through complete scan coverage without inventing a gap", () => {
  const card = summarizeCatchup({
    runId: "qq-scanned",
    textMessages: 4,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 4,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });
  assert.equal(card.scan.status, "complete");
  assert.equal(card.scan.coverageRatio, 1);
  assert.equal(card.scan.missingSeconds, 0);
  assert.equal(card.ai, undefined);
});

test("passes through partial AI coverage so the card can warn the model missed messages", () => {
  const card = summarizeCatchup({
    runId: "qq-ai-partial",
    textMessages: 80,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 80,
      llmSummary: { summary: "在讨论采样器。", topics: [{ title: "Euler a", importance: "high" }] },
    }],
    aiCoverage: { status: "partial", coverageRatio: 0.75, includedMessages: 60, totalMessages: 80 },
  });
  assert.equal(card.ai.status, "partial");
  assert.equal(card.ai.coverageRatio, 0.75);
  assert.equal(card.ai.includedMessages, 60);
  assert.equal(card.ai.totalMessages, 80);
  assert.equal(card.llmMode, "used");
});

test("does not invent AI coverage when the field is absent, and sanitizes junk", () => {
  const missing = summarizeCatchup({
    runId: "qq-no-ai",
    textMessages: 4,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 4,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
  });
  assert.equal(missing.ai, undefined);

  const junk = summarizeCatchup({
    runId: "qq-ai-junk",
    textMessages: 4,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 4,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    aiCoverage: ["nope"],
  });
  assert.equal(junk.ai.status, "indeterminate");
  assert.equal(junk.ai.includedMessages, null);
  assert.equal(junk.ai.totalMessages, null);
});

test("passes through complete AI coverage without inventing a gap", () => {
  const card = summarizeCatchup({
    runId: "qq-ai-complete",
    textMessages: 12,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 12,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    aiCoverage: { status: "complete", coverageRatio: 1, includedMessages: 12, totalMessages: 12 },
  });
  assert.equal(card.ai.status, "complete");
  assert.equal(card.ai.includedMessages, 12);
  assert.equal(card.ai.totalMessages, 12);
});

test("uses local topics when LLM was off, without inventing a prose summary", () => {
  const card = summarizeCatchup({
    runId: "qq-local",
    textMessages: 40,
    mediaMessages: 3,
    digest: null,
    groups: [{
      groupId: "9",
      name: "测试群甲",
      textMessages: 40,
      mediaMessages: 3,
      llmSummary: null,
      llmUnused: true,
      localTopics: [
        { id: "topic-1", name: "LoRA 训练", count: 12 },
        { id: "media", name: "媒体消息", count: 3 },
        { id: "topic-2", name: "模型对比", count: 8 },
        { id: "misc", name: "未归类 / 零散消息", count: 2 },
      ],
    }],
  });

  assert.equal(card.groups[0].fromLocal, true);
  assert.equal(card.groups[0].source, "local");
  assert.equal(card.groups[0].llmUnused, true);
  assert.equal(card.llmMode, "unused");
  assert.equal(card.groups[0].summary, "");
  assert.deepEqual(card.groups[0].topics, ["LoRA 训练", "模型对比"]);
  assert.match(card.headline, /LoRA 训练/u);
  assert.doesNotMatch(card.headline, /媒体消息/u);
  assert.doesNotMatch(card.headline, /未归类/u);
});

test("labels a local-only run with no sidecar as unknown instead of unused", () => {
  const card = summarizeCatchup({
    runId: "qq-legacy",
    textMessages: 12,
    mediaMessages: 0,
    digest: null,
    groups: [{
      groupId: "1",
      name: "旧报告",
      textMessages: 12,
      llmSummary: null,
      localTopics: [{ id: "topic-1", name: "闲聊", count: 9 }],
    }],
  });

  assert.equal(card.llmMode, "unknown");
  assert.equal(card.groups[0].source, "local");
  assert.equal(card.groups[0].llmUnused, false);
  assert.equal(card.groups[0].llmFailed, false);
});

test("prefers LLM topics over local clustering", () => {
  const card = summarizeCatchup({
    runId: "qq-both",
    textMessages: 10,
    mediaMessages: 0,
    digest: null,
    groups: [{
      groupId: "2",
      name: "单群",
      llmSummary: {
        summary: "在讨论采样器。",
        topics: [{ title: "Euler a", importance: "high" }],
        actions: [],
        risks: [],
      },
      localTopics: [{ id: "topic-1", name: "杂谈", count: 9 }],
    }],
  });

  assert.equal(card.groups[0].fromLocal, false);
  assert.equal(card.groups[0].source, "llm");
  assert.deepEqual(card.groups[0].topics, ["Euler a"]);
  assert.match(card.headline, /在讨论采样器/u);
});

test("still shows a card when a run has messages but no topics", () => {
  const card = summarizeCatchup({
    runId: "qq-counts",
    textMessages: 7,
    mediaMessages: 2,
    digest: null,
    groups: [{
      groupId: "3",
      name: "空主题",
      textMessages: 7,
      mediaMessages: 2,
      llmSummary: null,
      localTopics: [],
    }],
  });

  assert.equal(card.groups.length, 1);
  assert.equal(card.groups[0].source, "empty");
  assert.equal(card.llmMode, "unknown");
  assert.equal(card.headline, "这段没有归纳出主题。");
  assert.equal(card.textMessages, 7);
  assert.equal(card.mediaMessages, 2);
});

test("counts every open action and risk, then slices only the list shown on the card", () => {
  const actions = Array.from({ length: 14 }, (_, index) => ({
    status: "open",
    owner: `u${index}`,
    task: `task-${index}`,
  })).concat([{ status: "resolved", owner: "done", task: "already" }]);
  const risks = Array.from({ length: 8 }, (_, index) => ({
    severity: index === 0 ? "high" : "medium",
    risk: `risk-${index}`,
  }));

  const card = summarizeCatchup({
    runId: "qq-busy",
    textMessages: 3807,
    mediaMessages: 771,
    groups: [{
      groupId: "4",
      name: "乙群女仆咖啡厅",
      llmSummary: {
        summary: "在讨论模型。",
        topics: [{ title: "LoRA", importance: "high" }],
        actions,
        risks,
      },
    }],
  });

  assert.equal(card.openActionCount, 14);
  assert.equal(card.riskCount, 8);
  assert.equal(card.groups[0].openActions.length, 5);
  assert.equal(card.groups[0].moreOpenActions, 9);
  assert.equal(card.groups[0].risks.length, 3);
  assert.equal(card.groups[0].moreRisks, 5);
  assert.equal(card.groups[0].openActions[0].task, "task-0");
});

test("keeps totals for hidden groups when more than six groups have content", () => {
  const groups = Array.from({ length: 7 }, (_, index) => ({
    groupId: String(index + 1),
    name: `群${index + 1}`,
    textMessages: 2,
    llmSummary: {
      summary: `摘要${index + 1}`,
      topics: [],
      actions: [{ status: "open", owner: "", task: `todo-${index + 1}` }],
      risks: [],
    },
  }));

  const card = summarizeCatchup({
    runId: "qq-many",
    textMessages: 14,
    mediaMessages: 0,
    groups,
  });

  assert.equal(card.groups.length, 6);
  assert.equal(card.hiddenGroupCount, 1);
  assert.equal(card.openActionCount, 7);
});

test("marks a single-group LLM failure as failed, not unused", () => {
  const card = summarizeCatchup({
    runId: "qq-failed",
    textMessages: 12,
    mediaMessages: 0,
    digest: null,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 12,
      llmSummary: null,
      llmError: { failed: true, message: "timeout" },
      localTopics: [{ id: "topic-1", name: "闲聊", count: 9 }],
    }],
  });

  assert.equal(card.llmMode, "failed");
  assert.equal(card.groups[0].source, "failed");
  assert.equal(card.groups[0].llmFailed, true);
  assert.equal(card.groups[0].fromLocal, true);
  assert.deepEqual(card.groups[0].topics, ["闲聊"]);
});

test("marks an all-failed digest as failed rather than unused", () => {
  const card = summarizeCatchup({
    runId: "qq-all-fail",
    textMessages: 8,
    mediaMessages: 0,
    groups: [
      {
        groupId: "1",
        name: "A",
        textMessages: 4,
        llmError: { failed: true },
        localTopics: [{ id: "topic-1", name: "主题A", count: 2 }],
      },
      {
        groupId: "2",
        name: "B",
        textMessages: 4,
        llmFailed: true,
        localTopics: [{ id: "topic-1", name: "主题B", count: 2 }],
      },
    ],
  });

  assert.equal(card.llmMode, "failed");
  assert.equal(card.groups[0].source, "failed");
  assert.equal(card.groups[1].source, "failed");
});

test("marks mixed digest runs as partial when one group has LLM and another failed", () => {
  const card = summarizeCatchup({
    runId: "qq-mixed-fail",
    textMessages: 20,
    mediaMessages: 0,
    groups: [
      {
        groupId: "1",
        name: "LLM群",
        llmSummary: { summary: "模型讨论。", topics: [{ title: "Grok", importance: "high" }] },
      },
      {
        groupId: "2",
        name: "失败群",
        llmSummary: null,
        llmError: { failed: true, message: "timeout" },
        localTopics: [{ id: "topic-1", name: "闲聊", count: 4 }],
        textMessages: 4,
      },
    ],
  });

  assert.equal(card.llmMode, "partial");
  assert.equal(card.groups[0].source, "llm");
  assert.equal(card.groups[0].llmFailed, false);
  assert.equal(card.groups[1].source, "failed");
});

test("marks mixed digest runs as partial when some groups fell back to local topics", () => {
  const card = summarizeCatchup({
    runId: "qq-mixed",
    textMessages: 20,
    mediaMessages: 0,
    groups: [
      {
        groupId: "1",
        name: "LLM群",
        llmSummary: { summary: "模型讨论。", topics: [{ title: "Grok", importance: "high" }] },
      },
      {
        groupId: "2",
        name: "本地群",
        llmSummary: null,
        localTopics: [{ id: "topic-1", name: "闲聊", count: 4 }],
        textMessages: 4,
      },
    ],
  });

  assert.equal(card.llmMode, "partial");
  assert.equal(card.groups[0].source, "llm");
  assert.equal(card.groups[1].source, "local");
  assert.equal(card.groups[1].fromLocal, true);
});

test("drops N/A timestamps instead of showing them as a window", () => {
  const card = summarizeCatchup({
    runId: "qq-na",
    textMessages: 1,
    mediaMessages: 0,
    firstHkt: "N/A",
    lastHkt: "N/A",
    groups: [{
      groupId: "1",
      name: "空",
      textMessages: 1,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
  });

  assert.equal(card.firstHkt, "");
  assert.equal(card.lastHkt, "");
});

test("passes requested scan unix through without filling it from message times", () => {
  const withWindow = summarizeCatchup({
    runId: "qq-scan-window",
    textMessages: 4,
    mediaMessages: 0,
    firstHkt: "2026-08-20 10:06:58",
    lastHkt: "2026-08-21 10:05:20",
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 4,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    scanCoverage: {
      status: "complete",
      coverageRatio: 1,
      missingSeconds: 0,
      requestedStartUnix: 1755648000,
      requestedEndUnix: 1755734400,
    },
  });
  assert.equal(withWindow.scan.requestedStartUnix, 1755648000);
  assert.equal(withWindow.scan.requestedEndUnix, 1755734400);
  assert.equal(withWindow.firstHkt, "2026-08-20 10:06:58");
  assert.equal(withWindow.lastHkt, "2026-08-21 10:05:20");

  const empty = summarizeCatchup({
    runId: "qq-empty-window",
    textMessages: 0,
    mediaMessages: 0,
    firstHkt: null,
    lastHkt: null,
    groups: [],
    scanCoverage: {
      status: "complete",
      coverageRatio: 1,
      missingSeconds: 0,
      requestedStartUnix: 1755648000,
      requestedEndUnix: 1755734400,
    },
  });
  assert.equal(empty.firstHkt, "");
  assert.equal(empty.lastHkt, "");
  assert.equal(empty.scan.requestedStartUnix, 1755648000);
  assert.equal(empty.scan.requestedEndUnix, 1755734400);
  assert.equal(empty.headline, "这次范围内没有消息。");

  const noScanTimes = summarizeCatchup({
    runId: "qq-no-scan-times",
    textMessages: 4,
    mediaMessages: 0,
    firstHkt: "2026-08-20 10:06:58",
    lastHkt: "2026-08-21 10:05:20",
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 4,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    scanCoverage: { status: "complete", coverageRatio: 1, missingSeconds: 0 },
  });
  assert.equal(noScanTimes.scan.requestedStartUnix, null);
  assert.equal(noScanTimes.scan.requestedEndUnix, null);
  assert.equal(noScanTimes.firstHkt, "2026-08-20 10:06:58");

  const junk = summarizeCatchup({
    runId: "qq-scan-junk",
    textMessages: 1,
    mediaMessages: 0,
    groups: [{
      groupId: "1",
      name: "单群",
      textMessages: 1,
      llmSummary: { summary: "有一句。", topics: [], actions: [], risks: [] },
    }],
    scanCoverage: { status: "complete", requestedStartUnix: "nope", requestedEndUnix: "nope" },
  });
  assert.equal(junk.scan.requestedStartUnix, null);
  assert.equal(junk.scan.requestedEndUnix, null);
});

test("getRunDetail hands the message window, scan coverage, and AI coverage to catchup", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/server/toolkit_state.js"), "utf8");
  assert.match(source, /firstHkt: combined\.firstMessageHkt/u);
  assert.match(source, /lastHkt: combined\.lastMessageHkt/u);
  assert.match(source, /scanCoverage: runMeta\.scanCoverage/u);
  assert.match(source, /aiCoverage: runMeta\.aiCoverage/u);
  assert.match(source, /readLlmError/u);
  assert.match(source, /readLlmUnused/u);
  assert.match(source, /llmError: analysis\.llmSummary \? null : normalizeLlmError\(analysis\.llmError\)/u);
  assert.match(source, /llmUnused: Boolean\(analysis\.llmSummary \|\| analysis\.llmError\) \? false : analysis\.llmUnused === true/u);
});
