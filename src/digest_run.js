"use strict";

// On request from the page: write (or rewrite) one 每日总览 / 周报 / 月报.
//   node src/digest_run.js <day|week|month> <period> <outputJson>
// A report first writes any of its day overviews that are missing. The user
// asked for it, so the background budget does not apply (pause does), and an
// existing digest is rewritten even if its input did not change.

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("./message_store");
const { ensureBriefingSchema } = require("./briefing_store");
const engine = require("./briefing_engine");
const { ensureDigestSchema } = require("./digest_store");
const { isValidPeriod } = require("./digest_periods");
const digestEngine = require("./digest_engine");
const { createClient, setUsageRecorder } = require("./llm_summarizer");
const { ensureUsageSchema, recordUsage } = require("./llm_usage");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");

const STORE_PATH = path.join(__dirname, "..", "store", "messages.db");

const parseArgs = (argv) => {
  const [kind, period, outputJson] = argv.slice(2);
  if (argv.length !== 5 || !isValidPeriod(kind, period)) {
    throw new Error("Usage: node digest_run.js <day|week|month> <period> <outputJson>");
  }
  return { kind, period, outputJson };
};

const main = async () => {
  const args = parseArgs(process.argv);
  const route = await resolveLlmRoute(loadConfig());
  const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
  const db = ensureDigestSchema(ensureUsageSchema(ensureBriefingSchema(messageStore.openStore(STORE_PATH))));
  setUsageRecorder((entry) => recordUsage(db, entry));
  try {
    const now = Math.floor(Date.now() / 1000);
    const gate = () => (engine.pauseStatus(db, now).paused ? "paused" : null);
    const result = await digestEngine.generate(db, client, { kind: args.kind, period: args.period, now, gate, force: true });
    if (result.status === "blocked") {
      throw new Error("AI 整理已暂停，恢复后再生成。");
    }
    if (result.status === "no-data") {
      throw new Error("这段时间还没有 AI 摘要可以汇总（先让后台总结，或在回顾页「补齐」那几天）。");
    }
    fs.writeFileSync(args.outputJson, `${JSON.stringify({ status: result.status, kind: args.kind, period: args.period })}\n`, "utf8");
    console.log(`digest ${args.kind} ${args.period} ${result.status}`);
  } finally {
    setUsageRecorder(null);
    db.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`digest_run failed: ${error.message}`);
    process.exit(1);
  });
}
