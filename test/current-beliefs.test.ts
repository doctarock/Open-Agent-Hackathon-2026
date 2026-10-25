import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { createServer } from "../src/server.js";
import { testConfig, withDesk, writeScenario } from "./helpers.js";

// Speck's own rankHypotheses lists superseded hypotheses, ranked by
// confidence. Here a superseded one (H-PAID, confirmed 0.86) ranks first. Every
// path by which Evidence Desk presents beliefs, to the investigator or to the
// model, must show only the current ones:
//   conclusionFromSpeck (headline, hypothesis, alternatives, rejected, direction)
//   hypotheses()              -> /api/investigation "hypotheses"
//   the Meterless carryover   -> the model's view between chunks (DECISIONS)
//   the explanation prompt    -> the model's view for its explanation
//   the timeline              -> entries about replaced hypotheses are history
//   /api/investigation        -> "current" and "hypotheses" vs "history"

const record = (id: string, observedAt: string, facts: Record<string, string>, supersedes: string[] = []) => ({
  id, caseId: "CASE-RANK", source: { system: "bank", name: "Bank" }, observedAt, content: id, facts,
  provenance: { systemOfRecord: "Bank", recordRef: id, author: "test", supersedes }
});

function scenario(): string {
  return writeScenario({
    id: "rank", caseId: "CASE-RANK", title: "Paid?", question: "Was the invoice paid?",
    sources: { bank: { name: "Bank", reliability: 0.95 }, ledger: { name: "Ledger", reliability: 0.85 } },
    hypotheses: [
      { key: "H-PAID", statement: "Paid in full.", prior: 0.5, rules: [
        { fact: "received", equals: "true", direction: "supports" },
        { fact: "ledger", equals: "paid", direction: "supports" },
        { fact: "reversed", equals: "true", direction: "contradicts", decisive: true } ] },
      { key: "H-UNPAID", statement: "Unpaid.", prior: 0.3, rules: [
        { fact: "reversed", equals: "true", direction: "supports" },
        { fact: "ledger", equals: "reopened", direction: "supports" },
        { fact: "received", equals: "true", direction: "contradicts" } ] }
    ],
    questions: [],
    stages: [
      { id: "credit", label: "Credit", asOf: "2026-05-02T00:00:00Z", description: "" },
      { id: "reversal", label: "Reversal", asOf: "2026-05-04T00:00:00Z", description: "" }
    ]
  }, [
    record("P1", "2026-05-01T01:00:00Z", { received: "true" }),
    { ...record("P2", "2026-05-01T02:00:00Z", { ledger: "paid" }), source: { system: "ledger", name: "Ledger" } },
    record("P3", "2026-05-03T01:00:00Z", { reversed: "true" }, ["P1"]),
    { ...record("P4", "2026-05-03T02:00:00Z", { ledger: "reopened" }), source: { system: "ledger", name: "Ledger" } }
  ]);
}

test("no path presents a superseded belief as current, even when Speck ranks it first", async () => {
  const prompts: string[] = [];
  let current: EvidenceDesk | null = null;
  // The rule assessor, plus an explanation step so the model-facing prompt is built.
  const reasoner: Reasoner = {
    kind: "rules",
    describe: () => ({ kind: "rules", label: "rules with explanation (test)", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      return { judgments: Object.fromEntries(input.batch.map((item) => [item.id, ruleJudgments(item, current!.scenario.hypotheses)])), notes: [], narrative: "" };
    },
    async explain(prompt) {
      prompts.push(prompt);
      return { text: "", citedEvidence: [], statedConclusion: "unresolved", statedEstablished: false };
    }
  };
  const config = testConfig({ scenarioDir: scenario(), execution: { maxChunks: 8, batchSize: 1 } });
  await withDesk(config, async (desk) => {
    current = desk;
    await desk.run();
    await desk.introduceNextUpdate();
    const run = await desk.run();

    // Precondition: Speck's raw ranking puts the superseded H-PAID first.
    const raw = desk.runtime.rankHypotheses(desk.runtime.listWorkers()[0]!.id);
    assert.equal(raw[0]!.data.key, "H-PAID");
    assert.equal(raw[0]!.data.status, "superseded");
    assert.equal(raw[0]!.data.statusWhenReplaced, "confirmed");
    const superseded = new Set(raw.filter((object) => object.data.status === "superseded").map((object) => object.id));
    assert.ok(superseded.size >= 2);
    const currentIds = new Set([...desk.currentHypotheses().values()].map((object) => object.id));
    assert.ok([...superseded].every((id) => !currentIds.has(id)));

    // The conclusion and every view in it.
    const conclusion = desk.conclusionFromSpeck();
    const views = [conclusion.hypothesis, ...conclusion.alternatives, ...conclusion.rejected].filter((view) => view !== null);
    assert.deepEqual(views.map((view) => `${view!.key} ${view!.status} ${view!.confidence}`).sort(), ["H-PAID rejected 0.05", "H-UNPAID supported 0.66"]);
    assert.equal(conclusion.hypothesis?.key, "H-UNPAID");
    assert.equal(conclusion.direction.pointsTo?.key, "H-UNPAID");
    assert.ok(!conclusion.headline.includes("Paid in full"));
    assert.deepEqual(desk.hypotheses().map((view) => view.status).filter((status) => status === "superseded"), []);

    // What the model saw between chunks: after the rebuild, never the superseded H-PAID.
    const decisions = run.execution.chunks.flatMap((chunk) => [chunk.content, chunk.carryover]).join("\n").split("\n").filter((line) => line.startsWith("DECISIONS:"));
    assert.ok(decisions.length >= 1, "a state checkpoint was written");
    for (const line of decisions) {
      assert.match(line, /H-PAID rejected 0\.05/);
      assert.doesNotMatch(line, /superseded|confirmed|0\.86/);
    }
    // What the model saw for its explanation.
    const explanation = prompts.at(-1)!;
    const hypothesisLines = explanation.split("\n").filter((line) => line.startsWith("- H-"));
    assert.deepEqual(hypothesisLines.map((line) => line.split(":")[0]), ["- H-UNPAID [supported, Speck confidence 0.66]", "- H-PAID [rejected, Speck confidence 0.05]"]);
    assert.doesNotMatch(explanation, /superseded,|confirmed|0\.86/);
    assert.match(explanation, /\[P1\] .*NO LONGER COUNTS: P1 superseded by P3/);

    // The timeline: anything about a replaced hypothesis is history, never a significant change.
    for (const entry of desk.timeline()) {
      if (entry.historical) assert.equal(entry.significant, false, `${entry.title} is history, not a current change`);
    }
    assert.ok(desk.timeline().some((entry) => entry.historical && /H-PAID: .* → confirmed 0\.86 \(since replaced\)/.test(entry.title)));

    // The API keeps current and history apart.
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/investigation`)).json() as any;
      assert.deepEqual(body.hypotheses.map((view: any) => `${view.key} ${view.status}`).sort(), ["H-PAID rejected", "H-UNPAID supported"]);
      assert.equal(body.current.hypothesis.key, "H-UNPAID");
      assert.ok(body.history.replaced.some((item: any) => item.key === "H-PAID" && item.statusWhenReplaced === "confirmed"));
      // ("superseded" may appear as a record's invalidation, never as a belief's status.)
      const presented = [body.current.hypothesis, ...body.current.alternatives, ...body.current.rejected].filter(Boolean);
      assert.deepEqual(presented.map((view: any) => view.status).filter((status: string) => status === "superseded"), []);
      assert.deepEqual(body.current.noLongerCounted.map((item: any) => [item.recordId, item.invalidation.kind]), [["P1", "superseded"], ["P2", "restated"]]);
    } finally {
      server.close();
    }
  }, { reasoner });
});
