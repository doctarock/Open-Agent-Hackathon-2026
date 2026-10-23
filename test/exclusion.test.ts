import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSESSMENT_SCHEMA, type AssessmentAttempt, type EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { testConfig, withDesk } from "./helpers.js";

// Withdrawal before assessment. A record that is not in Speck's evidence
// ledger (pending, or failed) can be withdrawn: it is excluded from
// assessment, no judgment is recorded or invented for it, and beliefs do not
// change. Without this, one record whose assessment always fails stalls every
// later record in the case.

// Rules, except that any chunk holding one of `failing` fails.
function failingOn(desk: () => EvidenceDesk, ...failing: string[]): Reasoner {
  return {
    kind: "rules",
    describe: () => ({ kind: "rules", label: "test", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      if (input.batch.some((record) => failing.includes(record.id))) throw new Error("model output unparseable");
      return { judgments: Object.fromEntries(input.batch.map((record) => [record.id, ruleJudgments(record, desk().scenario.hypotheses)])), notes: [], narrative: "" };
    }
  };
}

const beliefs = (desk: EvidenceDesk) => desk.hypotheses().map((view) => `${view.key} ${view.status} ${view.confidence} +[${view.supporting.map((ref) => ref.recordId)}] -[${view.contradicting.map((ref) => ref.recordId)}]`).sort();
const ledgerIds = (desk: EvidenceDesk) => desk.runtime.mentalObjects.listForWorker(desk.runtime.listWorkers()[0]!.id).filter((object) => object.kind === "evidence").map((object) => String(object.data.source).split("/").pop()).sort();
const judgedIds = (desk: EvidenceDesk) => desk.runtime.mentalObjects.listForWorker(desk.runtime.listWorkers()[0]!.id)
  .filter((object) => object.data.schema === ASSESSMENT_SCHEMA).flatMap((object) => (object.data as unknown as AssessmentAttempt).judged.map((item) => item.record.id));

test("a record whose assessment always fails stalls the case until it is withdrawn before assessment", async () => {
  let current: EvidenceDesk | null = null;
  await withDesk(testConfig(), async (desk) => {
    current = desk;
    // Every run fails on the first chunk, taking EV-OMS-001 with it; the rest are never reached.
    for (let run = 0; run < 2; run += 1) assert.equal((await desk.run()).execution.status, "errored");
    assert.deepEqual((await desk.listEvidence()).records.map((record) => record.status), ["failed", "failed", "pending", "pending"]);

    const before = beliefs(desk);
    assert.equal(await desk.withdrawRecord("EV-WMS-002", "warehouse export is unparseable"), null, "nothing to recompute");
    assert.deepEqual(beliefs(desk), before, "withdrawing an unassessed record changes no belief");
    const listed = (await desk.listEvidence()).records.find((record) => record.id === "EV-WMS-002")!;
    assert.equal(listed.status, "withdrawn");
    assert.deepEqual([listed.invalidation?.kind, listed.assessed, listed.assessment], ["withdrawn", false, null]);
    assert.ok(desk.timeline().some((entry) => entry.title === "EV-WMS-002 withdrawn before assessment" && /model output unparseable/.test(entry.detail)));

    // The case is unblocked: the next run assesses everything else.
    const run = await desk.run();
    assert.equal(run.execution.status, "completed");
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["EV-OMS-001", "EV-CAR-003", "EV-SUP-004"]);
    assert.deepEqual((await desk.listEvidence()).pending, []);
    // No judgment exists for it anywhere, and it never entered Speck's ledger.
    assert.ok(!judgedIds(desk).includes("EV-WMS-002"));
    assert.deepEqual(ledgerIds(desk), ["EV-CAR-003", "EV-OMS-001", "EV-SUP-004"]);
    // The handover's decisive refutation is absent, and nothing was invented in
    // its place: only the delivery scan counts against H-NOT-SHIPPED.
    assert.deepEqual(desk.hypotheses().find((view) => view.key === "H-NOT-SHIPPED")!.contradicting.map((ref) => [ref.recordId, ref.judgment?.decisive]), [["EV-CAR-003", false]]);
    // Withdrawing it again is a no-op; an unknown record is refused.
    const events = desk.runtime.listEvents(desk.runtime.listWorkers()[0]!.id, 0, 1000).length;
    assert.equal(await desk.withdrawRecord("EV-WMS-002", "again"), null);
    assert.equal(desk.runtime.listEvents(desk.runtime.listWorkers()[0]!.id, 0, 1000).length, events);
    await assert.rejects(desk.withdrawRecord("EV-NOPE-999", "x"), /not evidence available in this case/);
  }, { reasoner: failingOn(() => current!, "EV-WMS-002") });
});

test("a correction withdrawn before assessment supersedes nothing", async () => {
  // EV-CAR-005 would supersede EV-CAR-003. Withdrawn unassessed, it must not.
  const config = testConfig();
  let current: EvidenceDesk | null = null;
  const expected = await withDesk(testConfig(), async (desk) => { await desk.run(); return beliefs(desk); });
  await withDesk(config, async (desk) => {
    current = desk;
    await desk.run();
    await desk.introduceNextUpdate();
    assert.equal((await desk.run()).execution.status, "errored");
    await desk.withdrawRecord("EV-CAR-005", "proof-of-delivery review was for another parcel");
    await desk.withdrawRecord("EV-SUP-006", "duplicate call");
    await desk.run();
    const listing = await desk.listEvidence();
    assert.equal(listing.records.find((record) => record.id === "EV-CAR-003")!.invalidation, null, "EV-CAR-003 still counts");
    assert.deepEqual(desk.conclusionFromSpeck().noLongerCounted, []);
    assert.deepEqual(beliefs(desk), expected, "the same beliefs as before the update arrived");
  }, { reasoner: failingOn(() => current!, "EV-CAR-005") });
});
