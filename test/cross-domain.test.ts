import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CROSS_DOMAIN_DIR, EVAL_DIR, loadEvalCases, REGRESSION_DIR } from "../src/eval/cases.js";
import { LOCK_FILE, verifyLock } from "../src/eval/cross-domain.js";
import { ASSESSMENT_FAILURE, speckDesk, statelessRules } from "../src/eval/systems.js";
import { tempDir } from "./helpers.js";

// The cross-domain suite's integrity, not its scores: no test asserts what any
// system concludes on it.

const recordsOf = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8")) as { records: Array<{ id: string; provenance: { supersedes: string[] } }> }).records;

test("the cross-domain expectations match their lock, and any later edit is refused", () => {
  assert.equal(verifyLock().files, 30);
  const copy = path.join(tempDir(), "cross-domain");
  fs.cpSync(CROSS_DOMAIN_DIR, copy, { recursive: true });
  const expected = path.join(copy, "payment-reversal-withdrawn", "expected.json");
  fs.writeFileSync(expected, fs.readFileSync(expected, "utf8").replace('"conclusion": "H-UNPAID"', '"conclusion": null'));
  assert.throws(() => verifyLock(copy, LOCK_FILE), /payment-reversal-withdrawn\/expected\.json changed/);
});

test("the suite is separate from the held-out and regression cases and covers what it claims", () => {
  const cases = loadEvalCases(CROSS_DOMAIN_DIR);
  const elsewhere = new Set([...loadEvalCases(EVAL_DIR), ...loadEvalCases(REGRESSION_DIR)].flatMap((item) => [item.scenario.caseId, ...recordsOf(item.dir).map((record) => record.id)]));
  for (const item of cases) {
    assert.ok(!elsewhere.has(item.scenario.caseId), item.id);
    for (const record of recordsOf(item.dir)) assert.ok(!elsewhere.has(record.id), record.id);
  }
  assert.deepEqual([...new Set(cases.map((item) => item.domain))].sort(), ["logistics", "payments", "procurement"]);
  // Arrival order: families of the same records in two or more orders.
  const families = new Map<string, string[]>();
  for (const item of cases) if (item.family) families.set(item.family, [...(families.get(item.family) ?? []), item.id]);
  assert.ok([...families.values()].filter((members) => members.length >= 2).length >= 2);
  for (const members of families.values()) {
    const sets = members.map((id) => JSON.stringify(recordsOf(cases.find((item) => item.id === id)!.dir).map((record) => record.id).sort()));
    assert.equal(new Set(sets).size, 1, "a family shares its records");
  }
  // A replacement chain: a record that replaces a record that replaces another.
  assert.ok(cases.some((item) => {
    const records = recordsOf(item.dir);
    return records.some((record) => record.provenance.supersedes.some((id) => records.find((other) => other.id === id)?.provenance.supersedes.length));
  }));
  // A withdrawn correction, a decisive refutation, missing evidence, a failed assessment.
  assert.ok(cases.some((item) => item.checkpoints.some((checkpoint) => (checkpoint.withdrawBefore ?? []).some((withdrawal) => recordsOf(item.dir).find((record) => record.id === withdrawal.recordId)!.provenance.supersedes.length))));
  assert.ok(cases.some((item) => item.scenario.hypotheses.some((hypothesis) => hypothesis.rules.some((rule) => rule.decisive))));
  assert.ok(cases.some((item) => item.category === "missing evidence" && item.checkpoints.every((checkpoint) => checkpoint.conclusion === null)));
  assert.ok(cases.some((item) => item.failAssessment?.length));
});

test("an injected assessment failure reaches Evidence Desk per batch and the baseline per checkpoint", async () => {
  const item = loadEvalCases(CROSS_DOMAIN_DIR).find((entry) => entry.id === "payment-unreadable-record")!;
  const baseline = await statelessRules().run(item);
  assert.deepEqual(baseline.checkpoints.map((outcome) => outcome.error?.includes(ASSESSMENT_FAILURE) ?? false), [false, true, false]);
  const desk = await speckDesk({ kind: "rules" }).run(item);
  assert.deepEqual(desk.checkpoints.map((outcome) => outcome.executionStatus), ["completed", "errored", "completed"]);
  assert.ok(desk.checkpoints.every((outcome) => outcome.error === null), "Evidence Desk reports the failed run, not an error in place of a result");
});
