import type { ActorInput, MentalObjectId } from "#speck";
import { generationOf, type CaseHandle, type CaseState } from "./case-state.js";
import type { Conclusion } from "./conclusion.js";
import { ASSESSMENT_SCHEMA, RUN_SCHEMA, type AssessedEvidence } from "./records.js";

// What a case gives Speck beyond its own worker's state: links between the
// case's memories in Speck's association graph, and a shared summary that
// Speck's conversation can recall.

// Links the case's memories in Speck's own association graph (Speck's
// public reinforceAssociation), so Speck's activation and memory map see how
// they relate:
// - an assessment is derived-from each evidence record it judged;
// - an evidence record supports, or contradicts, the conclusion of each run
//   whose conclusion it bore on;
// - a correcting record is inhibitory towards the record it replaced, so
//   recalling the correction suppresses the outdated record.
// Each link is made once: an existing one is left as it is.
export async function linkCaseMemories(desk: CaseHandle): Promise<void> {
  const state = desk.read();
  const worker = state.worker;
  const actor: ActorInput = { kind: "runtime", source: "evidence-desk/links" };
  const evidence = state.recordedEvidence();
  const objects = new Map(state.objects.map((object) => [object.id as string, object]));
  const link = async (sourceId: string | undefined, targetId: string | undefined, kind: "derived-from" | "supports" | "contradicts" | "inhibitory") => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (objects.get(sourceId)?.associations.some((edge) => edge.targetId === targetId && edge.kind === kind)) return;
    const updated = await desk.runtime.reinforceAssociation({ workerId: worker.id, sourceId: sourceId as MentalObjectId, targetId: targetId as MentalObjectId, kind, actor });
    objects.set(updated.id, updated);
  };
  for (const object of [...objects.values()]) {
    const data = object.data as { schema?: unknown; judged?: AssessedEvidence[]; conclusion?: Conclusion };
    if (data.schema === ASSESSMENT_SCHEMA) {
      for (const item of data.judged ?? []) await link(object.id, evidence.get(item.record.id), "derived-from");
    }
    if (data.schema === RUN_SCHEMA && data.conclusion) {
      const c = data.conclusion;
      const subject = c.hypothesis ?? c.alternatives?.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
      for (const ref of subject?.supporting ?? []) await link(evidence.get(ref.recordId), object.id, "supports");
      for (const ref of subject?.contradicting ?? []) await link(evidence.get(ref.recordId), object.id, "contradicts");
    }
  }
  for (const entry of state.ledger()) {
    for (const replaced of entry.record.provenance.supersedes) await link(evidence.get(entry.record.id), evidence.get(replaced), "inhibitory");
  }
}

// What Speck's own conversation can recall about this case. A case's
// memories belong to its worker, which Speck's chat does not search; the
// chat recalls shared memories. So after every change to the case's
// beliefs, one shared memory states the case's current conclusion and the
// evidence behind it, read from Speck's state, and the previous one is
// archived so an outdated conclusion is never recalled. A case with no
// assessed evidence publishes nothing.
export async function publishToSpeck(desk: CaseHandle): Promise<void> {
  const actor: ActorInput = { kind: "runtime", source: "evidence-desk/summary" };
  for (const object of desk.runtime.mentalObjects.listAll()) {
    const tag = object.data.evidenceDeskSummary as { caseId?: unknown } | undefined;
    if (object.workerId === null && object.status !== "archived" && tag?.caseId === desk.scenario.caseId) {
      await desk.runtime.archiveSharedMemory(object.id, actor);
    }
  }
  const state = desk.read();
  if (!state.recordedCount()) return;
  await desk.runtime.recordSharedMemory({
    type: "semantic", content: caseSummary(state), sourceWorkerId: state.worker.id, importance: 0.8, confidence: 1,
    data: { evidenceDeskSummary: { caseId: desk.scenario.caseId, generation: generationOf(state.worker), runNumber: state.runs().at(-1)?.runNumber ?? null } },
    actor
  });
}

// The case's current state in plain words, from Speck's beliefs.
export function caseSummary(state: CaseState): string {
  const { scenario } = state;
  const c = state.conclusion();
  const runs = state.runs();
  const last = runs.at(-1);
  const content = new Map(state.ledger().map((entry) => [entry.record.id, entry.record]));
  const quote = (id: string) => {
    const record = content.get(id);
    return record ? `${id} (${record.source.name}): "${record.content.length > 160 ? `${record.content.slice(0, 157)}…` : record.content}"` : id;
  };
  const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
  const lines = [
    `Evidence Desk investigation ${scenario.caseId}, "${scenario.title}". Question: ${scenario.question}`,
    `Current conclusion (after run ${last?.runNumber ?? "?"}, stage "${state.currentStage().label}"): ${c.headline}${c.justification?.confidence !== null && c.justification?.confidence !== undefined ? ` Speck confidence ${c.justification.confidence}, a belief-revision score, not a probability.` : ""}`,
    subject?.supporting.length ? `Evidence supporting ${subject.statement}: ${subject.supporting.map((ref) => quote(ref.recordId)).join("; ")}.` : null,
    subject?.contradicting.length ? `Evidence against it: ${subject.contradicting.map((ref) => quote(ref.recordId)).join("; ")}.` : null,
    c.rejected.length ? `Ruled out: ${c.rejected.map((view) => `${view.statement}${view.contradicting.length ? ` (refuted by ${view.contradicting.map((ref) => ref.recordId).join(", ")})` : ""}`).join("; ")}.` : null,
    c.noLongerCounted.length ? `No longer counts: ${c.noLongerCounted.map((item) => `${item.recordId}, ${item.invalidation.kind === "superseded" ? `replaced by its source with ${item.invalidation.by}` : `withdrawn (${item.invalidation.reason})`}`).join("; ")}.` : null,
    c.openQuestions.length ? `Still open: ${c.openQuestions.map((q) => q.text).join(" ")}` : null,
    // How it got here: each run's conclusion in order, so a change can be explained.
    runs.length > 1 ? `History: ${runs.map((run) => `run ${run.runNumber} at stage "${run.stage.label}" concluded: ${run.conclusion.headline}`).join("; then ")}.` : null,
    c.noLongerCounted.length ? "The conclusion changed because records that no longer count were taken out and every belief that rested on them was rebuilt from the evidence that still counts." : null,
    // Records the last run could not assess do not count yet; say so, so
    // their absence is not read as "no new evidence".
    last?.unprocessed.length ? `Not yet assessed (they do not count until a run assesses them): ${last.unprocessed.map((id) => quote(id)).join("; ")}.` : null
  ];
  return lines.filter(Boolean).join("\n");
}
