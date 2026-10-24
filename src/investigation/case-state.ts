import type { CognitiveEvent, MentalObject, SpeckRuntime, Worker } from "#speck";
import { byObservation, type EvidenceRecord } from "../evidence/types.js";
import type { Scenario, StageSpec } from "../scenario.js";
import { deriveBasis, isPrefix, type BeliefBasis, type LedgerEntry } from "./basis.js";
import { deriveConclusion, type Conclusion, type HypothesisView } from "./conclusion.js";
import {
  ASSESSMENT_SCHEMA, EXCLUSION_SCHEMA, RECOMPUTE_SCHEMA, RUN_SCHEMA, STAGE_KEY,
  type AssessedEvidence, type AssessmentAttempt, type AssessmentStatus, type EvidenceListing, type Exclusion,
  type JudgmentEffect, type Recomputation, type ReplacedHypothesis, type RunSnapshot
} from "./records.js";
import { buildTimeline, type TimelineEntry } from "./timeline.js";

// What the modules that change a case need from it (EvidenceDesk): Speck's
// runtime, the scenario, and a fresh read of the case's state.
export interface CaseHandle {
  readonly runtime: SpeckRuntime;
  readonly scenario: Scenario;
  read(): CaseState;
}

type AttemptEntry = { runId: string; at: string; item: AssessedEvidence | null; error: string | null };

// One read of a case's state in Speck: the worker's objects, listed once, and
// everything derived from them (the ledger, the basis of current beliefs, the
// conclusion), each worked out at most once. A read is a snapshot: after
// changing the case, take a new one. A request that shows several views of
// the case reads them all from one snapshot, so they agree with each other.
export class CaseState {
  private readonly memo = new Map<string, unknown>();

  constructor(readonly runtime: SpeckRuntime, readonly scenario: Scenario, readonly worker: Worker) {}

  private once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  get objects(): readonly MentalObject[] {
    return this.once("objects", () => this.runtime.mentalObjects.listForWorker(this.worker.id));
  }

  object(id: string): MentalObject | undefined {
    return this.once("byId", () => new Map(this.objects.map((object) => [object.id as string, object]))).get(id);
  }

  private stored<T>(schema: string): T[] {
    return this.objects.filter((object) => object.data.schema === schema).map((object) => object.data as unknown as T);
  }

  currentStage(): StageSpec {
    const id = this.worker.worldState[STAGE_KEY]?.value;
    return this.scenario.stages.find((stage) => stage.id === id) ?? this.scenario.stages[0]!;
  }

  nextStage(): StageSpec | null {
    const index = this.scenario.stages.findIndex((stage) => stage.id === this.currentStage().id);
    return this.scenario.stages[index + 1] ?? null;
  }

  // At its starting state: the first stage, and nothing in Speck but the
  // proposed hypotheses (no evidence, judgments, runs or withdrawals).
  atStart(): boolean {
    return this.worker.worldState[STAGE_KEY]?.value === this.scenario.stages[0]!.id
      && this.objects.length === this.scenario.hypotheses.length
      && this.objects.every((object) => object.kind === "hypothesis");
  }

  runs(): RunSnapshot[] {
    return this.once("runs", () => this.stored<RunSnapshot>(RUN_SCHEMA).sort((left, right) => left.runNumber - right.runNumber));
  }

  // Records withdrawn before assessment, by record id.
  exclusions(): Map<string, Exclusion> {
    return this.once("exclusions", () => new Map(this.stored<Exclusion>(EXCLUSION_SCHEMA).map((exclusion) => [String(exclusion.recordId), exclusion])));
  }

  // Record id -> Speck evidence object id, for evidence already in the ledger.
  recordedEvidence(): Map<string, string> {
    return this.once("recorded", () => {
      const recorded = new Map<string, string>();
      for (const object of this.objects) if (object.kind === "evidence") recorded.set(recordIdOf(object), object.id);
      return recorded;
    });
  }

  // How many records are in Speck's evidence ledger for the case.
  recordedCount(): number {
    return this.recordedEvidence().size;
  }

  // Recomputation records, each with its replacements resolved: the record is
  // written before the replacements are made, so an interruption can leave
  // one not carried out (a later recomputation then redoes it).
  recomputations(): Recomputation[] {
    return this.once("recomputations", () => {
      const hypotheses = this.allHypotheses();
      return this.stored<Recomputation>(RECOMPUTE_SCHEMA)
        .map((record) => ({
          ...record,
          hypotheses: record.hypotheses.map((entry) => {
            if (entry.mode === "extended") return { ...entry, carriedOut: true };
            const replacement = hypotheses.find((object) => object.data.replaces === entry.previousId && object.data.recomputation === record.version);
            // Records written before Build 3.1 name their replacement directly.
            const replacementId = replacement?.id ?? entry.replacementId ?? null;
            return { ...entry, replacementId, carriedOut: replacementId !== null };
          })
        }))
        .sort((left, right) => left.version - right.version);
    });
  }

  allHypotheses(): MentalObject[] {
    return this.once("hypotheses", () => this.objects
      .filter((object) => object.kind === "hypothesis")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  // The current hypothesis for each key: the one no other hypothesis
  // replaces. Every view of current belief reads only these.
  currentHypotheses(): Map<string, MentalObject> {
    return this.once("current", () => {
      const all = this.allHypotheses();
      const replaced = new Set(all.flatMap((object) => (object.data.replaces ? [String(object.data.replaces)] : [])));
      const current = new Map<string, MentalObject>();
      for (const object of all) if (!replaced.has(object.id)) current.set(String(object.data.key), object);
      return current;
    });
  }

  replacedHypotheses(): ReplacedHypothesis[] {
    const current = new Set([...this.currentHypotheses().values()].map((object) => object.id));
    const replacedBy = new Map(this.allHypotheses().flatMap((object) => (object.data.replaces ? [[String(object.data.replaces), object] as const] : [])));
    return this.allHypotheses().filter((object) => !current.has(object.id)).map((object) => ({
      key: String(object.data.key), id: object.id, statement: object.content, confidence: round(object.confidence),
      statusWhenReplaced: String(object.data.statusWhenReplaced ?? object.data.status),
      supersededBy: object.data.supersededBy ? String(object.data.supersededBy) : null,
      recomputation: Number(replacedBy.get(object.id)?.data.recomputation) || null
    // In the order they were replaced, then by key: creation times can tie.
    })).sort((left, right) => (left.recomputation ?? 0) - (right.recomputation ?? 0) || left.key.localeCompare(right.key));
  }

  rankedCurrent(): MentalObject[] {
    return this.once("ranked", () => {
      const current = new Set([...this.currentHypotheses().values()].map((object) => object.id));
      return this.runtime.rankHypotheses(this.worker.id).filter((object) => current.has(object.id));
    });
  }

  // Record id -> every attempt to assess it, oldest first: the per-chunk
  // assessments saved in Speck, and the run snapshots of runs that predate
  // them.
  assessmentHistory(): Map<string, AttemptEntry[]> {
    return this.once("attempts", () => {
      const attempts = this.stored<AssessmentAttempt>(ASSESSMENT_SCHEMA);
      const covered = new Set(attempts.map((attempt) => attempt.runId));
      const legacy = this.runs().filter((run) => !covered.has(run.runId))
        .map((run): AssessmentAttempt => ({ schema: ASSESSMENT_SCHEMA, runId: run.runId, at: run.finishedAt, judged: run.assessed, failed: [] }));
      const history = new Map<string, AttemptEntry[]>();
      const add = (recordId: string, entry: AttemptEntry) => {
        history.set(recordId, [...(history.get(recordId) ?? []), entry]);
      };
      for (const attempt of [...legacy, ...attempts].sort((left, right) => left.at.localeCompare(right.at))) {
        for (const item of attempt.judged) add(item.record.id, { runId: attempt.runId, at: attempt.at, item, error: null });
        for (const item of attempt.failed) add(item.record.id, { runId: attempt.runId, at: attempt.at, item: null, error: item.error });
      }
      return history;
    });
  }

  // Every record in Speck's evidence ledger for the case, with the judgments
  // saved for it and whether it has been withdrawn. A record in the ledger
  // with no saved judgments (possible only in a database written before
  // judgments were saved per chunk) counts for nothing; the listing marks it
  // failed rather than letting it pass as "no bearing".
  // inFlight: judgments of the run in progress, which take precedence.
  ledger(inFlight: readonly AssessedEvidence[] = []): LedgerEntry[] {
    const make = () => {
      const history = this.assessmentHistory();
      const inFlightById = new Map(inFlight.map((item) => [item.record.id, item]));
      const entries: LedgerEntry[] = [];
      for (const object of this.objects) {
        if (object.kind !== "evidence") continue;
        const recordId = recordIdOf(object);
        const item = inFlightById.get(recordId) ?? [...(history.get(recordId) ?? [])].reverse().find((attempt) => attempt.item)?.item;
        if (!item) continue;
        const marker = object.data.withdrawn as { reason?: unknown; at?: unknown } | undefined;
        entries.push({
          record: item.record, judgments: item.judgments,
          withdrawn: marker ? { reason: String(marker.reason ?? ""), at: String(marker.at ?? "") } : null
        });
      }
      return entries;
    };
    return inFlight.length ? make() : this.once("ledger", make);
  }

  basis(inFlight: readonly AssessedEvidence[] = []): BeliefBasis {
    const make = () => deriveBasis(this.ledger(inFlight), this.scenario.hypotheses.map((hypothesis) => hypothesis.key));
    return inFlight.length ? make() : this.once("basis", make);
  }

  // Runs that saved assessments but no snapshot (the process stopped first),
  // and not yet reported by a later run: which of their records entered the
  // ledger and which did not.
  interruptedRuns(): Array<{ runId: string; recorded: string[]; unrecorded: string[] }> {
    const runs = this.runs();
    const finished = new Set(runs.map((run) => run.runId));
    const reported = new Set(runs.flatMap((run) => run.recovered ?? []));
    const recorded = this.recordedEvidence();
    const byRun = new Map<string, Set<string>>();
    for (const attempt of this.stored<AssessmentAttempt>(ASSESSMENT_SCHEMA)) {
      if (finished.has(attempt.runId) || reported.has(attempt.runId)) continue;
      const ids = byRun.get(attempt.runId) ?? new Set<string>();
      for (const item of attempt.judged) ids.add(item.record.id);
      byRun.set(attempt.runId, ids);
    }
    return [...byRun].map(([runId, ids]) => ({
      runId, recorded: [...ids].filter((id) => recorded.has(id)), unrecorded: [...ids].filter((id) => !recorded.has(id))
    }));
  }

  // Whether every current hypothesis carries exactly the relations its plan
  // calls for: false after an interrupted or failed reconciliation.
  beliefsReconciled(inFlight: readonly AssessedEvidence[] = []): boolean {
    const basis = this.basis(inFlight);
    const recordOf = new Map([...this.recordedEvidence()].map(([recordId, objectId]) => [objectId, recordId]));
    return [...this.currentHypotheses()].every(([key, hypothesis]) => {
      const applied = appliedRelations(hypothesis, recordOf);
      const plan = basis.plan.get(key) ?? [];
      return applied.length === plan.length && isPrefix(applied, plan);
    });
  }

  // Speck's current belief state as a conclusion.
  conclusion(inFlight: readonly AssessedEvidence[] = []): Conclusion {
    const make = () => {
      const ledger = this.ledger(inFlight);
      // Every record in Speck's ledger, including any from a run interrupted
      // before its snapshot was saved.
      const records = ledger.map((entry) => entry.record).sort(byObservation);
      const byRecordId = new Map(ledger.map((entry) => [entry.record.id, entry]));
      const objectToRecord = new Map<string, string>();
      for (const [recordId, objectId] of this.recordedEvidence()) objectToRecord.set(objectId, recordId);
      const { supportedThreshold, supportBonus, modelReliabilityCeiling } = this.runtime.config.beliefRevision;
      const conclusion = deriveConclusion({
        ranked: this.rankedCurrent(),
        assessed: records,
        evidenceFor: (objectId, hypothesisKey) => {
          const entry = byRecordId.get(objectToRecord.get(objectId) ?? "");
          const object = this.object(objectId);
          return entry && object ? {
            record: entry.record,
            reliability: Number(object.data.reliability ?? 0.5),
            judgedBy: object.provenance.kind === "model" ? "model" : "rules",
            judgment: entry.judgments.find((judgment) => judgment.hypothesisKey === hypothesisKey)
          } : undefined;
        },
        questions: this.scenario.questions,
        belief: { supportedThreshold, supportBonus, modelReliabilityCeiling },
        invalidated: this.basis(inFlight).invalid,
        judgmentsFor: (recordId) => byRecordId.get(recordId)?.judgments ?? []
      });
      // Never present beliefs that lag the ledger as if they were current.
      if (!this.beliefsReconciled(inFlight)) {
        conclusion.reconciled = false;
        conclusion.uncertainty.notes.unshift("Speck's current beliefs do not yet reflect every recorded judgment (a run or recomputation was interrupted). They are reconciled when the desk is next opened or run.");
      }
      return conclusion;
    };
    return inFlight.length ? make() : this.once("conclusion", make);
  }

  hypotheses(): HypothesisView[] {
    const conclusion = this.conclusion();
    return [...(conclusion.hypothesis ? [conclusion.hypothesis] : []), ...conclusion.alternatives, ...conclusion.rejected];
  }

  events(): CognitiveEvent[] {
    return this.once("events", () => {
      const events: CognitiveEvent[] = [];
      let after = 0;
      for (;;) {
        const page = this.runtime.listEvents(this.worker.id, after, 1000);
        events.push(...page);
        if (page.length < 1000) break;
        after = page[page.length - 1]!.sequence;
      }
      return events;
    });
  }

  timeline(): TimelineEntry[] {
    return buildTimeline({ events: this.events(), objects: [...this.objects], scenario: this.scenario, runs: this.runs() });
  }

  // The visible evidence, each record with how it was assessed and whether it
  // still counts.
  listing(visible: readonly EvidenceRecord[]): Pick<EvidenceListing, "records" | "pending"> {
    const recorded = this.recordedEvidence();
    const supersededBy = new Map<string, string>();
    for (const record of visible) for (const id of record.provenance.supersedes) supersededBy.set(id, record.id);
    const basis = this.basis();
    const history = this.assessmentHistory();
    const excluded = this.exclusions();
    const runNumbers = new Map(this.runs().map((run) => [run.runId, run.runNumber]));
    const records = visible.map((record) => {
      const attempts = history.get(record.id) ?? [];
      const last = attempts.at(-1) ?? null;
      // The judgments in force are the last ones saved before the record
      // entered the ledger; later attempts only happen while it is pending.
      const judged = [...attempts].reverse().find((attempt) => attempt.item);
      const inLedger = recorded.has(record.id);
      const exclusion = inLedger ? undefined : excluded.get(record.id);
      const status: AssessmentStatus = inLedger ? (judged ? "completed" : "failed") : exclusion ? "withdrawn" : last && !last.item ? "failed" : "pending";
      const assessment = inLedger && judged?.item ? {
        runNumber: runNumbers.get(judged.runId) ?? null, reliability: judged.item.reliability, recordedBy: judged.item.recordedBy,
        appliedReliability: numberOrNull(this.object(recorded.get(record.id)!)?.data.reliability),
        judgments: judged.item.judgments.map((judgment) => {
          const withheld = basis.withheld.find((entry) => entry.recordId === record.id && entry.hypothesisKey === judgment.hypothesisKey);
          const effect: JudgmentEffect = basis.invalid.has(record.id) ? "void" : withheld ? "withheld" : "applied";
          return { ...judgment, effect, refutedBy: withheld?.refutedBy ?? null };
        })
      } : null;
      return {
        ...record, assessed: inLedger, supersededBy: supersededBy.get(record.id) ?? null,
        invalidation: basis.invalid.get(record.id) ?? (exclusion ? { kind: "withdrawn" as const, reason: exclusion.reason, at: exclusion.at } : null),
        assessment,
        status,
        lastAttempt: last ? { runId: last.runId, at: last.at, outcome: last.item ? "judged" as const : "failed" as const, error: last.error ?? (inLedger && !judged ? "in Speck's ledger without saved judgments; it counts for nothing" : null) } : null
      };
    });
    return {
      records,
      pending: records.filter((record) => record.status === "pending" || record.status === "failed").map((record) => record.id)
    };
  }
}

export interface AppliedRelation { recordId: string; direction: string }

// Copies of a case after a restart carry "evidence-desk:generation=<n>".
export const GENERATION_TAG = "evidence-desk:generation=";

export function generationOf(worker: Worker): number {
  const tag = worker.objective.constraints.find((constraint) => constraint.startsWith(GENERATION_TAG));
  const value = tag ? Number(tag.slice(GENERATION_TAG.length)) : 1;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

// The relations Speck has applied to a hypothesis, in order, from its own
// revision history.
export function appliedRelations(hypothesis: MentalObject, recordOf: ReadonlyMap<string, string>): AppliedRelation[] {
  const history = Array.isArray(hypothesis.data.revisionHistory) ? hypothesis.data.revisionHistory as Array<{ evidenceId?: string; direction?: string }> : [];
  return history.map((entry) => ({ recordId: recordOf.get(String(entry.evidenceId)) ?? `unknown:${entry.evidenceId}`, direction: String(entry.direction) }));
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The evidence record a Speck evidence object was recorded for.
// Evidence is recorded with source "<system>/<record id>". A system name has
// no "/", but a record id may (ids derived from a source's own references, as
// the Zetaris USL makes them), so the id is everything after the first "/".
function recordIdOf(object: MentalObject): string {
  const source = String(object.data.source ?? "");
  return source.slice(source.indexOf("/") + 1);
}
