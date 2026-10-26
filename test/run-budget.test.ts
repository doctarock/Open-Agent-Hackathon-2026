// A checkpoint with more records than one run's chunk budget (8 chunks of 2)
// is assessed over as many runs as it needs, as an investigator would press
// Run again; an errored run is not retried. The case is set 6's 72-record
// permit-long, run with the deterministic fact rules (no model).

import assert from "node:assert/strict";
import { test } from "node:test";
import { CHALLENGE6_DIR, loadEvalCases } from "../src/eval/cases.js";
import { speckDesk, speckFresh } from "../src/eval/systems.js";

test("a checkpoint larger than one run's budget is assessed over several runs, by both Speck systems", async () => {
  const item = loadEvalCases(CHALLENGE6_DIR).find((candidate) => candidate.id === "permit-long")!;
  const persistent = await speckDesk({ kind: "rules" }).run(item);
  const rebuilt = await speckFresh({ kind: "rules" }).run(item);
  for (const result of [persistent, rebuilt]) {
    assert.ok(result.checkpoints.every((outcome) => outcome.error === null), "no checkpoint errors");
    assert.ok(result.checkpoints.every((outcome) => outcome.executionStatus !== "max-chunks"), "no checkpoint is left at the engine's budget");
  }
  // The rebuilt system sees up to 72 records at once; before, it stopped at 16
  // and withheld its conclusion. Now it reaches the persistent system's answers.
  assert.deepEqual(rebuilt.checkpoints.map((outcome) => outcome.conclusion), persistent.checkpoints.map((outcome) => outcome.conclusion));
  assert.equal(rebuilt.checkpoints.at(-1)!.conclusion, "H-REFUSED");
});
