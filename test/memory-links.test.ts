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
