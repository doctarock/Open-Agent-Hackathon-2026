import { loadConfig, loadDotEnv } from "../config.js";
import { probeMeterless } from "../reasoning/meterless.js";
import { modelConfigProblem, plainTextCheck, providerLabel } from "../reasoning/nemotron.js";

// Verifies the configured model provider with one tiny plain-text chat
// completion and prints the model the endpoint reports having served. For a
// Meterless Runtime it first asks /v1/models whether the runtime is online and
// the token accepted. Run this before claiming a model was used.

loadDotEnv();
const { nemotron } = loadConfig();
const problem = modelConfigProblem(nemotron);
if (problem) {
  console.error(`Not configured: ${problem}. Run npm run configure (or see .env.example).`);
  process.exit(1);
}
console.log(`provider: ${providerLabel(nemotron)}`);
if (nemotron.provider === "meterless") {
  const probe = await probeMeterless(nemotron.baseUrl, nemotron.apiKey);
  console.log(`runtime: ${probe.status} at ${probe.baseUrl} (${probe.detail})`);
  if (probe.status === "unauthorized") {
    console.error(`FAILED: the runtime rejected the token in ${nemotron.apiKeyEnv}. Paste the one in <stateDir>/proxy-token (npm run configure).`);
    process.exit(1);
  }
  if (probe.status === "offline") {
    console.error("FAILED: no Meterless Runtime answered. Start it, or run npm run configure to find it.");
    process.exit(1);
  }
  console.log(`routing modes: ${probe.models.join(", ")}`);
}
try {
  const check = await plainTextCheck(nemotron);
  console.log(`endpoint: ${check.url}`);
  console.log(`requested model: ${nemotron.model}`);
  console.log(`served model:    ${check.served ?? "(endpoint did not report a model)"}`);
  console.log(`reply: ${JSON.stringify(check.content.trim().slice(0, 80))}`);
  console.log(`latency: ${check.latencyMs} ms; usage: ${JSON.stringify(check.usage)}`);
  if (!/nemotron/i.test(check.served ?? "")) {
    // A Meterless routing mode chooses the model per call; say so rather than fail.
    if (nemotron.provider === "meterless") console.log("note: the runtime routed this call to a model whose name does not mention Nemotron.");
    else {
      console.error("WARNING: the served model name does not mention Nemotron.");
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
