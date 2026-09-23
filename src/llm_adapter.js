const fs = require("node:fs");
const path = require("node:path");
const { clearLlmError, clearLlmUnused, writeLlmError, writeLlmUnused } = require("./llm_status");
const { createClient, summarizeMessages } = require("./llm_summarizer");
const { readSecretSync } = require("./secrets");

// CLI used by the manual summary pipeline: summarizes one analysis dir and
// writes llm-summary.json (+ merges it into analysis.json).

const parseArgs = (argv) => {
  if (argv.length !== 10) {
    throw new Error(
      "Usage: node llm_adapter.js <analysisJson> <messagesJson> <outputJson> <baseUrl> <model> <apiKeyEnv> <maxMessages> <maxChars>",
    );
  }
  const maxMessages = Number.parseInt(argv[8], 10);
  const maxChars = Number.parseInt(argv[9], 10);
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
    throw new Error(`Invalid maxMessages. It must be a positive integer. maxMessages=${argv[8]}`);
  }
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`Invalid maxChars. It must be a positive integer. maxChars=${argv[9]}`);
  }
  return {
    analysisJson: argv[2],
    messagesJson: argv[3],
    outputJson: argv[4],
    baseUrl: argv[5],
    model: argv[6],
    apiKeyEnv: argv[7],
    maxMessages,
    maxChars,
  };
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const resolveApiKey = (apiKeyEnv) => {
  const fromEnv = String(process.env[apiKeyEnv] ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : readSecretSync("llmKey").trim();
};

const main = async () => {
  const args = parseArgs(process.argv);
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
    const client = createClient({ baseUrl: args.baseUrl, apiKey: resolveApiKey(args.apiKeyEnv), model: args.model });
    const provider = { baseUrl: args.baseUrl, model: args.model, apiKeyEnv: args.apiKeyEnv };
    const { summary, coverage } = await summarizeMessages(client, analysis, messages, args, provider);

    const llmSummary = { ...summary, coverage };
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
