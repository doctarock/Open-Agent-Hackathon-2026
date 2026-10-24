import fs from "node:fs";
import path from "node:path";
import type { Rate } from "../eval/metrics.js";
import { COMPARISON_SCHEMA, repositoryRoot, type ComparisonReport } from "./comparison.js";

// The evaluation results, as the page shows them. Read from the reports the
// evaluation commands wrote (eval/results/ in the repository); nothing here is
// recomputed or re-scored, and a report that has not been generated is listed
// as missing with the command that makes it.
// Why read rather than recompute: the page shows exactly the numbers the
// committed reports contain, so what a judge sees on the page and what is in
// the repository cannot differ.

interface MetricRow { id: string; label: string; meaning: string }

// The evaluation's own metrics (src/eval/metrics.ts), in the order the
// commands print them, with what each counts.
export const METRIC_ROWS: MetricRow[] = [
  { id: "correctness", label: "Conclusion matches the label", meaning: "Checkpoints where the conclusion equals the pre-registered label (abstaining counts as concluding nothing)." },
  { id: "unsupportedClaims", label: "Unsupported conclusions", meaning: "Of the firm conclusions made: ones the label says the evidence does not support, or with no valid supporting citation. Lower is better." },
  { id: "appropriateAbstention", label: "Abstained when it should", meaning: "Checkpoints labelled 'no conclusion is justified' where the system concluded nothing." },
  { id: "overAbstention", label: "Abstained when a conclusion was due", meaning: "Checkpoints with a labelled conclusion where the system concluded nothing. Lower is better." },
  { id: "correctionHandling", label: "Refuted explanation kept out of current", meaning: "Checkpoints with a refuted or replaced explanation where none was presented as current or favoured." },
  { id: "invalidatedExcluded", label: "Replaced or withdrawn evidence kept out of support", meaning: "Checkpoints with invalidated records where none of them supports what is presented (regression cases)." },
  { id: "validCitations", label: "Valid citations", meaning: "Cited record ids that exist in the evidence visible at that checkpoint." },
  { id: "failureSurfaced", label: "Evidence-source failure surfaced", meaning: "Cases whose evidence source fails: the error is reported and nothing is concluded." },
  { id: "explanationAgreement", label: "Model explanation agrees with Speck", meaning: "Speck systems with a model only: the model's explanation states the same conclusion and firmness as Speck's state." }
];

const CROSS_DOMAIN_ROWS: MetricRow[] = [
  { id: "invalidatedInfluencing", label: "Invalidated evidence still bearing on a current belief", meaning: "Checkpoints with replaced or withdrawn records where one still bears on a current belief. Lower is better." },
  { id: "correctRevisions", label: "Followed a labelled change of conclusion", meaning: "Checkpoints where the label changes from the previous checkpoint and the system followed it." },
  { id: "unnecessaryAbstentions", label: "Abstained when a conclusion was due", meaning: "Checkpoints labelled with a conclusion where the system abstained without an error. Lower is better." },
  { id: "orderConsistent", label: "Same answer whatever the arrival order", meaning: "Families of the same records in different orders where every variant ends correct and identical." }
];

const REPORTS = [
  { id: "fixture", title: "Held-out cases", kind: "deterministic", command: "npm run eval" },
  { id: "fixture-regression", title: "Correction-sequence regression cases", kind: "deterministic", command: "npm run eval" },
  { id: "cross-domain", title: "Cross-domain suite (logistics, payments, procurement)", kind: "deterministic", command: "npm run eval:cross-domain" },
  { id: "live", title: "Held-out cases, live model", kind: "live", command: "npm run eval:live" },
  { id: "live-regression", title: "Correction-sequence regression cases, live model", kind: "live", command: "npm run eval:live" }
] as const;

interface SystemScoreLike {
  system: string;
  metrics: Record<string, unknown> & { model?: { servedModels: string[]; httpCalls: number; latencyMs: { mean: number; median: number; max: number } | null } | null };
  checkpoints: Array<{ caseId: string; stage: string; expected: string | null; concluded: string | null; tentative: string | null; error: string | null; correct: boolean; unsupportedClaim: boolean; staleSupport: string[]; presentedRefuted: string[]; invalidCitations: string[] }>;
}

export interface EvaluationSummary {
  resultsDir: string;
  reports: Array<{
    id: string; title: string; kind: string; command: string; available: boolean; generatedAt: string | null;
    cases: number; checkpoints: number; models: string[];
    rows: Array<MetricRow & { values: Record<string, Rate | null> }>;
    systems: string[];
    perCheckpoint: Array<{ caseId: string; stage: string; expected: string | null; results: Record<string, Omit<SystemScoreLike["checkpoints"][number], "caseId" | "stage" | "expected">> }>;
    recovery: { interrupted: Rate; identical: Rate; correct: Rate } | null;
    differences: string[];
  }>;
  comparisons: ComparisonAggregate[];
}

// Saved side-by-side comparisons from npm run compare / compare:live,
// counted per case and configuration. Each count has its denominator: the
// number of comparisons (samples) of that configuration.
export interface ComparisonAggregate {
  scenarioId: string;
  title: string;
  kind: "deterministic" | "live";
  evidence: string;
  assessor: string;
  samples: number;
  first: string;
  last: string;
  stages: Array<{
    stage: string;
    label: string | null;
    approaches: Record<"speck" | "stateless", {
      committed: number; abstained: number; errors: number; supportFromReplaced: number; unknownCitations: number;
      matchesLabel: number | null; unsupportedClaims: number | null; recordsWhy: number;
      // What each sample concluded (firm conclusion, or "none").
      conclusions: Record<string, number>;
    }>;
  }>;
}

export function evaluationSummary(rootDir: string): EvaluationSummary {
  const resultsDir = path.join(repositoryRoot(rootDir), "eval", "results");
  const reports = REPORTS.map((spec) => {
    const file = path.join(resultsDir, `${spec.id}.json`);
    const empty = { ...spec, available: false, generatedAt: null, cases: 0, checkpoints: 0, models: [], rows: [], systems: [], perCheckpoint: [], recovery: null, differences: [] };
    if (!fs.existsSync(file)) return empty;
    let data: { generatedAt?: string; cases?: Array<{ checkpoints: number }>; systems?: SystemScoreLike[]; extras?: Array<Record<string, unknown> & { system: string }>; recovery?: { interrupted: Rate; identical: Rate; correct: Rate }; differences?: string[] };
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return empty;
    }
    const systems = data.systems ?? [];
    const names = systems.map((system) => system.system);
    const rows = [
      ...METRIC_ROWS.map((row) => ({ ...row, values: Object.fromEntries(systems.map((system) => [system.system, (system.metrics[row.id] as Rate | undefined) ?? null])) })),
      ...(data.extras ? CROSS_DOMAIN_ROWS.map((row) => ({ ...row, values: Object.fromEntries(data.extras!.map((extra) => [extra.system, (extra[row.id] as Rate | undefined) ?? null])) })) : [])
    ].filter((row) => Object.values(row.values).some((value) => value && value.of > 0));
    const first = systems[0];
    return {
      ...spec,
      available: true,
      generatedAt: data.generatedAt ?? null,
      cases: data.cases?.length ?? 0,
      checkpoints: data.cases?.reduce((sum, item) => sum + item.checkpoints, 0) ?? 0,
      models: [...new Set(systems.flatMap((system) => system.metrics.model?.servedModels ?? []))],
      rows,
      systems: names,
      perCheckpoint: (first?.checkpoints ?? []).map((checkpoint, index) => ({
        caseId: checkpoint.caseId, stage: checkpoint.stage, expected: checkpoint.expected,
        results: Object.fromEntries(systems.map((system) => {
          const score = system.checkpoints[index]!;
          return [system.system, {
            concluded: score.concluded, tentative: score.tentative, error: score.error, correct: score.correct, unsupportedClaim: score.unsupportedClaim,
            staleSupport: score.staleSupport, presentedRefuted: score.presentedRefuted, invalidCitations: score.invalidCitations
          }];
        }))
      })),
      recovery: data.recovery ? { interrupted: data.recovery.interrupted, identical: data.recovery.identical, correct: data.recovery.correct } : null,
      differences: data.differences ?? []
    };
  });
  return { resultsDir, reports, comparisons: aggregateComparisons(path.join(resultsDir, "comparisons")) };
}

export function aggregateComparisons(dir: string): ComparisonAggregate[] {
  if (!fs.existsSync(dir)) return [];
  const groups = new Map<string, ComparisonReport[]>();
  for (const scenario of fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const name of fs.readdirSync(path.join(dir, scenario.name)).filter((entry) => entry.endsWith(".json"))) {
      let report: ComparisonReport;
      try {
        report = JSON.parse(fs.readFileSync(path.join(dir, scenario.name, name), "utf8"));
        if (report.schema !== COMPARISON_SCHEMA) continue;
      } catch {
        continue;
      }
      const assessor = report.configuration.assessor.kind === "nemotron" ? `Nemotron ${report.configuration.assessor.model}` : "deterministic rules";
      const key = [scenario.name, report.fingerprint, report.kind, report.configuration.evidence.mode, assessor].join("|");
      groups.set(key, [...(groups.get(key) ?? []), report]);
    }
  }
  return [...groups.entries()].map(([key, reports]) => {
    const [scenarioId] = key.split("|");
    reports.sort((left, right) => left.finishedAt.localeCompare(right.finishedAt));
    const sample = reports[0]!;
    const tally = (side: "speck" | "stateless", stageIndex: number) => {
      const conclusions: Record<string, number> = {};
      let committed = 0, abstained = 0, errors = 0, supportFromReplaced = 0, unknownCitations = 0, recordsWhy = 0, matches = 0, unsupported = 0, labelled = 0;
      for (const report of reports) {
        const stage = report.stages[stageIndex];
        if (!stage) continue;
        const checks = stage.checks[side];
        const outcome = side === "speck" ? stage.speck : stage.stateless;
        const concluded = outcome.concluded ?? "none";
        conclusions[concluded] = (conclusions[concluded] ?? 0) + 1;
        if (outcome.error) errors += 1;
        if (checks.commits) committed += 1;
        if (checks.abstains) abstained += 1;
        if (checks.supportFromReplaced.length) supportFromReplaced += 1;
        if (checks.unknownCitations.length) unknownCitations += 1;
        if (checks.recordsWhy) recordsWhy += 1;
        if (stage.label) {
          labelled += 1;
          if (stage.label[side].correct) matches += 1;
          if (stage.label[side].unsupportedClaim) unsupported += 1;
        }
      }
      return { committed, abstained, errors, supportFromReplaced, unknownCitations, recordsWhy, matchesLabel: labelled ? matches : null, unsupportedClaims: labelled ? unsupported : null, conclusions };
    };
    return {
      scenarioId: scenarioId!,
      title: sample.case.title,
      kind: sample.kind,
      evidence: sample.configuration.evidence.mode === "zetaris" ? "Zetaris live" : "fixture file",
      assessor: sample.configuration.assessor.kind === "nemotron" ? `Nemotron ${sample.configuration.assessor.model}` : "deterministic rules",
      samples: reports.length,
      first: reports[0]!.finishedAt,
      last: reports.at(-1)!.finishedAt,
      stages: sample.stages.map((stage, index) => ({
        stage: stage.stage.label,
        label: stage.label ? stage.label.checkpoint.conclusion ?? "no conclusion justified" : null,
        approaches: { speck: tally("speck", index), stateless: tally("stateless", index) }
      }))
    };
  }).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId) || left.kind.localeCompare(right.kind));
}
