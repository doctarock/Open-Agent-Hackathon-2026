import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { RUN_SCHEMA, type EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { testConfig, withDesk } from "./helpers.js";

// Crash recovery. A run's judgments are saved in Speck per chunk, before its
// evidence enters the ledger; reopening reconciles current beliefs with the
// ledger. Each test interrupts a run, "restarts" by reopening the database,
// and compares the result with an uninterrupted run on the same evidence.

function beliefs(desk: EvidenceDesk) {
  return Object.fromEntries(desk.hypotheses().map((view) => [view.key, {
    status: view.status, confidence: view.confidence,
    supporting: view.supporting.map((ref) => ref.recordId), contradicting: view.contradicting.map((ref) => ref.recordId)
  }]));
}

async function reference(stages: number): Promise<ReturnType<typeof beliefs>> {
  return withDesk(testConfig(), async (desk) => {
    await desk.run();
    for (let stage = 1; stage < stages; stage += 1) { await desk.introduceNextUpdate(); await desk.run(); }
    return beliefs(desk);
  });
}

const evidenceObjects = (desk: EvidenceDesk) => desk.runtime.mentalObjects.listForWorker(desk.runtime.listWorkers()[0]!.id).filter((object) => object.kind === "evidence");

// Simulates the process dying: Speck calls start failing at the chosen point,
// and the run snapshot is never written.
function crash(desk: EvidenceDesk, method: "recordEvidence" | "reviseHypothesesFromEvidence", afterCalls: number): void {
  const runtime = desk.runtime as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = runtime[method]!.bind(desk.runtime);
  let calls = 0;
  runtime[method] = async (...args) => { if (++calls > afterCalls) throw new Error("simulated crash"); return original(...args); };
  const recordMemory = desk.runtime.recordMemory.bind(desk.runtime);
  desk.runtime.recordMemory = async (input) => { if (input.data?.schema === RUN_SCHEMA) throw new Error("process died"); return recordMemory(input); };
}

test("a run interrupted mid-chunk loses no judgment: reopening and rerunning gives the uninterrupted result", async () => {
  const expected = await reference(1);
  const config = testConfig();
  await withDesk(config, async (desk) => {
    crash(desk, "recordEvidence", 3);
    await assert.rejects(desk.run(), /process died/);
    assert.equal(desk.runs().length, 0, "no snapshot was saved");
    const listing = await desk.listEvidence();
    // Three records entered the ledger, each with its judgments saved first.
    assert.deepEqual(listing.records.map((record) => [record.id, record.status]),
      [["EV-OMS-001", "completed"], ["EV-WMS-002", "completed"], ["EV-CAR-003", "completed"], ["EV-SUP-004", "pending"]]);
    assert.equal(listing.records.find((record) => record.id === "EV-SUP-004")!.lastAttempt?.outcome, "judged", "judged, but the run died before recording it");
  });
  await withDesk(config, async (desk) => {
    // After the restart the three recorded records still count, with their own judgments.
    assert.deepEqual(desk.hypotheses().find((view) => view.key === "H-NOT-SHIPPED")!.contradicting.map((ref) => ref.recordId), ["EV-WMS-002", "EV-CAR-003"]);
    const run = await desk.run();
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["EV-SUP-004"], "only the unrecorded record is assessed again");
    assert.ok(run.notes.some((note) => /Recovered 1 interrupted run.*EV-OMS-001, EV-WMS-002, EV-CAR-003.*assessed again: EV-SUP-004/.test(note)), run.notes.join(" | "));
    assert.deepEqual(beliefs(desk), expected);
    assert.equal(evidenceObjects(desk).length, 4, "no record was recorded twice");
    // Retrying again is idempotent, and the interruption is reported once.
    const again = await desk.run();
    assert.deepEqual(again.assessed, []);
    assert.ok(!again.notes.some((note) => /Recovered/.test(note)));
    assert.deepEqual(beliefs(desk), expected);
    assert.equal(evidenceObjects(desk).length, 4);
  });
});

test("a run interrupted during reconciliation is flagged as unreconciled, then repaired on reopen", async () => {
  const expected = await reference(2);
  const config = testConfig();
  let partial: ReturnType<typeof beliefs> | null = null;
  await withDesk(config, async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    // Run 2 replaces H-DELIVERED and H-NOT-SHIPPED; let one replay call through, then die.
    crash(desk, "reviseHypothesesFromEvidence", 1);
    await assert.rejects(desk.run(), /process died/);
    const conclusion = desk.conclusionFromSpeck();
    assert.equal(conclusion.reconciled, false);
    assert.match(conclusion.uncertainty.notes[0]!, /do not yet reflect every recorded judgment/);
    partial = beliefs(desk);
  });
  assert.notDeepEqual(partial, expected, "the crash really left beliefs behind the ledger");
  await withDesk(config, async (desk) => {
    // Opening reconciles: the half-replayed replacements are completed, not
    // replaced again, and the repair is recorded as such.
    assert.equal(desk.conclusionFromSpeck().reconciled, true);
    assert.deepEqual(beliefs(desk), expected);
    // A recomputation record is written before its relations are applied, so
    // the crashed process's end-of-run retry is recorded as an attempt, and
    // the repair on reopen as its own record.
    const recomputations = desk.recomputations();
    assert.deepEqual(recomputations[0]!.hypotheses.map((entry) => entry.mode), ["replaced", "replaced"]);
    assert.deepEqual(recomputations.slice(1).map((item) => item.trigger), ["end of run", "recovery on open"]);
    assert.ok(recomputations.slice(1).every((item) => item.hypotheses.every((entry) => entry.mode === "extended" && /applied after an interrupted run/.test(entry.cause))));
    assert.deepEqual(desk.replacedHypotheses().map((item) => item.key).sort(), ["H-DELIVERED", "H-NOT-SHIPPED"]);
    await desk.run();
    assert.deepEqual(beliefs(desk), expected);
    assert.equal(desk.recomputations().length, 3, "nothing further to repair");
  });
});

test("assessments are pending, failed or completed, and a failed one is retried", async () => {
  const config = testConfig();
  const failing: Reasoner = {
    kind: "rules",
    describe: () => ({ kind: "rules", label: "failing", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess() { throw new Error("assessor unavailable"); }
  };
  await withDesk(config, async (desk) => {
    assert.deepEqual((await desk.listEvidence()).records.map((record) => record.status), ["pending", "pending", "pending", "pending"]);
    const run = await desk.run();
    assert.equal(run.execution.status, "errored");
    const listing = await desk.listEvidence();
    // The first chunk failed; the second was never reached.
    assert.deepEqual(listing.records.map((record) => [record.id, record.status, record.lastAttempt?.error ?? null]), [
      ["EV-OMS-001", "failed", "assessor unavailable"], ["EV-WMS-002", "failed", "assessor unavailable"],
      ["EV-CAR-003", "pending", null], ["EV-SUP-004", "pending", null]
    ]);
    assert.deepEqual(listing.pending, ["EV-OMS-001", "EV-WMS-002", "EV-CAR-003", "EV-SUP-004"]);
    assert.equal(evidenceObjects(desk).length, 0, "a failed assessment never enters the ledger");
  }, { reasoner: failing });
  await withDesk(config, async (desk) => {
    await desk.run();
    const listing = await desk.listEvidence();
    assert.deepEqual(listing.records.map((record) => record.status), ["completed", "completed", "completed", "completed"]);
    assert.deepEqual(listing.pending, []);
    assert.deepEqual(beliefs(desk), await reference(1));
  });
});

