"use strict";

// Turns getRunDetail into the few lines a person actually wants on the run
// page after a summary, so they do not have to open the HTML report first.

const OPEN_ACTION_SHOW = 5;
const RISK_SHOW = 3;
const TOPIC_SHOW = 4;
const GROUP_SHOW = 6;

const allOpenActionsOf = (llm) =>
  (Array.isArray(llm?.actions) ? llm.actions : [])
    .filter((action) => action && action.status === "open" && String(action.task ?? "").trim() !== "")
    .map((action) => ({
      owner: String(action.owner ?? "").trim(),
      task: String(action.task).trim(),
    }));

const allRisksOf = (llm) =>
  (Array.isArray(llm?.risks) ? llm.risks : [])
    .filter((risk) => risk && String(risk.risk ?? "").trim() !== "")
    .map((risk) => ({
      severity: String(risk.severity ?? "").trim(),
      risk: String(risk.risk).trim(),
    }));

const topicsOf = (llm) =>
  (Array.isArray(llm?.topics) ? llm.topics : [])
    .filter((topic) => topic && (topic.importance === "high" || topic.importance === "medium"))
    .slice(0, TOPIC_SHOW)
    .map((topic) => String(topic.title ?? topic.name ?? "").trim())
    .filter(Boolean);

const localTopicsOf = (group) =>
  (Array.isArray(group.localTopics) ? group.localTopics : [])
    .filter((topic) => topic && topic.id !== "media" && topic.id !== "misc" && Number(topic.count) > 0)
    .sort((left, right) => Number(right.count ?? 0) - Number(left.count ?? 0))
    .slice(0, TOPIC_SHOW)
    .map((topic) => String(topic.name ?? "").trim())
    .filter(Boolean);

const cleanStamp = (value) => {
  const text = String(value ?? "").trim();
  return text === "" || text === "N/A" ? "" : text;
};

const groupHeadline = (group) => {
  if (group.summary !== "") {
    return `${group.name}：${group.summary}`;
  }
  if (group.topics.length > 0) {
    return `${group.name}：${group.topics.join(" · ")}`;
  }
  return "";
};

const groupCountsKnown = (group) =>
  Object.prototype.hasOwnProperty.call(group, "textMessages")
  || Object.prototype.hasOwnProperty.call(group, "mediaMessages");

const groupHasMessages = (group) => {
  if (!groupCountsKnown(group)) {
    return true;
  }
  return Number(group.textMessages ?? 0) + Number(group.mediaMessages ?? 0) > 0;
};

const digestOverviewOf = (digest, emptyNames) => {
  if (digest === null || digest === undefined || typeof digest !== "object" || Array.isArray(digest)) {
    return "";
  }
  const digestGroups = Array.isArray(digest.groups) ? digest.groups : [];
  if (digestGroups.length > 0) {
    return digestGroups
      .filter(groupHasMessages)
      .map((group) => {
        const name = String(group.name ?? group.groupId ?? "").trim();
        const summary = String(group.summary ?? "").trim();
        if (summary === "") {
          return "";
        }
        return name === "" ? summary : `${name}: ${summary}`;
      })
      .filter(Boolean)
      .join("；");
  }
  const overview = String(digest.overview ?? "").trim();
  if (overview === "" || emptyNames.length === 0) {
    return overview;
  }
  const prefixes = emptyNames.flatMap((name) => [`${name}:`, `${name}：`]);
  return overview
    .split("；")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !prefixes.some((prefix) => part.startsWith(prefix)))
    .join("；");
};

const llmWasUsed = (group) => group.llmSummary !== null && group.llmSummary !== undefined;

const llmDidFail = (group) =>
  !llmWasUsed(group)
  && ((group.llmError !== null && group.llmError !== undefined) || group.llmFailed === true);

const llmWasSkipped = (group) =>
  !llmWasUsed(group)
  && !llmDidFail(group)
  && (group.llmUnused === true
    || (group.llmUnused !== null && typeof group.llmUnused === "object"));

const SCAN_STATUSES = new Set(["complete", "partial", "none", "unknown"]);
const AI_STATUSES = new Set([
  "complete",
  "partial",
  "empty",
  "unknown",
  "not-used",
  "failed",
  "indeterminate",
]);

const scanOf = (scanCoverage) => {
  if (scanCoverage === null || typeof scanCoverage !== "object" || Array.isArray(scanCoverage)) {
    return {
      status: "unknown",
      coverageRatio: null,
      missingSeconds: null,
      requestedStartUnix: null,
      requestedEndUnix: null,
    };
  }
  const status = SCAN_STATUSES.has(scanCoverage.status) ? scanCoverage.status : "unknown";
  return {
    status,
    coverageRatio: Number.isFinite(scanCoverage.coverageRatio) ? scanCoverage.coverageRatio : null,
    missingSeconds: Number.isFinite(scanCoverage.missingSeconds) ? scanCoverage.missingSeconds : null,
    requestedStartUnix: Number.isFinite(scanCoverage.requestedStartUnix) ? scanCoverage.requestedStartUnix : null,
    requestedEndUnix: Number.isFinite(scanCoverage.requestedEndUnix) ? scanCoverage.requestedEndUnix : null,
  };
};

const aiOf = (aiCoverage) => {
  if (aiCoverage === null || typeof aiCoverage !== "object" || Array.isArray(aiCoverage)) {
    return { status: "indeterminate", coverageRatio: null, includedMessages: null, totalMessages: null };
  }
  const status = AI_STATUSES.has(aiCoverage.status) ? aiCoverage.status : "indeterminate";
  return {
    status,
    coverageRatio: Number.isFinite(aiCoverage.coverageRatio) ? aiCoverage.coverageRatio : null,
    includedMessages: Number.isFinite(aiCoverage.includedMessages) ? aiCoverage.includedMessages : null,
    totalMessages: Number.isFinite(aiCoverage.totalMessages) ? aiCoverage.totalMessages : null,
  };
};

const emptyScanHeadline = (status) => {
  if (status === "complete") {
    return "这次范围内没有消息。";
  }
  if (status === "none") {
    return "这次没有有效扫描。";
  }
  if (status === "partial") {
    return "扫描到的时段里没有消息，但扫描并不完整。";
  }
  return "无法判断这次范围内有没有漏掉的消息。";
};

const summarizeCatchup = (detail) => {
  if (detail === null || detail === undefined) {
    return null;
  }
  const mapped = (detail.groups ?? []).map((group) => {
    const countsKnown = groupCountsKnown(group);
    const hasMessages = groupHasMessages(group);
    const llm = hasMessages ? (group.llmSummary ?? {}) : {};
    const summary = hasMessages ? String(llm.summary ?? "").trim() : "";
    const llmTopics = hasMessages ? topicsOf(llm) : [];
    const localTopics = hasMessages ? localTopicsOf(group) : [];
    const usedLlm = hasMessages && llmWasUsed(group);
    const failedLlm = hasMessages && llmDidFail(group);
    const unusedLlm = hasMessages && llmWasSkipped(group);
    const allOpenActions = hasMessages ? allOpenActionsOf(llm) : [];
    const allRisks = hasMessages ? allRisksOf(llm) : [];
    const topics = llmTopics.length > 0 ? llmTopics : localTopics;
    return {
      groupId: String(group.groupId ?? ""),
      name: String(group.name ?? group.groupId ?? ""),
      summary,
      topics,
      openActions: allOpenActions.slice(0, OPEN_ACTION_SHOW),
      moreOpenActions: Math.max(0, allOpenActions.length - OPEN_ACTION_SHOW),
      risks: allRisks.slice(0, RISK_SHOW),
      moreRisks: Math.max(0, allRisks.length - RISK_SHOW),
      fromLocal: !usedLlm && localTopics.length > 0,
      llmFailed: failedLlm,
      llmUnused: unusedLlm,
      source: usedLlm ? "llm" : failedLlm ? "failed" : localTopics.length > 0 ? "local" : "empty",
      textMessages: Number(group.textMessages ?? 0),
      mediaMessages: Number(group.mediaMessages ?? 0),
      openActionCount: allOpenActions.length,
      riskCount: allRisks.length,
      empty: countsKnown && !hasMessages,
    };
  });
  const emptyGroupCount = mapped.filter((group) => group.empty).length;
  const emptyNames = mapped.filter((group) => group.empty).map((group) => group.name).filter(Boolean);
  const groups = mapped.filter((group) =>
    !group.empty
    && (group.summary !== ""
      || group.openActionCount > 0
      || group.topics.length > 0
      || group.textMessages > 0
      || group.mediaMessages > 0));

  const digestOverview = digestOverviewOf(detail.digest, emptyNames);
  const fromGroups = groups.map(groupHeadline).filter(Boolean).join("；");
  const textMessages = Number(detail.textMessages ?? 0);
  const mediaMessages = Number(detail.mediaMessages ?? 0);
  const scan = Object.prototype.hasOwnProperty.call(detail, "scanCoverage")
    ? scanOf(detail.scanCoverage)
    : null;
  const ai = Object.prototype.hasOwnProperty.call(detail, "aiCoverage")
    ? aiOf(detail.aiCoverage)
    : null;
  let headline = digestOverview !== ""
    ? digestOverview
    : fromGroups !== ""
      ? fromGroups
      : groups.length > 0
        ? textMessages + mediaMessages > 0
          ? "这段没有归纳出主题。"
          : emptyScanHeadline(scan?.status)
        : "";

  if (headline === "") {
    if (textMessages + mediaMessages > 0) {
      headline = "这段没有归纳出主题。";
    } else if (scan === null) {
      return null;
    } else {
      headline = emptyScanHeadline(scan.status);
    }
  }

  const llmGroupCount = groups.filter((group) => group.source === "llm").length;
  const failedGroupCount = groups.filter((group) => group.source === "failed").length;
  const localGroupCount = groups.filter((group) => group.source === "local").length;
  const unknownGroupCount = groups.filter((group) =>
    group.source !== "llm" && group.llmFailed !== true && group.llmUnused !== true).length;

  return {
    runId: String(detail.runId ?? ""),
    headline,
    firstHkt: cleanStamp(detail.firstHkt),
    lastHkt: cleanStamp(detail.lastHkt),
    textMessages,
    mediaMessages,
    groups: groups.slice(0, GROUP_SHOW).map((group) => {
      const next = { ...group };
      delete next.empty;
      return next;
    }),
    hiddenGroupCount: Math.max(0, groups.length - GROUP_SHOW),
    emptyGroupCount,
    openActionCount: groups.reduce((total, group) => total + group.openActionCount, 0),
    riskCount: groups.reduce((total, group) => total + group.riskCount, 0),
    llmMode: llmGroupCount === 0
      ? (failedGroupCount > 0 ? "failed" : unknownGroupCount > 0 ? "unknown" : "unused")
      : (localGroupCount > 0 || failedGroupCount > 0 ? "partial" : "used"),
    ...(scan !== null ? { scan } : {}),
    ...(ai !== null ? { ai } : {}),
  };
};

module.exports = { summarizeCatchup };
