import fs from "node:fs";
import type { CognitiveEvent, MentalObject } from "#speck";
import type { FetchSummary } from "../evidence/types.js";
import type { ModelCallTrace } from "../reasoning/types.js";
import type { AssessmentAttempt, Exclusion, Recomputation, RunSnapshot } from "./desk.js";

// The execution trace: for each run, what each component actually did, read
// back from what was persisted. Nothing here is inferred or simulated:
//   evidence  - the provider's fetch summary saved with the run (each Zetaris
//               SELECT with its query token, or the fixture file)
//   Meterless - the engine's run record (id, status, chunks) saved with the run,
//               checked against the engine's own history.json
//   reasoner  - each chunk's assessment saved in Speck before its evidence was
//               recorded, with the Nemotron call trace (attempts, contract
//               rejections, served model, latency) when a model was used
//   Speck     - its event log for the run: evidence recorded, beliefs revised,
//               hypotheses rebuilt
// Evidence Desk's own steps (reconciliation, recovery, withdrawal) are
// labelled as Evidence Desk's, not as any sponsor component's.

const RUN_SCHEMA = "evidence-desk.run.v1";
const ASSESSMENT_SCHEMA = "evidence-desk.assessment.v1";
const RECOMPUTE_SCHEMA = "evidence-desk.recompute.v1";
const EXCLUSION_SCHEMA = "evidence-desk.exclusion.v1";

// Only these events are attributed by correlation id: Evidence Desk sets one
// explicitly for each of them. (Speck carries an id forward onto events that
// lack one, so other events cannot be attributed this way.)
const TRACED = new Set(["evidence.recorded", "belief.revised", "evidence.withdrawn", "memory.recorded", "hypothesis.proposed"]);

export interface Revision {
  hypothesisKey: string;
  recordId: string | null;
  from: string;
  to: string;
  // On a hypothesis that has since been replaced.
  historical: boolean;
}

export interface SpeckActivity {
  recorded: string[];
  revisions: Revision[];
  recomputations: number[];
}

export type TraceStep =
  | { kind: "reconcile"; when: "start" | "end"; by: "Evidence Desk"; speck: SpeckActivity }
  | {
      kind: "chunk";
      chunk: number;
      // Meterless's record of the step; null if the run was interrupted before the engine recorded it.
      meterless: { tokens: number; carryoverIn: boolean } | null;
      records: string[];
      failed: Array<{ recordId: string; error: string }>;
      // The Nemotron call for this chunk; null when the rule assessor (no model) judged it.
      model: ModelCallTrace | null;
      judgments: { rule: number; model: number; noBearing: string[] };
      notes: string[];
      speck: SpeckActivity;
    }
  | { kind: "explanation"; model: ModelCallTrace | null; agrees: boolean | null; problems: string[]; invalidCitations: string[] };

export interface RunTrace {
  kind: "run";
  runId: string;
  // Null for a run interrupted before it saved a snapshot.
  runNumber: number | null;
  status: RunSnapshot["execution"]["status"] | "interrupted";
  startedAt: string | null;
  finishedAt: string | null;
  evidence: {
    mode: FetchSummary["mode"];
    label: string;
    target: string;
    visible: number | null;
    sources: FetchSummary["sources"];
  } | null;
  meterless: {
    engine: string;
    runId: string;
    status: string;
    chunks: number;
    maxChunks: number;
    reflection: boolean;
    durationMs: number;
    // Whether the engine's own history.json holds this run; null if it could not be read.
    inHistory: boolean | null;
  } | null;
  reasoner: { kind: string; model: string | null; endpoint: string | null } | null;
  steps: TraceStep[];
  flags: {
    pending: string[];
    failed: string[];
    modelCalls: number;
    retries: number;
    contractFailures: number;
    invalidCitations: string[];
    recovered: string[];
    revisions: number;
    recomputations: number[];
  };
}

// Something done outside a run that changed beliefs: a withdrawal, a
// withdrawal before assessment, or recovery when the desk was opened.
export interface ActionTrace {
  kind: "action";
  action: "withdrawal" | "withdrawal-before-assessment" | "recovery";
  at: string;
  recordId: string | null;
  reason: string | null;
  by: "Evidence Desk";
  speck: SpeckActivity;
}

export type TraceEntry = RunTrace | ActionTrace;

// A run as the Meterless engine recorded it in its own history.json.
export interface EngineHistoryEntry {
  id: string;
  timestamp: number;
  status: string;
  chunks: Array<{ content: string }>;
}

export function readEngineHistory(file: string): EngineHistoryEntry[] | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as EngineHistoryEntry[];
  } catch {
    return null;
  }
}

// The engine's record of a run. The engine numbers runs run-1, run-2, ... per
// process, so an id alone can match a run from an earlier process: the
// engine's timestamp identifies it, and for runs saved before the timestamp
// was kept, the chunks' content must match as well.
export function findEngineRun(history: readonly EngineHistoryEntry[], execution: RunSnapshot["execution"]): EngineHistoryEntry | null {
  return history.find((entry) => entry.id === execution.runId && (execution.timestamp !== undefined
    ? entry.timestamp === execution.timestamp
    : entry.chunks.length === execution.chunks.length && entry.chunks.every((chunk, index) => chunk.content === execution.chunks[index]!.content))) ?? null;
}

export function buildTrace(input: {
  events: readonly CognitiveEvent[];
  objects: readonly MentalObject[];
  runs: readonly RunSnapshot[];
  recomputations: readonly Recomputation[];
  engine: string;
  meterlessHistory: readonly EngineHistoryEntry[] | null;
}): TraceEntry[] {
  const objects = new Map(input.objects.map((object) => [object.id, object]));
  const replaced = new Set(input.objects.flatMap((object) => (object.kind === "hypothesis" && object.data.replaces ? [String(object.data.replaces)] : [])));
  const recordIdOf = (objectId: unknown) => {
    const source = String(objects.get(String(objectId) as MentalObject["id"])?.data.source ?? "");
    return source ? source.slice(source.lastIndexOf("/") + 1) : null;
  };
  const schemaOf = (event: CognitiveEvent) => event.type === "memory.recorded"
    ? String(objects.get((event.payload as { objectId?: string }).objectId as MentalObject["id"])?.data.schema ?? "")
    : "";

  // Traced events, grouped by correlation id, in order.
  const groups = new Map<string, CognitiveEvent[]>();
  for (const event of input.events) {
    if (!TRACED.has(event.type)) continue;
    if (event.type === "memory.recorded" && ![ASSESSMENT_SCHEMA, RECOMPUTE_SCHEMA, EXCLUSION_SCHEMA, RUN_SCHEMA].includes(schemaOf(event))) continue;
    groups.set(event.correlationId, [...(groups.get(event.correlationId) ?? []), event]);
  }

  const activity = (events: readonly CognitiveEvent[]): SpeckActivity => ({
    recorded: events.filter((event) => event.type === "evidence.recorded").map((event) => recordIdOf((event.payload as { objectId?: string }).objectId) ?? "?"),
    revisions: events.filter((event) => event.type === "belief.revised").map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const hypothesis = objects.get(String(payload.hypothesisId) as MentalObject["id"]);
      return {
        hypothesisKey: String(hypothesis?.data.key ?? payload.hypothesisId),
        recordId: recordIdOf(payload.evidenceId),
        from: `${String(payload.previousStatus)} ${Number(payload.previousConfidence).toFixed(2)}`,
        to: `${String(payload.newStatus)} ${Number(payload.newConfidence).toFixed(2)}`,
        historical: replaced.has(String(payload.hypothesisId))
      };
    }),
    recomputations: events.filter((event) => schemaOf(event) === RECOMPUTE_SCHEMA)
      .map((event) => Number(objects.get((event.payload as { objectId?: string }).objectId as MentalObject["id"])?.data.version))
  });

  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const entries: Array<TraceEntry & { order: number }> = [];
  for (const [correlationId, events] of groups) {
    const order = events[0]!.sequence;
    const attempts = events.filter((event) => schemaOf(event) === ASSESSMENT_SCHEMA)
      .map((event) => ({ event, attempt: objects.get((event.payload as { objectId?: string }).objectId as MentalObject["id"])!.data as unknown as AssessmentAttempt }));
    const run = runsById.get(correlationId);
    if (run || attempts.length) {
      entries.push({ ...runTrace(correlationId, run ?? null, events, attempts, activity, input), order });
      continue;
    }
    // Not a run: a withdrawal, an exclusion, or recovery on open.
    const speck = activity(events);
    const withdrawn = events.find((event) => event.type === "evidence.withdrawn");
    const exclusionEvent = events.find((event) => schemaOf(event) === EXCLUSION_SCHEMA);
    if (withdrawn) {
      entries.push({ kind: "action", action: "withdrawal", at: withdrawn.occurredAt, recordId: recordIdOf((withdrawn.payload as { objectId?: string }).objectId),
        reason: String((withdrawn.payload as { reason?: string }).reason ?? ""), by: "Evidence Desk", speck, order });
    } else if (exclusionEvent) {
      const exclusion = objects.get((exclusionEvent.payload as { objectId?: string }).objectId as MentalObject["id"])!.data as unknown as Exclusion;
      entries.push({ kind: "action", action: "withdrawal-before-assessment", at: exclusionEvent.occurredAt, recordId: exclusion.recordId, reason: exclusion.reason, by: "Evidence Desk", speck, order });
    } else if (speck.revisions.length || speck.recomputations.length) {
      entries.push({ kind: "action", action: "recovery", at: events[0]!.occurredAt, recordId: null, reason: null, by: "Evidence Desk", speck, order });
    }
  }
  return entries.sort((left, right) => left.order - right.order).map(({ order: _order, ...entry }) => entry as TraceEntry);
}

function runTrace(
  runId: string,
  run: RunSnapshot | null,
  events: readonly CognitiveEvent[],
  attempts: ReadonlyArray<{ event: CognitiveEvent; attempt: AssessmentAttempt }>,
  activity: (events: readonly CognitiveEvent[]) => SpeckActivity,
  input: { engine: string; meterlessHistory: readonly EngineHistoryEntry[] | null }
): RunTrace {
  // Events before the first assessment are the start-of-run reconciliation;
  // each assessment owns the events up to the next one (recording its
  // evidence and reconciling beliefs).
  const steps: TraceStep[] = [];
  const firstSequence = attempts[0]?.event.sequence ?? Number.POSITIVE_INFINITY;
  const startActivity = activity(events.filter((event) => event.sequence < firstSequence));
  if (startActivity.revisions.length || startActivity.recomputations.length) steps.push({ kind: "reconcile", when: "start", by: "Evidence Desk", speck: startActivity });
  attempts.forEach(({ event, attempt }, index) => {
    const next = attempts[index + 1]?.event.sequence ?? Number.POSITIVE_INFINITY;
    const owned = events.filter((other) => other.sequence > event.sequence && other.sequence < next);
    const chunk = attempt.chunk ?? index + 1;
    const engineChunk = run?.execution.chunks.find((item) => item.id === chunk) ?? null;
    const judged = attempt.judged.flatMap((item) => item.judgments);
    steps.push({
      kind: "chunk", chunk,
      meterless: engineChunk ? { tokens: engineChunk.tokens, carryoverIn: Boolean(engineChunk.carryover) } : null,
      records: attempt.judged.map((item) => item.record.id),
      failed: attempt.failed.map((item) => ({ recordId: item.record.id, error: item.error })),
      model: attempt.model ?? null,
      judgments: {
        rule: judged.filter((judgment) => judgment.basis === "rule").length,
        model: judged.filter((judgment) => judgment.basis === "model").length,
        noBearing: attempt.judged.filter((item) => item.judgments.length === 0).map((item) => item.record.id)
      },
      notes: attempt.notes ?? [],
      speck: activity(owned)
    });
  });
  if (run?.explanation || run?.explanationCall) {
    steps.push({
      kind: "explanation", model: run.explanationCall ?? null,
      agrees: run.explanation ? run.explanation.agreement.agrees : null,
      problems: run.explanation?.agreement.problems ?? [],
      invalidCitations: run.explanation?.invalidCitations ?? []
    });
  }
  const chunkSteps = steps.filter((step): step is Extract<TraceStep, { kind: "chunk" }> => step.kind === "chunk");
  const modelCalls = [...chunkSteps.map((step) => step.model), ...steps.flatMap((step) => (step.kind === "explanation" ? [step.model] : []))].filter((call): call is ModelCallTrace => call !== null);
  const all = activity(events);
  return {
    kind: "run", runId,
    runNumber: run?.runNumber ?? null,
    status: run?.execution.status ?? "interrupted",
    startedAt: run?.startedAt ?? attempts[0]?.attempt.at ?? null,
    finishedAt: run?.finishedAt ?? null,
    evidence: run?.retrieval
      ? { mode: run.retrieval.mode, label: run.evidence.label, target: run.evidence.target, visible: run.retrieval.visible, sources: run.retrieval.sources }
      : run ? { mode: run.evidence.mode, label: run.evidence.label, target: run.evidence.target, visible: null, sources: [] }
      : null,
    meterless: run ? {
      engine: input.engine, runId: run.execution.runId, status: run.execution.status, chunks: run.execution.chunks.length,
      maxChunks: run.execution.chunkConfig.maxChunks, reflection: Boolean(run.explanation || run.explanationCall), durationMs: run.execution.durationMs,
      inHistory: input.meterlessHistory ? findEngineRun(input.meterlessHistory, run.execution) !== null : null
    } : null,
    reasoner: run ? { kind: run.reasoner.kind, model: run.reasoner.model, endpoint: run.reasoner.endpoint } : null,
    steps,
    flags: {
      pending: run?.unprocessed ?? [],
      failed: chunkSteps.flatMap((step) => step.failed.map((item) => item.recordId)),
      modelCalls: modelCalls.length,
      retries: modelCalls.reduce((sum, call) => sum + Math.max(0, call.attempts - 1), 0),
      contractFailures: modelCalls.reduce((sum, call) => sum + call.contractFailures, 0),
      invalidCitations: run?.explanation?.invalidCitations ?? [],
      recovered: run?.recovered ?? [],
      revisions: all.revisions.length,
      recomputations: all.recomputations
    }
  };
}
