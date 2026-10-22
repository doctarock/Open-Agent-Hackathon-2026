import type { CognitiveEvent, MentalObject } from "#speck";
import type { Scenario } from "../scenario.js";
import type { Recomputation, RunSnapshot } from "./desk.js";

// The revision timeline is Speck's event log for the case, read back: each
// hypothesis, each evidence update, each recorded piece of evidence, each
// belief revision with the evidence that caused it, and each run's
// conclusion. Nothing is reconstructed that Speck did not record.
//
// Hypotheses are replaced when what they rested on is invalidated. Entries
// about a replaced hypothesis stay, marked historical: they show what was
// believed then, not what is believed now.

export interface TimelineEntry {
  sequence: number;
  at: string;
  kind: "case" | "hypothesis" | "stage" | "evidence" | "revision" | "recomputation" | "conclusion";
  runNumber: number | null;
  title: string;
  detail: string;
  recordId: string | null;
  hypothesisKey: string | null;
  actor: string;
  // For revisions and conclusions: whether this changed what is believed.
  significant: boolean;
  // About a hypothesis that has since been replaced: history, not current.
  historical: boolean;
}

const STAGE_KEY = "evidence-desk.stage";
const RUN_SCHEMA = "evidence-desk.run.v1";
const RECOMPUTE_SCHEMA = "evidence-desk.recompute.v1";

export function buildTimeline(input: {
  events: readonly CognitiveEvent[];
  objects: readonly MentalObject[];
  scenario: Scenario;
  runs: readonly RunSnapshot[];
}): TimelineEntry[] {
  const objects = new Map(input.objects.map((object) => [object.id, object]));
  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  // Judgments by record, from whichever run assessed it: a recomputation
  // replays records assessed in earlier runs.
  const assessedById = new Map(input.runs.flatMap((run) => run.assessed.map((item) => [item.record.id, item] as const)));
  const replaced = new Set(input.objects.flatMap((object) => (object.kind === "hypothesis" && object.data.replaces ? [String(object.data.replaces)] : [])));
  const recordIdOf = (objectId: unknown) => {
    const source = String(objects.get(String(objectId) as MentalObject["id"])?.data.source ?? "");
    return source ? source.slice(source.lastIndexOf("/") + 1) : null;
  };
  const keyOf = (objectId: unknown) => {
    const key = objects.get(String(objectId) as MentalObject["id"])?.data.key;
    return key === undefined ? null : String(key);
  };
  const entries: TimelineEntry[] = [];
  let previousRun: RunSnapshot | null = null;

  for (const event of input.events) {
    const payload = event.payload as Record<string, any>;
    const run = runsById.get(event.correlationId) ?? null;
    const base = {
      sequence: event.sequence, at: event.occurredAt, runNumber: run?.runNumber ?? null,
      actor: `${event.provenance.kind}:${event.provenance.source}`, recordId: null, hypothesisKey: null, significant: false, historical: false
    };
    switch (event.type) {
      case "worker.created":
        entries.push({ ...base, kind: "case", title: `Case ${input.scenario.caseId} opened`, detail: input.scenario.question });
        break;
      case "hypothesis.proposed": {
        const key = keyOf(payload.objectId);
        const object = objects.get(payload.objectId);
        const rebuilt = object?.data.recomputation;
        entries.push({ ...base, kind: "hypothesis", hypothesisKey: key, historical: replaced.has(String(payload.objectId)),
          title: rebuilt ? `${key} rebuilt from its prior ${payload.confidence} (recomputation ${rebuilt})` : `Hypothesis ${key} proposed (prior ${payload.confidence})`,
          detail: object?.content ?? "" });
        break;
      }
      case "world-state.changed": {
        if (payload.key !== STAGE_KEY) break;
        const previousIndex = input.scenario.stages.findIndex((stage) => stage.id === payload.previous?.value);
        const stage = input.scenario.stages[previousIndex + 1];
        if (!stage) break;
        // Speck carries the last correlation id forward; a stage change is
        // the user's action, not part of the run before it.
        entries.push({ ...base, kind: "stage", runNumber: null, significant: previousIndex >= 0,
          title: previousIndex >= 0 ? `Evidence update introduced: ${stage.label}` : `Evidence available: ${stage.label}`,
          detail: stage.description });
        break;
      }
      case "evidence.recorded": {
        const recordId = recordIdOf(payload.objectId);
        const assessed = recordId ? assessedById.get(recordId) : undefined;
        entries.push({ ...base, kind: "evidence", recordId,
          title: `${recordId} assessed (${assessed?.record.source.name ?? payload.source}, reliability ${payload.reliability})`,
          detail: assessed?.record.content ?? "" });
        break;
      }
      case "belief.revised": {
        const recordId = recordIdOf(payload.evidenceId);
        const key = keyOf(payload.hypothesisId);
        const judgment = (recordId ? assessedById.get(recordId) : undefined)?.judgments.find((item) => item.hypothesisKey === key);
        const statusChanged = payload.previousStatus !== payload.newStatus;
        const historical = replaced.has(String(payload.hypothesisId));
        entries.push({ ...base, kind: "revision", recordId, hypothesisKey: key, significant: statusChanged && !historical, historical,
          title: `${key}: ${payload.previousStatus} ${num(payload.previousConfidence)} → ${payload.newStatus} ${num(payload.newConfidence)}${historical ? " (since replaced)" : ""}`,
          detail: `${recordId} ${payload.direction} ${key}${judgment?.decisive ? " decisively" : ""}`
            + (judgment ? ` (${judgment.basis}: ${judgment.rationale})` : "") });
        break;
      }
      case "evidence.withdrawn": {
        const recordId = recordIdOf(payload.objectId);
        entries.push({ ...base, kind: "evidence", recordId, significant: true,
          title: `${recordId} withdrawn from the case`, detail: `Reason: ${payload.reason}. Beliefs that rested on it are recomputed.` });
        break;
      }
      case "memory.recorded": {
        const data = objects.get(payload.objectId)?.data;
        if (data?.schema === RECOMPUTE_SCHEMA) {
          const recomputation = data as unknown as Recomputation;
          entries.push({ ...base, kind: "recomputation", significant: true,
            title: `Recomputation ${recomputation.version}: ${recomputation.hypotheses.map((item) => item.key).join(", ")} rebuilt from evidence that still counts`,
            detail: recomputation.hypotheses.map((item) => `${item.key} was ${item.previous.status} ${num(item.previous.confidence)}; ${item.cause}.`
              + ` Replayed: ${item.replayed.join(", ") || "nothing (prior only)"}.`).join(" ") });
          break;
        }
        const snapshot = data as unknown as RunSnapshot | undefined;
        if (snapshot?.schema !== RUN_SCHEMA) break;
        const before = previousRun?.conclusion;
        const now = snapshot.conclusion;
        const changed = !before || before.state !== now.state || before.hypothesis?.key !== now.hypothesis?.key
          || before.direction?.pointsTo?.key !== now.direction?.pointsTo?.key;
        entries.push({ ...base, kind: "conclusion", runNumber: snapshot.runNumber, hypothesisKey: now.hypothesis?.key ?? null, significant: Boolean(before) && changed,
          title: before && changed
            ? `Run ${snapshot.runNumber}: conclusion revised (${describe(before)} → ${describe(now)})`
            : `Run ${snapshot.runNumber}: ${describe(now)}${before ? " (unchanged)" : ""}`,
          detail: `${now.headline} Execution ${snapshot.execution.status}, ${snapshot.execution.chunks.length} chunk(s); ${snapshot.assessed.length} record(s) assessed via ${snapshot.evidence.mode}; reasoner ${snapshot.reasoner.kind}${snapshot.reasoner.model ? ` (${snapshot.reasoner.model})` : ""}.` });
        previousRun = snapshot;
        break;
      }
    }
  }
  return entries;
}

function describe(conclusion: RunSnapshot["conclusion"]): string {
  if (conclusion.hypothesis) return `${conclusion.state} ${conclusion.hypothesis.key}`;
  const pointsTo = conclusion.direction?.pointsTo;
  return pointsTo ? `${conclusion.state}, pointing to ${pointsTo.key}` : conclusion.state;
}

function num(value: unknown): string {
  return Number(value).toFixed(2);
}
