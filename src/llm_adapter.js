const fs = require("node:fs");
const path = require("node:path");
const { clearLlmError, clearLlmUnused, writeLlmError, writeLlmUnused } = require("./llm_status");
const { createClient, currentModel, summarizeMessages, setUsageRecorder } = require("./llm_summarizer");
const { createStoreRecorder } = require("./llm_usage");
const { resolveLlmRoute, markGrokUnavailable } = require("./llm_route");
const { loadConfig } = require("./server/toolkit_state");

// CLI used by the manual summary pipeline: summarizes one analysis dir and
// writes llm-summary.json (+ merges it into analysis.json). Which LLM, and its
// credential, comes from the saved config (src/llm_route.js).

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node llm_adapter.js <analysisJson> <messagesJson> <outputJson>");
  }
  return { analysisJson: argv[2], messagesJson: argv[3], outputJson: argv[4] };
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const main = async () => {
  const args = parseArgs(process.argv);
  setUsageRecorder(createStoreRecorder(path.resolve(__dirname, "..")));
  const analysisDir = path.dirname(args.outputJson);
  try {
    const analysis = readJson(args.analysisJson);
    const messages = readJson(args.messagesJson);
    if (!Array.isArray(messages) || messages.length === 0) {
      // Nothing was said in this window: no LLM call, no failure either.
      writeLlmUnused(analysisDir);
      console.log("llm skipped: no text messages in this window");
      return;
    }
    const route = await resolveLlmRoute(loadConfig());
    const client = createClient(route.primary, { fallback: route.fallback, onFallback: (error) => markGrokUnavailable(error) });
    const { summary, coverage } = await summarizeMessages(client, analysis, messages, route.primary, {});
    // Labelled after the call: a fallback may have answered instead.
    const llmSummary = { ...summary, provider: { ...summary.provider, model: currentModel(client) }, coverage };
    fs.writeFileSync(args.outputJson, JSON.stringify(llmSummary, null, 2), "utf8");
    fs.writeFileSync(args.analysisJson, JSON.stringify({ ...analysis, llmSummary }, null, 2), "utf8");
    clearLlmError(analysisDir);
    clearLlmUnused(analysisDir);
    console.log(`llmSummaryPath=${args.outputJson} coverage=${coverage.includedTextMessages}/${coverage.totalTextMessages} chunks=${coverage.chunks} mode=${coverage.mode}`);
  } catch (error) {
    try {
      writeLlmError(analysisDir, error);
    } catch (writeError) {
      console.error(`llm-error.json could not be written: ${writeError.message}`);
    }
    throw error;
  }
};

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
