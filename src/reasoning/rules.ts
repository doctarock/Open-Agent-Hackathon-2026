import type { EvidenceRecord } from "../evidence/types.js";
import type { HypothesisSpec, RelationRule } from "../scenario.js";
import type { BatchAssessment, Reasoner, ReasonerDescription, RelationJudgment } from "./types.js";

// The deterministic assessor: the scenario's own fact rules, no model.
//
// Why it exists:
// - Reproducibility. Tests, the fixture evaluation and the deterministic
//   comparison need a run that gives the same result every time, with no
//   model, network or credentials.
// - Hard facts stay hard. Even when a model assesses the evidence, the
//   decisive rules are applied first and win over the model (nemotron.ts). A
//   returned payment or an amended delivery scan disproves an explanation;
//   a model should not be able to argue around it.

// The scenario's fact rules applied to one record. Where several rules for a
// hypothesis match, a decisive contradiction wins, then the strongest rule.
export function ruleJudgments(record: EvidenceRecord, hypotheses: readonly HypothesisSpec[], options: { decisiveOnly?: boolean } = {}): RelationJudgment[] {
  const judgments: RelationJudgment[] = [];
  for (const hypothesis of hypotheses) {
    const matching = hypothesis.rules
      .filter((rule) => record.facts[rule.fact] === rule.equals)
      .filter((rule) => !options.decisiveOnly || rule.decisive === true);
    const chosen = matching.find((rule) => rule.decisive)
      ?? [...matching].sort((left, right) => (right.strength ?? 1) - (left.strength ?? 1))[0];
    if (chosen) judgments.push(fromRule(hypothesis.key, chosen));
  }
  return judgments;
}

function fromRule(hypothesisKey: string, rule: RelationRule): RelationJudgment {
  return {
    hypothesisKey,
    direction: rule.direction,
    strength: rule.strength ?? 1,
    decisive: rule.decisive === true,
    basis: "rule",
    rationale: `fact ${rule.fact} = ${rule.equals}${rule.decisive ? " (decisive counter-example)" : ""}`
  };
}

// The deterministic assessor: no model, only the scenario's declared rules.
export class RuleReasoner implements Reasoner {
  readonly kind = "rules" as const;

  describe(): ReasonerDescription {
    return {
      kind: this.kind, label: "Deterministic fact rules (no model)", provider: "none",
      model: null, endpoint: null, ready: true, problem: null
    };
  }

  async assess(input: { batch: EvidenceRecord[]; hypotheses: HypothesisSpec[] }): Promise<BatchAssessment> {
    const judgments: BatchAssessment["judgments"] = {};
    const lines: string[] = [];
    for (const record of input.batch) {
      judgments[record.id] = ruleJudgments(record, input.hypotheses);
      lines.push(describeJudgments(record, judgments[record.id]!));
    }
    return { judgments, notes: [], narrative: lines.join("\n") };
  }

  usage(): null { return null; }
}

export function describeJudgments(record: EvidenceRecord, judgments: readonly RelationJudgment[]): string {
  if (!judgments.length) return `${record.id} (${record.source.name}): no bearing on any hypothesis.`;
  return `${record.id} (${record.source.name}): ${judgments.map((judgment) =>
    `${judgment.direction} ${judgment.hypothesisKey}${judgment.decisive ? " decisively" : ""} [${judgment.basis}: ${judgment.rationale}]`).join("; ")}.`;
}
