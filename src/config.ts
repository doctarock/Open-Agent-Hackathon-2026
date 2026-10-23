import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Configuration comes from the environment (and a local, git-ignored .env).
// Nothing here has a credential default: a missing credential is reported
// where it is needed, never filled in.

export type EvidenceMode = "fixture" | "zetaris";
export type ReasonerKind = "rules" | "nemotron";

export interface ZetarisConfig {
  baseUrl: string;
  username: string;
  password: string;
  // Taken from the login response when not set.
  orgId: string | null;
  queryConfigPath: string;
  timeoutMs: number;
}

export interface NemotronConfig {
  baseUrl: string;
  model: string;
  // The name of the environment variable holding the API key, never the key.
  apiKeyEnv: string;
  timeoutMs: number;
  maxTokens: number;
  // Sent as reasoning_effort when set (e.g. "none" turns Nemotron's
  // reasoning trace off on Ollama); omitted when empty.
  reasoningEffort: string;
}

export interface AppConfig {
  rootDir: string;
  databasePath: string;
  historyDir: string;
  scenarioDir: string;
  evidenceMode: EvidenceMode;
  zetaris: ZetarisConfig;
  reasoner: ReasonerKind;
  nemotron: NemotronConfig;
  execution: { maxChunks: number; batchSize: number };
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

// Loads ROOT/.env into process.env when present. Values already in the
// environment win, as with Node's own loader.
export function loadDotEnv(rootDir = ROOT_DIR): string | null {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
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
    nemotron: {
      baseUrl: env.NEMOTRON_BASE_URL?.trim() ?? "",
      model: env.NEMOTRON_MODEL?.trim() ?? "",
      apiKeyEnv: env.NEMOTRON_API_KEY_ENV?.trim() || "NEMOTRON_API_KEY",
      timeoutMs: positiveInt(env.NEMOTRON_TIMEOUT_MS, 180_000, "NEMOTRON_TIMEOUT_MS"),
      maxTokens: positiveInt(env.NEMOTRON_MAX_TOKENS, 4096, "NEMOTRON_MAX_TOKENS"),
      reasoningEffort: env.NEMOTRON_REASONING_EFFORT?.trim() ?? ""
    },
    execution: {
      maxChunks: positiveInt(env.MARKOVIAN_MAX_CHUNKS, 8, "MARKOVIAN_MAX_CHUNKS"),
      batchSize: positiveInt(env.EVIDENCE_BATCH_SIZE, 2, "EVIDENCE_BATCH_SIZE")
    },
    host: env.EVIDENCE_DESK_HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.EVIDENCE_DESK_PORT, 4320, "EVIDENCE_DESK_PORT"),
    ...overrides
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
