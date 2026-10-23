import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, rankHypotheses, reviseHypothesis, SpeckRuntime, type MentalObject, type MentalObjectId } from "#speck";
import { EvidenceDesk } from "../src/investigation/desk.js";
import { retireHypothesis, SpeckCompatibilityError } from "../src/investigation/speck-compat.js";
import { tempDir, testConfig, withDesk } from "./helpers.js";

// Evidence Desk retires a replaced hypothesis through Speck's mental-object
// repository, because Speck has no public operation for it
// (src/investigation/speck-compat.ts). These tests pin down every assumption
// that write relies on, so a Speck update that breaks one fails here.

test("a retired hypothesis keeps everything that records what was believed, before and after a reopen", async () => {
  const config = testConfig();
  let before: MentalObject | null = null;
  let retiredId = "";
  await withDesk(config, async (desk) => {
    await desk.run();
    // H-DELIVERED as run 1 left it: it will be replaced when the scan is superseded.
    before = desk.currentHypotheses().get("H-DELIVERED")!;
    retiredId = before.id;
    await desk.introduceNextUpdate();
    await desk.run();
  });
  await withDesk(config, async (desk) => {
    const after = desk.runtime.mentalObjects.get(retiredId as MentalObjectId)!;
    const was = before!;
    assert.equal(after.data.status, "superseded");
    assert.equal(after.status, "superseded");
    assert.equal(after.data.statusWhenReplaced, was.data.status);
    assert.equal(after.data.supersededBy, desk.currentHypotheses().get("H-DELIVERED")!.id);
    for (const field of ["key", "supportingEvidence", "contradictoryEvidence", "revisionHistory", "lastUpdatedAt"]) {
      assert.deepEqual(after.data[field], was.data[field], field);
    }
    assert.equal(after.confidence, was.confidence);
    assert.equal(after.content, was.content);
    assert.equal(after.createdAt, was.createdAt);
    assert.deepEqual(after.provenance, was.provenance);
    // Its revisions are still in Speck's event log, and the worker still lists it.
    const workerId = desk.runtime.listWorkers()[0]!.id;
    const revised = desk.runtime.listEvents(workerId, 0, 1000).filter((event) => event.type === "belief.revised" && (event.payload as { hypothesisId?: string }).hypothesisId === retiredId);
    assert.equal(revised.length, (was.data.revisionHistory as unknown[]).length);
    assert.ok(desk.runtime.getWorker(workerId)!.hypotheses.includes(retiredId as MentalObjectId));
    // Not current: it appears only in the history.
    assert.ok(desk.replacedHypotheses().some((item) => item.id === retiredId));
    assert.ok(!desk.hypotheses().some((view) => view.statement === was.content && view.status === "superseded"));
  });
});

test("retiring is idempotent and refuses anything that is not a hypothesis", async () => {
  await withDesk(testConfig(), async (desk) => {
    await desk.run();
    const hypothesis = desk.currentHypotheses().get("H-NOT-SHIPPED")!;
    const first = retireHypothesis(desk.runtime, hypothesis.id, null, "2026-10-22T00:00:00.000Z");
    const second = retireHypothesis(desk.runtime, hypothesis.id, "other", "2026-10-23T00:00:00.000Z");
    assert.deepEqual(second, first, "a second retirement changes nothing");
    const evidence = desk.runtime.mentalObjects.listForWorker(desk.runtime.listWorkers()[0]!.id).find((object) => object.kind === "evidence")!;
    assert.throws(() => retireHypothesis(desk.runtime, evidence.id, null, "2026-10-22T00:00:00.000Z"), SpeckCompatibilityError);
    assert.throws(() => retireHypothesis(desk.runtime, "missing" as MentalObjectId, null, "2026-10-22T00:00:00.000Z"), /could not be read back/);
  });
});

test("Speck treats a superseded hypothesis as terminal and ranks it below live ones", () => {
  const config = loadConfig().beliefRevision;
  const superseded = {
    id: "h1", kind: "hypothesis", content: "old", confidence: 0.5, createdAt: "2026-01-01T00:00:00.000Z",
    data: { status: "superseded", supportingEvidence: [], contradictoryEvidence: [], revisionHistory: [] }
  } as unknown as MentalObject;
  // Further revision cannot revive it.
  const revised = reviseHypothesis({ hypothesis: superseded, evidenceId: "e1" as MentalObjectId, relation: { hypothesisId: "h1" as MentalObjectId, direction: "supports" }, reliability: 1, source: "test", at: "2026-01-02T00:00:00.000Z", config });
  assert.equal(revised.hypothesis.data.status, "superseded");
  // At equal confidence a live hypothesis ranks first.
  const live = { ...superseded, id: "h2", data: { ...superseded.data, status: "active" } } as unknown as MentalObject;
  assert.deepEqual(rankHypotheses([superseded, live]).map((object) => object.id), ["h2", "h1"]);
});

// Speck's background cognition runs over every worker, including a case's
// when Evidence Desk runs inside Speck. Its embedding job reads a worker's
// objects, awaits the embeddings, then writes the objects back whole.
// encodeTexts is held open here so the two can be interleaved on purpose.
function holdEmbeddings(runtime: SpeckRuntime) {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const memory = runtime.memory as unknown as { encodeTexts: (...args: unknown[]) => Promise<unknown> };
  const original = memory.encodeTexts.bind(runtime.memory);
  memory.encodeTexts = async (...args: unknown[]) => { entered(); await gate; return original(...args); };
  return { started, release: () => release() };
}

test("Speck's background embedding job overwrites a belief revised while it waits (why Evidence Desk takes the foreground lease)", async () => {
  const runtime = new SpeckRuntime({ databasePath: `${tempDir()}/speck.sqlite` });
  await runtime.initialize();
  try {
    const worker = await runtime.createWorker("A question", [], {});
    const hypothesis = await runtime.proposeHypothesis({ workerId: worker.id, content: "An answer", confidence: 0.5 });
    const held = holdEmbeddings(runtime);
    const background = runtime.runBackgroundCognition();
    await held.started;
    // Revised while the background job holds a stale copy...
    await runtime.recordEvidence({ workerId: worker.id, content: "support", source: "test/support", reliability: 1, supports: [hypothesis.id] });
    assert.equal(runtime.mentalObjects.get(hypothesis.id)!.confidence, 0.7);
    held.release();
    await background;
    // ...and the stale copy is written back.
    assert.equal(runtime.mentalObjects.get(hypothesis.id)!.confidence, 0.5);
  } finally {
    runtime.close();
  }
});

test("inside Speck, a case's revisions are never lost to background cognition, and the case worker never blocks it", async () => {
  const reference = await withDesk(testConfig(), async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    return desk.hypotheses();
  });
  const runtime = new SpeckRuntime({ databasePath: `${tempDir()}/speck.sqlite` });
  await runtime.initialize();
  try {
    const desk = await EvidenceDesk.attach(runtime, testConfig());
    // The case is waiting on evidence: not queued, so it does not hold back
    // background cognition for Speck's other workers.
    assert.equal(desk.runtime.getWorker(runtime.listWorkers()[0]!.id)!.status, "waiting");
    await desk.run();
    await desk.introduceNextUpdate();
    // A background slice is mid-way through its embedding job when run 2 starts.
    const held = holdEmbeddings(runtime);
    const background = runtime.runBackgroundCognition();
    await held.started;
    const run = desk.run();
    // While run 2 waits for it, no new slice may start.
    setTimeout(() => held.release(), 20);
    await background;
    await run;
    const during = await (async () => {
      const blocked = desk.run().catch(() => null);
      const slice = await runtime.runBackgroundCognition();
      await blocked;
      return slice;
    })();
    assert.equal(during.status, "deferred", "background cognition waits while the case is being revised");
    assert.equal(desk.conclusionFromSpeck().reconciled, true);
    assert.deepEqual(desk.hypotheses(), reference);
    // Afterwards, background cognition runs over the case as over any worker.
    const after = await runtime.runBackgroundCognition();
    assert.notEqual(after.status, "deferred");
    assert.deepEqual(desk.hypotheses(), reference);
    desk.close();
    assert.ok(runtime.listWorkers().length >= 1, "closing the desk leaves Speck's runtime open");
  } finally {
    runtime.close();
  }
});
