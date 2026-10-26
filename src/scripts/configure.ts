import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig, ROOT_DIR, updateEnvText, type AppConfig } from "../config.js";
import { EvidenceProviderError } from "../evidence/types.js";
import { ZETARIS_CASES } from "../evidence/zetaris-cases.js";
import { ZetarisEvidenceProvider } from "../evidence/zetaris-provider.js";
import { AUTO_DETECT_PORTS, autoDetectMeterless, describeMeterlessModel, EVIDENCE_DESK_METERLESS_MODEL, METERLESS_DEFAULT_MODEL, METERLESS_TOKEN_KEY, parseConnectLink, probeMeterless, usableToken } from "../reasoning/meterless.js";
import { plainTextCheck, providerLabel } from "../reasoning/nemotron.js";
import { loadScenario } from "../scenario.js";

// npm run configure
//
// Asks two questions, the model and the evidence source, checks each answer
// against the real service, and writes the result to the repository's .env:
// the one settings file the standalone server, the scripts and the Speck
// plugin all read. Secrets are typed hidden and never printed. When the model
// is a Meterless Runtime, its token also goes to Speck's secret store, and
// Speck's own chat can be pointed at the same runtime.
//
//   --model meterless|ollama|nvidia|rules
//   --evidence fixture|zetaris-local|zetaris
//   --yes        take the defaults for anything not given, without asking
//   --first-run  as npm run setup uses it: nothing if .env already exists or
//                there is no terminal to ask in, and never a failing exit, so
//                setup still finishes (the defaults are fixtures and rules)

const ENV_FILE = path.join(ROOT_DIR, ".env");
const EXAMPLE_FILE = path.join(ROOT_DIR, ".env.example");
const OLLAMA = "http://127.0.0.1:11434";
const OLLAMA_SUGGESTED = "nemotron-3-nano:4b";
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const LOCAL_ZETARIS = "http://localhost:3000";

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const assumeDefaults = args.includes("--yes") || !process.stdin.isTTY;
const firstRun = args.includes("--first-run");

if (firstRun && fs.existsSync(ENV_FILE)) {
  console.log("Settings already in .env; run npm run configure to change them.");
  process.exit(0);
}
if (firstRun && !process.stdin.isTTY) {
  console.log("No .env yet: the cases run on fixture files with the rule assessor. Run npm run configure in a terminal to choose a model and evidence source.");
  process.exit(0);
}

const existing: Record<string, string> = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, "utf8")) as Record<string, string> : {};
const values: Record<string, string> = {};
// .env.example's placeholders (<...>) count as unset.
const current = (key: string) => (values[key] ?? existing[key] ?? "").replace(/^<.*>$/, "");
const settings = () => ({ ...existing, ...values });

// Prompts, only when asking. Hidden input echoes nothing; the defaults are
// shown in brackets. Closing the prompt (Ctrl+C, Ctrl+D) saves nothing.
const rl = assumeDefaults ? null : readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let finished = false;
let hidden = false;
if (rl) {
  rl.on("close", () => {
    if (finished) return;
    console.log("\nStopped; nothing saved.");
    process.exit(firstRun ? 0 : 130);
  });
  const output = rl as unknown as { _writeToOutput: (text: string) => void };
  const writeOut = output._writeToOutput.bind(rl);
  output._writeToOutput = (text) => { if (!hidden || /^\r?\n$/.test(text)) writeOut(text); };
}

function ask(question: string, fallback = "", options: { secret?: boolean } = {}): Promise<string> {
  if (!rl) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    rl.question(`${question}${fallback && !options.secret ? ` [${fallback}]` : ""}: `, (answer) => {
      hidden = false;
      resolve(answer.trim() || fallback);
    });
    hidden = Boolean(options.secret);
  });
}

async function choose<T extends string>(question: string, name: string, choices: Array<{ value: T; label: string }>): Promise<T> {
  const given = flag(name);
  if (given) {
    const match = choices.find((choice) => choice.value === given);
    if (!match) {
      console.error(`--${name} must be one of ${choices.map((choice) => choice.value).join(", ")}`);
      process.exit(1);
    }
    return match.value;
  }
  console.log(`\n${question}`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}`));
  for (;;) {
    const answer = await ask("Choose", "1");
    const picked = choices[Number(answer) - 1] ?? choices.find((choice) => choice.value === answer);
    if (picked) return picked.value;
    console.log(`  Type a number from 1 to ${choices.length}.`);
  }
}

const yes = async (question: string, fallback: boolean) => /^y/i.test(await ask(`${question} (y/n)`, fallback ? "y" : "n"));
const fail = (message: string) => console.log(`  ✗ ${message}`);
const ok = (message: string) => console.log(`  ✓ ${message}`);

// ---------------------------------------------------------------- model

// Speck's own settings, beside .env: its secret store, where Speck keeps the
// runtime token (the plugin and Speck's chat read it there), and its model
// processors (System view, Brains). Applied only when the settings are saved.
const SPECK_DIR = path.join(ROOT_DIR, "speck");
const SPECK_RUNTIME = path.resolve(SPECK_DIR, process.env.SPECK_GENESIS_RUNTIME_PATH ?? path.join("data", "genesis-runtime"));
let forSpeck = null as { token: string; baseUrl: string; model: string; chat: boolean } | null;

async function speckSecrets(): Promise<{ get(handle: string): Promise<string | null>; set(handle: string, value: string): Promise<unknown> } | null> {
  const file = path.join(SPECK_DIR, "dist", "security", "secret-store.js");
  if (!fs.existsSync(file)) return null;
  const { SecretStore } = await import(pathToFileURL(file).href);
  return new SecretStore(SPECK_RUNTIME);
}

// Speck's chat roles on the Meterless Runtime, as the System view would save
// them. Speck's other processors are kept, so it can be switched back there.
function useMeterlessForSpeckChat(baseUrl: string, model: string): void {
  const file = path.join(SPECK_RUNTIME, "model-processors.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as { processors?: Array<{ id: string }>; roles?: Record<string, unknown> } : {};
  const processor = { id: "meterless", provider: "meterless", model, baseUrl, tier: 2, contextSize: 32_768, hardware: "meterless", specialties: ["general"], enabled: true };
  const processors = [...(saved.processors ?? []).filter((entry) => entry.id !== "meterless"), processor];
  const roles = { ...(saved.roles ?? {}), intake: "meterless", planner: "meterless", worker: "meterless", toolCaller: "meterless", specialists: (saved.roles?.specialists as object | undefined) ?? {} };
  fs.mkdirSync(SPECK_RUNTIME, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...saved, processors, roles }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

async function configureMeterless(): Promise<boolean> {
  let token = usableToken(current(METERLESS_TOKEN_KEY)) || usableToken(await (await speckSecrets())?.get(METERLESS_TOKEN_KEY).catch(() => null));
  let baseUrl = current("METERLESS_BASE_URL");
  for (let attempt = 0; attempt < 4; attempt++) {
    const pasted = await ask("Meterless Runtime address or connect link (Enter to Auto Detect)", baseUrl);
    const link = parseConnectLink(pasted);
    if (link) { baseUrl = link.baseUrl; token = link.token; ok(`connect link read: ${link.baseUrl} and its key`); }
    else baseUrl = pasted;
    const probe = baseUrl ? await probeMeterless(baseUrl, token) : await autoDetectMeterless(token);
    if (!probe) {
      fail(`no Meterless Runtime found on ports ${AUTO_DETECT_PORTS.join(", ")} of this machine. Start it, or paste its address.`);
      if (assumeDefaults) return false;
      continue;
    }
    baseUrl = probe.baseUrl;
    if (probe.status === "offline") {
      fail(`${probe.baseUrl} is not a Meterless Runtime (${probe.detail}).`);
      baseUrl = "";
      if (assumeDefaults) return false;
      continue;
    }
    if (probe.status === "unauthorized") {
      fail(`found the runtime at ${probe.baseUrl}, but it ${token ? "rejected the token" : "needs its token"}.`);
      if (assumeDefaults) return false;
      token = usableToken(await ask("Paste the token from the runtime's <stateDir>/proxy-token (hidden)", "", { secret: true }));
      if (!token) fail("rt-local is a placeholder, not a token.");
      continue;
    }
    ok(`Meterless Runtime online at ${probe.baseUrl}`);
    // The project's model (Bolt E4B) whenever the runtime serves it, without
    // asking; otherwise its routing modes and the Nemotron models it serves by name.
    const choices = [...probe.models, ...probe.pinned.filter((id) => /nemotron/i.test(id))];
    const pinned = choices.includes(EVIDENCE_DESK_METERLESS_MODEL);
    const fallback = pinned ? EVIDENCE_DESK_METERLESS_MODEL
      : probe.models.includes(METERLESS_DEFAULT_MODEL) ? METERLESS_DEFAULT_MODEL : probe.models[0]!;
    let model = fallback;
    if (pinned) ok(`model: ${model}`);
    else if (!assumeDefaults && choices.length > 1) {
      console.log("  Routing modes and Nemotron models it offers:");
      choices.forEach((id, index) => console.log(`    ${index + 1}. ${id}  (${describeMeterlessModel(id)})`));
      const answer = await ask("  Routing mode or model", String(choices.indexOf(current("METERLESS_MODEL") || fallback) + 1 || choices.indexOf(fallback) + 1));
      model = choices[Number(answer) - 1] ?? (choices.includes(answer) ? answer : fallback);
    }
    Object.assign(values, { REASONER: "nemotron", MODEL_PROVIDER: "meterless", METERLESS_BASE_URL: probe.baseUrl, METERLESS_MODEL: model, [METERLESS_TOKEN_KEY]: token });
    if (!(await checkModel())) return false;
    const speckBuilt = fs.existsSync(path.join(SPECK_DIR, "dist", "index.js"));
    forSpeck = speckBuilt ? { token, baseUrl: probe.baseUrl, model, chat: await yes("Use this runtime for Speck's own chat too (Speck's System view, Brains)?", true) } : null;
    return true;
  }
  return false;
}

async function configureOllama(): Promise<boolean> {
  for (;;) {
    const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json() as Promise<{ models?: Array<{ name: string }> }>).catch(() => null);
    if (!tags) {
      fail(`Ollama is not answering at ${OLLAMA}. Install it from https://ollama.com and start it.`);
      if (assumeDefaults || !(await yes("Try again?", true))) return false;
      continue;
    }
    const nemotrons = (tags.models ?? []).map((model) => model.name).filter((name) => /nemotron/i.test(name));
    if (!nemotrons.length) {
      fail("Ollama has no Nemotron model.");
      if (!(await yes(`Download ${OLLAMA_SUGGESTED} now (about 3 GB)?`, true))) return false;
      const pulled = spawnSync("ollama", ["pull", OLLAMA_SUGGESTED], { stdio: "inherit", shell: process.platform === "win32" });
      if (pulled.status !== 0) { fail(`ollama pull ${OLLAMA_SUGGESTED} failed.`); return false; }
      continue;
    }
    let model = nemotrons.includes(current("NEMOTRON_MODEL")) ? current("NEMOTRON_MODEL") : nemotrons.includes(OLLAMA_SUGGESTED) ? OLLAMA_SUGGESTED : nemotrons[0]!;
    if (!assumeDefaults && nemotrons.length > 1) {
      nemotrons.forEach((name, index) => console.log(`    ${index + 1}. ${name}`));
      const answer = await ask("  Model", String(nemotrons.indexOf(model) + 1));
      model = nemotrons[Number(answer) - 1] ?? model;
    }
    ok(`Ollama is serving ${model}`);
    // With reasoning on, a small model's reasoning trace uses up the output budget.
    Object.assign(values, { REASONER: "nemotron", MODEL_PROVIDER: "ollama", NEMOTRON_BASE_URL: `${OLLAMA}/v1`, NEMOTRON_MODEL: model, NEMOTRON_REASONING_EFFORT: "none" });
    return checkModel();
  }
}

async function configureNvidia(): Promise<boolean> {
  const keyName = current("NEMOTRON_API_KEY_ENV") || "NEMOTRON_API_KEY";
  const known = current(keyName);
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await ask(`NVIDIA API key from build.nvidia.com (hidden${known ? "; Enter keeps the current one" : ""})`, known, { secret: true });
    if (!key) { fail("no key given."); if (assumeDefaults) return false; continue; }
    const response = await fetch(`${NVIDIA_BASE}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!response) { fail(`${NVIDIA_BASE} is unreachable from this machine.`); return false; }
    if (!response.ok) { fail(`NVIDIA's API answered HTTP ${response.status}.`); continue; }
    const listed = ((await response.json().catch(() => ({}))) as { data?: Array<{ id: string }> }).data ?? [];
    const nemotrons = listed.map((model) => model.id).filter((id) => /nemotron/i.test(id)).sort();
    if (!nemotrons.length) { fail("the key works, but no Nemotron model is listed for it."); return false; }
    let model = nemotrons.includes(current("NEMOTRON_MODEL")) ? current("NEMOTRON_MODEL") : nemotrons.find((id) => /nano/i.test(id)) ?? nemotrons[0]!;
    if (!assumeDefaults) {
      nemotrons.forEach((id, index) => console.log(`    ${index + 1}. ${id}`));
      const answer = await ask("  Model", String(nemotrons.indexOf(model) + 1));
      model = nemotrons[Number(answer) - 1] ?? (nemotrons.includes(answer) ? answer : model);
    }
    Object.assign(values, { REASONER: "nemotron", MODEL_PROVIDER: "nvidia", NEMOTRON_BASE_URL: NVIDIA_BASE, NEMOTRON_MODEL: model, NEMOTRON_API_KEY_ENV: keyName, [keyName]: key, NEMOTRON_REASONING_EFFORT: "" });
    return checkModel();
  }
  return false;
}

// One plain-text request through exactly the settings about to be saved.
async function checkModel(): Promise<boolean> {
  const config = loadConfig(settings()).nemotron;
  console.log(`  Asking ${providerLabel(config)} (${config.model}) for one short reply; a first model load can take minutes…`);
  try {
    const check = await plainTextCheck(config);
    ok(`replied ${JSON.stringify(check.content.trim().slice(0, 40))} in ${check.latencyMs} ms, served by ${check.served ?? "(not reported)"}`);
    return true;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ---------------------------------------------------------------- evidence

async function configureZetaris(local: boolean): Promise<boolean> {
  const baseUrl = await ask(local ? "Zetaris web interface" : "Zetaris address (its sign-in URL)", current("ZETARIS_BASE_URL") || (local ? LOCAL_ZETARIS : ""));
  const username = await ask("Zetaris sign-in email", current("ZETARIS_USERNAME") || (local ? "admin@zetaris.com" : ""));
  const knownPassword = current("ZETARIS_PASSWORD");
  const password = await ask(`Zetaris password (hidden${knownPassword ? "; Enter keeps the current one" : ""})`, knownPassword, { secret: true });
  Object.assign(values, { EVIDENCE_MODE: "zetaris", ZETARIS_BASE_URL: baseUrl, ZETARIS_USERNAME: username, ZETARIS_PASSWORD: password });
  const config = loadConfig(settings());
  const provider = new ZetarisEvidenceProvider(config.zetaris);
  try {
    await provider.select("SELECT 1 AS ok", "connectivity probe");
    ok(`signed in to Zetaris at ${config.zetaris.baseUrl}`);
  } catch (error) {
    fail(zetarisError(error));
    return false;
  }
  if (await everyCaseEvidence()) return true;
  if (!local) {
    fail(`the tables in ${ZETARIS_CASES.map((item) => item.queries).join(" and ")} are not all there. Seeding works only on the local Docker bundle; on another platform, create them with the columns those files list.`);
    return false;
  }
  if (!(await yes("Load the cases' evidence into this Zetaris now (npm run zetaris:seed)?", true))) return false;
  const seeded = spawnSync(process.execPath, [path.join(ROOT_DIR, "dist", "src", "scripts", "zetaris-seed.js")], { stdio: "inherit", env: { ...process.env, ...values } });
  if (seeded.status !== 0) { fail("seeding failed (see above)."); return false; }
  return everyCaseEvidence();
}

// Every prepared case that reads from Zetaris (src/evidence/zetaris-cases.ts),
// each from its own tables: all of them must have their records.
async function everyCaseEvidence(): Promise<boolean> {
  let all = true;
  for (const item of ZETARIS_CASES) {
    const config = loadConfig({ ...settings(), EVIDENCE_DESK_SCENARIO: item.scenarioDir, ZETARIS_QUERY_CONFIG: item.queries });
    if (!(await caseEvidence(config, new ZetarisEvidenceProvider(config.zetaris)))) all = false;
  }
  return all;
}

async function caseEvidence(config: AppConfig, provider: ZetarisEvidenceProvider): Promise<boolean> {
  const caseId = loadScenario(config.scenarioDir).caseId;
  try {
    const { records } = await provider.fetchCaseEvidence(caseId);
    if (!records.length) return false;
    ok(`${records.length} record(s) for ${caseId} through Zetaris`);
    return true;
  } catch (error) {
    console.log(`  (${zetarisError(error)})`);
    return false;
  }
}

const zetarisError = (error: unknown) => (error instanceof EvidenceProviderError ? `${error.message}. ${error.hint}` : error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- run

console.log("Evidence Desk setup. Each choice is checked against the real service before anything is saved.");
const model = await choose("Which model should weigh the evidence?", "model", [
  { value: "meterless", label: "Meterless Runtime (recommended): routes each call; finds a runtime on this machine" },
  { value: "ollama", label: "Nemotron on local Ollama" },
  { value: "nvidia", label: "Nemotron on NVIDIA's hosted API (needs an API key)" },
  { value: "rules", label: "No model: the scenario's deterministic fact rules" }
]);
const modelOk = model === "rules"
  ? (Object.assign(values, { REASONER: "rules" }), true)
  : await { meterless: configureMeterless, ollama: configureOllama, nvidia: configureNvidia }[model]();

const evidence = await choose("Where does the evidence come from?", "evidence", [
  { value: "fixture", label: "Fixture files in this repository (recommended to start; nothing else to run)" },
  { value: "zetaris-local", label: "Local Zetaris (the Docker Compose bundle on this machine)" },
  { value: "zetaris", label: "Another Zetaris address (not tested beyond the local bundle)" }
]);
const evidenceOk = evidence === "fixture"
  ? (Object.assign(values, { EVIDENCE_MODE: "fixture" }), true)
  : await configureZetaris(evidence === "zetaris-local");

const problems = [...(modelOk ? [] : ["the model check failed"]), ...(evidenceOk ? [] : ["the Zetaris check failed"])];
const save = !problems.length || (!assumeDefaults && (await yes(`\n${problems.join(" and ")}. Save these settings anyway?`, false)));
finished = true;
rl?.close();
if (!save) {
  console.log(`\nNothing saved${fs.existsSync(ENV_FILE) ? "; .env is unchanged" : "; the cases run on fixture files with the rule assessor"}. Run npm run configure again when the service is up.`);
  process.exit(firstRun ? 0 : 1);
}
const base = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : fs.readFileSync(EXAMPLE_FILE, "utf8");
fs.writeFileSync(ENV_FILE, updateEnvText(base, values));
if (forSpeck) {
  await (await speckSecrets())!.set(METERLESS_TOKEN_KEY, forSpeck.token);
  console.log(`\nSaved the runtime token in Speck's secret store as ${METERLESS_TOKEN_KEY}.`);
  if (forSpeck.chat) {
    useMeterlessForSpeckChat(forSpeck.baseUrl, forSpeck.model);
    console.log(`Speck's chat now uses the Meterless Runtime (${forSpeck.model}); its other processors are kept in the System view.`);
  }
}
const saved = loadConfig(settings());
console.log(`\nSaved to .env: ${saved.reasoner === "rules" ? "rule assessor" : `${providerLabel(saved.nemotron)}, ${saved.nemotron.model}`}; evidence from ${saved.evidenceMode === "zetaris" ? `Zetaris at ${saved.zetaris.baseUrl}` : "fixture files"}.`);
console.log("Start (or restart) Speck with npm run speck; the standalone page is npm start.");
