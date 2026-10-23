import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { EvidenceRecord } from "../src/evidence/types.js";
import { addUserEvidence, createUserCase, listUserCases, UserCaseError } from "../src/investigation/user-cases.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { loadScenario } from "../src/scenario.js";
import { tempDir, testConfig, withDesk } from "./helpers.js";

// Investigations a person creates from the Evidence tab: ordinary scenarios
// in their own folders, investigated by the same pipeline.

const input = {
  title: "Missing laptop return",
  question: "The customer says they returned laptop SN-4471; the warehouse has no record. Was it returned?",
  explanations: ["The laptop was returned and lost at the warehouse.", "The laptop was never sent back."],
  evidence: [{ source: "Courier", content: "Pickup of a parcel from the customer on 3 Oct, weight 2.1 kg.", observedAt: "2026-10-03T09:00:00Z" }]
};

test("a new investigation is validated and written as an ordinary scenario, numbered in order", () => {
  const dir = tempDir();
  for (const [bad, message] of [
    [{ ...input, title: " " }, /A title is required/],
    [{ ...input, explanations: ["Only one"] }, /at least two/],
    [{ ...input, explanations: ["A", "a"] }, /must differ/],
    [{ ...input, explanations: ["1", "2", "3", "4", "5", "6"] }, /at most five/],
    [{ ...input, evidence: [{ source: "X", content: "Y", observedAt: "not a date" }] }, /not a valid date/]
  ] as const) {
    assert.throws(() => createUserCase(dir, bad), (error: unknown) => error instanceof UserCaseError && message.test((error as Error).message));
  }
  assert.deepEqual(listUserCases(dir), [], "a refused investigation leaves nothing behind");
  const first = createUserCase(dir, input);
  const second = createUserCase(dir, { ...input, title: "Second" });
  assert.deepEqual([first.id, second.id], ["my-1", "my-2"]);
  const scenario = loadScenario(first.scenarioDir);
  assert.equal(scenario.caseId, "MY-1");
  assert.deepEqual(scenario.hypotheses.map((h) => [h.key, h.prior, h.rules.length]), [["H1", 0.5, 0], ["H2", 0.5, 0]]);
  const records = JSON.parse(fs.readFileSync(path.join(first.scenarioDir, "evidence.json"), "utf8")).records;
  assert.deepEqual(records.map((r: { id: string; facts: object; source: { name: string } }) => [r.id, r.source.name, Object.keys(r.facts).length]), [["E-1", "Courier", 0]]);
  assert.deepEqual(listUserCases(dir).map((item) => [item.id, item.label]), [["my-1", "Missing laptop return"], ["my-2", "Second"]]);
});

test("evidence added later can correct an earlier record, but only an existing, earlier one", () => {
  const { scenarioDir } = createUserCase(tempDir(), input);
  assert.throws(() => addUserEvidence(scenarioDir, { source: "Warehouse", content: "x", corrects: "E-9" }), /E-9 is not a record/);
  assert.throws(() => addUserEvidence(scenarioDir, { source: "Courier", content: "x", corrects: "E-1", observedAt: "2026-10-01T00:00:00Z" }), /dated after/);
  assert.throws(() => addUserEvidence(scenarioDir, { source: "Courier", content: "x", observedAt: "2999-01-01" }), /future/);
  assert.deepEqual(addUserEvidence(scenarioDir, { source: "Courier", content: "Correction: the 3 Oct pickup was a different customer's parcel.", corrects: "E-1" }), { recordId: "E-2" });
  const records = JSON.parse(fs.readFileSync(path.join(scenarioDir, "evidence.json"), "utf8")).records;
  assert.deepEqual(records[1].provenance.supersedes, ["E-1"]);
});

// A stand-in for the model: it reads the text, as a model would.
const reader: Reasoner = {
  kind: "nemotron",
  describe: () => ({ kind: "nemotron", label: "stand-in model", provider: "test", model: "nemotron-test", endpoint: null, ready: true, problem: null }),
  usage: () => null,
  async assess(input) {
    const judge = (record: EvidenceRecord) => /pickup of a parcel from the customer/i.test(record.content)
      ? [{ hypothesisKey: "H1", direction: "supports" as const, strength: 1, decisive: false, basis: "model" as const, rationale: "a parcel was collected" },
         { hypothesisKey: "H2", direction: "contradicts" as const, strength: 1, decisive: false, basis: "model" as const, rationale: "a parcel was collected" }]
      : /different customer's parcel/i.test(record.content)
        ? [{ hypothesisKey: "H2", direction: "supports" as const, strength: 1, decisive: false, basis: "model" as const, rationale: "the pickup was not this laptop" }]
        : [];
    return { judgments: Object.fromEntries(input.batch.map((record) => [record.id, judge(record)])), notes: [], narrative: "" };
  }
};

test("a person's investigation is investigated by the same pipeline: runs, a correction, and what no longer counts", async () => {
  const { scenarioDir } = createUserCase(tempDir(), input);
  const config = testConfig({ scenarioDir });
  await withDesk(config, async (desk) => {
    await desk.run();
    const first = desk.hypotheses();
    assert.ok(first.find((h) => h.key === "H1")!.confidence > 0.5, "the pickup supports a return");
    addUserEvidence(scenarioDir, { source: "Courier", content: "Correction: the 3 Oct pickup was a different customer's parcel.", corrects: "E-1" });
    assert.deepEqual((await desk.listEvidence()).pending, ["E-2"], "added evidence waits for the next run");
    await desk.run();
    const c = desk.conclusionFromSpeck();
    assert.deepEqual(c.noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["E-1", "superseded"]]);
    assert.equal(desk.hypotheses().find((h) => h.key === "H1")!.supporting.length, 0, "the corrected pickup no longer supports a return");
    assert.ok(desk.hypotheses().find((h) => h.key === "H2")!.confidence > first.find((h) => h.key === "H2")!.confidence);
  }, { reasoner: reader });
});

test("with the rule assessor, a person's free-text evidence is assessed but weighs nothing, and the case stays unresolved", async () => {
  const { scenarioDir } = createUserCase(tempDir(), input);
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    const run = await desk.run();
    assert.equal(run.execution.status, "completed");
    assert.equal(desk.conclusionFromSpeck().state, "unresolved");
    assert.ok(desk.hypotheses().every((h) => h.confidence === 0.5 && !h.supporting.length));
  });
});
