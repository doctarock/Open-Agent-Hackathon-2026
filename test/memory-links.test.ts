import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSESSMENT_SCHEMA, RUN_SCHEMA, type EvidenceDesk } from "../src/investigation/desk.js";
import { testConfig, withDesk } from "./helpers.js";

// Evidence Desk links a case's memories in Speck's own association graph
// (reinforceAssociation), so Speck's activation and memory map see how they
// relate. The links change no belief.

function edges(desk: EvidenceDesk) {
  const objects = desk.runtime.mentalObjects.listForWorker(desk.runtime.listWorkers()[0]!.id);
  const label = new Map(objects.map((object) => {
    const data = object.data as { schema?: string; runNumber?: number };
    const evidenceId = object.kind === "evidence" ? String(object.data.source).slice(String(object.data.source).indexOf("/") + 1) : null;
    return [object.id as string, evidenceId ?? (data.schema === RUN_SCHEMA ? `run ${data.runNumber}` : data.schema === ASSESSMENT_SCHEMA ? "assessment" : object.kind)];
  }));
  return {
    objects,
    list: objects.flatMap((object) => object.associations
      .filter((edge) => edge.kind !== "supports" || label.get(edge.targetId)?.startsWith("run") || false)
      .map((edge) => `${label.get(object.id)} -${edge.kind}-> ${label.get(edge.targetId) ?? edge.targetId}`))
  };
}

test("the case's memories are linked in Speck's association graph, once each, without changing any belief", async () => {
  await withDesk(testConfig(), async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const { list, objects } = edges(desk);
    // An assessment is derived from each record it judged.
    assert.ok(list.includes("assessment -derived-from-> EV-OMS-001") && list.includes("assessment -derived-from-> EV-CAR-005"), list.join("\n"));
    // Evidence supports (or contradicts) the conclusion of each run it bore on.
    assert.ok(list.includes("EV-CAR-003 -supports-> run 1"), "the delivery scan supported run 1's leading explanation");
    assert.ok(list.includes("EV-SUP-004 -contradicts-> run 1"), "the complaint counted against it");
    assert.ok(list.includes("EV-CAR-005 -supports-> run 2") && list.includes("EV-SUP-006 -supports-> run 2"));
    assert.ok(!list.includes("EV-CAR-003 -supports-> run 2"), "a replaced record does not support the later conclusion");
    // The correction suppresses the record it replaced.
    assert.ok(list.includes("EV-CAR-005 -inhibitory-> EV-CAR-003"));
    // The memory map shows memories (objects with memory roles) and the links between them.
    const memories = new Set(objects.filter((object) => object.memoryRoles.length > 0).map((object) => object.id as string));
    const shown = objects.filter((object) => memories.has(object.id)).flatMap((object) => object.associations.filter((edge) => memories.has(edge.targetId)));
    assert.ok(shown.length >= 10, `${shown.length} links visible in the memory map`);

    // Running again neither duplicates nor strengthens an existing link (the
    // new run's own memory gets links of its own), and changes no belief.
    const known = new Set(objects.map((object) => object.id as string));
    const snapshot = (list: typeof objects) => JSON.stringify(list.filter((object) => known.has(object.id))
      .map((object) => [object.id, object.associations.filter((edge) => known.has(edge.targetId)).map((edge) => [edge.targetId, edge.kind, edge.strength])]));
    const before = snapshot(objects);
    const beliefs = desk.hypotheses().map((view) => [view.key, view.status, view.confidence]);
    await desk.run();
    const rerun = edges(desk);
    assert.equal(snapshot(rerun.objects), before);
    assert.ok(rerun.list.includes("EV-CAR-005 -supports-> run 3"), "the new run's conclusion is linked too");
    assert.deepEqual(desk.hypotheses().map((view) => [view.key, view.status, view.confidence]), beliefs);
    assert.deepEqual(beliefs, [["H-MISDELIVERED", "supported", 0.7], ["H-NOT-SHIPPED", "rejected", 0.05], ["H-DELIVERED", "rejected", 0.05]]);
  });
});

test("the case's current state is published to Speck's shared memory as one summary, replaced on every change and cleared by a reset", async () => {
  const summaries = (desk: EvidenceDesk) => desk.runtime.mentalObjects.listAll()
    .filter((object) => object.workerId === null && (object.data as { evidenceDeskSummary?: unknown }).evidenceDeskSummary);
  await withDesk(testConfig(), async (desk) => {
    assert.equal(summaries(desk).length, 0, "nothing assessed, nothing published");
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const live = summaries(desk).filter((object) => object.status !== "archived");
    assert.equal(live.length, 1, "one current summary");
    assert.equal(summaries(desk).filter((object) => object.status === "archived").length, 1, "run 1's summary was archived");
    const text = live[0]!.content;
    assert.match(text, /Current conclusion \(after run 2, stage "Carrier proof-of-delivery review \(16 Oct\)"\): The carrier delivered the parcel to the wrong address\. Speck confidence 0\.7/);
    assert.match(text, /EV-CAR-005 \(Carrier tracking API\): "Proof-of-delivery review/);
    assert.match(text, /No longer counts: EV-CAR-003, replaced by its source with EV-CAR-005\./);
    assert.match(text, /History: run 1 at stage "Initial evidence \(14 Oct\)" concluded: Leading, not established: .*; then run 2 .* concluded: The carrier delivered the parcel to the wrong address\./);
    assert.doesNotMatch(text, /Not yet assessed/);
    await desk.restartCase();
    assert.equal(summaries(desk).filter((object) => object.status !== "archived").length, 0, "a reset leaves Speck nothing outdated to recall");
  });
});

test("records a run could not assess are named in the summary, so their absence is not read as no new evidence", async () => {
  let current: EvidenceDesk | null = null;
  const failing = {
    kind: "rules" as const,
    describe: () => ({ kind: "rules" as const, label: "test", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input: { batch: Array<{ id: string }> }) {
      if (input.batch.some((record) => record.id === "EV-CAR-005")) throw new Error("model output unparseable");
      const { ruleJudgments } = await import("../src/reasoning/rules.js");
      return { judgments: Object.fromEntries(input.batch.map((record) => [record.id, ruleJudgments(record as never, current!.scenario.hypotheses)])), notes: [], narrative: "" };
    }
  };
  await withDesk(testConfig(), async (desk) => {
    current = desk;
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const text = desk.caseSummary();
    assert.match(text, /Not yet assessed \(they do not count until a run assesses them\): EV-CAR-005; EV-SUP-006\./);
    assert.match(text, /Leading, not established/);
  }, { reasoner: failing as never });
});
