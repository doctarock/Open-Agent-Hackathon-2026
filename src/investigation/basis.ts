import { byObservation, type EvidenceRecord } from "../evidence/types.js";
import type { RelationJudgment } from "../reasoning/types.js";

// Which assessed evidence and which judgments currently count. This is
// derived from the ledger every time, never stored, so withdrawing or
// superseding a record changes the basis for every belief that rested on it.
// The desk then makes Speck's current hypotheses equal a replay of this basis.
//
// Two dependencies are tracked, both stated by the data:
// - a record stops counting when a valid later record says it supersedes it,
//   or when it is withdrawn;
// - support for a hypothesis is withheld while a valid decisive contradiction
//   refutes it (nothing short of invalidating the refutation revives it).

export interface LedgerEntry {
  record: EvidenceRecord;
  // The reasoner's judgments as given, before any withholding.
  judgments: readonly RelationJudgment[];
  withdrawn: { reason: string; at: string } | null;
}

export type Invalidation =
  | { kind: "superseded"; by: string }
  | { kind: "withdrawn"; reason: string; at: string };

export interface PlannedRelation {
  recordId: string;
  direction: RelationJudgment["direction"];
  strength: number;
  decisive: boolean;
}

export interface WithheldRelation {
  recordId: string;
  hypothesisKey: string;
  basis: RelationJudgment["basis"];
  refutedBy: string;
}

export interface BeliefBasis {
  // Record id -> why it no longer counts. Records not listed count.
  invalid: Map<string, Invalidation>;
  // Hypothesis key -> the relations that take effect, in canonical order
  // (observation time, then record id), whatever order they arrived in.
  plan: Map<string, PlannedRelation[]>;
  withheld: WithheldRelation[];
  // Hypothesis key -> the valid record that refutes it decisively.
  refutedBy: Map<string, string>;
}

export function deriveBasis(entries: readonly LedgerEntry[], hypothesisKeys: readonly string[]): BeliefBasis {
  const ordered = [...entries].sort((left, right) => byObservation(left.record, right.record));

  // Newest first, so a record's validity is settled before the claims it
  // makes about older records are honoured. A superseded or withdrawn
  // correction therefore supersedes nothing, and a claim about a later
  // record is ignored.
  const invalid = new Map<string, Invalidation>();
  const supersededBy = new Map<string, string>();
  for (const entry of [...ordered].reverse()) {
    const id = entry.record.id;
    if (entry.withdrawn) invalid.set(id, { kind: "withdrawn", ...entry.withdrawn });
    else if (supersededBy.has(id)) invalid.set(id, { kind: "superseded", by: supersededBy.get(id)! });
    if (invalid.has(id)) continue;
    // Overwritten as older superseders are reached: the earliest one is named.
    for (const target of entry.record.provenance.supersedes) supersededBy.set(target, id);
  }

  const valid = ordered.filter((entry) => !invalid.has(entry.record.id));
  const keys = new Set(hypothesisKeys);
  const refutedBy = new Map<string, string>();
  for (const entry of valid) {
    for (const judgment of entry.judgments) {
      if (judgment.decisive && judgment.direction === "contradicts" && !refutedBy.has(judgment.hypothesisKey)) refutedBy.set(judgment.hypothesisKey, entry.record.id);
    }
  }

  const plan = new Map<string, PlannedRelation[]>(hypothesisKeys.map((key) => [key, []]));
  const withheld: WithheldRelation[] = [];
  for (const entry of valid) {
    for (const judgment of entry.judgments) {
      if (!keys.has(judgment.hypothesisKey)) continue;
      const refuter = refutedBy.get(judgment.hypothesisKey);
      if (judgment.direction === "supports" && refuter) {
        withheld.push({ recordId: entry.record.id, hypothesisKey: judgment.hypothesisKey, basis: judgment.basis, refutedBy: refuter });
        continue;
      }
      plan.get(judgment.hypothesisKey)!.push({
        recordId: entry.record.id, direction: judgment.direction, strength: judgment.strength, decisive: judgment.decisive
      });
    }
  }
  return { invalid, plan, withheld, refutedBy };
}

// Whether the relations already applied to a hypothesis are the start of its
// plan, so the rest can be appended instead of replaying from the prior.
export function isPrefix(applied: ReadonlyArray<{ recordId: string; direction: string }>, plan: readonly PlannedRelation[]): boolean {
  return applied.length <= plan.length
    && applied.every((item, index) => item.recordId === plan[index]!.recordId && item.direction === plan[index]!.direction);
}

export function describeInvalidation(recordId: string, invalidation: Invalidation): string {
  return invalidation.kind === "superseded"
    ? `${recordId} superseded by ${invalidation.by}`
    : `${recordId} withdrawn (${invalidation.reason})`;
}
