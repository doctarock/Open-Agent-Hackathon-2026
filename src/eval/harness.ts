import type { NemotronConfig } from "../config.js";
import type { EvalCase } from "./cases.js";
import { scoreSystem, type SystemScore } from "./metrics.js";
import { speckDesk, speckFresh, statelessModel, statelessRules, type EvalSystem } from "./systems.js";

export type EvalMode = "fixture" | "live";

export interface EvalReport {
  mode: EvalMode;
  cases: Array<{ id: string; category: string; checkpoints: number }>;
  systems: SystemScore[];
  // Differences between the systems' inputs and model calls that the
  // comparison cannot remove; read the scores with them in mind.
  differences: string[];
}

// fixture: deterministic, no model and no network beyond a refused local port.
// live: the configured Nemotron endpoint for every model-backed system.
export function systemsFor(mode: EvalMode, nemotron?: NemotronConfig): EvalSystem[] {
  if (mode === "fixture") return [speckDesk({ kind: "rules" }), speckFresh({ kind: "rules" }), statelessRules()];
  if (!nemotron) throw new Error("Live evaluation needs a Nemotron configuration");
  const reasoner = { kind: "nemotron" as const, config: nemotron };
  return [speckDesk(reasoner), speckFresh(reasoner), statelessModel(nemotron)];
}

export const DIFFERENCES: Record<EvalMode, string[]> = {
  fixture: [
    "All three systems read the same held-out evidence and the same scenario fact rules; none uses a model.",
    "The Speck systems apply Speck's belief revision (reliability-weighted steps, decisive refutation, status thresholds) and Evidence Desk's conclusion policy; the stateless baseline sums rule weights and takes the top positive score. Differences between them reflect that policy, not only persistence.",
    "speck-desk and speck-fresh differ only in persisted state: speck-desk carries beliefs and history across checkpoints and receives evidence incrementally; speck-fresh starts empty at each checkpoint and receives all visible evidence in one run."
  ],
  live: [
    "All model-backed systems use the same Nemotron endpoint, model, temperature (0.1), reasoning effort and output budget, and at most two attempts per structured reply.",
    "Speck systems call the model once per evidence chunk (relation judgments) plus once for the explanation; the baseline calls it once per checkpoint with all visible evidence. Call counts and latencies are therefore not like for like.",
    "Speck systems also apply the scenario's decisive fact rules and Speck's 0.4 reliability cap on model-judged evidence; the baseline sees the same facts in its prompt but has no rules, so differences cannot be attributed to persistence alone.",
    "The baseline is told to answer \"unresolved\" when nothing is established; Speck systems abstain through Speck's thresholds. Only Speck systems produce an explanation, so explanation agreement exists only for them.",
    "Evidence comes from the held-out fixture files in both modes; the provider-failure case uses the real Zetaris adapter against an unreachable port."
  ]
};

export async function runEvaluation(mode: EvalMode, cases: readonly EvalCase[], systems: readonly EvalSystem[], onProgress?: (message: string) => void): Promise<EvalReport> {
  const scores: SystemScore[] = [];
  for (const system of systems) {
    const results = [];
    for (const item of cases) {
      onProgress?.(`${system.name}: ${item.id}`);
      results.push({ item, result: await system.run(item) });
    }
    scores.push(scoreSystem(system.name, results));
  }
  return {
    mode,
    cases: cases.map((item) => ({ id: item.id, category: item.category, checkpoints: item.checkpoints.length })),
    systems: scores,
    differences: DIFFERENCES[mode]
  };
}
