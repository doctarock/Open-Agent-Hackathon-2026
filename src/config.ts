import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { METERLESS_DEFAULT_MODEL, METERLESS_TOKEN_KEY, normaliseMeterlessUrl, usableToken } from "./reasoning/meterless.js";

// Configuration comes from the environment (and a local, git-ignored .env).
// Nothing here has a credential default: a missing credential is reported
// where it is needed, never filled in.
//
// Why it is built this way:
// - Every choice that changes what a run means is explicit: where evidence
//   comes from (EVIDENCE_MODE), who assesses it (REASONER), which model and
//   provider. Invalid values stop the program with the setting's name, rather
//   than running on a silent default.
// - One .env for every entry point. The standalone server, the Speck plugin,
//   the scripts and npm run configure all read the same file, so the page
//   inside Speck and the command line describe the same configuration.

export type EvidenceMode = "fixture" | "zetaris";
export type ReasonerKind = "rules" | "nemotron";
// Evidence Desk's corroboration rule (src/investigation/conclusion.ts):
// corroborated-1 (Build 4, the default) or the Build 5 candidate
// corroborated-2 (docs/build-5-corroboration.md).
export type ConclusionRule = "corroborated-1" | "corroborated-2";
export const CONCLUSION_RULES: readonly ConclusionRule[] = ["corroborated-1", "corroborated-2"];
// Where the model assessor's calls go. meterless: a Meterless Runtime, which
// routes each call (src/reasoning/meterless.ts). ollama, nvidia: a Nemotron
// model on local Ollama or NVIDIA's hosted API. openai-compatible: any other
// endpoint serving a Nemotron model.
export type ModelProvider = "meterless" | "ollama" | "nvidia" | "openai-compatible";
export const MODEL_PROVIDERS: readonly ModelProvider[] = ["meterless", "ollama", "nvidia", "openai-compatible"];
const PROVIDER_BASE_URLS: Partial<Record<ModelProvider, string>> = {
  ollama: "http://127.0.0.1:11434/v1",
  nvidia: "https://integrate.api.nvidia.com/v1"
};

export interface ZetarisConfig {
  baseUrl: string;
  username: string;
  password: string;
  // Taken from the login response when not set.
  orgId: string | null;
  queryConfigPath: string;
  timeoutMs: number;
}

// The model assessor's settings, whichever provider serves it.
export interface NemotronConfig {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  // The name of the setting holding the API key or token.
  apiKeyEnv: string;
  // Its value, read from the same settings as everything else (inside Speck
  // those are the plugin's, not Speck's environment). Never logged.
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  // Sent as reasoning_effort when set (e.g. "none" turns Nemotron's
  // reasoning trace off on Ollama); omitted when empty.
  reasoningEffort: string;
  // The same, for decisive mode's one stateless call. Reasoning on by default
  // where the provider is known to take the parameter (Ollama, Meterless),
  // because reasoning made the stateless answer markedly better (README,
  // "Reasoning on or off"); the provider's default elsewhere.
  decisiveReasoningEffort: string;
}

// What one case needs, wherever it runs: inside Speck (the plugin, on
// Speck's own runtime) or standalone.
export interface CaseConfig {
  rootDir: string;
  historyDir: string;
  scenarioDir: string;
  evidenceMode: EvidenceMode;
  zetaris: ZetarisConfig;
  reasoner: ReasonerKind;
  nemotron: NemotronConfig;
  execution: { maxChunks: number; batchSize: number };
  // Absent: corroborated-1.
  conclusionRule?: ConclusionRule;
}

// A standalone desk also opens its own Speck database, and the standalone
// server listens on host:port.
export interface AppConfig extends CaseConfig {
  databasePath: string;
  host: string;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The repository Evidence Desk was installed from (the installed plugin
// records it in install.json); otherwise rootDir itself.
export function repositoryRoot(rootDir: string): string {
  try {
    const recorded = (JSON.parse(fs.readFileSync(path.join(rootDir, "install.json"), "utf8")) as { repository?: string }).repository;
    if (recorded && fs.existsSync(recorded)) return recorded;
  } catch { /* not an installed plugin */ }
  return rootDir;
}

// Loads ROOT/.env into process.env when present. Values already in the
// environment win, as with Node's own loader.
export function loadDotEnv(rootDir = ROOT_DIR): string | null {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

// .env text with each given key set: an existing KEY= line is replaced in
// place (the first, if repeated), a commented-out or missing key is appended,
// and every other line, comments included, is kept. A value containing
// whitespace, # or quotes is single-quoted, which Node's parser reads verbatim.
export function updateEnvText(text: string, values: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const quote = (value: string) => (/[\s#"'`]/.test(value) && !value.includes("'") ? `'${value}'` : value);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    const line = `${key}=${quote(value)}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const rootDir = overrides.rootDir ?? ROOT_DIR;
  const fromRoot = (value: string) => path.resolve(rootDir, value);
  const dataDir = fromRoot(env.EVIDENCE_DESK_DATA_DIR?.trim() || "data");
  return {
    rootDir,
    databasePath: path.resolve(dataDir, env.EVIDENCE_DESK_DB?.trim() || "evidence-desk.sqlite"),
    historyDir: path.resolve(dataDir, "meterless"),
    scenarioDir: fromRoot(env.EVIDENCE_DESK_SCENARIO?.trim() || "fixtures/scenarios/disputed-delivery"),
    evidenceMode: oneOf(env.EVIDENCE_MODE, ["fixture", "zetaris"], "fixture", "EVIDENCE_MODE"),
    zetaris: {
      baseUrl: (env.ZETARIS_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
      username: env.ZETARIS_USERNAME?.trim() ?? "",
      password: env.ZETARIS_PASSWORD ?? "",
      orgId: env.ZETARIS_ORG_ID?.trim() || null,
      queryConfigPath: fromRoot(env.ZETARIS_QUERY_CONFIG?.trim() || "config/zetaris-queries.json"),
      timeoutMs: positiveInt(env.ZETARIS_TIMEOUT_MS, 120_000, "ZETARIS_TIMEOUT_MS")
    },
    reasoner: oneOf(env.REASONER, ["rules", "nemotron"], "rules", "REASONER"),
    conclusionRule: oneOf(env.CONCLUSION_RULE, CONCLUSION_RULES, "corroborated-1", "CONCLUSION_RULE"),
    nemotron: modelConfig(env),
    execution: {
      maxChunks: positiveInt(env.MARKOVIAN_MAX_CHUNKS, 8, "MARKOVIAN_MAX_CHUNKS"),
      batchSize: positiveInt(env.EVIDENCE_BATCH_SIZE, 2, "EVIDENCE_BATCH_SIZE")
    },
    host: env.EVIDENCE_DESK_HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.EVIDENCE_DESK_PORT, 4320, "EVIDENCE_DESK_PORT"),
    ...overrides
  };
}

// MODEL_PROVIDER when set. Otherwise an explicit NEMOTRON_BASE_URL keeps the
// endpoint it names (as before providers existed), and Meterless is the default.
function modelConfig(env: NodeJS.ProcessEnv): NemotronConfig {
  const nemotronBase = env.NEMOTRON_BASE_URL?.trim() ?? "";
  const provider = oneOf(env.MODEL_PROVIDER, MODEL_PROVIDERS, nemotronBase ? "openai-compatible" : "meterless", "MODEL_PROVIDER");
  // Providers known to take reasoning_effort: Ollama (also when named by its
  // port) and Meterless.
  const takesReasoningEffort = provider === "ollama" || provider === "meterless" || (provider === "openai-compatible" && /:11434\b/.test(nemotronBase));
  const common = {
    timeoutMs: positiveInt(env.NEMOTRON_TIMEOUT_MS, 180_000, "NEMOTRON_TIMEOUT_MS"),
    maxTokens: positiveInt(env.NEMOTRON_MAX_TOKENS, 4096, "NEMOTRON_MAX_TOKENS"),
    reasoningEffort: env.NEMOTRON_REASONING_EFFORT?.trim() ?? "",
    decisiveReasoningEffort: env.NEMOTRON_DECISIVE_REASONING_EFFORT?.trim() || (takesReasoningEffort ? "medium" : "")
  };
  // .env.example's placeholders (<...>) are not values.
  const secret = (name: string) => (env[name] ?? "").trim().replace(/^<.*>$/, "");
  if (provider === "meterless") {
    return {
      provider, ...common,
      baseUrl: normaliseMeterlessUrl(env.METERLESS_BASE_URL ?? ""),
      model: env.METERLESS_MODEL?.trim() || METERLESS_DEFAULT_MODEL,
      apiKeyEnv: METERLESS_TOKEN_KEY,
      apiKey: usableToken(secret(METERLESS_TOKEN_KEY))
    };
  }
  const apiKeyEnv = env.NEMOTRON_API_KEY_ENV?.trim() || "NEMOTRON_API_KEY";
  return {
    provider, ...common,
    baseUrl: nemotronBase || PROVIDER_BASE_URLS[provider] || "",
    model: env.NEMOTRON_MODEL?.trim() ?? "",
    apiKeyEnv,
    apiKey: secret(apiKeyEnv)
  };
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (!allowed.includes(normalized as T)) throw new ConfigError(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  return normalized as T;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ConfigError(`${name} must be a positive integer (got "${value}")`);
  return parsed;
}
