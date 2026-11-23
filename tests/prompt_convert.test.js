"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { queueOnComfy, graphOf, comfyBase } = require("../src/comfy_queue");

// web/prompt_convert.js is a page script: its functions are read out of it here.
const source = fs.readFileSync(path.join(__dirname, "..", "web", "prompt_convert.js"), "utf8");
const { promptToNai, promptToSd, promptStyleOf } = new Function(`${source}; return { promptToNai, promptToSd, promptStyleOf };`)();

test("WebUI emphasis becomes NovelAI's, and what NovelAI cannot use is left out", () => {
  assert.equal(promptToNai("1girl, (blue hair:1.2), (smile), [blurry]"), "1girl, 1.2::blue hair::, 1.1::smile::, 0.91::blurry::");
  assert.equal(promptToNai("((masterpiece)), best quality"), "1.21::masterpiece::, best quality");
  assert.equal(promptToNai("(artist:wlop:1.3), hatsune miku \\(vocaloid\\)"), "1.3::artist:wlop::, hatsune miku (vocaloid)");
  assert.equal(promptToNai("1girl, <lora:style_v2:0.8>, solo BREAK night"), "1girl, solo , night".replace(" ,", ","));
  assert.equal(promptToNai("((a, b:1.2))"), "1.32::a, b::");
  assert.equal(promptToNai("plain tags, no marks"), "plain tags, no marks");
});

test("NovelAI emphasis becomes WebUI's, and tag parentheses are escaped", () => {
  assert.equal(promptToSd("1girl, 1.2::blue hair, long hair::, {smile}, [blurry]"), "1girl, (blue hair, long hair:1.2), (smile:1.05), (blurry:0.95)");
  assert.equal(promptToSd("{{{masterpiece}}}, hatsune miku (vocaloid)"), "(masterpiece:1.16), hatsune miku \\(vocaloid\\)");
  assert.equal(promptToSd("0.28::artist:rolua::, -1::text::"), "(artist:rolua:0.28), (text:-1)");
  assert.equal(promptToSd("plain tags"), "plain tags");
});

test("there and back keeps the weights", () => {
  const nai = "1girl, 1.3::artist:wlop::, 0.8::simple background::";
  assert.equal(promptToNai(promptToSd(nai)), nai);
});

test("the way a prompt is written is told from its own marks, then from what made the picture", () => {
  assert.equal(promptStyleOf("1.2::a::, b"), "nai");
  assert.equal(promptStyleOf("{a}, b"), "nai");
  assert.equal(promptStyleOf("(a:1.2), b"), "sd");
  assert.equal(promptStyleOf("a, <lora:x:1>"), "sd");
  assert.equal(promptStyleOf("a, b", "nai"), "nai");
  assert.equal(promptStyleOf("a, b", "comfyui"), "sd");
  assert.equal(promptStyleOf("a, miku \\(vocaloid\\)", ""), null);
});

/* ---------- ComfyUI ---------- */

const GRAPH = { 3: { class_type: "KSampler", inputs: { seed: 1 } }, 4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } } };

const startComfy = (answer) => new Promise((resolve) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const { status, body } = answer();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
});

test("the picture's own graph is queued on this computer's ComfyUI", async () => {
  const comfy = await startComfy(() => ({ status: 200, body: { prompt_id: "abc", number: 7, node_errors: {} } }));
  try {
    const result = await queueOnComfy({ chunks: { prompt: JSON.stringify(GRAPH), workflow: "{}" }, baseUrl: comfy.url });
    assert.deepEqual([result.promptId, result.number], ["abc", 7]);
    assert.equal(comfy.seen[0].url, "/prompt");
    assert.deepEqual(comfy.seen[0].body.prompt, GRAPH);
  } finally {
    comfy.server.close();
  }
});

test("what ComfyUI refuses is passed on in its own words", async () => {
  const comfy = await startComfy(() => ({ status: 400, body: {
    error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
    node_errors: { 4: { class_type: "CheckpointLoaderSimple", errors: [{ message: "Value not in list", details: "ckpt_name: 'x.safetensors' not in []" }] } },
  } }));
  try {
    await assert.rejects(() => queueOnComfy({ chunks: { prompt: GRAPH }, baseUrl: comfy.url }),
      /没有接受这个工作流：Prompt outputs failed validation — CheckpointLoaderSimple（Value not in list：ckpt_name: 'x\.safetensors' not in \[\]）/u);
  } finally {
    comfy.server.close();
  }
});

test("no graph, ComfyUI not running, or an address that is not this computer: said plainly, nothing sent", async () => {
  assert.equal(graphOf({ workflow: "{\"nodes\":[]}" }), null);
  assert.equal(graphOf({ prompt: "not json" }), null);
  // ComfyUI's own NaN is read, its note about the past run is left out, a tag that says NaN stays a tag
  assert.deepEqual(graphOf({ prompt: '{"3": {"class_type": "KSampler", "inputs": {"text": "NaN, Infinity"}, "is_changed": [NaN]}}' }),
    { 3: { class_type: "KSampler", inputs: { text: "NaN, Infinity" } } });
  assert.equal(graphOf({ prompt: JSON.stringify({ 1: { inputs: {} } }) }), null);
  await assert.rejects(() => queueOnComfy({ chunks: { workflow: "{}" } }), /没有 ComfyUI 能直接排队/u);
  let called = 0;
  const refused = async () => {
    called += 1;
    throw new TypeError("fetch failed");
  };
  await assert.rejects(() => queueOnComfy({ chunks: { prompt: GRAPH }, fetchImpl: refused }), /没连上这台电脑的 ComfyUI（http:\/\/127\.0\.0\.1:8188）/u);
  assert.equal(called, 1);
  assert.throws(() => comfyBase("http://192.168.1.5:8188"), /只能连这台电脑/u);
  assert.throws(() => comfyBase("https://example.com"), /只能连这台电脑/u);
  assert.equal(comfyBase(""), "http://127.0.0.1:8188");
  assert.equal(comfyBase("http://localhost:8189/"), "http://localhost:8189");
});
