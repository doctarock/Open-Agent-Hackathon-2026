import type { ActorInput, EvidenceRelation, MentalObject, MentalObjectId } from "#speck";
import { byObservation } from "../evidence/types.js";
import { describeInvalidation, isPrefix, type BeliefBasis, type PlannedRelation } from "./basis.js";
import { appliedRelations, round, type AppliedRelation, type CaseHandle } from "./case-state.js";
import { RECOMPUTE_SCHEMA, type AssessedEvidence, type Recomputation } from "./records.js";
import { retireHypothesis } from "./speck-compat.js";

export interface ReconcileInput {
  correlationId: string;
  trigger: string;
  inFlight?: readonly AssessedEvidence[];
  newRecords?: ReadonlySet<string>;
  // Repairing state left by an interruption rather than responding to a change.
  recovery?: boolean;
}

// Reconciliation: makes Speck's current hypotheses equal a replay of the
// evidence and judgments that still count (basis.ts). A hypothesis whose
// applied relations are the start of its plan is extended. Any other is
// replaced: a new hypothesis from the scenario prior, the whole plan replayed
// through Speck's own revision, and the old one marked superseded. On
// consistent state it does nothing.
//
// Why it is built this way:
// - Rebuild, because revision cannot be undone. Speck's belief revision is
//   incremental: each relation moves the stored confidence by an amount that
//   depends on the confidence at that moment. When a record later stops
//   counting (its source supersedes it, or the investigator withdraws it),
//   its effect cannot be subtracted exactly. So every hypothesis it touched is
//   rebuilt from its prior with only the relations that still count. This is
//   what lets a corrected case end where it would have ended had the wrong
//   record never arrived.
// - Speck still does every revision. The replay goes through Speck's own
//   reviseHypothesesFromEvidence, so the confidence values, statuses, caps and
//   event log are Speck's, not a reimplementation of them.
// - Nothing is erased. The replaced hypothesis stays in Speck with its full
//   revision history, marked superseded, and the recomputation record says
//   why. The page shows it as history, apart from current belief.
// - Observation order. Relations are replayed in the order things were
//   observed, not the order they were received, so a record that arrives late
//   gives the same beliefs as if it had arrived on time.
// - Extend when possible. If what has been applied is the beginning of the
//   plan, appending the rest gives the same result as a replay and keeps one
//   hypothesis object with one continuous history.
// - Idempotent, so it doubles as repair. It runs on open, at the start and end
//   of every run, after each chunk, and after a withdrawal. On consistent state
//   it writes nothing, which makes it safe to call after any interruption.
export async function reconcile(desk: CaseHandle, input: ReconcileInput): Promise<{ basis: BeliefBasis; recomputation: Recomputation | null }> {
  const { runtime, scenario } = desk;
  const state = desk.read();
  const workerId = state.worker.id;
  const ledger = state.ledger(input.inFlight);
  const basis = state.basis(input.inFlight);
  const recorded = state.recordedEvidence();
  const recordOf = new Map([...recorded].map(([recordId, objectId]) => [objectId, recordId]));
  const current = state.currentHypotheses();
  const capacity = runtime.config.beliefRevision.revisionHistoryCapacity;
  const startAt = new Map<string, number>();
  const replace: Array<{ key: string; statement: string; prior: number; previous: MentalObject; applied: AppliedRelation[] }> = [];
  for (const spec of scenario.hypotheses) {
    const hypothesis = current.get(spec.key);
    if (!hypothesis) throw new Error(`Case ${scenario.caseId} has no Speck hypothesis for ${spec.key}`);
    const applied = appliedRelations(hypothesis, recordOf);
    // Speck keeps the last `capacity` revisions; a full history may be
    // truncated and cannot be checked, so it is replayed instead.
    // Why: extending a hypothesis is only safe when its applied relations are
    // known exactly; a truncated history cannot prove that.
    if (applied.length < capacity && isPrefix(applied, basis.plan.get(spec.key)!)) startAt.set(spec.key, applied.length);
    else replace.push({ key: spec.key, statement: spec.statement, prior: spec.prior, previous: hypothesis, applied });
  }

  // Hypotheses extended with relations from records that were already in
  // the ledger: reinstated by an invalidation, or left unapplied by an
  // interrupted run. Unlike new evidence, these need explaining.
  const newRecords = input.newRecords ?? new Set<string>();
  const extended = scenario.hypotheses.flatMap((spec) => {
    if (!startAt.has(spec.key)) return [];
    const tail = basis.plan.get(spec.key)!.slice(startAt.get(spec.key));
    return tail.some((relation) => !newRecords.has(relation.recordId))
      ? [{ key: spec.key, hypothesis: current.get(spec.key)!, tail: tail.filter((relation) => !newRecords.has(relation.recordId)) }]
      : [];
  });

  const hypothesisIds = new Map([...current].map(([key, object]) => [key, object.id]));
  let recomputation: Recomputation | null = null;
  if (replace.length || extended.length) {
    const actor: ActorInput = { kind: "tool", source: "evidence-desk/recompute", correlationId: input.correlationId };
    const version = state.recomputations().length + 1;
    const entries: Recomputation["hypotheses"] = [];
    for (const item of replace) entries.push(describeReplacement(item, basis, newRecords, input.recovery === true));
    for (const item of extended) {
      const added = item.tail.map((relation) => ({ recordId: relation.recordId, direction: relation.direction, reinstated: input.recovery !== true }));
      entries.push({
        key: item.key, mode: "extended", previousId: item.hypothesis.id, replacementId: item.hypothesis.id,
        previous: { confidence: round(item.hypothesis.confidence), status: String(item.hypothesis.data.status) },
        dropped: [], added, replayed: added.map((relation) => `${relation.recordId} ${relation.direction}`),
        cause: input.recovery ? `${added.map((relation) => relation.recordId).join(", ")} applied after an interrupted run or recomputation`
          : `${[...new Set(added.map((relation) => relation.recordId))].join(", ")} count${added.length === 1 ? "s" : ""} again`
      });
    }
    recomputation = {
      schema: RECOMPUTE_SCHEMA, version, at: new Date().toISOString(), correlationId: input.correlationId,
      trigger: input.trigger, hypotheses: entries
    };
    // The record is written before anything changes, so every replacement
    // points at a record that explains it, and its version is never reused.
    // If the process stops before a replacement is made, a later
    // recomputation makes it and recomputations() shows this one as not
    // carried out.
    await runtime.recordMemory({
      workerId, type: "episodic",
      content: `Recomputation ${version}: ${entries.map((entry) => `${entry.key} (${entry.cause})`).join("; ")}`,
      data: recomputation as unknown as Record<string, unknown>, actor
    });
    for (const item of replace) {
      const replacement = await runtime.proposeHypothesis({
        workerId, content: item.statement, confidence: item.prior,
        data: { key: item.key, replaces: item.previous.id, recomputation: version }, actor
      });
      hypothesisIds.set(item.key, replacement.id);
      startAt.set(item.key, 0);
    }
  }
  retireReplaced(desk);

  // Apply each record's outstanding relations in canonical order. Each
  // hypothesis's revisions depend only on its own sequence, so this equals
  // replaying every plan from the start.
  const outstanding = new Map<string, EvidenceRelation[]>();
  for (const [key, plan] of basis.plan) {
    for (const relation of plan.slice(startAt.get(key))) {
      const list = outstanding.get(relation.recordId) ?? [];
      list.push({ hypothesisId: hypothesisIds.get(key)!, direction: relation.direction, strength: relation.strength, decisive: relation.decisive });
      outstanding.set(relation.recordId, list);
    }
  }
  for (const entry of [...ledger].sort((left, right) => byObservation(left.record, right.record))) {
    const relations = outstanding.get(entry.record.id);
    if (!relations) continue;
    const evidenceId = recorded.get(entry.record.id)! as MentalObjectId;
    const evidence = state.object(evidenceId)!;
    // Why the original actor: a replayed model judgment is recorded as the
    // model's again, so Speck keeps applying its cap on model-judged evidence
    // and its event log still says who made the judgment.
    await runtime.reviseHypothesesFromEvidence({
      workerId, evidenceId, relations,
      actor: evidence.provenance.kind === "model"
        ? { kind: "model", source: evidence.provenance.source, correlationId: input.correlationId }
        : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: input.correlationId }
    });
  }
  return { basis, recomputation };
}

// A replaced hypothesis is marked superseded in Speck, the way Speck's own
// mind component retires a contradicted fact. It keeps its revision
// history and the status it had reached, for the audit trail.
// Why "superseded": it is the one hypothesis status Speck treats as terminal,
// so no later evidence can revive a belief that has been rebuilt elsewhere.
function retireReplaced(desk: CaseHandle): void {
  const state = desk.read();
  const all = state.allHypotheses();
  const current = new Set([...state.currentHypotheses().values()].map((object) => object.id));
  const now = new Date().toISOString();
  for (const object of all) {
    if (current.has(object.id) || object.data.status === "superseded") continue;
    const replacement = all.find((other) => other.data.replaces === object.id);
    retireHypothesis(desk.runtime, object.id, replacement?.id ?? null, now);
  }
}

function describeReplacement(
  item: { key: string; previous: MentalObject; applied: AppliedRelation[] },
  basis: BeliefBasis,
  newRecords: ReadonlySet<string>,
  recovery: boolean
): Recomputation["hypotheses"][number] {
  const plan = basis.plan.get(item.key)!;
  const same = (left: AppliedRelation, right: AppliedRelation | PlannedRelation) => left.recordId === right.recordId && left.direction === right.direction;
  const dropped = item.applied.filter((applied) => !plan.some((planned) => same(applied, planned))).map((applied) => {
    const invalidation = basis.invalid.get(applied.recordId);
    const withheld = basis.withheld.find((entry) => entry.recordId === applied.recordId && entry.hypothesisKey === item.key);
    const reason = invalidation ? describeInvalidation(applied.recordId, invalidation)
      : withheld ? `support withheld: ${withheld.refutedBy} refutes ${item.key} decisively`
      : "no longer judged to bear on it";
    return { ...applied, reason };
  });
  const added = plan.filter((planned) => !item.applied.some((applied) => same(applied, planned)))
    .map((planned) => ({ recordId: planned.recordId, direction: planned.direction, reinstated: !recovery && !newRecords.has(planned.recordId) }));
  const reinstated = added.filter((entry) => entry.reinstated);
  const cause = dropped.length ? dropped.map((entry) => entry.reason).join("; ")
    : reinstated.length ? `${reinstated.map((entry) => entry.recordId).join(", ")} count${reinstated.length === 1 ? "s" : ""} again`
    : recovery ? "applied after an interrupted run or recomputation"
    : "evidence observed earlier arrived later; replayed in observation order";
  return {
    key: item.key, mode: "replaced", previousId: item.previous.id, replacementId: null,
    previous: { confidence: round(item.previous.confidence), status: String(item.previous.data.status) },
    dropped, added, replayed: plan.map((planned) => `${planned.recordId} ${planned.direction}`), cause
  };
}

// Run notes for what the basis did to a chunk's evidence.
// Why notes: a withheld judgment or a rebuilt belief changes the outcome
// without any new evidence being visible on the page; the run says so in
// plain words rather than leaving the change unexplained.
export function revisionNotes(basis: BeliefBasis, recomputation: Recomputation | null, recordedNow: ReadonlySet<string>): string[] {
  const notes = basis.withheld
    .filter((entry) => recordedNow.has(entry.recordId) || recordedNow.has(entry.refutedBy))
    .map((entry) => `Withheld from Speck: ${entry.recordId} supports ${entry.hypothesisKey} (${entry.basis}), which ${entry.refutedBy} refutes decisively.`);
  for (const entry of recomputation?.hypotheses ?? []) {
    notes.push(entry.mode === "extended"
      ? `Revised ${entry.key} (was ${entry.previous.status} ${entry.previous.confidence}): ${entry.cause}.`
      : `Recomputed ${entry.key} from its prior (was ${entry.previous.status} ${entry.previous.confidence}): ${entry.cause}.`);
  }
  return notes;
}
