import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { autoDetectMeterless, describeMeterlessModel, METERLESS_APP_ID, normaliseMeterlessUrl, parseConnectLink, probeMeterless } from "../src/reasoning/meterless.js";
import { chatEndpoint, modelConfigProblem, NemotronProcessor } from "../src/reasoning/nemotron.js";
import { parseModelCompletion } from "#speck";

// A stand-in Meterless Runtime: it checks the bearer token on every call,
// lists routing modes on /v1/models, and answers chat with a plain string. It
// exercises the provider contract, not the runtime itself.
const TOKEN = "stand-in-token-not-a-secret";
interface Seen { path: string; headers: http.IncomingHttpHeaders; body?: any }

async function standIn(options: { models?: string[] } = {}): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers, ...(body ? { body: JSON.parse(body) } : {}) });
      const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/healthz") return send(200, { ok: true });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
      if (request.url === "/v1/models") return send(200, { data: (options.models ?? ["meterless/auto", "meterless/deep", "meterless/reasoning.fast", "meterless/new-mode"]).map((id) => ({ id })) });
      if (request.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body);
        return send(200, { model: "nemotron-routed-stand-in", choices: [{ message: { role: "assistant", content: `ready (${parsed.model})` } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
      }
      send(404, {});
    });
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test("a pasted Meterless address is normalised to <host>/v1, never /v1/v1", () => {
  for (const pasted of ["127.0.0.1:8088", "http://127.0.0.1:8088", "http://127.0.0.1:8088/", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/",
    "http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/healthz", " 127.0.0.1:8088/v1 "]) {
    assert.equal(normaliseMeterlessUrl(pasted), "http://127.0.0.1:8088/v1", pasted);
  }
  assert.equal(normaliseMeterlessUrl("https://runtime.example:9443/v1/chat/completions"), "https://runtime.example:9443/v1");
  assert.equal(normaliseMeterlessUrl("[::1]:8090"), "http://[::1]:8090/v1");
  assert.equal(normaliseMeterlessUrl(""), "http://127.0.0.1:8088/v1");
});

test("a connect link gives the base URL from its origin and the key from k", () => {
  assert.deepEqual(parseConnectLink("http://192.168.1.20:8088/connect#k=abc123"), { baseUrl: "http://192.168.1.20:8088/v1", token: "abc123" });
  assert.equal(parseConnectLink("http://127.0.0.1:8088/v1"), null);
  assert.equal(parseConnectLink("http://127.0.0.1:8088/connect"), null);
});

test("routing ids are described, and ones this version does not know are kept", () => {
  assert.equal(describeMeterlessModel("meterless/auto"), "auto routing");
  assert.equal(describeMeterlessModel("meterless/reasoning"), "reasoning class");
  assert.equal(describeMeterlessModel("meterless/reasoning.fast"), "reasoning class, fast routing");
  assert.equal(describeMeterlessModel("meterless/a.b.c"), "routing mode");
});

test("/v1/models decides: a wrong token is unauthorized, not offline; another server is offline", async () => {
  const runtime = await standIn();
  const ollamaLike = await standIn({ models: ["nemotron-3-nano:4b"] });
  try {
    assert.equal((await probeMeterless(runtime.url, "wrong-token")).status, "unauthorized");
    const online = await probeMeterless(`${runtime.url}/healthz`, TOKEN);
    assert.equal(online.status, "online");
    assert.deepEqual(online.models, ["meterless/auto", "meterless/deep", "meterless/reasoning.fast", "meterless/new-mode"]);
    assert.equal((await probeMeterless(ollamaLike.url, TOKEN)).status, "offline");
    assert.equal((await probeMeterless("http://127.0.0.1:9", TOKEN)).status, "offline");
    const models = runtime.seen.find((call) => call.path === "/v1/models" && call.headers.authorization === `Bearer ${TOKEN}`)!;
    assert.equal(models.headers["meterless-app"], METERLESS_APP_ID);
    assert.equal(models.headers["meterless-scope"], undefined, "meterless-scope is sent on chat only");
  } finally {
    runtime.close();
    ollamaLike.close();
  }
});

test("Auto Detect saves the first online or unauthorized candidate, skipping offline ones", async () => {
  const runtime = await standIn();
  const ollamaLike = await standIn({ models: ["llama3.1:8b"] });
  try {
    const found = await autoDetectMeterless(TOKEN, ["http://127.0.0.1:9/v1", `${ollamaLike.url}/v1`, `${runtime.url}/v1`]);
    assert.equal(found?.status, "online");
    assert.equal(found?.baseUrl, `${runtime.url}/v1`);
    assert.equal((await autoDetectMeterless("wrong", [`${runtime.url}/v1`]))?.status, "unauthorized");
    assert.equal(await autoDetectMeterless(TOKEN, ["http://127.0.0.1:9/v1"]), null);
  } finally {
    runtime.close();
    ollamaLike.close();
  }
});

test("Meterless is the default provider; its token comes from the settings, and rt-local is no token", () => {
  const meterless = loadConfig({ REASONER: "nemotron", meterless_runtime_token: TOKEN }).nemotron;
  assert.deepEqual([meterless.provider, meterless.baseUrl, meterless.model, meterless.timeoutMs], ["meterless", "http://127.0.0.1:8088/v1", "nvidia/nemotron-3.5-bolt-e4b", 180_000]);
  assert.equal(meterless.apiKey, TOKEN);
  assert.equal(modelConfigProblem(meterless), null);
  assert.match(modelConfigProblem(loadConfig({ meterless_runtime_token: "rt-local" }).nemotron) ?? "", /meterless_runtime_token is not set/);
  assert.match(modelConfigProblem(loadConfig({ meterless_runtime_token: TOKEN, METERLESS_MODEL: "nemotron-3-nano:4b" }).nemotron) ?? "", /neither a Meterless routing mode/);
  // A model the runtime lists by name is accepted if it is a Nemotron; a
  // routing mode still is; another named model is not the assessor.
  assert.equal(modelConfigProblem(loadConfig({ meterless_runtime_token: TOKEN, METERLESS_MODEL: "local-runtime/nemotron-3.5-bolt-e4b" }).nemotron), null);
  assert.equal(modelConfigProblem(loadConfig({ meterless_runtime_token: TOKEN, METERLESS_MODEL: "meterless/auto" }).nemotron), null);
  assert.match(modelConfigProblem(loadConfig({ meterless_runtime_token: TOKEN, METERLESS_MODEL: "local-runtime/gemma-4-e4b-it" }).nemotron) ?? "", /does not name a Nemotron model/);
  // An existing NEMOTRON_BASE_URL keeps its endpoint; local Ollama and NVIDIA have their own defaults.
  assert.equal(loadConfig({ NEMOTRON_BASE_URL: "http://127.0.0.1:11434/v1" }).nemotron.provider, "openai-compatible");
  assert.equal(loadConfig({ MODEL_PROVIDER: "ollama" }).nemotron.baseUrl, "http://127.0.0.1:11434/v1");
  const nvidia = loadConfig({ MODEL_PROVIDER: "nvidia", NEMOTRON_MODEL: "nvidia/nemotron-x" }).nemotron;
  assert.equal(nvidia.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.match(modelConfigProblem(nvidia) ?? "", /NEMOTRON_API_KEY is not set/);
  // The key is read from the settings handed in (inside Speck, the plugin's), not from Speck's process.env.
  assert.equal(chatEndpoint({ ...nvidia, ...loadConfig({ MODEL_PROVIDER: "nvidia", NEMOTRON_API_KEY: "k-1" }).nemotron }).headers.authorization, "Bearer k-1");
});

test("Nightshift is not asked for JSON mode; Speck's contract takes the JSON after the engine's '>> action' line", async () => {
  const runtime = await standIn();
  try {
    const contract = { name: "check", required: ["ok"], properties: { ok: { type: "boolean" as const } } };
    const request = { prompt: "p", temperature: 0, timeoutMs: 5000, contract } as any;
    await new NemotronProcessor(loadConfig({ REASONER: "nemotron", METERLESS_BASE_URL: `${runtime.url}/v1`, meterless_runtime_token: TOKEN }).nemotron).infer(request);
    await new NemotronProcessor(loadConfig({ REASONER: "nemotron", MODEL_PROVIDER: "openai-compatible", NEMOTRON_BASE_URL: `${runtime.url}/v1`, NEMOTRON_MODEL: "nemotron-x", NEMOTRON_API_KEY: TOKEN }).nemotron).infer(request);
    const [throughNightshift, elsewhere] = runtime.seen.filter((call) => call.path === "/v1/chat/completions").map((call) => call.body);
    assert.equal(throughNightshift.response_format, undefined);
    assert.deepEqual(elsewhere.response_format, { type: "json_object" }, "other endpoints keep JSON mode");
    // What Bolt E4B wrote on a first chunk: the engine's log line, then the JSON.
    assert.deepEqual(parseModelCompletion(">> action\n{\"ok\": true}", contract).structured, { ok: true });
  } finally {
    runtime.close();
  }
});

test("a plain text request on meterless/auto returns a string, with the token and app headers", async () => {
  const runtime = await standIn();
  try {
    const config = loadConfig({ REASONER: "nemotron", METERLESS_BASE_URL: `${runtime.url}/v1/chat/completions`, METERLESS_MODEL: "meterless/auto", meterless_runtime_token: TOKEN }).nemotron;
    const processor = new NemotronProcessor(config);
    const completion = await processor.infer({ prompt: "Reply with the single word: ready", temperature: 0, timeoutMs: config.timeoutMs } as any);
    assert.equal(typeof completion.text, "string");
    assert.equal(completion.text, "ready (meterless/auto)");
    const chat = runtime.seen.find((call) => call.path === "/v1/chat/completions")!;
    assert.equal(chat.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(chat.headers["meterless-app"], METERLESS_APP_ID);
    assert.equal(chat.headers["meterless-scope"], "user");
    assert.equal(typeof chat.body.messages[0].content, "string", "plain text stays a string");
    assert.deepEqual([...processor.servedModels], ["nemotron-routed-stand-in"]);

    const wrong = new NemotronProcessor({ ...config, apiKey: "wrong" });
    await assert.rejects(wrong.infer({ prompt: "x", temperature: 0, timeoutMs: 5000 } as any), /HTTP 401 \(unauthorized: check meterless_runtime_token\)/);
  } finally {
    runtime.close();
  }
});
