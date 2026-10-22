import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { FixtureEvidenceProvider } from "../src/evidence/fixture-provider.js";
import type { EvidenceProvider, EvidenceRecord } from "../src/evidence/types.js";
import { deriveBasis } from "../src/investigation/basis.js";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { createServer } from "../src/server.js";
import { testConfig, withDesk, writeScenario } from "./helpers.js";

// Reversible belief revision. Current beliefs must equal a replay of the
// evidence and judgments that still count; what no longer counts must leave
// no trace in current belief and a full trace in the history.
//
// The fixture is a small payment case. Speck adds 0.2 x reliability per
// supporting record and subtracts the same per contradicting one; a decisive
// contradiction drops a hypothesis to 0.05. Bank 0.95 -> 0.19, ledger 0.85 -> 0.17.

const record = (id: string, system: "bank" | "ledger", observedAt: string, facts: Record<string, string>, supersedes: string[] = []) => ({
  id, caseId: "CASE-PAY", source: { system, name: system === "bank" ? "Bank feed" : "Ledger" }, observedAt, content: id, facts,
  provenance: { systemOfRecord: system, recordRef: id, author: "test", supersedes }
});

const PAY_RECORDS = [
  record("P1", "bank", "2026-05-01T01:00:00Z", { "payment.received": "true", "payment.amount_matches": "true" }),
  record("P2", "ledger", "2026-05-01T02:00:00Z", { "ledger.status": "paid" }),
  record("P3", "bank", "2026-05-03T01:00:00Z", { "payment.reversed": "true" }, ["P1"]),
  record("P4", "ledger", "2026-05-03T02:00:00Z", { "ledger.status": "reopened" }),
  record("P5", "bank", "2026-05-05T01:00:00Z", { "payment.return_cancelled": "true" }, ["P3"])
];

function payScenario(): string {
  return writeScenario({
    id: "pay", caseId: "CASE-PAY", title: "Paid?", question: "Was the invoice paid?",
    sources: { bank: { name: "Bank feed", reliability: 0.95 }, ledger: { name: "Ledger", reliability: 0.85 } },
    hypotheses: [
      { key: "H-PAID", statement: "Paid in full.", prior: 0.5, rules: [
        { fact: "payment.received", equals: "true", direction: "supports" },
        { fact: "ledger.status", equals: "paid", direction: "supports" },
        { fact: "payment.return_cancelled", equals: "true", direction: "supports" },
        { fact: "payment.reversed", equals: "true", direction: "contradicts", decisive: true } ] },
      { key: "H-UNPAID", statement: "Unpaid.", prior: 0.3, rules: [
        { fact: "payment.reversed", equals: "true", direction: "supports" },
        { fact: "ledger.status", equals: "reopened", direction: "supports" },
        { fact: "payment.received", equals: "true", direction: "contradicts" },
        { fact: "payment.return_cancelled", equals: "true", direction: "contradicts", decisive: true } ] },
      { key: "H-PARTIAL", statement: "Part paid.", prior: 0.2, rules: [
        { fact: "payment.amount_matches", equals: "true", direction: "contradicts", decisive: true } ] }
    ],
    questions: [],
    stages: [
      { id: "credit", label: "Credit", asOf: "2026-05-02T00:00:00Z", description: "" },
      { id: "reversal", label: "Reversal", asOf: "2026-05-04T00:00:00Z", description: "" },
      { id: "cancelled", label: "Return cancelled", asOf: "2026-05-06T00:00:00Z", description: "" }
    ]
  }, PAY_RECORDS);
}

// A hypothesis as current belief presents it: status, confidence, and the
// records that currently support and contradict it.
function beliefs(desk: EvidenceDesk): Record<string, { status: string; confidence: number; supporting: string[]; contradicting: string[] }> {
  return Object.fromEntries(desk.hypotheses().map((view) => [view.key, {
    status: view.status, confidence: view.confidence,
    supporting: view.supporting.map((ref) => ref.recordId), contradicting: view.contradicting.map((ref) => ref.recordId)
  }]));
}

async function runTo(desk: EvidenceDesk, stageId: string): Promise<void> {
  while (desk.currentStage().id !== stageId) await desk.introduceNextUpdate();
  await desk.run();
}

// The fixture provider, revealing only the records allowed so far: lets a
// record arrive after records observed later than it.
class GatedProvider implements EvidenceProvider {
  readonly mode = "fixture" as const;
  readonly allowed = new Set<string>();
  constructor(private readonly inner: EvidenceProvider) {}
  describe() { return this.inner.describe(); }
  async fetchCaseEvidence(caseId: string): Promise<EvidenceRecord[]> {
    return (await this.inner.fetchCaseEvidence(caseId)).filter((item) => this.allowed.has(item.id));
  }
}

test("bank reversal: the superseded payment's effect leaves current belief", async () => {
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "credit");
    // Before the reversal the payment counts: it pushed H-UNPAID down to 0.11.
    assert.deepEqual(beliefs(desk)["H-UNPAID"], { status: "rejected", confidence: 0.11, supporting: [], contradicting: ["P1"] });
    assert.equal(desk.conclusionFromSpeck().hypothesis?.key, "H-PAID");

    await runTo(desk, "reversal");
    const now = beliefs(desk);
    // 0.30 + 0.19 (P3) + 0.17 (P4): P1's -0.19 is gone, not compensated.
    assert.deepEqual(now["H-UNPAID"], { status: "supported", confidence: 0.66, supporting: ["P3", "P4"], contradicting: [] });
    assert.deepEqual(now["H-PAID"], { status: "rejected", confidence: 0.05, supporting: [], contradicting: ["P3"] });
    const conclusion = desk.conclusionFromSpeck();
    assert.equal(conclusion.state, "supported");
    assert.equal(conclusion.hypothesis?.key, "H-UNPAID");
    assert.deepEqual(conclusion.noLongerCounted.map((item) => [item.recordId, item.invalidation]), [["P1", { kind: "superseded", by: "P3" }]]);
    // Each current adjustment names its record, judgment and delta.
    assert.deepEqual(conclusion.hypothesis!.supporting.map((ref) => [ref.recordId, ref.judgment?.basis, ref.delta]), [["P3", "rule", 0.19], ["P4", "rule", 0.17]]);
    // Speck's saved state agrees: the current hypothesis object holds 0.66.
    assert.equal(Math.round(desk.currentHypotheses().get("H-UNPAID")!.confidence * 1000) / 1000, 0.66);
  });
});

test("invalidated support: withdrawing a record recomputes every belief that rested on it", async () => {
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "credit");
    assert.deepEqual(beliefs(desk)["H-PAID"], { status: "confirmed", confidence: 0.86, supporting: ["P1", "P2"], contradicting: [] });
    const recomputation = await desk.withdrawRecord("P1", "Credit belongs to a different customer");
    const now = beliefs(desk);
    assert.deepEqual(now["H-PAID"], { status: "supported", confidence: 0.67, supporting: ["P2"], contradicting: [] });
    assert.deepEqual(now["H-UNPAID"], { status: "proposed", confidence: 0.3, supporting: [], contradicting: [] });
    // P1 was also H-PARTIAL's only refutation; it no longer stands.
    assert.deepEqual(now["H-PARTIAL"], { status: "proposed", confidence: 0.2, supporting: [], contradicting: [] });
    assert.deepEqual(recomputation?.hypotheses.map((item) => [item.key, item.dropped.map((drop) => drop.reason)]), [
      ["H-PAID", ["P1 withdrawn (Credit belongs to a different customer)"]],
      ["H-UNPAID", ["P1 withdrawn (Credit belongs to a different customer)"]],
      ["H-PARTIAL", ["P1 withdrawn (Credit belongs to a different customer)"]]
    ]);
    await assert.rejects(desk.withdrawRecord("P9", "x"), /has not been assessed/);
    await assert.rejects(desk.withdrawRecord("P2", "  "), /reason is required/);
  });
});

test("correction withdrawal: when a correction stops counting, what it displaced counts again", async () => {
  // By its source: P5 says the reversal P3 was posted in error.
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "reversal");
    await runTo(desk, "cancelled");
    const now = beliefs(desk);
    // P1 is reinstated (its superseder is itself superseded). P4 still counts
    // as a record, but its support is withheld: P5 refutes H-UNPAID decisively.
    assert.deepEqual(now["H-PAID"], { status: "confirmed", confidence: 1, supporting: ["P1", "P2", "P5"], contradicting: [] });
    assert.deepEqual(now["H-UNPAID"], { status: "rejected", confidence: 0.05, supporting: [], contradicting: ["P1", "P5"] });
    assert.deepEqual((await desk.listEvidence()).records.find((item) => item.id === "P4")!.assessment!.judgments.map((j) => [j.effect, j.refutedBy]), [["withheld", "P5"]]);
    const last = desk.recomputations().at(-1)!;
    const paid = last.hypotheses.find((item) => item.key === "H-PAID")!;
    assert.deepEqual(paid.dropped.map((item) => [item.recordId, item.reason]), [["P3", "P3 superseded by P5"]]);
    assert.deepEqual(paid.added.map((item) => [item.recordId, item.reinstated]), [["P1", true], ["P2", true], ["P5", false]]);
  });
  // By the investigator: the reversal is withdrawn. P2's support for H-PAID,
  // withheld while P3 refuted it, applies again.
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "reversal");
    assert.equal((await desk.listEvidence()).records.find((item) => item.id === "P2")!.assessment!.judgments[0]!.effect, "withheld");
    await desk.withdrawRecord("P3", "Posted against the wrong invoice");
    const now = beliefs(desk);
    assert.deepEqual(now["H-PAID"], { status: "confirmed", confidence: 0.86, supporting: ["P1", "P2"], contradicting: [] });
    assert.deepEqual(now["H-UNPAID"], { status: "active", confidence: 0.28, supporting: ["P4"], contradicting: ["P1"] });
    assert.equal(desk.conclusionFromSpeck().hypothesis?.key, "H-PAID");
    assert.equal((await desk.listEvidence()).records.find((item) => item.id === "P2")!.assessment!.judgments[0]!.effect, "applied");
  });
});

test("evidence ordering: the same final evidence gives the same beliefs whatever the arrival order", async () => {
  const scenarioDir = payScenario();
  const finalStage = async (desk: EvidenceDesk) => { while (desk.nextStage()?.id !== "cancelled") await desk.introduceNextUpdate(); };
  const outcomes: Array<ReturnType<typeof beliefs>> = [];

  // Incrementally, stage by stage.
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    await runTo(desk, "credit");
    await runTo(desk, "reversal");
    outcomes.push(beliefs(desk));
  });
  // All at once, one record per chunk.
  await withDesk(testConfig({ scenarioDir, execution: { maxChunks: 8, batchSize: 1 } }), async (desk) => {
    await finalStage(desk);
    await desk.run();
    outcomes.push(beliefs(desk));
  });
  // Out of observation order: the reopening first, then the older records.
  for (const arrivals of [["P4"], ["P2", "P3", "P4"], ["P3"]]) {
    const config = testConfig({ scenarioDir });
    const provider = new GatedProvider(new FixtureEvidenceProvider(path.join(scenarioDir, "evidence.json"), config.rootDir));
    await withDesk(config, async (desk) => {
      await finalStage(desk);
      for (const id of arrivals) provider.allowed.add(id);
      await desk.run();
      for (const id of ["P1", "P2", "P3", "P4"]) provider.allowed.add(id);
      await desk.run();
      outcomes.push(beliefs(desk));
      if (arrivals[0] === "P4") {
        // P1 and P2 (one chunk) arrive after P4 but were observed before it.
        const causes = desk.recomputations().flatMap((item) => item.hypotheses.filter((entry) => entry.key === "H-UNPAID").map((entry) => entry.cause));
        assert.ok(causes.some((cause) => /replayed in observation order/.test(cause)), causes.join(" | "));
      }
    }, { provider });
  }
  assert.equal(outcomes.length, 5);
  for (const outcome of outcomes.slice(1)) assert.deepEqual(outcome, outcomes[0]);
  assert.deepEqual(outcomes[0]!["H-UNPAID"], { status: "supported", confidence: 0.66, supporting: ["P3", "P4"], contradicting: [] });
});

test("auditability: the original decisions and the revisions stay in the history", async () => {
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "credit");
    await runTo(desk, "reversal");
    // Run 1's conclusion is kept as it was reached.
    const [first, second] = desk.runs();
    assert.equal(first!.conclusion.hypothesis?.key, "H-PAID");
    assert.equal(first!.conclusion.state, "supported");
    assert.equal(second!.conclusion.hypothesis?.key, "H-UNPAID");
    // The hypotheses that held then are in Speck, marked superseded, with what they had reached.
    const replaced = desk.replacedHypotheses();
    assert.deepEqual(replaced.map((item) => [item.key, item.statusWhenReplaced, item.confidence]).sort(),
      [["H-PAID", "confirmed", 0.86], ["H-PARTIAL", "rejected", 0.05], ["H-UNPAID", "rejected", 0.11]]);
    for (const item of replaced) {
      const object = desk.runtime.mentalObjects.get(item.id as never)!;
      assert.equal(object.data.status, "superseded");
      assert.equal(item.supersededBy, desk.currentHypotheses().get(item.key)!.id);
    }
    // The recomputation says what stopped counting and why.
    const [recomputation] = desk.recomputations();
    assert.deepEqual(recomputation!.hypotheses.find((item) => item.key === "H-UNPAID")!.dropped, [{ recordId: "P1", direction: "contradicts", reason: "P1 superseded by P3" }]);
    // The timeline keeps the original revisions, marked as no longer current.
    const timeline = desk.timeline();
    const original = timeline.find((entry) => entry.kind === "revision" && entry.hypothesisKey === "H-UNPAID" && entry.recordId === "P1")!;
    assert.equal(original.historical, true);
    assert.match(original.title, /→ rejected 0\.11 \(since replaced\)/);
    assert.ok(timeline.some((entry) => entry.kind === "recomputation" && /H-UNPAID was rejected 0\.11; P1 superseded by P3/.test(entry.detail)));
    const current = timeline.filter((entry) => entry.kind === "revision" && entry.hypothesisKey === "H-UNPAID" && !entry.historical);
    assert.deepEqual(current.map((entry) => entry.recordId), ["P3", "P4"]);
    assert.match(current.at(-1)!.title, /→ supported 0\.66$/);
  });
});

test("persistence: reopening keeps the corrected state and its history, and a rerun changes nothing", async () => {
  const config = testConfig({ scenarioDir: payScenario() });
  const snapshot = (desk: EvidenceDesk) => ({
    beliefs: beliefs(desk), conclusion: desk.conclusionFromSpeck(), recomputations: desk.recomputations(),
    replaced: desk.replacedHypotheses(), current: [...desk.currentHypotheses()].map(([key, object]) => [key, object.id])
  });
  let before: ReturnType<typeof snapshot> | null = null;
  await withDesk(config, async (desk) => {
    await runTo(desk, "credit");
    await runTo(desk, "reversal");
    await desk.withdrawRecord("P4", "Ledger entry belongs to INV-12");
    before = snapshot(desk);
  });
  await withDesk(config, async (desk) => {
    assert.deepEqual(snapshot(desk), before);
    assert.equal((await desk.listEvidence()).records.find((item) => item.id === "P4")!.invalidation?.kind, "withdrawn");
    await desk.run();
    assert.deepEqual(snapshot(desk), before, "a rerun with nothing new recomputes nothing");
  });
});

test("unrelated claims: invalidating one chain leaves independently supported beliefs alone", async () => {
  await withDesk(testConfig({ scenarioDir: payScenario() }), async (desk) => {
    await runTo(desk, "reversal");
    const ids = new Map([...desk.currentHypotheses()].map(([key, object]) => [key, object.id]));
    await desk.withdrawRecord("P4", "Ledger entry belongs to INV-12");
    // Only H-UNPAID rested on P4: only it is rebuilt.
    const [recomputation] = desk.recomputations().slice(-1);
    assert.deepEqual(recomputation!.hypotheses.map((item) => item.key), ["H-UNPAID"]);
    assert.equal(desk.currentHypotheses().get("H-PAID")!.id, ids.get("H-PAID"));
    const now = beliefs(desk);
    assert.deepEqual(now["H-UNPAID"], { status: "active", confidence: 0.49, supporting: ["P3"], contradicting: [] });
    assert.deepEqual(now["H-PAID"], { status: "rejected", confidence: 0.05, supporting: [], contradicting: ["P3"] });
  });
  // The development fixture: EV-CAR-003 contradicted H-NOT-SHIPPED as well as
  // supporting H-DELIVERED. Its supersession must not revive H-NOT-SHIPPED,
  // which the warehouse handover refutes on its own.
  await withDesk(testConfig(), async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const notShipped = desk.hypotheses().find((view) => view.key === "H-NOT-SHIPPED")!;
    assert.equal(notShipped.status, "rejected");
    assert.deepEqual(notShipped.contradicting.map((ref) => ref.recordId), ["EV-WMS-002"]);
    assert.deepEqual(desk.hypotheses().find((view) => view.key === "H-MISDELIVERED")!.supporting.map((ref) => ref.recordId), ["EV-SUP-004", "EV-CAR-005", "EV-SUP-006"]);
  });
});

test("failure handling: a missing or failed judgment is neither support nor contradiction", async () => {
  const scenarioDir = payScenario();
  const scenario = JSON.parse((await import("node:fs")).readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));
  // A reasoner that returns nothing for P1, or fails outright.
  const partial = (fail: boolean): Reasoner => ({
    kind: "rules",
    describe: () => ({ kind: "rules", label: "test", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      if (fail) throw new Error("assessor unavailable");
      const judgments: Record<string, ReturnType<typeof ruleJudgments>> = {};
      for (const item of input.batch) if (item.id !== "P1") judgments[item.id] = ruleJudgments(item, scenario.hypotheses);
      return { judgments, notes: [], narrative: "" };
    }
  });
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    const run = await desk.run();
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["P2"]);
    assert.deepEqual(run.unprocessed, ["P1"]);
    assert.ok(run.notes.some((note) => /No judgment was returned for P1; it was not recorded and stays pending/.test(note)));
    assert.deepEqual((await desk.listEvidence()).pending, ["P1"]);
    const now = beliefs(desk);
    assert.deepEqual(now["H-UNPAID"], { status: "proposed", confidence: 0.3, supporting: [], contradicting: [] });
    assert.deepEqual(now["H-PARTIAL"], { status: "proposed", confidence: 0.2, supporting: [], contradicting: [] });
    assert.deepEqual(now["H-PAID"]!.supporting, ["P2"]);
  }, { reasoner: partial(false) });
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    const run = await desk.run();
    assert.equal(run.execution.status, "errored");
    assert.deepEqual(run.assessed, []);
    assert.deepEqual((await desk.listEvidence()).pending, ["P1", "P2"]);
    assert.deepEqual(desk.hypotheses().map((view) => [view.key, view.confidence, view.supporting.length + view.contradicting.length]),
      [["H-PAID", 0.5, 0], ["H-UNPAID", 0.3, 0], ["H-PARTIAL", 0.2, 0]]);
    assert.deepEqual(desk.recomputations(), []);
  }, { reasoner: partial(true) });
});

test("the API withdraws a record, reports the recomputation, and keeps history apart from current state", async () => {
  const config = testConfig({ scenarioDir: payScenario() });
  await withDesk(config, async (desk) => {
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (body: unknown) => fetch(`${base}/api/evidence/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      await fetch(`${base}/api/run`, { method: "POST" });
      assert.equal((await post({ recordId: "P1" })).status, 400);
      assert.equal((await post({ recordId: "P1", reason: " " })).status, 400);
      assert.equal((await post({ recordId: "P7", reason: "x" })).status, 400);
      const accepted = await post({ recordId: "P1", reason: "Wrong customer" });
      assert.equal(accepted.status, 200);
      assert.equal(((await accepted.json()) as any).recomputation.version, 1);
      const investigation = await (await fetch(`${base}/api/investigation`)).json() as any;
      assert.equal(investigation.current.hypothesis.key, "H-PAID");
      assert.deepEqual(investigation.current.hypothesis.supporting.map((ref: any) => ref.recordId), ["P2"]);
      assert.deepEqual(investigation.current.noLongerCounted.map((item: any) => item.recordId), ["P1"]);
      assert.deepEqual(investigation.history.replaced.map((item: any) => item.key).sort(), ["H-PAID", "H-PARTIAL", "H-UNPAID"]);
      assert.ok(investigation.timeline.some((entry: any) => entry.title === "P1 withdrawn from the case"));
      // The run's own record of its conclusion is unchanged: it is history.
      assert.deepEqual(investigation.latestRun.conclusion.hypothesis.supporting.map((ref: any) => ref.recordId), ["P1", "P2"]);
    } finally {
      server.close();
    }
  });
});

test("the basis resolves supersession chains newest first and ignores claims about later records", () => {
  const entry = (id: string, observedAt: string, supersedes: string[], withdrawn = false) => ({
    record: { ...record(id, "bank", observedAt, {}, supersedes), retrieval: { mode: "fixture" as const, location: "", retrievedAt: "" } },
    judgments: [{ hypothesisKey: "H", direction: "supports" as const, strength: 1, decisive: false, basis: "rule" as const, rationale: "" }],
    withdrawn: withdrawn ? { reason: "test", at: "" } : null
  });
  const basis = deriveBasis([
    entry("A", "2026-01-01T00:00:00Z", []),
    entry("B", "2026-01-02T00:00:00Z", ["A"]),
    entry("C", "2026-01-03T00:00:00Z", ["B"], true),
    entry("D", "2026-01-04T00:00:00Z", ["E"]),
    entry("E", "2026-01-05T00:00:00Z", [])
  ], ["H"]);
  // C is withdrawn, so B stands and still replaces A; D cannot replace the later E.
  assert.deepEqual([...basis.invalid].map(([id, why]) => [id, why.kind]), [["C", "withdrawn"], ["A", "superseded"]]);
  assert.deepEqual(basis.plan.get("H")!.map((item) => item.recordId), ["B", "D", "E"]);
});
