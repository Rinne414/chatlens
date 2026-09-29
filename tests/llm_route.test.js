"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const route = require("../src/llm_route");
const { GrokAuthError, authFromTokenResponse } = require("../src/grok_auth");
const { assembleStream, callLlm, createClient, currentModel, shouldFallBack } = require("../src/llm_summarizer");

const NOW = 1_800_000_000;
const KEY_ENV = "CHATLENS_TEST_LLM_KEY";

// Every test gets an empty secret dir (so no Grok sign-in exists) and its
// own provider-state file.
const isolate = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-route-"));
  const previousDir = process.env.CHATLENS_SECRET_DIR;
  process.env.CHATLENS_SECRET_DIR = path.join(dir, "secrets");
  process.env[KEY_ENV] = "sk-test-key";
  t.after(() => {
    if (previousDir === undefined) {
      delete process.env.CHATLENS_SECRET_DIR;
    } else {
      process.env.CHATLENS_SECRET_DIR = previousDir;
    }
    delete process.env[KEY_ENV];
  });
  return path.join(dir, "llm-provider-state.json");
};

const apiConfig = (extra = {}) => ({
  llm: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKeyEnv: KEY_ENV, ...extra },
});

test("the API-key provider is used as-is when Grok is not selected", async (t) => {
  const statePath = isolate(t);
  const result = await route.resolveLlmRoute(apiConfig({ detail: "detailed" }), { statePath, now: NOW });
  assert.equal(result.primary.provider, "api");
  assert.equal(result.primary.model, "deepseek-v4-flash");
  assert.equal(result.primary.apiKey, "sk-test-key");
  assert.equal(result.primary.detail, "detailed");
  assert.equal(result.fallback, null);
});

test("Grok selected but not signed in: the API key takes over at the standard level", async (t) => {
  const statePath = isolate(t);
  const config = apiConfig({ provider: route.GROK_PROVIDER, detail: "detailed" });
  assert.equal(route.isLlmConfigured(config), true);
  const result = await route.resolveLlmRoute(config, { statePath, now: NOW });
  assert.equal(result.primary.provider, "api");
  assert.equal(result.primary.detail, "standard");
  assert.equal(result.fallback, null);
  assert.match(result.grokSkipped, /还没有登录 Grok/u);
});

test("Grok selected with no sign-in and no API key is not configured", async (t) => {
  const statePath = isolate(t);
  const config = { llm: { provider: route.GROK_PROVIDER } };
  assert.equal(route.isLlmConfigured(config), false);
  await assert.rejects(route.resolveLlmRoute(config, { statePath, now: NOW }), /没有配置备用的 API key/u);
});

test("a remembered Grok failure is skipped until it expires, by cause", (t) => {
  const statePath = isolate(t);
  const quota = route.markGrokUnavailable(Object.assign(new Error("pool"), { status: 429 }), { statePath, now: NOW });
  assert.equal(quota.kind, "quota");
  assert.equal(quota.grokSkippedUntil, NOW + route.SKIP_SECONDS.quota);
  assert.notEqual(route.grokSkip({ statePath, now: NOW + route.SKIP_SECONDS.quota - 1 }), null);
  assert.equal(route.grokSkip({ statePath, now: NOW + route.SKIP_SECONDS.quota }), null);

  assert.equal(route.markGrokUnavailable(Object.assign(new Error("gate"), { status: 403 }), { statePath, now: NOW }).kind, "auth");
  assert.equal(route.markGrokUnavailable(new GrokAuthError("dead", "refresh-rejected", 400), { statePath, now: NOW }).kind, "auth");
  assert.equal(route.markGrokUnavailable(Object.assign(new Error("down"), { status: 503 }), { statePath, now: NOW }).kind, "other");

  route.clearGrokUnavailable({ statePath });
  assert.equal(route.grokSkip({ statePath, now: NOW }), null);
});

test("token responses keep the old refresh token when xAI does not rotate it", () => {
  const auth = authFromTokenResponse({ access_token: "a2", expires_in: 21600 }, "r1", NOW);
  assert.deepEqual(auth, { v: 1, accessToken: "a2", refreshToken: "r1", expiresAt: NOW + 21600, savedAt: NOW });
  assert.equal(authFromTokenResponse({ access_token: "a3", refresh_token: "r2" }, "r1", NOW).refreshToken, "r2");
  assert.throws(() => authFromTokenResponse({}, "r1", NOW), /access token/u);
});

test("only an unavailable provider falls back, never a bad request or an unusable answer", () => {
  for (const status of [401, 402, 403, 429, 500, 503]) {
    assert.equal(shouldFallBack(Object.assign(new Error("x"), { status })), true, `status ${status}`);
  }
  for (const status of [400, 404, 413, 422]) {
    assert.equal(shouldFallBack(Object.assign(new Error("x"), { status })), false, `status ${status}`);
  }
  assert.equal(shouldFallBack(new Error("connect ECONNREFUSED")), true);
  assert.equal(shouldFallBack(new Error("LLM response was truncated. Body=...")), false);
});

// One mock server plays both providers: /grok answers with `grokStatus`,
// /api always answers. Each request's detail level is echoed back.
const startProviders = (grokStatus) =>
  new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const provider = request.url.startsWith("/grok") ? "grok" : "api";
        seen.push({ provider, model: body.model, user: body.messages[1].content, maxTokens: body.max_tokens });
        if (provider === "grok" && grokStatus !== 200) {
          response.writeHead(grokStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "nope" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answeredBy: provider }) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });

const buildFor = (detail) => ({ system: "s", user: `detail=${detail}`, maxTokens: detail === "detailed" ? 9000 : 1000 });

test("a refused primary hands this and every later call to the fallback, rebuilt at its level", async (t) => {
  const mock = await startProviders(429);
  t.after(() => mock.server.close());
  const failures = [];
  const client = createClient(
    { baseUrl: `${mock.base}/grok`, apiKey: "t", model: "grok-4.7", provider: route.GROK_PROVIDER, detail: "detailed" },
    { fallback: { baseUrl: `${mock.base}/api`, apiKey: "k", model: "deepseek-v4-flash", detail: "standard" }, onFallback: (error) => failures.push(error.status) },
  );
  assert.deepEqual(await callLlm(client, buildFor), { answeredBy: "api" });
  assert.deepEqual(await callLlm(client, buildFor), { answeredBy: "api" });
  assert.deepEqual(failures, [429]);
  assert.equal(currentModel(client), "deepseek-v4-flash");
  // Grok was tried once (429 is retried 3 times inside that one call), then never again.
  assert.equal(mock.seen.filter((call) => call.provider === "grok").length, 3);
  const apiCalls = mock.seen.filter((call) => call.provider === "api");
  assert.deepEqual(apiCalls.map((call) => [call.user, call.maxTokens]), [["detail=standard", 1000], ["detail=standard", 1000]]);
});

test("a refused request or an unusable answer is asked elsewhere once, without leaving the primary", async (t) => {
  const mock = await startProviders(400);
  t.after(() => mock.server.close());
  const failures = [];
  const client = createClient(
    { baseUrl: `${mock.base}/grok`, apiKey: "t", model: "grok-4.7", provider: route.GROK_PROVIDER },
    { fallback: { baseUrl: `${mock.base}/api`, apiKey: "k", model: "deepseek-v4-flash" }, onFallback: (error) => failures.push(error) },
  );
  assert.deepEqual(await callLlm(client, buildFor), { answeredBy: "api" });
  assert.deepEqual(await callLlm(client, buildFor), { answeredBy: "api" });
  // Grok is asked first every time (a 400 is not retried on it), and never remembered as down.
  assert.deepEqual(mock.seen.map((call) => call.provider), ["grok", "api", "grok", "api"]);
  assert.equal(client.state.usingFallback, false);
  assert.equal(client.state.answeredByFallback, 2);
  assert.deepEqual(failures, []);
  assert.equal(currentModel(client), "grok-4.7");
});

test("an answer the caller rejects (an empty summary) goes to the fallback for that call", async (t) => {
  const mock = await startProviders(200);
  t.after(() => mock.server.close());
  const client = createClient(
    { baseUrl: `${mock.base}/grok`, apiKey: "t", model: "grok-4.7", provider: route.GROK_PROVIDER },
    { fallback: { baseUrl: `${mock.base}/api`, apiKey: "k", model: "deepseek-v4-flash" } },
  );
  const validate = (raw) => {
    if (raw.answeredBy === "grok") {
      throw new Error("Invalid LLM JSON. Required string is missing: summary");
    }
  };
  assert.deepEqual(await callLlm(client, buildFor, { purpose: "map", validate }), { answeredBy: "api" });
  assert.equal(client.state.usingFallback, false);
});

test("a streamed answer is reassembled; a stream cut off mid-answer is an error", () => {
  const event = (payload) => `data: ${JSON.stringify(payload)}`;
  const stream = [
    event({ choices: [{ delta: { role: "assistant" } }] }),
    event({ choices: [{ delta: { content: '{"summary":' } }] }),
    "",
    event({ choices: [{ delta: { content: '"好"}' }, finish_reason: "stop" }] }),
    event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    "data: [DONE]",
  ].join("\n");
  assert.deepEqual(assembleStream(stream), {
    choices: [{ finish_reason: "stop", message: { content: '{"summary":"好"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  const cut = stream.split("\n").slice(0, 2).join("\n");
  assert.throws(() => assembleStream(cut), /stream ended before the answer finished/u);
  assert.equal(shouldFallBack(new Error("LLM stream ended before the answer finished")), false);
});
