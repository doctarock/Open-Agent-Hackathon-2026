import type { MentalObject, MentalObjectId, SpeckRuntime } from "#speck";

// The one place Evidence Desk writes to Speck's storage outside Speck's
// public service methods. Speck (pinned at 8821789) has no public operation
// that retires a worker's hypothesis: archiveSharedMemory accepts only shared
// memories, and the belief service sets hypothesis status only through
// revision. Speck's own components use the same repository write (for
// example speck/components/mind.ts retires a contradicted fact this way).
//
// Assumptions this relies on, each checked here or in
// test/speck-compat.test.ts:
// 1. runtime.mentalObjects.update(object) stores the object it is given whole
//    (it rewrites object_json), so the caller must pass the full current
//    object, read immediately before.
// 2. A hypothesis status of "superseded" is terminal in Speck: revision keeps
//    it (statusAfter) and ranking places it below live statuses at equal
//    confidence. MentalObject.status accepts "superseded".
// 3. The repository has no cache: get() reads back what update() wrote.
// 4. update() emits no event and leaves the worker record untouched. The
//    audit trail for a retirement is the recomputation memory Evidence Desk
//    records through recordMemory, and the hypothesis keeps its own revision
//    history and confidence.
// If a Speck update changes any of these, retireHypothesis throws
// SpeckCompatibilityError instead of corrupting the historical belief.

export class SpeckCompatibilityError extends Error {
  constructor(message: string) {
    super(`Speck compatibility: ${message}. Evidence Desk retires replaced hypotheses through Speck's mental-object repository (see src/investigation/speck-compat.ts); check that operation against the installed Speck.`);
    this.name = "SpeckCompatibilityError";
  }
}

// Fields of a hypothesis that record what was believed and why. Retiring it
// must leave every one of them exactly as it was.
const PRESERVED_DATA = ["key", "supportingEvidence", "contradictoryEvidence", "revisionHistory", "lastUpdatedAt"] as const;

export function retireHypothesis(runtime: SpeckRuntime, hypothesisId: MentalObjectId, replacementId: string | null, at: string): MentalObject {
  const current = runtime.mentalObjects.get(hypothesisId);
  if (!current) throw new SpeckCompatibilityError(`hypothesis ${hypothesisId} could not be read back`);
  if (current.kind !== "hypothesis") throw new SpeckCompatibilityError(`object ${hypothesisId} is a ${current.kind}, not a hypothesis`);
  if (current.data.status === "superseded") return current;
  runtime.mentalObjects.update({
    ...current,
    status: "superseded",
    data: { ...current.data, status: "superseded", statusWhenReplaced: current.data.status, supersededBy: replacementId, supersededAt: at }
  });
  const stored = runtime.mentalObjects.get(hypothesisId);
  const problems: string[] = [];
  if (!stored) problems.push("the hypothesis is gone after the update");
  else {
    if (stored.data.status !== "superseded" || stored.status !== "superseded") problems.push("the superseded status did not persist");
    if (stored.data.statusWhenReplaced !== current.data.status) problems.push("the status it had reached was not kept");
    if (stored.confidence !== current.confidence) problems.push("its confidence changed");
    if (stored.content !== current.content || stored.createdAt !== current.createdAt) problems.push("its statement or creation time changed");
    if (JSON.stringify(stored.provenance) !== JSON.stringify(current.provenance)) problems.push("its provenance changed");
    for (const field of PRESERVED_DATA) {
      if (JSON.stringify(stored.data[field]) !== JSON.stringify(current.data[field])) problems.push(`its ${field} changed`);
    }
  }
  if (problems.length) throw new SpeckCompatibilityError(`retiring hypothesis ${hypothesisId}: ${problems.join("; ")}`);
  return stored!;
}
