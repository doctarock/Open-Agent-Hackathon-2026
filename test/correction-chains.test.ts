import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { testConfig, withDesk, writeScenario } from "./helpers.js";

// Correction chains. A delivery scan is amended, and the amendment amended
// again. One independent record refutes H-LOST throughout; no correction
// touches it, so its hypothesis must never be rebuilt. Carrier reliability
// 0.85, so each supporting scan adds 0.17.

const record = (id: string, observedAt: string, facts: Record<string, string>, supersedes: string[] = []) => ({
  id, caseId: "CASE-CHAIN", source: { system: "carrier", name: "Carrier" }, observedAt, content: id, facts,
  provenance: { systemOfRecord: "Carrier", recordRef: id, author: "test", supersedes }
});

// finalSupersedes: what the second amendment S3 says it replaces.
function chainScenario(finalSupersedes: string[]): string {
  return writeScenario({
    id: "chain", caseId: "CASE-CHAIN", title: "Chain", question: "Where was the parcel left?",
    sources: { carrier: { name: "Carrier", reliability: 0.85 } },
    hypotheses: [
      { key: "H-FRONT", statement: "Left at the front door.", prior: 0.3, rules: [{ fact: "left", equals: "front", direction: "supports" }] },
      { key: "H-NEIGHBOUR", statement: "Left with a neighbour.", prior: 0.3, rules: [{ fact: "left", equals: "neighbour", direction: "supports" }] },
      { key: "H-LOCKER", statement: "Left in a parcel locker.", prior: 0.3, rules: [{ fact: "left", equals: "locker", direction: "supports" }] },
      { key: "H-LOST", statement: "Lost before delivery.", prior: 0.2, rules: [{ fact: "handover", equals: "true", direction: "contradicts", decisive: true }] }
    ],
    questions: [],
    stages: [
      { id: "scan", label: "Scan", asOf: "2026-04-02T00:00:00Z", description: "" },
      { id: "amended", label: "Amended", asOf: "2026-04-04T00:00:00Z", description: "" },
      { id: "amended-again", label: "Amended again", asOf: "2026-04-06T00:00:00Z", description: "" }
    ]
  }, [
    record("I1", "2026-04-01T00:00:00Z", { handover: "true" }),
    record("S1", "2026-04-01T06:00:00Z", { left: "front" }),
    record("S2", "2026-04-03T00:00:00Z", { left: "neighbour" }, ["S1"]),
    record("S3", "2026-04-05T00:00:00Z", { left: "locker" }, finalSupersedes)
  ]);
}

const support = (desk: EvidenceDesk) => Object.fromEntries(desk.hypotheses().map((view) => [view.key, `${view.status} ${view.confidence} +[${view.supporting.map((ref) => ref.recordId)}] -[${view.contradicting.map((ref) => ref.recordId)}]`]));
const lostId = (desk: EvidenceDesk) => desk.currentHypotheses().get("H-LOST")!.id;

async function through(desk: EvidenceDesk, stageId: string): Promise<void> {
  while (desk.currentStage().id !== stageId) await desk.introduceNextUpdate();
  await desk.run();
}

test("replacement of a replacement: only the latest valid record in the chain counts", async () => {
  // S3 replaces S2 and, as stated, S1 too: only S3 counts.
  await withDesk(testConfig({ scenarioDir: chainScenario(["S2", "S1"]) }), async (desk) => {
    await through(desk, "scan");
    const lost = lostId(desk);
    await through(desk, "amended");
    await through(desk, "amended-again");
    assert.deepEqual(support(desk), {
      "H-LOCKER": "active 0.47 +[S3] -[]", "H-FRONT": "proposed 0.3 +[] -[]", "H-NEIGHBOUR": "proposed 0.3 +[] -[]", "H-LOST": "rejected 0.05 +[] -[I1]"
    });
    assert.deepEqual(desk.conclusionFromSpeck().noLongerCounted.map((item) => item.reason), ["S1 superseded by S3", "S2 superseded by S3"]);
    assert.equal(lostId(desk), lost, "the independent refutation was never rebuilt");
    // Each step is in the history: H-FRONT lost S1, then H-NEIGHBOUR lost S2.
    assert.deepEqual(desk.recomputations().map((item) => item.hypotheses.map((entry) => `${entry.key}: ${entry.cause}`)), [["H-FRONT: S1 superseded by S2"], ["H-NEIGHBOUR: S2 superseded by S3"]]);
    assert.deepEqual(desk.replacedHypotheses().map((item) => `${item.key} ${item.statusWhenReplaced} ${item.confidence}`), ["H-FRONT active 0.47", "H-NEIGHBOUR active 0.47"]);
  });
  // S3 replaces only S2. S2 no longer counts, so its claim on S1 lapses, but
  // S1 still does not count: the same carrier system now reports "left" as
  // locker (S3), so S1's "front" is out of date. (Build 3 counted S1 again;
  // the lapse itself is tested without facts in revision.test.ts.)
  await withDesk(testConfig({ scenarioDir: chainScenario(["S2"]) }), async (desk) => {
    await through(desk, "amended");
    await through(desk, "amended-again");
    assert.deepEqual(support(desk), {
      "H-FRONT": "proposed 0.3 +[] -[]", "H-LOCKER": "active 0.47 +[S3] -[]", "H-NEIGHBOUR": "proposed 0.3 +[] -[]", "H-LOST": "rejected 0.05 +[] -[I1]"
    });
    assert.deepEqual(desk.conclusionFromSpeck().noLongerCounted.map((item) => item.reason), [
      "S1 out of date: its source now reports left=locker (S3, was front)", "S2 superseded by S3"
    ]);
  });
});

test("withdrawing a replacement reinstates what it replaced; withdrawing it again changes nothing", async () => {
  await withDesk(testConfig({ scenarioDir: chainScenario(["S2", "S1"]) }), async (desk) => {
    await through(desk, "scan");
    const lost = lostId(desk);
    await through(desk, "amended");
    assert.equal(support(desk)["H-NEIGHBOUR"], "active 0.47 +[S2] -[]");
    const recomputation = await desk.withdrawRecord("S2", "Scan belonged to a different parcel");
    // H-NEIGHBOUR is rebuilt without S2. H-FRONT needs no rebuild (it carried
    // nothing), but S1 applying again is still recorded, with its cause.
    assert.deepEqual(recomputation?.hypotheses.map((entry) => `${entry.key} ${entry.mode}: ${entry.cause}`), [
      "H-NEIGHBOUR replaced: S2 withdrawn (Scan belonged to a different parcel)", "H-FRONT extended: S1 counts again"
    ]);
    assert.deepEqual(support(desk), {
      "H-FRONT": "active 0.47 +[S1] -[]", "H-NEIGHBOUR": "proposed 0.3 +[] -[]", "H-LOCKER": "proposed 0.3 +[] -[]", "H-LOST": "rejected 0.05 +[] -[I1]"
    });
    assert.equal(lostId(desk), lost);

    // Repeated withdrawal: nothing is recorded, recomputed or changed, and the first reason stands.
    const workerId = desk.runtime.listWorkers()[0]!.id;
    const events = desk.runtime.listEvents(workerId, 0, 1000).length;
    const state = support(desk);
    assert.equal(await desk.withdrawRecord("S2", "a different reason"), null);
    assert.equal(desk.runtime.listEvents(workerId, 0, 1000).length, events);
    assert.equal(desk.recomputations().length, 2);
    assert.deepEqual(support(desk), state);
    assert.match((await desk.listEvidence()).records.find((item) => item.id === "S2")!.invalidation!.kind === "withdrawn"
      ? desk.conclusionFromSpeck().noLongerCounted.find((item) => item.recordId === "S2")!.reason : "", /Scan belonged to a different parcel/);

    // The full history stays auditable: H-FRONT as S1 left it, and H-NEIGHBOUR as S2 left it.
    assert.deepEqual(desk.replacedHypotheses().map((item) => `${item.key} ${item.statusWhenReplaced} ${item.confidence} r${item.recomputation}`).sort(),
      ["H-FRONT active 0.47 r1", "H-NEIGHBOUR active 0.47 r2"]);
    const timeline = desk.timeline();
    assert.ok(timeline.some((entry) => entry.title === "S2 withdrawn from the case"));
    assert.ok(timeline.filter((entry) => entry.kind === "revision" && entry.recordId === "S2").every((entry) => entry.historical), "S2's revision is history only");

    // A later correction to a withdrawn record changes nothing about it: S3 replaces S2 and S1, so S1 stops counting again.
    await through(desk, "amended-again");
    assert.deepEqual(support(desk), {
      "H-LOCKER": "active 0.47 +[S3] -[]", "H-FRONT": "proposed 0.3 +[] -[]", "H-NEIGHBOUR": "proposed 0.3 +[] -[]", "H-LOST": "rejected 0.05 +[] -[I1]"
    });
    assert.deepEqual(desk.conclusionFromSpeck().noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["S1", "superseded"], ["S2", "withdrawn"]]);
    assert.equal(lostId(desk), lost);
  });
});
