import { loadConfig, loadDotEnv } from "../config.js";

// Verifies the configured Nemotron endpoint with one tiny chat completion and
// prints the model the endpoint reports having served. Run this before
// claiming Nemotron was used.

loadDotEnv();
const { nemotron } = loadConfig();
if (!nemotron.baseUrl || !nemotron.model) {
  console.error("Set NEMOTRON_BASE_URL and NEMOTRON_MODEL (see .env.example).");
  process.exit(1);
}
const base = nemotron.baseUrl.replace(/\/+$/, "");
const url = `${base}${base.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
const apiKey = process.env[nemotron.apiKeyEnv];
const began = performance.now();
try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: nemotron.model, temperature: 0, max_tokens: nemotron.maxTokens,
      ...(nemotron.reasoningEffort ? { reasoning_effort: nemotron.reasoningEffort } : {}),
      messages: [{ role: "user", content: "Reply with the single word: ready" }]
    }),
    signal: AbortSignal.timeout(nemotron.timeoutMs)
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    console.error(`FAILED: HTTP ${response.status} from ${url}: ${JSON.stringify(body).slice(0, 400)}`);
    if (response.status === 401 || response.status === 403) console.error(`  Is ${nemotron.apiKeyEnv} set to a valid key?`);
    process.exit(1);
  }
  const served = String(body.model ?? "(endpoint did not report a model)");
  console.log(`endpoint: ${url}`);
  console.log(`requested model: ${nemotron.model}`);
  console.log(`served model:    ${served}`);
  console.log(`reply: ${JSON.stringify(String(body.choices?.[0]?.message?.content ?? "").trim().slice(0, 80))}`);
  console.log(`latency: ${Math.round(performance.now() - began)} ms; usage: ${JSON.stringify(body.usage ?? null)}`);
  if (!/nemotron/i.test(served)) {
    console.error("WARNING: the served model name does not mention Nemotron.");
    process.exit(1);
  }
} catch (error) {
  console.error(`FAILED: ${url} unreachable: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
