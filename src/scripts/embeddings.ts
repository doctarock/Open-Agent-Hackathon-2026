import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../config.js";

// npm run embeddings (and the last step of npm run setup)
//
// Turns on Speck's embedding encoder, nomic-embed-text on local Ollama, so
// Speck's memory search and fact grounding use it without a visit to the
// System view. Never asks and never fails setup:
//   - an encoder already saved in Speck's settings (System view, Embeddings)
//     is kept as it is, wherever it points;
//   - local Ollama not answering: nothing changes, and Speck keeps its
//     built-in feature-hash encoder;
//   - Ollama without the model: it is pulled (about 270 MB), then checked
//     with one real embedding call before anything is saved.
// The encoder is written to Speck's model-processors.json beside its model
// processors, which are kept. Restart Speck to apply it.

const OLLAMA = "http://127.0.0.1:11434";
const MODEL = "nomic-embed-text";
const SPECK_RUNTIME = path.resolve(ROOT_DIR, "speck", process.env.SPECK_GENESIS_RUNTIME_PATH ?? path.join("data", "genesis-runtime"));

type Saved = { processors?: unknown[]; roles?: Record<string, unknown>; embedding?: { enabled?: boolean; baseUrl?: string; model?: string } };

export async function setUpEmbeddings(options: { runtimeDir?: string; ollama?: string; pull?: (model: string) => boolean } = {}): Promise<string> {
  const file = path.join(options.runtimeDir ?? SPECK_RUNTIME, "model-processors.json");
  const ollama = options.ollama ?? OLLAMA;
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Saved : {};
  if (saved.embedding) return `kept Speck's saved encoder: ${saved.embedding.model} at ${saved.embedding.baseUrl}${saved.embedding.enabled === false ? " (turned off)" : ""}`;

  const tags = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json() as Promise<{ models?: Array<{ name: string }> }>).catch(() => null);
  if (!tags) return `Ollama is not answering at ${ollama}; Speck keeps its built-in feature-hash encoder (run npm run embeddings once Ollama is up)`;
  const present = (tags.models ?? []).some((model) => model.name === MODEL || model.name === `${MODEL}:latest`);
  if (!present) {
    console.log(`Downloading ${MODEL} for Speck's memory (about 270 MB)...`);
    const pull = options.pull ?? ((model: string) => spawnSync("ollama", ["pull", model], { stdio: "inherit", shell: process.platform === "win32" }).status === 0);
    if (!pull(MODEL)) return `ollama pull ${MODEL} failed; Speck keeps its built-in feature-hash encoder`;
  }

  const check = await fetch(`${ollama}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: ["search_query: check"] }),
    signal: AbortSignal.timeout(60_000)
  }).then((response) => response.ok ? response.json() as Promise<{ embeddings?: number[][] }> : null).catch(() => null);
  const dimensions = check?.embeddings?.[0]?.length;
  if (!dimensions) return `${MODEL} did not return an embedding; Speck keeps its built-in feature-hash encoder`;

  // Saved as Speck's System view saves an encoder: with the model processors
  // and roles Speck is using now (its defaults when nothing is saved yet).
  const embedding = { enabled: true, provider: "ollama", baseUrl: ollama, model: MODEL, dimensions, timeoutMs: 30_000, batchSize: 16, allowHashFallback: true };
  const models = saved.processors && saved.roles ? { processors: saved.processors, roles: saved.roles } : await speckModels(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...saved, ...models, embedding }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return `Speck's encoder is ${MODEL} on Ollama (${dimensions} dimensions); restart Speck to apply it`;
}

async function speckModels(runtimeDir: string): Promise<{ processors: unknown[]; roles: Record<string, unknown> }> {
  const { loadAppConfig } = await import(pathToFileURL(path.join(ROOT_DIR, "speck", "dist", "config.js")).href) as { loadAppConfig(overrides: { genesisRuntimePath: string }): { modelRuntime: { processors: unknown[]; roles: Record<string, unknown> } } };
  const { processors, roles } = loadAppConfig({ genesisRuntimePath: runtimeDir }).modelRuntime;
  return { processors, roles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "embeddings.js")) {
  console.log(`Embeddings: ${await setUpEmbeddings().catch((error: unknown) => `not set up (${error instanceof Error ? error.message : String(error)}); Speck keeps its built-in feature-hash encoder`)}`);
}
