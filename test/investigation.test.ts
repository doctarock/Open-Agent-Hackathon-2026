import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { EvidenceRecord } from "../src/evidence/types.js";
import type { EvidenceRef, HypothesisView } from "../src/investigation/conclusion.js";
import { createServer } from "../src/server.js";
import { testConfig, withDesk, writeScenario } from "./helpers.js";

const fixtureRecords = (dir: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8")) as { records: EvidenceRecord[] }).records;

test("fixture mode runs end to end without external credentials", async () => {
  const config = testConfig();
  assert.equal(config.evidenceMode, "fixture");
  assert.equal(config.reasoner, "rules");
  assert.equal(config.zetaris.username, "");
  assert.equal(config.zetaris.password, "");
  await withDesk(config, async (desk) => {
    const run = await desk.run();
    assert.equal(run.execution.status, "completed");
    assert.equal(run.evidence.mode, "fixture");
    assert.equal(run.reasoner.kind, "rules");
    assert.equal(run.reasoner.model, null);
    assert.equal(run.explanation, null);
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["EV-OMS-001", "EV-WMS-002", "EV-CAR-003", "EV-SUP-004"]);
    assert.ok(run.assessed.every((item) => item.record.retrieval.mode === "fixture"));
    // The initial evidence supports a plausible but incomplete conclusion.
    assert.equal(run.conclusion.state, "leading");
    assert.equal(run.conclusion.hypothesis?.key, "H-DELIVERED");
    assert.deepEqual(run.conclusion.hypothesis?.contradicting.map((ref) => ref.recordId), ["EV-SUP-004"]);
    assert.ok(run.conclusion.openQuestions.some((question) => question.id === "Q-ADDRESS"));
  });
});

test("every cited evidence item exists and keeps its source metadata", async () => {
  const config = testConfig();
  const original = new Map(fixtureRecords(config.scenarioDir).map((record) => [record.id, record]));
  await withDesk(config, async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    const run = await desk.run();
    const listing = await desk.listEvidence();
    const listed = new Map(listing.records.map((record) => [record.id, record]));
    const views: HypothesisView[] = [run.conclusion.hypothesis!, ...run.conclusion.alternatives, ...run.conclusion.rejected];
    const refs: EvidenceRef[] = views.flatMap((view) => [...view.supporting, ...view.contradicting]);
    assert.ok(refs.length >= 6);
    for (const ref of refs) {
      const record = listed.get(ref.recordId);
      assert.ok(record, `${ref.recordId} is cited but not in the evidence list`);
      assert.equal(ref.sourceSystem, record.source.system);
      assert.equal(ref.sourceName, record.source.name);
      assert.equal(ref.observedAt, record.observedAt);
      assert.equal(ref.retrievalMode, record.retrieval.mode);
      const source = original.get(ref.recordId)!;
      assert.deepEqual(record.provenance, source.provenance);
      assert.equal(record.content, source.content);
    }
    for (const answered of run.conclusion.answeredQuestions) assert.ok(listed.has(answered.recordId));
  });
});

test("a corrective update is persisted and visible to the next investigation", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    await desk.run();
    const listing = await desk.listEvidence();
    assert.ok(!listing.records.some((record) => record.id === "EV-CAR-005"), "the update is not visible before it is introduced");
    const stage = await desk.introduceNextUpdate();
    assert.equal(stage.id, "carrier-correction");
  });
  // A new process: the stage and the earlier run come back from Speck's database.
  await withDesk(config, async (desk) => {
    assert.equal(desk.currentStage().id, "carrier-correction");
    assert.equal(desk.runs().length, 1);
    const listing = await desk.listEvidence();
    assert.deepEqual(listing.pending, ["EV-CAR-005", "EV-SUP-006"]);
    assert.equal(listing.records.find((record) => record.id === "EV-CAR-003")?.supersededBy, "EV-CAR-005");
    const run = await desk.run();
    assert.equal(run.runNumber, 2);
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["EV-CAR-005", "EV-SUP-006"]);
    assert.match(run.execution.chunks[0]!.content, /EV-CAR-005/);
    assert.equal((await desk.listEvidence()).pending.length, 0);
  });
});

test("claims Speck has refuted are not presented as current", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    await desk.run();
    await desk.introduceNextUpdate();
    const run = await desk.run();
    const conclusion = run.conclusion;
    assert.equal(conclusion.state, "supported");
    assert.equal(conclusion.hypothesis?.key, "H-MISDELIVERED");
    assert.notEqual(conclusion.headline, desk.scenario.hypotheses.find((h) => h.key === "H-DELIVERED")!.statement);
    assert.ok(!conclusion.alternatives.some((view) => view.key === "H-DELIVERED"));
    // With rule-judged evidence the direction is also justified.
    assert.equal(conclusion.direction.pointsTo?.key, "H-MISDELIVERED");
    assert.equal(conclusion.justification.established, true);
    assert.equal(conclusion.justification.gapToSupported, 0);
    const delivered = conclusion.rejected.find((view) => view.key === "H-DELIVERED");
    assert.equal(delivered?.status, "rejected");
    assert.ok(delivered?.contradicting.some((ref) => ref.recordId === "EV-CAR-005"));
    // The revision is Speck's: its belief state and event log, not this app's bookkeeping.
    // EV-CAR-005 supersedes the delivery scan, so H-DELIVERED was rebuilt without
    // it; the earlier hypothesis stays in Speck, marked superseded.
    const speckViews = desk.runtime.rankHypotheses(desk.runtime.listWorkers()[0]!.id).filter((object) => object.data.key === "H-DELIVERED");
    const speckView = speckViews.find((object) => object.data.status !== "superseded")!;
    assert.equal(speckView.data.status, "rejected");
    assert.equal(desk.currentHypotheses().get("H-DELIVERED")?.id, speckView.id);
    assert.ok(speckViews.some((object) => object.data.status === "superseded" && object.data.supersededBy === speckView.id));
    const timeline = desk.timeline();
    const revision = timeline.find((entry) => entry.kind === "revision" && entry.hypothesisKey === "H-DELIVERED" && entry.recordId === "EV-CAR-005");
    assert.ok(revision, "the timeline shows the revision and the evidence responsible");
    assert.match(revision.title, /→ rejected/);
    assert.match(revision.detail, /decisively/);
    const changed = timeline.find((entry) => entry.kind === "conclusion" && entry.runNumber === 2);
    assert.match(changed!.title, /conclusion revised \(leading H-DELIVERED → supported H-MISDELIVERED\)/);
    const entries = timeline.map((entry) => entry.sequence);
    assert.deepEqual(entries, [...entries].sort((left, right) => left - right), "the timeline is chronological");
  });
});

test("an unsupported conclusion stays explicitly unresolved", async () => {
  const scenarioDir = writeScenario({
    id: "thin-evidence", caseId: "CASE-THIN", title: "Thin evidence", question: "Who took the parcel?",
    sources: { support: { name: "Support inbox", reliability: 0.6 } },
    hypotheses: [
      { key: "H-NEIGHBOUR", statement: "A neighbour took the parcel.", prior: 0.3,
        rules: [{ fact: "customer.suspects_neighbour", equals: "true", direction: "supports", strength: 0.5 }] },
      { key: "H-COURIER", statement: "The courier kept the parcel.", prior: 0.3, rules: [] }
    ],
    questions: [{ id: "Q-WHO", text: "Who signed for the parcel?", answeredBy: "delivery.signed_by" }],
    stages: [{ id: "only", label: "Only stage", asOf: "2026-10-20T00:00:00Z", description: "One message." }]
  }, [{
    id: "EV-THIN-1", caseId: "CASE-THIN", source: { system: "support", name: "Support inbox" },
    observedAt: "2026-10-19T00:00:00Z", content: "Customer thinks a neighbour may have taken it.",
    facts: { "customer.suspects_neighbour": "true" },
    provenance: { systemOfRecord: "Support inbox", recordRef: "t/1", author: "customer", supersedes: [] }
  }]);
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    const run = await desk.run();
    assert.equal(run.conclusion.state, "unresolved");
    assert.equal(run.conclusion.hypothesis, null);
    assert.match(run.conclusion.headline, /^Unresolved/);
    assert.deepEqual(run.conclusion.openQuestions.map((question) => question.id), ["Q-WHO"]);
    assert.equal(run.conclusion.direction.pointsTo, null, "0.36 against 0.30 is too close to favour either");
    assert.equal(run.conclusion.justification.established, false);
    assert.equal(run.conclusion.answeredQuestions.length, 0);
    // Nothing was invented: the only evidence is the one record supplied.
    const cited = [...run.conclusion.alternatives, ...run.conclusion.rejected].flatMap((view) => [...view.supporting, ...view.contradicting]);
    assert.deepEqual([...new Set(cited.map((ref) => ref.recordId))], ["EV-THIN-1"]);
  });
});

test("later support cannot revive a decisively refuted hypothesis", async () => {
  const record = (id: string, observedAt: string, facts: Record<string, string>) => ({
    id, caseId: "CASE-REVIVE", source: { system: "carrier", name: "Carrier" }, observedAt, content: id, facts,
    provenance: { systemOfRecord: "Carrier", recordRef: id, author: "test", supersedes: [] }
  });
  const scenarioDir = writeScenario({
    id: "revive", caseId: "CASE-REVIVE", title: "Revive", question: "Was it delivered?",
    sources: { carrier: { name: "Carrier", reliability: 0.9 } },
    hypotheses: [
      { key: "H-DELIVERED", statement: "Delivered to the right address.", prior: 0.5, rules: [
        { fact: "delivery.address_match", equals: "false", direction: "contradicts", decisive: true },
        { fact: "carrier.status", equals: "delivered", direction: "supports" }
      ] },
      { key: "H-WRONG", statement: "Delivered to the wrong address.", prior: 0.3, rules: [
        { fact: "delivery.address_match", equals: "false", direction: "supports" }
      ] }
    ],
    questions: [],
    stages: [{ id: "only", label: "Only", asOf: "2026-10-20T00:00:00Z", description: "" }]
  }, [
    record("EV-1", "2026-10-10T00:00:00Z", { "delivery.address_match": "false" }),
    record("EV-2", "2026-10-11T00:00:00Z", { "carrier.status": "delivered" })
  ]);
  await withDesk(testConfig({ scenarioDir }), async (desk) => {
    const run = await desk.run();
    const delivered = run.conclusion.rejected.find((view) => view.key === "H-DELIVERED");
    assert.equal(delivered?.status, "rejected", "EV-2's support did not move it back to active");
    assert.deepEqual(delivered?.supporting, [], "the support never reached Speck");
    // The judgment is kept as given and withheld by derivation, so it would
    // apply again if EV-1 were ever invalidated.
    assert.deepEqual(run.assessed.find((item) => item.record.id === "EV-2")?.judgments.map((judgment) => [judgment.hypothesisKey, judgment.direction]), [["H-DELIVERED", "supports"]]);
    const listed = (await desk.listEvidence()).records.find((record) => record.id === "EV-2")!;
    assert.deepEqual(listed.assessment?.judgments.map((judgment) => [judgment.effect, judgment.refutedBy]), [["withheld", "EV-1"]]);
    assert.ok(run.notes.some((note) => /Withheld from Speck: EV-2 supports H-DELIVERED \(rule\), which EV-1 refutes decisively/.test(note)));
    assert.equal(run.conclusion.direction.pointsTo?.key, "H-WRONG");
  });
});

test("the page shows Speck's persisted belief state and labels how each record was weighed", async () => {
  const config = testConfig();
  const fetchJson = async (port: number, path: string, method = "GET") => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json() as Promise<any>;
  const serve = async (body: (port: number) => Promise<void>) => withDesk(config, async (desk) => {
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try { await body((server.address() as { port: number }).port); } finally { server.close(); }
  });
  await serve(async (port) => {
    assert.equal((await fetchJson(port, "/api/investigation")).current, null);
    await fetchJson(port, "/api/run", "POST");
    const investigation = await fetchJson(port, "/api/investigation");
    assert.deepEqual(investigation.current, investigation.latestRun.conclusion);
    const evidence = await fetchJson(port, "/api/evidence");
    const wms = evidence.records.find((record: any) => record.id === "EV-WMS-002");
    assert.equal(wms.assessment.recordedBy, "rules");
    assert.deepEqual(wms.assessment.judgments.map((j: any) => [j.basis, j.hypothesisKey, j.decisive]), [["rule", "H-NOT-SHIPPED", true]]);
  });
  // Reopened from disk, Speck's state still matches what the run recorded.
  await serve(async (port) => {
    const investigation = await fetchJson(port, "/api/investigation");
    assert.deepEqual(investigation.current, investigation.latestRun.conclusion);
  });
});

test("a rerun with no new evidence changes nothing", async () => {
  await withDesk(testConfig(), async (desk) => {
    const first = await desk.run();
    const second = await desk.run();
    assert.equal(second.assessed.length, 0);
    assert.equal(second.execution.status, "completed");
    assert.deepEqual(second.conclusion, first.conclusion);
  });
});
