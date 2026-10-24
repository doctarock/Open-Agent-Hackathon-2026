import type { EvalCase } from "./cases.js";
import type { CheckpointOutcome, ModelStats, SystemResult } from "./systems.js";

// Scoring. Every number is a count over the labelled checkpoints of this
// run, reported with its denominator; none is an estimate, and none is a
// general accuracy figure. Latency is wall-clock time measured per HTTP call.
// Why counts with denominators: the suites are small (a handful of cases).
// A percentage alone would suggest a precision these samples cannot give.

export interface Rate { count: number; of: number; rate: number | null }

export interface CheckpointScore {
  caseId: string;
  category: string;
  stage: string;
  expected: string | null;
  concluded: string | null;
  tentative: string | null;
  error: string | null;
  correct: boolean;
  unsupportedClaim: boolean;
  invalidCitations: string[];
  forbiddenCited: string[];
  presentedRefuted: string[];
  // Records labelled as no longer counting that still support what is presented.
  staleSupport: string[];
  explanationAgrees: boolean | null;
  executionStatus: string | null;
}

export interface SystemScore {
  system: string;
  checkpoints: CheckpointScore[];
  metrics: {
    // Conclusion equals the label (abstaining counts as concluding null).
    correctness: Rate;
    validCitations: Rate;
    // Conclusions the evidence does not support, or backed by no valid citation.
    unsupportedClaims: Rate;
    // Checkpoints with refuted or superseded hypotheses where none of them
    // was presented as current or favoured.
    correctionHandling: Rate;
    // Checkpoints with withdrawn or superseded records (regression cases)
    // where none of them supports what is presented as current or favoured.
    invalidatedExcluded: Rate;
    // Checkpoints labelled "abstain" where the system abstained.
    appropriateAbstention: Rate;
    // Checkpoints labelled with a conclusion where the system abstained.
    overAbstention: Rate;
    // Cases whose evidence provider fails: error surfaced, nothing concluded.
    failureSurfaced: Rate;
    explanationAgreement: Rate;
    model: null | {
      httpCalls: number;
      answered: Rate;
      contractValid: Rate;
      latencyMs: { mean: number; median: number; max: number } | null;
      servedModels: string[];
    };
  };
}

const rate = (count: number, of: number): Rate => ({ count, of, rate: of ? Math.round((count / of) * 1000) / 1000 : null });

export function scoreSystem(system: string, results: Array<{ item: EvalCase; result: SystemResult }>): SystemScore {
  const checkpoints: CheckpointScore[] = [];
  let citationsTotal = 0;
  let citationsValid = 0;
  for (const { item, result } of results) {
    item.checkpoints.forEach((label, index) => {
      const outcome: CheckpointOutcome = result.checkpoints[index]!;
      const visible = new Set(outcome.visibleEvidence);
      const invalid = outcome.citations.filter((id) => !visible.has(id));
      citationsTotal += outcome.citations.length;
      citationsValid += outcome.citations.length - invalid.length;
      const supportValid = outcome.supportCitations.filter((id) => visible.has(id));
      const concluded = outcome.conclusion;
      checkpoints.push({
        caseId: item.id, category: item.category, stage: label.afterStage,
        expected: item.expectError ? `error:${item.expectError}` : label.conclusion,
        concluded, tentative: outcome.tentative, error: outcome.error,
        correct: item.expectError
          ? Boolean(outcome.error?.startsWith(`${item.expectError}:`)) && concluded === null
          : !outcome.error && concluded === label.conclusion,
        unsupportedClaim: concluded !== null && (label.unsupported.includes(concluded) || supportValid.length === 0),
        invalidCitations: invalid,
        forbiddenCited: outcome.citations.filter((id) => item.forbiddenCitations.includes(id)),
        presentedRefuted: outcome.presentedAsCurrent.filter((key) => label.notCurrent.includes(key)),
        staleSupport: outcome.presentedSupport.filter((id) => (label.invalidated ?? []).includes(id)),
        explanationAgrees: outcome.explanationAgrees,
        executionStatus: outcome.executionStatus
      });
    });
  }
  const normal = checkpoints.filter((score) => !score.expected?.startsWith("error:"));
  const failures = checkpoints.filter((score) => score.expected?.startsWith("error:"));
  const withRefuted = results.flatMap(({ item }) => item.expectError ? [] : item.checkpoints.map((label) => label.notCurrent.length > 0));
  const withInvalidated = results.flatMap(({ item }) => item.expectError ? [] : item.checkpoints.map((label) => (label.invalidated ?? []).length > 0));
  const committed = normal.filter((score) => score.concluded !== null);
  const abstainLabels = normal.filter((score) => score.expected === null);
  const concludeLabels = normal.filter((score) => score.expected !== null);
  const explained = checkpoints.filter((score) => score.explanationAgrees !== null);
  return {
    system,
    checkpoints,
    metrics: {
      correctness: rate(normal.filter((score) => score.correct).length, normal.length),
      validCitations: rate(citationsValid, citationsTotal),
      unsupportedClaims: rate(committed.filter((score) => score.unsupportedClaim).length, committed.length),
      correctionHandling: rate(normal.filter((score, index) => withRefuted[index] && score.presentedRefuted.length === 0).length, withRefuted.filter(Boolean).length),
      invalidatedExcluded: rate(normal.filter((score, index) => withInvalidated[index] && score.staleSupport.length === 0).length, withInvalidated.filter(Boolean).length),
      appropriateAbstention: rate(abstainLabels.filter((score) => score.concluded === null && !score.error).length, abstainLabels.length),
      overAbstention: rate(concludeLabels.filter((score) => score.concluded === null).length, concludeLabels.length),
      failureSurfaced: rate(failures.filter((score) => score.correct).length, failures.length),
      explanationAgreement: rate(explained.filter((score) => score.explanationAgrees).length, explained.length),
      model: modelMetrics(results.map(({ result }) => result.model))
    }
  };
}

function modelMetrics(stats: Array<ModelStats | null>): SystemScore["metrics"]["model"] {
  const present = stats.filter((item): item is ModelStats => item !== null);
  if (!present.length) return null;
  const calls = present.flatMap((item) => item.httpCalls);
  const latencies = calls.map((call) => call.latencyMs).sort((left, right) => left - right);
  return {
    httpCalls: calls.length,
    answered: rate(calls.filter((call) => call.answered).length, calls.length),
    contractValid: rate(present.reduce((sum, item) => sum + item.contractValid, 0), present.reduce((sum, item) => sum + item.contractAttempts, 0)),
    latencyMs: latencies.length ? {
      mean: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      median: latencies[Math.floor((latencies.length - 1) / 2)]!,
      max: latencies.at(-1)!
    } : null,
    servedModels: [...new Set(present.flatMap((item) => item.servedModels))]
  };
}
