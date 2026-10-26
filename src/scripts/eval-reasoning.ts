import fs from "node:fs";
import path from "node:path";
import { CONCLUSION_RULES, loadConfig, loadDotEnv, ROOT_DIR, type ConclusionRule } from "../config.js";
import { loadEvalCases, REGRESSION_DIR } from "../eval/cases.js";
import { runEvaluation, systemsFor, type EvalReport } from "../eval/harness.js";

// npm run eval:reasoning [-- --repeats N] [-- --only <config>]
// npm run eval:reasoning -- --summarize <dir>
// npm run eval:reasoning -- --rule corroborated-2 [--out <name>]  the Build 5
//   candidate rule (docs/build-5-corroboration.md); corroborated-1 is scored
//   on the same judgments as well
//
// The live evaluation (held-out and regression groups) under each assessor
// configuration, alternated and repeated, with every system (Speck, Speck
// rebuilt from scratch, the stateless baseline) on the same model:
//   4k-noreason  nemotron-3-nano:4b, Ollama's default 4,096-token window,
//                reasoning off, replies capped at 4,096 tokens (the default)
//   16k-reason   the same weights in a 16,384-token window
//                (config/ollama/nemotron-3-nano-4b-ctx16k.Modelfile), reasoning
//                on (the model's default), replies capped at 12,288 tokens
//   bolt-e4b     nvidia/nemotron-3.5-bolt-e4b through the Meterless Runtime
//                (its address and token from .env), reasoning off, replies
//                capped at 4,096 tokens: the project's model since 2026-10-26
// The first two run on local Ollama.
// Each report is written as its own file under
// eval/results/experiments/reasoning/<timestamp>/, then summarised there
// (summary.md). eval/results/live.json is not touched.

const CONFIGS: Record<string, Record<string, string>> = {
  "4k-noreason": { NEMOTRON_MODEL: "nemotron-3-nano:4b", NEMOTRON_REASONING_EFFORT: "none", NEMOTRON_MAX_TOKENS: "4096" },
  "16k-reason": { NEMOTRON_MODEL: "nemotron-3-nano-4b-ctx16k", NEMOTRON_REASONING_EFFORT: "", NEMOTRON_MAX_TOKENS: "12288" },
  "bolt-e4b": { MODEL_PROVIDER: "meterless", METERLESS_MODEL: "nvidia/nemotron-3.5-bolt-e4b", NEMOTRON_REASONING_EFFORT: "none", NEMOTRON_MAX_TOKENS: "4096" }
};
const METRICS = [
  ["correctness", "conclusion correct"],
  ["overAbstention", "abstained when a conclusion was due"],
  ["unsupportedClaims", "unsupported claims (of conclusions)"],
  ["correctionHandling", "refuted claim kept out of current"],
  ["invalidatedExcluded", "invalidated evidence kept out of support"],
  ["validCitations", "valid citations"]
] as const;

type Saved = EvalReport & { config: string; group: string; repeat: number; wallMs: number };

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "eval-reasoning.js")) {
  const summarizeOnly = option("summarize");
  const dir = summarizeOnly ? path.resolve(summarizeOnly)
    : path.join(ROOT_DIR, "eval", "results", "experiments", "reasoning", option("out") ?? new Date().toISOString().replace(/[:.]/g, "-"));
  if (!summarizeOnly) await run(dir, Number(option("repeats") ?? 3), option("only"));
  fs.writeFileSync(path.join(dir, "summary.md"), summarize(dir));
  console.log(`\n${fs.readFileSync(path.join(dir, "summary.md"), "utf8")}`);
}

async function run(dir: string, repeats: number, only?: string): Promise<void> {
  loadDotEnv();
  const rule = (option("rule") ?? "corroborated-1") as ConclusionRule;
  if (!CONCLUSION_RULES.includes(rule)) throw new Error(`--rule must be one of ${CONCLUSION_RULES.join(", ")}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const [name, settings] of Object.entries(CONFIGS).filter(([name]) => !only || name === only)) {
      // Why the runtime's address and token are added here and not to the
      // preset: the preset is saved in every report, and the token must not be.
      const runtime = settings.MODEL_PROVIDER === "meterless" ? { METERLESS_BASE_URL: process.env.METERLESS_BASE_URL, meterless_runtime_token: process.env.meterless_runtime_token } : {};
      const nemotron = loadConfig({ REASONER: "nemotron", MODEL_PROVIDER: "ollama", NEMOTRON_TIMEOUT_MS: "300000", ...settings, ...runtime }).nemotron;
      for (const group of [{ id: "held-out", cases: loadEvalCases() }, { id: "regression", cases: loadEvalCases(REGRESSION_DIR) }]) {
        const began = Date.now();
        const report = await runEvaluation("live", group.cases, systemsFor("live", nemotron, rule));
        const file = path.join(dir, `${name}.r${repeat}.${group.id}.json`);
        if (fs.existsSync(file)) throw new Error(`${file} exists; live reports are never overwritten`);
        fs.writeFileSync(file,
          `${JSON.stringify({ generatedAt: new Date().toISOString(), config: name, settings, rule, repeat, group: group.id, wallMs: Date.now() - began, ...report }, null, 1)}\n`);
        console.log(`${name} repeat ${repeat} ${group.id}: ${Math.round((Date.now() - began) / 1000)} s; `
          + report.systems.map((system) => `${system.system} ${system.metrics.correctness.count}/${system.metrics.correctness.of}`).join("; "));
      }
    }
  }
}

// Every report in the directory, summed per configuration and system.
export function summarize(dir: string): string {
  const reports = fs.readdirSync(dir).filter((file) => /\.r\d+\.(held-out|regression)\.json$/.test(file))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Saved);
  const lines = [`# Reasoning on or off: ${path.basename(dir)}`, "",
    "Counts summed over every report in this folder (both groups, every repeat). Each repeat is a live sample; small counts.", ""];
  for (const config of [...new Set(reports.map((report) => report.config))]) {
    const mine = reports.filter((report) => report.config === config);
    const systems = [...new Set(mine.flatMap((report) => report.systems.map((system) => system.system)))];
    const repeats = new Set(mine.map((report) => report.repeat)).size;
    lines.push(`## ${config} (${repeats} repeat(s), ${Math.round(mine.reduce((sum, report) => sum + report.wallMs, 0) / 60000)} min in all)`, "",
      `| | ${systems.join(" | ")} |`, `|---|${systems.map(() => "---").join("|")}|`);
    const metrics = (system: string) => mine.map((report) => report.systems.find((item) => item.system === system)!.metrics);
    for (const [key, label] of METRICS) {
      lines.push(`| ${label} | ${systems.map((system) => {
        const rates = metrics(system).map((m) => m[key]).filter(Boolean);
        return rates.length ? `${rates.reduce((sum, rate) => sum + rate.count, 0)}/${rates.reduce((sum, rate) => sum + rate.of, 0)}` : "n/a";
      }).join(" | ")} |`);
    }
    lines.push(`| model replies valid | ${systems.map((system) => {
      const rates = metrics(system).map((m) => m.model?.contractValid).filter((rate): rate is NonNullable<typeof rate> => Boolean(rate));
      return rates.length ? `${rates.reduce((sum, rate) => sum + rate.count, 0)}/${rates.reduce((sum, rate) => sum + rate.of, 0)}` : "n/a";
    }).join(" | ")} |`);
    lines.push(`| median call latency, ms (per report) | ${systems.map((system) => metrics(system).map((m) => m.model?.latencyMs?.median ?? "-").join("/")).join(" | ")} |`, "");
  }
  return `${lines.join("\n")}\n`;
}
