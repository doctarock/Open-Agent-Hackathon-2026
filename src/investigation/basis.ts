import { byObservation, type EvidenceRecord } from "../evidence/types.js";
import type { RelationJudgment } from "../reasoning/types.js";

// The basis of belief: which assessed evidence and which judgments currently
// count. This is derived from the ledger every time, never stored, so
// withdrawing or superseding a record changes the basis for every belief that
// rested on it. The desk then makes Speck's current hypotheses equal a replay
// of this basis (reconcile.ts).
//
// Three dependencies are tracked, all stated by the data:
// - a record stops counting when a valid record says it supersedes it, or
//   when it is withdrawn;
// - a record stops counting when the same source system later reports a new
//   value for every fact it reported (restated);
// - support for a hypothesis is withheld while a valid decisive contradiction
//   refutes it (nothing short of invalidating the refutation revives it).
//
// Why it is built this way:
// - Pure. No Speck, no model, no I/O: the same ledger always gives the same
//   basis, and the rules can be tested exhaustively on their own.
// - Replacement comes from the source, never from a heuristic or a model. A
//   source replaces a record in one of two ways: by naming it
//   (provenance.supersedes), or by reporting a newer value for every fact it
//   reported (a ledger that marked an invoice paid and now reports it
//   reopened). Both are read from the source's own structured fields.
//   Similar content, a later time alone, or a model's reading never replace
//   anything. Build 3 accepted only the first; the bank return showed the
//   second matters (docs/build-4-bank-return.md): the ledger's old "paid"
//   status kept counting against the invoice being unpaid.
// - A named replacement holds whatever the timestamps. A record id in
//   supersedes is unambiguous, and a backfilled record can be stamped later
//   than the correction that names it.
// - A decisive refutation is final. In Speck only "superseded" is terminal:
//   later support moves a "rejected" hypothesis back to active. That happened
//   in a live run, where a model judgment revived "delivered" after the
//   carrier's correction had refuted it. So support for a decisively refuted
//   hypothesis is withheld here. It is kept, not deleted, and applies again if
//   the refuting record is itself later invalidated.
// - Canonical order. The plan is sorted by observation time, then record id,
//   so the replay is identical whatever order records arrived in.

export interface LedgerEntry {
  record: EvidenceRecord;
  // The reasoner's judgments as given, before any withholding.
  judgments: readonly RelationJudgment[];
  withdrawn: { reason: string; at: string } | null;
}

export type Invalidation =
  | { kind: "superseded"; by: string }
  | { kind: "withdrawn"; reason: string; at: string }
  // Every fact the record reported, with the later value its own source
  // system now reports for it.
  | { kind: "restated"; by: string; facts: Array<{ fact: string; was: string; now: string; recordId: string }> };

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
  const invalid = deriveValidity(ordered);
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

// Which records no longer count, from the records and withdrawals alone.
// `ordered` is in observation order.
//
// 1. Declared replacement. A record is replaced when a record that still
//    counts names it in supersedes, whatever their timestamps. Chains
//    resolve: a withdrawn or replaced correction replaces nothing, so the
//    record it named counts again. Where declarations form a cycle, a claim
//    by the older record against the newer one is ignored, which leaves no
//    cycle. The earliest valid record naming it is reported.
// 2. Restatement, among the records still counting. A record is restated
//    when a strictly later record from the same source system reports every
//    fact it reported and at least one value differs.
//    - Different systems never restate each other: a cycle count does not
//      replace a warehouse figure, it disagrees with it.
//    - The same value again changes nothing, so the older record counts.
//    - A correction (a record that itself names records it replaces) is
//      replaced only by being named or withdrawn. Why: restating it would
//      also undo the replacement it declared, which the source never said.
//    - Records without facts are never restated.
export function deriveValidity(ordered: readonly LedgerEntry[]): Map<string, Invalidation> {
  const invalid = new Map<string, Invalidation>();
  const position = new Map(ordered.map((entry, index) => [entry.record.id, index]));
  const claims = new Map<string, string[]>(ordered.map((entry) => [entry.record.id, entry.record.provenance.supersedes.filter((target) => target !== entry.record.id && position.has(target))]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const id = queue.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...claims.get(id)!);
    }
    return false;
  };
  // Target -> the records whose claim on it stands, earliest first.
  const claimants = new Map<string, string[]>();
  for (const entry of ordered) {
    const id = entry.record.id;
    for (const target of claims.get(id)!) {
      if (position.get(id)! < position.get(target)! && reaches(target, id)) continue;
      claimants.set(target, [...(claimants.get(target) ?? []), id]);
    }
  }
  const byId = new Map(ordered.map((entry) => [entry.record.id, entry]));
  const settled = new Map<string, boolean>();
  const counts = (id: string): boolean => {
    if (settled.has(id)) return settled.get(id)!;
    const entry = byId.get(id)!;
    let result = true;
    if (entry.withdrawn) {
      invalid.set(id, { kind: "withdrawn", ...entry.withdrawn });
      result = false;
    } else {
      const by = (claimants.get(id) ?? []).find(counts);
      if (by) {
        invalid.set(id, { kind: "superseded", by });
        result = false;
      }
    }
    settled.set(id, result);
    return result;
  };
  for (const entry of ordered) counts(entry.record.id);

  // Newest first, so the value each system now reports is known before the
  // records it may restate are reached.
  const latest = new Map<string, { value: string; recordId: string; observedAt: number }>();
  const slot = (system: string, fact: string) => `${system}\u0000${fact}`;
  for (const entry of [...ordered].reverse()) {
    const { record } = entry;
    if (invalid.has(record.id)) continue;
    const facts = Object.entries(record.facts);
    const observedAt = Date.parse(record.observedAt);
    if (facts.length && !record.provenance.supersedes.length) {
      const later = facts.map(([fact, value]) => ({ fact, was: value, newer: latest.get(slot(record.source.system, fact)) }));
      if (later.every((item) => item.newer && item.newer.observedAt > observedAt) && later.some((item) => item.newer!.value !== item.was)) {
        const changed = later.filter((item) => item.newer!.value !== item.was);
        invalid.set(record.id, {
          kind: "restated",
          by: changed.map((item) => item.newer!).sort((left, right) => right.observedAt - left.observedAt)[0]!.recordId,
          facts: later.map((item) => ({ fact: item.fact, was: item.was, now: item.newer!.value, recordId: item.newer!.recordId }))
        });
        continue;
      }
    }
    for (const [fact, value] of facts) {
      const key = slot(record.source.system, fact);
      if (!latest.has(key)) latest.set(key, { value, recordId: record.id, observedAt });
    }
  }
  return invalid;
}

// Whether the relations already applied to a hypothesis are the start of its
// plan, so the rest can be appended instead of replaying from the prior.
// Why it is safe: Speck's revision depends only on a hypothesis's own sequence
// of relations, so applying a prefix and then the rest equals applying it all.
export function isPrefix(applied: ReadonlyArray<{ recordId: string; direction: string }>, plan: readonly PlannedRelation[]): boolean {
  return applied.length <= plan.length
    && applied.every((item, index) => item.recordId === plan[index]!.recordId && item.direction === plan[index]!.direction);
}

export function describeInvalidation(recordId: string, invalidation: Invalidation): string {
  if (invalidation.kind === "superseded") return `${recordId} superseded by ${invalidation.by}`;
  if (invalidation.kind === "restated") {
    return `${recordId} out of date: its source now reports ${invalidation.facts.map((item) => `${item.fact}=${item.now} (${item.recordId}, was ${item.was})`).join(", ")}`;
  }
  return `${recordId} withdrawn (${invalidation.reason})`;
}
