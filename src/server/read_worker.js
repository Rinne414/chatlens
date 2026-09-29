"use strict";

// The console's heavy read-only queries run here, in one worker thread with
// connections (and caches) of its own, so the server's thread keeps
// answering every other page meanwhile. Measured 2026-09-30 on the server's
// thread: a cold 咒语库 facet count 16 s, 热点 over 30 days 6.5 s, the 群 page
// over 30 days 1.4 s — each froze the whole console for as long.

const { Worker, isMainThread, parentPort } = require("node:worker_threads");

// name -> [module, export]; only these can be asked for.
const HANDLERS = {
  overview: ["./knowledge_ops", "overview"],
  searchImages: ["./knowledge_ops", "searchImages"],
  facets: ["./knowledge_ops", "facets"],
  promptRequests: ["./knowledge_ops", "promptRequests"],
  coverage: ["./knowledge_ops", "coverage"],
  trends: ["./trends_ops", "getTrends"],
  groupInsights: ["./group_ops", "getGroupInsightsReadOnly"],
  gallery: ["./gallery_ops", "runHeavyGalleryQuery"],
};

if (!isMainThread && parentPort !== null) {
  parentPort.on("message", ({ id, method, args }) => {
    try {
      const [modulePath, name] = HANDLERS[method];
      parentPort.postMessage({ id, value: require(modulePath)[name](...args) });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

// { worker, pending: Map(id -> { resolve, reject }) }: each worker owns the
// answers it still owes, so a dying worker can only fail its own requests.
let current = null;
let nextId = 1;

// One worker, started on first use and again after it dies.
const ensureWorker = () => {
  if (current !== null) {
    return current;
  }
  const entry = { worker: new Worker(__filename), pending: new Map() };
  entry.worker.on("message", ({ id, value, error }) => {
    const request = entry.pending.get(id);
    if (request === undefined) {
      return;
    }
    entry.pending.delete(id);
    if (entry.pending.size === 0) {
      entry.worker.unref();
    }
    if (error === undefined) {
      request.resolve(value);
    } else {
      request.reject(new Error(error));
    }
  });
  const forget = (error) => {
    if (current === entry) {
      current = null;
    }
    for (const { reject } of entry.pending.values()) {
      reject(error);
    }
    entry.pending.clear();
  };
  entry.worker.on("error", forget);
  entry.worker.on("exit", (code) => forget(new Error(`查询线程意外退出（${code}），请重试。`)));
  current = entry;
  return entry;
};

// call("facets", toolRoot, options) -> Promise of what the handler returns.
// Arguments and answers must be plain data (they are copied between threads).
const call = (method, ...args) => {
  if (!Object.hasOwn(HANDLERS, method)) {
    return Promise.reject(new Error(`Unknown read query: ${method}`));
  }
  return new Promise((resolve, reject) => {
    const entry = ensureWorker();
    const id = nextId;
    nextId += 1;
    entry.pending.set(id, { resolve, reject });
    // Kept alive while it owes an answer, not while idle.
    entry.worker.ref();
    entry.worker.postMessage({ id, method, args });
  });
};

const stop = async () => {
  if (current !== null) {
    const { worker } = current;
    current = null;
    await worker.terminate();
  }
};

module.exports = { call, stop };
