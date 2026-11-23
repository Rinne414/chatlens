"use strict";

// The 角色卡 job (started from a person's page, src/server/persona_ops.js):
//   node src/persona_run.js <input.json> <output.json>
// input { uin, days }. Prints "persona step=<name> <done>/<total>" lines the
// page shows as progress; writes { uin } when the card is saved.

const fs = require("node:fs");
const path = require("node:path");
const messageStore = require("./message_store");
const { ensureBriefingSchema } = require("./briefing_store");
const { ensureUsageSchema, recordUsage } = require("./llm_usage");
const { createClient, currentModel, setUsageRecorder } = require("./llm_summarizer");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");
const { gather, enough, MIN_OWN_MESSAGES } = require("./persona_material");
const { buildCard } = require("./persona_card");
const { ensurePersonaSchema, savePersona } = require("./persona_store");

const STORE_PATH = path.join(__dirname, "..", "store", "messages.db");

const run = async (db, client, { uin, days }, { now = Math.floor(Date.now() / 1000), log = console.log } = {}) => {
  log("persona step=material 0/1");
  const material = gather(db, { uin, now, ...(Number.isFinite(days) && days > 0 ? { days } : {}) });
  if (!enough(material)) {
    throw new Error(`TA 在这段时间只有 ${material.stats.ownMessages} 条文字发言，不到 ${MIN_OWN_MESSAGES} 条，写不出像样的角色卡。`);
  }
  const built = await buildCard(client, material, { progress: (step, done, total) => log(`persona step=${step} ${done}/${total}`) });
  const name = material.names[0] ?? String(uin);
  savePersona(db, {
    uin, builtAt: now, name, model: currentModel(client),
    result: { days: material.days, range: material.range, stats: material.stats, names: material.names, ...built },
  });
  return { uin: String(uin), name };
};

const main = async () => {
  const [inputJson, outputJson] = process.argv.slice(2);
  const input = JSON.parse(fs.readFileSync(inputJson, "utf8"));
  const route = await resolveLlmRoute(loadConfig());
  const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
  const db = ensurePersonaSchema(ensureUsageSchema(ensureBriefingSchema(messageStore.openStore(STORE_PATH))));
  setUsageRecorder((entry) => recordUsage(db, entry));
  try {
    const result = await run(db, client, input);
    fs.writeFileSync(outputJson, `${JSON.stringify(result)}\n`, "utf8");
    console.log(`persona done uin=${result.uin}`);
  } finally {
    setUsageRecorder(null);
    db.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`persona_run failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { run };
