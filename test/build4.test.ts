import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../src/config.js";
import type { EvidenceRecord } from "../src/evidence/types.js";
import { deriveBasis, deriveValidity, type LedgerEntry } from "../src/investigation/basis.js";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner, RelationJudgment } from "../src/reasoning/types.js";
import { testConfig, withDesk, writeScenario } from "./helpers.js";

// Build 4 (docs/build-4-bank-return.md). The live bank-return failure, with
// the model's judgments as the local nemotron-3-nano:4b gave them in the saved
// sample eval/results/comparisons/eval-correction-supersedes/
// 2026-10-23T08-49-41-771Z-b92a9bde.json, replayed without a model. Then the
// cases where the same rules must still abstain.

const BANK_DIR = path.join(ROOT_DIR, "eval", "scenarios", "correction-supersedes");
const bankScenario = JSON.parse(fs.readFileSync(path.join(BANK_DIR, "scenario.json"), "utf8"));
const bankRecords = (JSON.parse(fs.readFileSync(path.join(BANK_DIR, "evidence.json"), "utf8")) as { records: EvidenceRecord[] }).records;

type Said = Array<[string, "supports" | "contradicts", number?]>;
// What the model said in sample b92a9bde (strength 1 unless noted). Pairs a
// decisive rule decides are left to the rule, as nemotron.ts does.
const SAMPLE: Record<string, Said> = {
  "EV-BNK-101": [["H-PAID", "supports"], ["H-UNPAID", "contradicts"]],
  "EV-LDG-102": [["H-PAID", "supports"], ["H-UNPAID", "contradicts"], ["H-PARTIAL", "contradicts"]],
  "EV-BNK-103": [["H-UNPAID", "supports"], ["H-PARTIAL", "contradicts"]],
  "EV-LDG-104": [["H-UNPAID", "supports"], ["H-PAID", "contradicts"], ["H-PARTIAL", "contradicts"]]
};

// A stand-in for the Nemotron reasoner: decisive fact rules first, then the
// given model judgments, recorded with basis "model" so Speck caps them at 0.4.
function modelLike(desk: () => EvidenceDesk, said: Record<string, Said>): Reasoner {
  return {
    kind: "nemotron",
    describe: () => ({ kind: "nemotron", label: "replayed model judgments (test)", provider: "ollama", model: "nemotron-3-nano:4b", endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      const judgments: Record<string, RelationJudgment[]> = {};
      for (const record of input.batch) {
        const rules = ruleJudgments(record, desk().scenario.hypotheses, { decisiveOnly: true });
        const model = (said[record.id] ?? [])
          .filter(([key]) => !rules.some((rule) => rule.hypothesisKey === key))
          .map(([hypothesisKey, direction, strength]): RelationJudgment => ({ hypothesisKey, direction, strength: strength ?? 1, decisive: false, basis: "model", rationale: "replayed" }));
        judgments[record.id] = [...rules, ...model];
      }
      return { judgments, notes: [], narrative: "" };
    }
  };
}

async function bankCase<T>(options: { records?: EvidenceRecord[]; said?: Record<string, Said> }, body: (desk: EvidenceDesk) => Promise<T>): Promise<T> {
  let current: EvidenceDesk | null = null;
  const scenarioDir = options.records ? writeScenario(bankScenario, options.records) : BANK_DIR;
  return withDesk(testConfig({ scenarioDir }), async (desk) => {
    current = desk;
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    return body(desk);
  }, { reasoner: modelLike(() => current!, options.said ?? SAMPLE) });
}

const speckBelief = (desk: EvidenceDesk, key: string) => {
  const object = desk.currentHypotheses().get(key)!;
  return `${object.data.status} ${Math.round(object.confidence * 1000) / 1000}`;
};

test("the live bank-return failure: concluded by corroboration, with Speck's own belief unchanged and the obsolete ledger status out", async () => {
  await bankCase({}, async (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "supported");
    assert.equal(c.hypothesis?.key, "H-UNPAID");
    assert.equal(c.justification.route, "corroboration");
    assert.deepEqual(c.justification.corroboration?.systems, ["bank", "ledger"]);
    // Speck's state is reported, not rewritten: 0.30 + 0.08 + 0.08, below 0.6.
    assert.equal(speckBelief(desk, "H-UNPAID"), "active 0.46");
    assert.equal(c.justification.confidence, 0.46);
    assert.match(c.justification.reasons.join("\n"), /0\.14 short of its supported threshold of 0\.6; Speck itself has not established it/);
    // Build 3 kept counting EV-LDG-102 against H-UNPAID (0.38 in the live sample).
    assert.deepEqual(c.noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["EV-BNK-101", "superseded"], ["EV-LDG-102", "restated"]]);
    assert.deepEqual(c.hypothesis!.contradicting, []);
  });
});

test("before the return the same judgments conclude H-PAID through Speck's own threshold, not corroboration", async () => {
  let current: EvidenceDesk | null = null;
  await withDesk(testConfig({ scenarioDir: BANK_DIR }), async (desk) => {
    current = desk;
    await desk.run();
    const c = desk.conclusionFromSpeck();
    assert.equal(c.hypothesis?.key, "H-PAID");
    assert.equal(c.justification.route, "speck-threshold");
    assert.equal(speckBelief(desk, "H-PAID"), "supported 0.66");
  }, { reasoner: modelLike(() => current!, SAMPLE) });
});

test("conflicting evidence: a ledger status from another system is not out of date, so it still counts against and Speck abstains", async () => {
  // The reopening is reported by a different system (a CRM note), so nothing
  // restates the ledger's "paid".
  const records = bankRecords.map((record) => record.id === "EV-LDG-104" ? { ...record, source: { system: "crm", name: "CRM note" } } : record);
  await bankCase({ records }, async (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.equal(c.direction.pointsTo?.key, "H-UNPAID");
    assert.deepEqual(c.noLongerCounted.map((item) => item.recordId), ["EV-BNK-101"]);
    assert.match(c.justification.reasons.join("\n"), /Not corroborated \(rule corroborated-1\): EV-LDG-102 is recorded against it/);
  });
});

test("missing evidence: the bank return alone is one source, so Speck abstains", async () => {
  const records = bankRecords.filter((record) => record.id !== "EV-LDG-104");
  await bankCase({ records }, async (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.match(c.justification.reasons.join("\n"), /its support comes from one source system \(bank\)/);
  });
});

test("a rival with support of its own blocks corroboration", async () => {
  const said = { ...SAMPLE, "EV-BNK-103": [["H-UNPAID", "supports"], ["H-PARTIAL", "supports", 0.5]] as Said };
  await bankCase({ said }, async (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.match(c.justification.reasons.join("\n"), /H-PARTIAL still has support of its own/);
  });
});

test("withdrawn evidence: withdrawing the ledger's reopening withdraws the conclusion and makes its earlier status count again", async () => {
  await bankCase({}, async (desk) => {
    await desk.withdrawRecord("EV-LDG-104", "Reopening belongs to INV-71");
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.deepEqual(c.noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["EV-BNK-101", "superseded"], ["EV-LDG-104", "withdrawn"]]);
    assert.deepEqual(c.alternatives.find((view) => view.key === "H-UNPAID")?.contradicting.map((ref) => ref.recordId) ?? c.hypothesis?.contradicting.map((ref) => ref.recordId), ["EV-LDG-102"]);
  });
});

test("superseded evidence: when the bank cancels its return, the credit counts again and the unpaid conclusion goes", async () => {
  const cancel: EvidenceRecord = {
    ...bankRecords.find((record) => record.id === "EV-BNK-103")!,
    id: "EV-BNK-105", observedAt: "2026-09-09T06:00:00Z",
    content: "The return of 9 Sep was posted in error and is cancelled.", facts: { "payment.reversed": "false" },
    provenance: { systemOfRecord: "Bank statement feed", recordRef: "ev-bnk-105", author: "bank-feed", supersedes: ["EV-BNK-103"] }
  };
  const said = { ...SAMPLE, "EV-BNK-105": [["H-PAID", "supports"], ["H-UNPAID", "contradicts"]] as Said };
  await bankCase({ records: [...bankRecords, cancel], said }, async (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.notEqual(c.hypothesis?.key, "H-UNPAID");
    assert.deepEqual(c.noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["EV-LDG-102", "restated"], ["EV-BNK-103", "superseded"]]);
  });
});

test("failure: while the correction cannot be assessed, the earlier conclusion is withheld, not presented as current", async () => {
  // Live 2026-10-25: the model's reply for the new records failed its
  // contract twice, and Speck's earlier conclusion was still shown as firm.
  let current: EvidenceDesk | null = null;
  let failing = true;
  const model = modelLike(() => current!, SAMPLE);
  const reasoner: Reasoner = {
    ...model,
    async assess(input) {
      if (failing && input.batch.some((record) => record.id === "EV-BNK-103")) throw new Error("model did not return a JSON object");
      return model.assess(input);
    }
  };
  await withDesk(testConfig({ scenarioDir: BANK_DIR }), async (desk) => {
    current = desk;
    await desk.run();
    assert.equal(desk.conclusionFromSpeck().hypothesis?.key, "H-PAID");
    await desk.introduceNextUpdate();
    const failed = await desk.run();
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.equal(c.hypothesis, null);
    assert.match(c.headline, /^Unresolved: 2 newer record\(s\) not yet assessed \(EV-BNK-103, EV-LDG-104\)\. Before them, the evidence pointed to "Invoice INV-77 has been paid in full\."/);
    assert.equal(failed.conclusion.state, "unresolved", "the run's own record says the same");
    // Speck's belief state is untouched: H-PAID is still what it holds.
    assert.equal(speckBelief(desk, "H-PAID"), "supported 0.66");

    failing = false;
    await desk.run();
    const after = desk.conclusionFromSpeck();
    assert.equal(after.hypothesis?.key, "H-UNPAID");
    assert.equal(after.justification.route, "corroboration");
  }, { reasoner });
});

// Pure validity rules.
const entry = (id: string, system: string, observedAt: string, facts: Record<string, string>, supersedes: string[] = [], withdrawn = false): LedgerEntry => ({
  record: {
    id, caseId: "C", source: { system, name: system }, observedAt, content: id, facts,
    provenance: { systemOfRecord: system, recordRef: id, author: "t", supersedes },
    retrieval: { mode: "fixture", location: "", retrievedAt: "" }
  },
  judgments: [],
  withdrawn: withdrawn ? { reason: "test", at: "" } : null
});
const validity = (entries: LedgerEntry[]) => [...deriveValidity([...entries].sort((a, b) => a.record.observedAt.localeCompare(b.record.observedAt)))]
  .map(([id, why]) => `${id} ${why.kind} ${"by" in why ? why.by : ""}`.trim()).sort();

test("restatement applies only to the same system, a changed value, every fact, and a strictly later record", () => {
  const t = (day: number) => `2026-01-0${day}T00:00:00Z`;
  assert.deepEqual(validity([entry("A", "ledger", t(1), { status: "paid" }), entry("B", "ledger", t(2), { status: "reopened" })]), ["A restated B"]);
  // Another system reporting the same fact disagrees; it does not replace.
  assert.deepEqual(validity([entry("A", "wms", t(1), { level: "ok" }), entry("B", "count", t(2), { level: "short" })]), []);
  // The same value again changes nothing.
  assert.deepEqual(validity([entry("A", "wms", t(1), { level: "ok" }), entry("B", "wms", t(2), { level: "ok" })]), []);
  // Only one of two facts reported again: the record still says something current.
  assert.deepEqual(validity([entry("A", "bank", t(1), { received: "true", amount: "full" }), entry("B", "bank", t(2), { received: "false" })]), []);
  // Same timestamp: no order, no restatement.
  assert.deepEqual(validity([entry("A", "ledger", t(1), { status: "paid" }), entry("B", "ledger", t(1), { status: "reopened" })]), []);
  // No facts, nothing to restate.
  assert.deepEqual(validity([entry("A", "ledger", t(1), {}), entry("B", "ledger", t(2), {})]), []);
});

test("restatement yields to declared replacement and withdrawal", () => {
  const t = (day: number) => `2026-01-0${day}T00:00:00Z`;
  // A correction (it names what it replaces) is replaced only by being named or withdrawn.
  assert.deepEqual(validity([
    entry("A", "scan", t(1), { status: "delivered" }), entry("B", "scan", t(2), { status: "at_depot" }, ["A"]), entry("C", "scan", t(3), { status: "delivered" })
  ]), ["A superseded B"]);
  // A late-stamped record its correction names cannot restate the correction.
  assert.deepEqual(validity([entry("B", "scan", t(2), { status: "at_depot" }, ["A"]), entry("A", "scan", t(3), { status: "delivered" })]), ["A superseded B"]);
  // The restating record withdrawn: the older value is current again.
  assert.deepEqual(validity([entry("A", "ledger", t(1), { status: "paid" }), entry("B", "ledger", t(2), { status: "reopened" }, [], true)]), ["B withdrawn"]);
  // The restating record itself replaced: the older value is current again.
  assert.deepEqual(validity([
    entry("A", "ledger", t(1), { status: "paid" }), entry("B", "ledger", t(2), { status: "reopened" }), entry("X", "ops", t(3), {}, ["B"])
  ]), ["B superseded X"]);
  // deriveBasis drops a restated record's judgments like any other invalid record.
  const basis = deriveBasis([
    { ...entry("A", "ledger", t(1), { status: "paid" }), judgments: [{ hypothesisKey: "H", direction: "contradicts", strength: 1, decisive: false, basis: "model", rationale: "" }] },
    { ...entry("B", "ledger", t(2), { status: "reopened" }), judgments: [{ hypothesisKey: "H", direction: "supports", strength: 1, decisive: false, basis: "model", rationale: "" }] }
  ], ["H"]);
  assert.deepEqual(basis.plan.get("H")!.map((item) => `${item.recordId} ${item.direction}`), ["B supports"]);
});
