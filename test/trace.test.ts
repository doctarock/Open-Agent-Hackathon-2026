import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSnapshot } from "../src/investigation/desk.js";
import { RUN_SCHEMA, type EvidenceDesk } from "../src/investigation/desk.js";
import type { RunTrace, TraceStep } from "../src/investigation/trace.js";
import { createServer } from "../src/server.js";
import { testConfig, withDesk } from "./helpers.js";

// The execution trace is read back from persisted state only. These tests
// check it against that state directly: the run snapshots, the Meterless
// engine's own record, Speck's event log, and the saved assessments.

const runs = (desk: EvidenceDesk) => desk.trace().filter((entry): entry is RunTrace => entry.kind === "run");
const chunks = (run: RunTrace) => run.steps.filter((step): step is Extract<TraceStep, { kind: "chunk" }> => step.kind === "chunk");
const revisedEvents = (desk: EvidenceDesk, correlationId: string) =>
  desk.runtime.listEvents(desk.runtime.listWorkers()[0]!.id, 0, 1000).filter((event) => event.type === "belief.revised" && event.correlationId === correlationId);

test("the trace of a fixture run names each component's actual work, and agrees with persisted state after a reopen", async () => {
  const config = testConfig();
  let before: ReturnType<EvidenceDesk["trace"]> | null = null;
  await withDesk(config, async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const [first, second] = runs(desk);
    const snapshots = desk.runs();
    assert.equal(runs(desk).length, 2);

    // Evidence: the fixture file, labelled as not Zetaris, with no query tokens.
    assert.equal(first!.evidence?.mode, "fixture");
    assert.equal(first!.evidence?.label, "Local fixtures (not Zetaris)");
    assert.deepEqual(first!.evidence?.sources.map((source) => [source.location, source.queryToken]), [["fixtures/scenarios/disputed-delivery/evidence.json", null]]);
    assert.deepEqual([first!.evidence?.visible, second!.evidence?.visible], [4, 6]);

    // Meterless: the engine's own run id, confirmed in its history.json.
    for (const [trace, snapshot] of [[first!, snapshots[0]!], [second!, snapshots[1]!]] as const) {
      assert.equal(trace.meterless?.runId, snapshot.execution.runId);
      assert.equal(trace.meterless?.chunks, snapshot.execution.chunks.length);
      assert.equal(trace.meterless?.inHistory, true);
      assert.match(trace.meterless!.engine, /@meterless\/markovian-reference@0\.1\.0, upstream commit 1742dec/);
      assert.equal(trace.reasoner?.kind, "rules");
    }

    // Each chunk is a Meterless step; its records are the ones Speck then recorded.
    assert.deepEqual(chunks(first!).map((step) => [step.chunk, step.records, step.speck.recorded, step.meterless !== null, step.model]), [
      [1, ["EV-OMS-001", "EV-WMS-002"], ["EV-OMS-001", "EV-WMS-002"], true, null],
      [2, ["EV-CAR-003", "EV-SUP-004"], ["EV-CAR-003", "EV-SUP-004"], true, null]
    ]);
    assert.equal(chunks(first!)[1]!.meterless?.carryoverIn, true, "the second step received the first step's carryover");
    // Speck: every belief revision in the run's event log is in the trace, once.
    for (const [trace, snapshot] of [[first!, snapshots[0]!], [second!, snapshots[1]!]] as const) {
      const traced = trace.steps.flatMap((step) => ("speck" in step ? step.speck.revisions : []));
      assert.equal(traced.length, revisedEvents(desk, snapshot.runId).length);
      assert.equal(trace.flags.revisions, traced.length);
    }
    // Run 2 rebuilt hypotheses (EV-CAR-003 superseded): the recomputation is attributed to its chunk.
    assert.deepEqual(second!.flags.recomputations, [1]);
    assert.deepEqual(chunks(second!)[0]!.speck.recomputations, [1]);
    assert.ok(chunks(first!)[1]!.speck.revisions.some((revision) => revision.historical), "run 1's revisions to since-replaced beliefs are marked");
    before = desk.trace();
  });
  await withDesk(config, async (desk) => {
    assert.deepEqual(desk.trace(), before, "the trace after a restart is the same, read from the same persisted state");
    // The API serves the same trace.
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/trace`)).json() as any;
      assert.deepEqual(body.entries, JSON.parse(JSON.stringify(before)));
      assert.equal(body.engine.commit, "1742dec56a66e58eef9dda2d2b865823758ca8cd");
    } finally {
      server.close();
    }
  });
});

test("withdrawals, exclusions and recovery appear as Evidence Desk actions; an interrupted run appears as interrupted", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    // Run 2 dies after recording EV-CAR-005 and before saving its snapshot.
    let calls = 0;
    const recordEvidence = desk.runtime.recordEvidence.bind(desk.runtime);
    desk.runtime.recordEvidence = async (input) => { if (++calls === 2) throw new Error("simulated crash"); return recordEvidence(input); };
    desk.runtime.reviseHypothesesFromEvidence = async () => { throw new Error("simulated crash"); };
    const recordMemory = desk.runtime.recordMemory.bind(desk.runtime);
    desk.runtime.recordMemory = async (input) => { if (input.data?.schema === RUN_SCHEMA) throw new Error("process died"); return recordMemory(input); };
    await assert.rejects(desk.run());
  });
  await withDesk(config, async (desk) => {
    // Reopening repaired beliefs: that is Evidence Desk's recovery, not a sponsor's.
    const entries = desk.trace();
    const interrupted = entries.find((entry): entry is RunTrace => entry.kind === "run" && entry.status === "interrupted")!;
    assert.equal(interrupted.runNumber, null);
    assert.equal(interrupted.meterless, null, "Meterless never recorded the interrupted run");
    assert.deepEqual(chunks(interrupted).map((step) => [step.records, step.meterless]), [[["EV-CAR-005", "EV-SUP-006"], null]]);
    const recovery = entries.find((entry) => entry.kind === "action" && entry.action === "recovery");
    assert.ok(recovery && recovery.kind === "action" && recovery.by === "Evidence Desk" && recovery.speck.revisions.length > 0);

    const run = await desk.run();
    const latest = runs(desk).at(-1)!;
    assert.deepEqual(latest.flags.recovered, run.recovered);
    assert.equal(latest.flags.recovered.length, 1);

    await desk.withdrawRecord("EV-SUP-006", "duplicate call");
    const withdrawal = desk.trace().at(-1)!;
    assert.ok(withdrawal.kind === "action" && withdrawal.action === "withdrawal" && withdrawal.recordId === "EV-SUP-006" && withdrawal.speck.revisions.length > 0);
  });
});

test("a Meterless run is matched in the engine's history by its timestamp, not only its per-process id", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const config = testConfig();
  await withDesk(config, async (desk) => {
    await desk.run();
    const file = path.join(config.historyDir, "history.json");
    const genuine = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ id: string; timestamp: number }>;
    const runId = desk.runs()[0]!.execution.runId;
    assert.equal(runs(desk)[0]!.meterless?.inHistory, true);
    // A run from another process with the same id (the engine restarts at run-1) is not this run.
    const decoy = genuine.map((entry) => ({ ...entry, timestamp: entry.timestamp - 60_000 }));
    fs.writeFileSync(file, JSON.stringify(decoy));
    assert.equal(decoy[0]!.id, runId);
    assert.equal(runs(desk)[0]!.meterless?.inHistory, false);
    // With both present, the genuine entry is found.
    fs.writeFileSync(file, JSON.stringify([...decoy, ...genuine]));
    assert.equal(runs(desk)[0]!.meterless?.inHistory, true);
    // An unreadable history is reported as unknown, not as present.
    fs.rmSync(file);
    assert.equal(runs(desk)[0]!.meterless?.inHistory, null);
  });
});

test("an exclusion before assessment is its own action, not part of the previous run", async () => {
  await withDesk(testConfig(), async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.withdrawRecord("EV-SUP-006", "duplicate call");
    const entries = desk.trace();
    const exclusion = entries.at(-1)!;
    assert.ok(exclusion.kind === "action" && exclusion.action === "withdrawal-before-assessment" && exclusion.recordId === "EV-SUP-006");
    assert.deepEqual(exclusion.kind === "action" ? exclusion.speck.revisions : null, []);
    // Run 1's trace is unchanged by it.
    const run1 = runs(desk)[0]!;
    assert.equal(run1.steps.length, chunks(run1).length);
    const snapshot = desk.runs()[0] as RunSnapshot;
    assert.equal(run1.flags.revisions, revisedEvents(desk, snapshot.runId).length);
  });
});
