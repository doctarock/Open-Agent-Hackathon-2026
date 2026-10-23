import assert from "node:assert/strict";
import { test } from "node:test";
import { deskApi, errorResponse } from "../src/investigation/api.js";
import { RunInProgressError, type EvidenceDesk } from "../src/investigation/desk.js";
import { testConfig, withDesk } from "./helpers.js";

// Resetting the demo case from the page (EvidenceDesk.restartCase): a fresh
// copy of the case becomes current and nothing is deleted. The previous copy
// is suspended in Speck with its history; other Speck workers are untouched.

const beliefs = (desk: EvidenceDesk) => desk.hypotheses().map((view) => [view.key, view.status, view.confidence, view.supporting.length, view.contradicting.length]);
const caseWorkers = (desk: EvidenceDesk) => desk.runtime.listWorkers().filter((worker) => worker.objective.constraints.includes(`evidence-desk:case=${desk.scenario.caseId}`));

async function investigate(desk: EvidenceDesk) {
  await desk.run();
  await desk.introduceNextUpdate();
  await desk.run();
}

test("a reset restores the case's starting state as a fresh copy, keeps the previous copy, and touches nothing else", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const start = { beliefs: beliefs(desk), stage: desk.currentStage().id };
    const other = await desk.runtime.createWorker("Someone else's task", [], { kind: "user", source: "test" });
    const otherObjects = desk.runtime.mentalObjects.listForWorker(other.id).length;

    // At its starting state there is nothing to reset.
    assert.deepEqual(await desk.restartCase(), { restarted: false, generation: 1, previousGeneration: null });
    assert.equal(caseWorkers(desk).length, 1);

    await investigate(desk);
    const original = caseWorkers(desk)[0]!;
    const originalObjects = desk.runtime.mentalObjects.listForWorker(original.id).length;
    const originalEvents = desk.runtime.listEvents(original.id, 0, 10_000).length;
    assert.ok(desk.runs().length === 2 && desk.recordedCount() === 6);

    const api = deskApi(desk, config, "test");
    const result = await api.reset() as { restarted: boolean; generation: number; previousGeneration: number; stage: { id: string }; runs: number };
    assert.deepEqual([result.restarted, result.generation, result.previousGeneration, result.stage.id, result.runs], [true, 2, 1, start.stage, 0]);

    // The current case is the fresh copy, at its starting state.
    assert.equal(desk.generation, 2);
    assert.deepEqual(beliefs(desk), start.beliefs);
    assert.equal(desk.currentStage().id, start.stage);
    assert.deepEqual([desk.runs().length, desk.recordedCount(), desk.conclusionFromSpeck().state], [0, 0, "unresolved"]);
    assert.deepEqual((await desk.listEvidence()).pending, ["EV-OMS-001", "EV-WMS-002", "EV-CAR-003", "EV-SUP-004"]);
    assert.deepEqual(desk.replacedHypotheses(), []);
    assert.equal((api.status() as { case: { generation: number } }).case.generation, 2);

    // The previous copy is suspended with everything it held.
    const previous = desk.runtime.getWorker(original.id)!;
    assert.equal(previous.status, "suspended");
    assert.equal(desk.runtime.mentalObjects.listForWorker(original.id).length, originalObjects);
    assert.ok(desk.runtime.listEvents(original.id, 0, 10_000).length > originalEvents, "only the suspension was added");
    // The unrelated worker is untouched.
    assert.equal(desk.runtime.getWorker(other.id)!.status, "created");
    assert.equal(desk.runtime.mentalObjects.listForWorker(other.id).length, otherObjects);

    // Repeating the reset does nothing; the fresh copy investigates as the original did.
    assert.deepEqual(await desk.restartCase(), { restarted: false, generation: 2, previousGeneration: null });
    assert.equal(caseWorkers(desk).length, 2);
    await desk.run();
    assert.deepEqual([desk.conclusionFromSpeck().state, desk.conclusionFromSpeck().hypothesis?.key, desk.runs().map((run) => run.runNumber)], ["leading", "H-DELIVERED", [1]]);
  });
  // After a restart the fresh copy is still the current one.
  await withDesk(config, async (desk) => {
    assert.equal(desk.generation, 2);
    assert.equal(desk.runs().length, 1);
  });
});

test("a reset during a run is refused and changes nothing; a failed reset is an error, never a success", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    await desk.run();
    const running = desk.run();
    await assert.rejects(desk.restartCase(), RunInProgressError);
    await running;
    assert.equal(errorResponse(new RunInProgressError()).status, 409);
    assert.equal(caseWorkers(desk).length, 1);

    // Speck refuses the suspension: the reset fails visibly.
    const transition = desk.runtime.transitionWorker.bind(desk.runtime);
    desk.runtime.transitionWorker = async () => { throw new Error("Speck refused the transition"); };
    const api = deskApi(desk, config, "test");
    await assert.rejects(api.reset(), /Speck refused the transition/);
    assert.equal(errorResponse(new Error("Speck refused the transition")).status, 500);
    desk.runtime.transitionWorker = transition;
  });
});

test("the progress endpoint reports the execution engine's own progress, and nothing when no run has happened", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    assert.deepEqual(api.progress(), { running: false, progress: null });
    const seen: unknown[] = [];
    desk.on("progress", () => seen.push((api.progress() as { running: boolean }).running));
    await desk.run();
    const after = api.progress() as { running: boolean; progress: { runId: string; phase: string; currentChunk: number; maxChunks: number } };
    assert.ok(seen.length > 0 && seen.every((running) => running === true), "reported while the run was going");
    assert.equal(after.running, false);
    assert.equal(after.progress.runId, desk.runs()[0]!.runId);
    assert.equal(after.progress.maxChunks, config.execution.maxChunks);
    assert.ok(after.progress.currentChunk >= 1);
    await api.reset();
    assert.deepEqual(api.progress(), { running: false, progress: null });
  });
});
