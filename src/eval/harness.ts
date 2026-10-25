import type { ConclusionRule, NemotronConfig } from "../config.js";
import type { EvalCase } from "./cases.js";
import { scoreSystem, type SystemScore } from "./metrics.js";
import { speckDesk, speckFresh, statelessModel, statelessRules, type EvalSystem, type RuleChoice } from "./systems.js";

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
// rule: the corroboration rule the Speck systems conclude with. Under
// corroborated-2, corroborated-1 is also scored on the same runs and
// judgments; under corroborated-1 (the default) the systems are exactly
// Build 4's, and nothing else is scored: live, the model was not asked what
// corroborated-2 reads (docs/build-5-corroboration.md, 3b).
export function systemsFor(mode: EvalMode, nemotron?: NemotronConfig, rule: ConclusionRule = "corroborated-1"): EvalSystem[] {
  const choice: RuleChoice = { rule, variants: rule === "corroborated-2" ? ["corroborated-1"] : [] };
  if (mode === "fixture") return [speckDesk({ kind: "rules" }, choice), speckFresh({ kind: "rules" }, choice), statelessRules()];
  if (!nemotron) throw new Error("Live evaluation needs a Nemotron configuration");
  const reasoner = { kind: "nemotron" as const, config: nemotron };
  return [speckDesk(reasoner, choice), speckFresh(reasoner, choice), statelessModel(nemotron)];
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
    // Other rules read from the same runs, scored the same way.
    for (const rule of Object.keys(results[0]?.result.variants ?? {}) as ConclusionRule[]) {
      scores.push(scoreSystem(`${system.name}~${rule}`, results.map(({ item, result }) => ({ item, result: { checkpoints: result.variants![rule]!, model: result.model } }))));
    }
  }
  return {
    mode,
    cases: cases.map((item) => ({ id: item.id, category: item.category, checkpoints: item.checkpoints.length })),
    systems: scores,
    differences: DIFFERENCES[mode]
  };
}
