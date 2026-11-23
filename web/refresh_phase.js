"use strict";

// What a running refresh is doing and for how long, and 「停下这一轮」.
// Shown on 简报, in 设置 and as the rail's tooltip.

// The refresh's step names (src/pipeline/refresh_run.js) in the reader's words.
const REFRESH_PHASES = {
  mirror: "同步聊天数据库",
  export: "读取新消息",
  lateExport: "读取新消息",
  recoveryExport: "读取新消息",
  lateIngest: "存入新消息",
  recoveryIngest: "存入新消息",
  textRepair: "读取新消息",
  replyExport: "读取新消息",
  pictureBackfill: "读取新消息",
  groupList: "读取新消息",
  unreadHint: "读取新消息",
  ingest: "存入新消息",
  replyBackfill: "存入新消息",
  filePreviews: "整理图片",
  knowledge: "整理图片",
  briefing: "准备总结",
  summaries: "AI 总结新消息",
  merge: "AI 合并各群的总结",
  digests: "AI 写各群总览",
  commitments: "AI 找答应过的事",
  notes: "更新笔记库",
  fingerprints: "算图片指纹",
};

const REFRESH_MINUTE_MS = 60 * 1000;
// Ending the refresh's processes takes a moment: how long to wait for it.
const REFRESH_STOP_WAIT_MS = 8000;
const REFRESH_STOP_STEP_MS = 400;

const waitForRefreshToEnd = async () => {
  for (let waited = 0; waited < REFRESH_STOP_WAIT_MS; waited += REFRESH_STOP_STEP_MS) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_STOP_STEP_MS));
    const background = await api("/api/background");
    if (background.running !== true) {
      return;
    }
  }
};

// "正在整理新消息：AI 总结新消息，已 12 分钟"; without a known step, "正在整理新消息…".
const refreshRunningText = (background, lead) => {
  const phase = REFRESH_PHASES[background?.phase] ?? null;
  const minutes = Math.floor((Date.now() - Date.parse(background?.lastStartedAt ?? "")) / REFRESH_MINUTE_MS);
  const elapsed = Number.isFinite(minutes) && minutes >= 1 ? `已 ${minutes} 分钟` : "";
  if (phase === null) {
    return elapsed ? `${lead}，${elapsed}` : `${lead}…`;
  }
  return `${lead}：${phase}${elapsed ? `，${elapsed}` : ""}`;
};

// done: called after the server answered, to reload whatever shows the state.
const refreshStopButton = (done) => el("button", {
  class: "linklike refresh-stop",
  type: "button",
  title: "只停下正在跑的这一轮：已经收进来的消息和写好的总结都留着，下一轮照常开始",
  onclick: async (event) => {
    event.target.disabled = true;
    try {
      await api("/api/background/stop-run", { method: "POST", body: "{}" });
      await waitForRefreshToEnd();
    } catch (error) {
      notifyError(error);
    }
    await done();
  },
}, "停下这一轮");
