import assert from "node:assert/strict";
import { test } from "node:test";
import { MentalObjectRepository, SpeckRuntime } from "#speck";
import { EvidenceDesk } from "../src/investigation/desk.js";
import { testConfig, writeScenario } from "./helpers.js";

// Exhaustive interruption. Every Speck write Evidence Desk makes during a run
// (and during a withdrawal) is an interruption point. For each point the
// process "dies" there: that write and every later one fail, as if the
// process had stopped. Startup recovery is then itself interrupted at each
// of its own write points, and finally allowed to finish. Whatever the
// sequence, the case must end in the same beliefs as an uninterrupted one,
// with a consistent history.

const WRITES: Array<[object, string]> = [
  [SpeckRuntime.prototype, "recordEvidence"],
  [SpeckRuntime.prototype, "recordMemory"],
  [SpeckRuntime.prototype, "proposeHypothesis"],
  [SpeckRuntime.prototype, "reviseHypothesesFromEvidence"],
  [SpeckRuntime.prototype, "withdrawEvidence"],
  [MentalObjectRepository.prototype, "update"]
];

// calls: writes so far while armed; dieAt: the write that fails (null: none).
const fault = { armed: false, calls: 0, dieAt: null as number | null, dead: false };
const originals = WRITES.map(([target, name]) => (target as Record<string, unknown>)[name] as (...args: unknown[]) => unknown);
WRITES.forEach(([target, name], index) => {
  (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    if (fault.armed) {
      fault.calls += 1;
      if (fault.dead || fault.calls === fault.dieAt) { fault.dead = true; throw new Error("simulated process death"); }
    }
    return originals[index]!.apply(this, args);
  };
});
const arm = (dieAt: number | null) => Object.assign(fault, { armed: true, calls: 0, dieAt, dead: false });
const disarm = () => Object.assign(fault, { armed: false, calls: 0, dieAt: null, dead: false });

function beliefs(desk: EvidenceDesk) {
  return desk.hypotheses().map((view) => `${view.key} ${view.status} ${view.confidence} +[${view.supporting.map((ref) => ref.recordId)}] -[${view.contradicting.map((ref) => ref.recordId)}]`).sort();
}

// Structural guarantees that must hold after any interruption and recovery.
function assertConsistent(desk: EvidenceDesk, label: string): void {
  const workerId = desk.runtime.listWorkers()[0]!.id;
  const objects = desk.runtime.mentalObjects.listForWorker(workerId);
  const hypotheses = objects.filter((object) => object.kind === "hypothesis");
  const current = new Set([...desk.currentHypotheses().values()].map((object) => object.id));
  const recomputations = desk.recomputations();
  assert.equal(desk.conclusionFromSpeck().reconciled, true, `${label}: beliefs reconciled`);
  assert.deepEqual(recomputations.map((item) => item.version), recomputations.map((_, index) => index + 1), `${label}: recomputation versions unique and contiguous`);
  for (const hypothesis of hypotheses) {
    if (!current.has(hypothesis.id)) assert.equal(hypothesis.data.status, "superseded", `${label}: replaced ${hypothesis.data.key} is marked superseded in Speck`);
    if (!hypothesis.data.replaces) continue;
    const record = recomputations.find((item) => item.version === hypothesis.data.recomputation);
    assert.ok(record?.hypotheses.some((entry) => entry.key === hypothesis.data.key && entry.mode !== "extended" && entry.previousId === hypothesis.data.replaces),
      `${label}: replacement of ${hypothesis.data.key} is explained by recomputation ${String(hypothesis.data.recomputation)}`);
  }
  // Recorded intent is fulfilled: a replacement a record announced but an
  // interruption stopped has been made by a later recomputation.
  for (const record of recomputations) {
    for (const entry of record.hypotheses) {
      if (entry.mode === "extended" || entry.carriedOut) continue;
      assert.ok(!current.has(entry.previousId as never), `${label}: recomputation ${record.version}'s unfinished replacement of ${entry.key} was redone`);
      assert.ok(recomputations.some((later) => later.version > record.version && later.hypotheses.some((other) => other.key === entry.key && other.previousId === entry.previousId && other.carriedOut)),
        `${label}: a later recomputation carried out ${entry.key}`);
    }
  }
  const recordIds = objects.filter((object) => object.kind === "evidence").map((object) => String(object.data.source));
  assert.equal(new Set(recordIds).size, recordIds.length, `${label}: no record entered the ledger twice`);
}

// A fresh case, brought to the point where the action is taken.
async function prepared(config: ReturnType<typeof testConfig>, prepare: (desk: EvidenceDesk) => Promise<void>) {
  disarm();
  const desk = await EvidenceDesk.open(config);
  try { await prepare(desk); } finally { desk.close(); }
  return config;
}

// Counts the writes `action` makes on a prepared case, uninterrupted.
async function countWrites(makeConfig: () => ReturnType<typeof testConfig>, prepare: (desk: EvidenceDesk) => Promise<void>, action: (desk: EvidenceDesk) => Promise<unknown>): Promise<{ writes: number; expected: string[] }> {
  const config = await prepared(makeConfig(), prepare);
  const desk = await EvidenceDesk.open(config);
  try {
    arm(null);
    await action(desk);
    const writes = fault.calls;
    disarm();
    return { writes, expected: beliefs(desk) };
  } finally {
    disarm();
    desk.close();
  }
}

async function interruptEverywhere(name: string, makeConfig: () => ReturnType<typeof testConfig>, prepare: (desk: EvidenceDesk) => Promise<void>, action: (desk: EvidenceDesk) => Promise<unknown>) {
  const { writes, expected } = await countWrites(makeConfig, prepare, action);
  assert.ok(writes > 5, `${name}: the action makes several writes (${writes})`);
  for (let dieAt = 1; dieAt <= writes; dieAt += 1) {
    for (const recoveryDeaths of [[], [1], [1, 1], [2, 1], [3, 2, 1]]) {
      const label = `${name}: died at write ${dieAt}/${writes}, recovery died at ${JSON.stringify(recoveryDeaths)}`;
      const config = await prepared(makeConfig(), prepare);
      // The interrupted action.
      let desk = await EvidenceDesk.open(config);
      arm(dieAt);
      await action(desk).catch(() => undefined);
      disarm();
      desk.close();
      // Recovery, interrupted again at each listed write.
      for (const recoveryDieAt of recoveryDeaths) {
        arm(recoveryDieAt);
        const opened = await EvidenceDesk.open(config).catch(() => null);
        disarm();
        opened?.close();
      }
      // A clean restart, then the action is retried to completion.
      desk = await EvidenceDesk.open(config);
      try {
        assertConsistent(desk, `${label} (after recovery)`);
        await action(desk).catch(() => undefined);
        assertConsistent(desk, `${label} (after retry)`);
        assert.deepEqual(beliefs(desk), expected, `${label}: final beliefs`);
      } finally {
        desk.close();
      }
    }
  }
}

test("a run interrupted at any write, with recovery interrupted repeatedly, ends as if uninterrupted", async () => {
  // Development fixture, run 2: the update supersedes EV-CAR-003, so two
  // hypotheses are rebuilt while new evidence is recorded. One record per
  // chunk, so interruptions also fall between chunks.
  const makeConfig = () => testConfig({ execution: { maxChunks: 8, batchSize: 1 } });
  await interruptEverywhere("run 2", makeConfig, async (desk) => { await desk.run(); await desk.introduceNextUpdate(); }, (desk) => desk.run());
});

test("a withdrawal interrupted at any write, with recovery interrupted repeatedly, ends as if uninterrupted", async () => {
  const record = (id: string, observedAt: string, facts: Record<string, string>, supersedes: string[] = []) => ({
    id, caseId: "CASE-INT", source: { system: "bank", name: "Bank" }, observedAt, content: id, facts,
    provenance: { systemOfRecord: "Bank", recordRef: id, author: "test", supersedes }
  });
  const scenarioDir = writeScenario({
    id: "int", caseId: "CASE-INT", title: "Paid?", question: "Paid?",
    sources: { bank: { name: "Bank", reliability: 0.95 } },
    hypotheses: [
      { key: "H-PAID", statement: "Paid.", prior: 0.5, rules: [
        { fact: "received", equals: "true", direction: "supports" },
        { fact: "reversed", equals: "true", direction: "contradicts", decisive: true } ] },
      { key: "H-UNPAID", statement: "Unpaid.", prior: 0.3, rules: [
        { fact: "reversed", equals: "true", direction: "supports" },
        { fact: "received", equals: "true", direction: "contradicts" } ] },
      { key: "H-PARTIAL", statement: "Part paid.", prior: 0.2, rules: [
        { fact: "amount_matches", equals: "true", direction: "contradicts", decisive: true } ] }
    ],
    questions: [],
    stages: [{ id: "all", label: "All", asOf: "2026-05-10T00:00:00Z", description: "" }]
  }, [
    record("B1", "2026-05-01T00:00:00Z", { received: "true", amount_matches: "true" }),
    record("B2", "2026-05-02T00:00:00Z", { received: "true" }),
    record("B3", "2026-05-03T00:00:00Z", { reversed: "true" }, ["B1"])
  ]);
  // Withdrawing the reversal B3: B1 counts again, H-PAID and H-UNPAID are
  // rebuilt, and H-PARTIAL is extended with B1's refutation.
  await interruptEverywhere("withdraw B3", () => testConfig({ scenarioDir }), async (desk) => { await desk.run(); },
    (desk) => desk.withdrawRecord("B3", "posted against the wrong invoice"));
});
