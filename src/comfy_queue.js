"use strict";

// 咒语库 → 「在本机 ComfyUI 排队」: a picture made with ComfyUI carries the
// graph that made it; this hands that graph to the ComfyUI running on this
// computer, which queues it as if the user had pressed Queue there.
//
// Only this computer's ComfyUI is ever talked to (a loopback address).

const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
const TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const comfyBase = (value) => {
  const text = String(value ?? "").trim() || DEFAULT_COMFY_URL;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`ComfyUI 地址不是网址：${text}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("只能连这台电脑上的 ComfyUI（http://127.0.0.1:端口）。");
  }
  return `${url.protocol}//${url.host}`;
};

// ComfyUI writes Python's NaN and Infinity into the picture ("is_changed": [NaN]),
// which is not JSON: outside of strings they are read as null.
const parseLoose = (text) => JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|\b(?:NaN|-?Infinity)\b/gu, (whole, quoted) => quoted ?? "null"));

// The graph ComfyUI runs (its "prompt" chunk: { nodeId: { class_type, inputs } }),
// or null when the picture only carries the editor's layout or nothing.
// is_changed is ComfyUI's own note about a past run, not part of the graph.
const graphOf = (chunks) => {
  let graph = chunks?.prompt;
  if (typeof graph === "string") {
    try {
      graph = parseLoose(graph);
    } catch {
      return null;
    }
  }
  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {
    return null;
  }
  const nodes = Object.entries(graph);
  if (nodes.length === 0 || !nodes.every(([, node]) => typeof node?.class_type === "string")) {
    return null;
  }
  return Object.fromEntries(nodes.map(([id, { is_changed: unused, ...node }]) => [id, node]));
};

// What ComfyUI said was wrong, in a line: missing models and nodes are the usual reasons.
const refusalText = (body) => {
  const main = body?.error?.message ?? (typeof body?.error === "string" ? body.error : "");
  const nodes = Object.values(body?.node_errors ?? {}).slice(0, 4).map((node) => {
    const details = (node?.errors ?? []).map((error) => [error?.message, error?.details].filter(Boolean).join("：")).filter(Boolean).slice(0, 2).join("；");
    return `${node?.class_type ?? "节点"}（${details || "有问题"}）`;
  });
  return [main, nodes.join("、")].filter(Boolean).join(" — ") || "没有说明原因";
};

// -> { promptId, number }. Throws with a sentence the page can show.
const queueOnComfy = async ({ chunks, baseUrl, fetchImpl = fetch }) => {
  const base = comfyBase(baseUrl);
  const graph = graphOf(chunks);
  if (graph === null) {
    throw new Error("这张图里没有 ComfyUI 能直接排队的那份工作流。可以用「下载工作流」，把文件拖进 ComfyUI。");
  }
  let response = null;
  try {
    response = await fetchImpl(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "chatlens" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError"
      ? `ComfyUI（${base}）${TIMEOUT_MS / 1000} 秒没有回应。`
      : `没连上这台电脑的 ComfyUI（${base}）：先把它打开，再按一次。`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`ComfyUI 没有接受这个工作流：${refusalText(body)}`);
  }
  return { promptId: String(body?.prompt_id ?? ""), number: Number.isFinite(body?.number) ? body.number : null, base };
};

module.exports = { queueOnComfy, graphOf, comfyBase, DEFAULT_COMFY_URL };
