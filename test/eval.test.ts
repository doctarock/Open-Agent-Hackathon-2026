import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEV_FIXTURES_DIR, EVAL_DIR, leakage, loadEvalCases } from "../src/eval/cases.js";
import { runEvaluation, systemsFor } from "../src/eval/harness.js";
import { scoreSystem } from "../src/eval/metrics.js";
import type { CheckpointOutcome } from "../src/eval/systems.js";
import { checkAgreement } from "../src/investigation/desk.js";
import type { Conclusion } from "../src/investigation/conclusion.js";

// Deterministic tests of the evaluation itself. They check that it loads,
// separates held-out cases, scores honestly and repeats exactly; they do not
// assert any system's score, so passing them never depends on tuning.

test("held-out cases load, cover every required category, and share nothing with the fixtures", () => {
  const cases = loadEvalCases();
  assert.deepEqual(cases.map((item) => item.category).sort(),
    ["abstention", "citation", "conflict", "correction", "model-interpretation", "partial-support", "provider-failure"]);
  assert.deepEqual(leakage(cases), []);
  assert.throws(() => loadEvalCases(path.join(DEV_FIXTURES_DIR)), /must not come from the development fixtures/);
  assert.ok(!path.resolve(EVAL_DIR).startsWith(path.resolve(DEV_FIXTURES_DIR)));
  const ghost = cases.find((item) => item.id === "ghost-citation")!;
  const records = JSON.parse(fs.readFileSync(path.join(ghost.dir, "evidence.json"), "utf8")).records.map((record: { id: string }) => record.id);
  for (const id of ghost.forbiddenCitations) assert.ok(!records.includes(id), `${id} must not exist`);
});

test("the fixture evaluation is deterministic", async () => {
  const cases = loadEvalCases();
  const first = await runEvaluation("fixture", cases, systemsFor("fixture"));
  const second = await runEvaluation("fixture", cases, systemsFor("fixture"));
  assert.deepEqual(first, second);
  assert.deepEqual(first.systems.map((system) => system.system), ["speck-desk/rules", "speck-fresh/rules", "baseline-stateless/rules"]);
  for (const system of first.systems) {
    assert.equal(system.metrics.model, null, "fixture mode makes no model calls");
    assert.equal(system.metrics.failureSurfaced.of, 1);
  }
});

const outcome = (overrides: Partial<CheckpointOutcome>): CheckpointOutcome => ({
  stage: "only", error: null, conclusion: null, tentative: null, presentedAsCurrent: [], citations: [], supportCitations: [],
  visibleEvidence: ["EV-A", "EV-B"], explanationAgrees: null, executionStatus: null, ...overrides
});

test("scoring counts invented citations, unsupported claims, refuted claims and silent provider failures", () => {
  const item = {
    id: "synthetic", dir: "", category: "test", description: "", scenario: {} as never, forbiddenCitations: ["EV-GHOST"],
    provider: "fixture" as const, expectError: null,
    checkpoints: [
      { afterStage: "one", conclusion: null, notCurrent: ["H-OLD"], unsupported: ["H-X"] },
      { afterStage: "two", conclusion: "H-Y", notCurrent: [], unsupported: [] }
    ]
  };
  const score = scoreSystem("synthetic", [{ item, result: { model: null, checkpoints: [
    outcome({ conclusion: "H-X", presentedAsCurrent: ["H-X", "H-OLD"], citations: ["EV-A", "EV-GHOST"], supportCitations: ["EV-GHOST"] }),
    outcome({ conclusion: "H-Y", presentedAsCurrent: ["H-Y"], citations: ["EV-B"], supportCitations: [] })
  ] } }]);
  assert.deepEqual(score.metrics.correctness, { count: 1, of: 2, rate: 0.5 });
  assert.deepEqual(score.metrics.validCitations, { count: 2, of: 3, rate: 0.667 });
  assert.deepEqual(score.checkpoints[0]!.forbiddenCited, ["EV-GHOST"]);
  // H-X is labelled unsupported; H-Y is right but backed by no citation.
  assert.deepEqual(score.metrics.unsupportedClaims, { count: 2, of: 2, rate: 1 });
  assert.deepEqual(score.metrics.correctionHandling, { count: 0, of: 1, rate: 0 });
  assert.deepEqual(score.metrics.appropriateAbstention, { count: 0, of: 1, rate: 0 });

  const failing = { ...item, expectError: "evidence" as const, checkpoints: [item.checkpoints[0]!] };
  const silent = scoreSystem("silent", [{ item: failing, result: { model: null, checkpoints: [outcome({ conclusion: null })] } }]);
  assert.deepEqual(silent.metrics.failureSurfaced, { count: 0, of: 1, rate: 0 }, "no error surfaced is a failure even without a conclusion");
  const surfaced = scoreSystem("surfaced", [{ item: failing, result: { model: null, checkpoints: [outcome({ error: "evidence: unreachable" })] } }]);
  assert.deepEqual(surfaced.metrics.failureSurfaced, { count: 1, of: 1, rate: 1 });
});

test("an explanation must state Speck's conclusion and its firmness", () => {
  const conclusion = {
    hypothesis: null, alternatives: [{ key: "H-WRONG" }], rejected: [{ key: "H-DELIVERED" }],
    direction: { pointsTo: { key: "H-WRONG", statement: "" } }, justification: { established: false }
  } as unknown as Conclusion;
  const explain = (statedConclusion: string, statedEstablished: boolean) => ({ text: "", citedEvidence: [], statedConclusion, statedEstablished });
  assert.equal(checkAgreement(explain("unresolved", false), [], conclusion).agrees, true);
  assert.equal(checkAgreement(explain("H-WRONG", false), [], conclusion).agrees, true, "pointing to the favoured explanation is allowed");
  assert.match(checkAgreement(explain("H-WRONG", true), [], conclusion).problems.join(), /presents the conclusion as established/);
  assert.match(checkAgreement(explain("H-DELIVERED", false), [], conclusion).problems.join(), /concludes "H-DELIVERED"; Speck's conclusion is "unresolved"/);
  assert.match(checkAgreement(explain("unresolved", false), ["EV-9"], conclusion).problems.join(), /cites evidence that does not exist: EV-9/);
});
