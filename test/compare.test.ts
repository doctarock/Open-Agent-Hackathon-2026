import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { comparisonFingerprint, loadComparisons, runComparison, saveComparison, type ComparisonReport } from "../src/compare/comparison.js";
import { acrossModels, aggregateComparisons, evaluationSummary } from "../src/compare/evaluation.js";
import { ROOT_DIR } from "../src/config.js";
import { loadEvalCases } from "../src/eval/cases.js";
import { writeReport } from "../src/eval/results.js";
import { speckDesk, statelessRules } from "../src/eval/systems.js";
import { createEvidenceProvider } from "../src/evidence/provider.js";
import { ZetarisEvidenceProvider } from "../src/evidence/zetaris-provider.js";
import { deskApi, errorResponse } from "../src/investigation/api.js";
import { tempDir, testConfig, withDesk } from "./helpers.js";

// Speck beside the stateless baseline on the same case (src/compare/).
// Nothing here asserts that one approach is better: the tests check that both
// see the same evidence, that each side is exactly what the evaluation's own
// systems produce, that the checks are computed the same way for both, and
// that saved comparisons are never overwritten or shown as current when they
// were made with other settings.

const BANK = path.join(ROOT_DIR, "eval", "scenarios", "correction-supersedes");
const DELIVERY = path.join(ROOT_DIR, "fixtures", "scenarios", "disputed-delivery");
const ui = await import(pathToFileURL(path.join(ROOT_DIR, "public", "compare.js")).href) as any;
const tour = await import(pathToFileURL(path.join(ROOT_DIR, "public", "tour.js")).href) as any;
const journey = await import(pathToFileURL(path.join(ROOT_DIR, "public", "journey.js")).href) as any;

async function compare(scenarioDir: string, env: NodeJS.ProcessEnv = {}): Promise<ComparisonReport> {
  const config = testConfig({ scenarioDir }, env);
  return runComparison(config, { provider: createEvidenceProvider(config) });
}

test("both approaches see the same records at every stage, and each side equals the evaluation's own system", async () => {
  const report = await compare(BANK);
  assert.equal(report.kind, "deterministic");
  assert.deepEqual(report.stages.map((stage) => stage.stage.id), ["before-return", "after-return"]);
  assert.deepEqual(report.stages.map((stage) => stage.visible.map((record) => record.id)), [["EV-BNK-101", "EV-LDG-102"], ["EV-BNK-101", "EV-LDG-102", "EV-BNK-103", "EV-LDG-104"]]);
  assert.deepEqual(report.stages[1]!.replaced, [{ recordId: "EV-BNK-101", by: "EV-BNK-103" }]);
  assert.deepEqual(report.stages[1]!.arrived, ["EV-BNK-103", "EV-LDG-104"]);

  // The same case through the evaluation's systems.
  const item = loadEvalCases().find((candidate) => candidate.id === "correction-supersedes")!;
  const [desk, stateless] = [await speckDesk({ kind: "rules" }).run(item), await statelessRules().run(item)];
  report.stages.forEach((stage, index) => {
    assert.deepEqual(stage.visible.map((record) => record.id), stateless.checkpoints[index]!.visibleEvidence, "the baseline saw what Speck saw");
    assert.equal(stage.stateless.concluded, stateless.checkpoints[index]!.conclusion);
    assert.deepEqual(stage.stateless.cited, stateless.checkpoints[index]!.supportCitations);
    assert.equal(stage.speck.concluded, desk.checkpoints[index]!.conclusion);
    assert.equal(stage.speck.tentative, desk.checkpoints[index]!.tentative);
  });
});

test("the correction: Speck's recorded revision, the baseline's lack of one, and the pre-registered labels", async () => {
  const report = await compare(BANK);
  const [before, after] = report.stages;
  assert.equal(before!.checks.speck.changed, "first");
  assert.equal(after!.checks.speck.recordsWhy, true, "Speck records why its conclusion changed");
  // EV-BNK-101 is replaced by the bank's return; EV-LDG-102 ("marked paid") is
  // out of date because the same ledger now reports the invoice reopened.
  assert.deepEqual(after!.speck.noLongerCounted.map((item) => item.recordId), ["EV-BNK-101", "EV-LDG-102"]);
  assert.match(after!.speck.noLongerCounted[1]!.explanation, /Accounts ledger has since reported a newer value for every fact in EV-LDG-102 \(ledger\.status: paid → reopened in EV-LDG-104\)/);
  assert.ok(after!.speck.revisions.length > 0, "the beliefs that rested on EV-BNK-101 were rebuilt");
  assert.equal(after!.checks.stateless.recordsWhy, false, "a stateless call keeps nothing to explain a change with");
  assert.deepEqual(after!.checks.speck.supportFromReplaced, [], "Speck's current support never includes the replaced record");
  // Labels come from expected.json, scored as the evaluation scores them.
  assert.equal(after!.label?.checkpoint.conclusion, "H-UNPAID");
  assert.equal(typeof after!.label?.stateless.correct, "boolean");

  // Build 4 fields: the out-of-date ledger status is marked for both sides,
  // the route is reported, and abstention is scored against the label.
  assert.equal(after!.visible.find((record) => record.id === "EV-LDG-102")?.outdatedBy, "EV-LDG-104");
  assert.equal(after!.speck.route, "speck-threshold");
  assert.equal(after!.label?.speck.abstention, null);
  assert.deepEqual(after!.checks.stateless.supportFromOutdated, []);
  assert.equal(after!.disagreement, null, "both conclude H-UNPAID");
  assert.equal(report.configuration.policy, "build-4 (restatement, corroborated-1)");

  // An evaluation-free case has no labels, and says so.
  const delivery = await compare(DELIVERY);
  assert.ok(delivery.stages.every((stage) => stage.label === null));
  assert.match(delivery.configuration.labels, /No pre-registered labels/);
  // Where they part, the report says why from what each returned.
  assert.match(delivery.stages[0]!.disagreement ?? "", /^Speck concludes nothing \(it points to H-DELIVERED\): .*; the stateless call concludes H-DELIVERED citing/);
});

test("the checks are computed the same way for both sides: a stateless answer citing a replaced record is flagged", async () => {
  // A stand-in model endpoint: the stateless prompt is answered by keeping
  // the original delivery and citing the replaced scan; Speck's own calls
  // get neutral judgments. It exercises the real adapters, not Nemotron.
  const endpoint = await standIn((prompt) => {
    if (prompt.includes("Decide which hypothesis the evidence establishes")) {
      return { conclusion: "H-DELIVERED", cited_evidence: ["EV-CAR-003"], rationale: "The carrier scan says delivered." };
    }
    if (prompt.includes("stated_conclusion")) return { explanation: "Unclear.", cited_evidence: [], stated_conclusion: "unresolved", stated_established: false };
    const ids = [...(prompt.split("EVIDENCE IN THIS CHUNK:")[1] ?? "").matchAll(/^\[(EV-[A-Z]+-\d+)\]/gm)].map((match) => match[1]!);
    return { judgments: ids.map((id) => ({ evidence_id: id, hypothesis: "H-DELIVERED", relation: "neutral", strength: 0.1, rationale: "no bearing" })), summary: "ok" };
  });
  try {
    const report = await compare(DELIVERY, { REASONER: "nemotron", NEMOTRON_BASE_URL: endpoint.url, NEMOTRON_MODEL: "test/nemotron-stand-in", NEMOTRON_REASONING_EFFORT: "none" });
    assert.equal(report.kind, "live");
    const after = report.stages[1]!;
    assert.equal(after.stateless.method, "nemotron");
    assert.equal(after.stateless.rationale, "The carrier scan says delivered.");
    assert.deepEqual(after.checks.stateless.supportFromReplaced, ["EV-CAR-003"]);
    assert.equal(after.checks.stateless.changed, "retained");
    assert.deepEqual(after.checks.speck.supportFromReplaced, []);
    assert.equal(after.stateless.model?.servedModels[0], "test/nemotron-stand-in");
    assert.ok(endpoint.prompts.some((prompt) => prompt.includes("replaces EV-CAR-003")), "the baseline is told what the correction replaces");
    assert.ok(report.notes.some((note) => /One sample|not a rate/.test(note)));
  } finally {
    endpoint.close();
  }
});

test("a comparison runs on its own storage: the case on the page is unchanged", async () => {
  const config = testConfig({ scenarioDir: BANK });
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    const before = { stage: desk.currentStage().id, runs: desk.runs().length, recorded: desk.recordedCount() };
    api.compare();
    await api.comparisonDone();
    assert.deepEqual({ stage: desk.currentStage().id, runs: desk.runs().length, recorded: desk.recordedCount() }, before);
    const state = api.comparison() as any;
    assert.equal(state.running, null);
    assert.equal(state.current.stages.length, 2);
  });
});

test("saved comparisons are never overwritten, partial writes are ignored, and other settings are never shown as current", async () => {
  const config = testConfig({ scenarioDir: BANK });
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    api.compare();
    assert.throws(() => api.compare(), (error: Error) => errorResponse(error).status === 409, "one comparison at a time");
    await api.comparisonDone();
    api.compare();
    await api.comparisonDone();
    const dir = path.join(path.dirname(config.historyDir), "comparisons", desk.scenario.id);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2, "each comparison is its own file");

    // An interrupted write leaves only a temporary file; a damaged file is counted.
    fs.writeFileSync(path.join(dir, "half.json.123.tmp"), "{\"schema\":");
    fs.writeFileSync(path.join(dir, "damaged.json"), "{not json");
    const state = api.comparison() as any;
    assert.equal(state.unreadable, 1);
    // (Comparisons saved by npm run compare in this repository are listed too, as "command".)
    assert.equal(state.others.filter((entry: any) => entry.origin === "page").length, 1, "the earlier comparison is listed");

    // A comparison made with other settings is listed but never current.
    const other = { ...(state.current as ComparisonReport), id: "other-settings", fingerprint: "0000000000000000", finishedAt: new Date(Date.now() + 60_000).toISOString() };
    saveComparison(dir, other);
    const after = api.comparison() as any;
    assert.notEqual(after.current.id, "other-settings");
    assert.equal(after.others.find((entry: any) => entry.id === "other-settings").matchesCurrent, false);
    assert.equal((api.comparisonReport("other-settings") as any).matchesCurrent, false);
    assert.throws(() => api.comparisonReport("missing"), (error: Error) => errorResponse(error).status === 404);
  });
});

test("a comparison that fails saves nothing and says so", async () => {
  const config = testConfig({ scenarioDir: DELIVERY });
  const unreachable = new ZetarisEvidenceProvider({ ...config.zetaris, baseUrl: "http://127.0.0.1:9", username: "test", password: "test-placeholder" });
  await withDesk(config, async (desk) => {
    // The case's provider is swapped for one that cannot be reached.
    Object.defineProperty(desk, "provider", { value: unreachable });
    const api = deskApi(desk, config, "test");
    api.compare();
    await api.comparisonDone();
    const state = api.comparison() as any;
    assert.equal(state.current, null);
    assert.equal(state.failure.kind, "evidence");
    assert.equal(fs.existsSync(path.join(path.dirname(config.historyDir), "comparisons", desk.scenario.id)), false);
  });
});

test("the fingerprint follows the scenario, its evidence and the assessor settings", () => {
  const rules = testConfig({ scenarioDir: BANK });
  const model = testConfig({ scenarioDir: BANK }, { REASONER: "nemotron", NEMOTRON_BASE_URL: "http://127.0.0.1:1/v1", NEMOTRON_MODEL: "nemotron-test" });
  const describe = (config: typeof rules) => createEvidenceProvider(config).describe();
  assert.equal(comparisonFingerprint(rules, describe(rules)), comparisonFingerprint(testConfig({ scenarioDir: BANK }), describe(rules)));
  assert.notEqual(comparisonFingerprint(rules, describe(rules)), comparisonFingerprint(model, describe(model)));
  assert.notEqual(comparisonFingerprint(rules, describe(rules)), comparisonFingerprint(testConfig({ scenarioDir: DELIVERY }), describe(rules)));
});

test("the page's findings and sequence are built from the report", async () => {
  const report = await compare(BANK);
  const text = JSON.stringify(ui.findings(report));
  assert.match(text, /EV-BNK-103 replaces EV-BNK-101/);
  assert.match(text, /Only Speck records why: EV-BNK-101 no longer counts/);
  assert.match(text, /Against the pre-registered labels/);
  assert.deepEqual(ui.sequence(report).map((step: any) => step.title), ["Observe", "Assess", "Correct", "Revise", "Verify", "Explain"]);
  assert.match(ui.sequence(report)[5].text, /stateless no · Speck yes/);
  assert.match(ui.provenanceLine(report), /^Deterministic run/);
  // The same templates describe a different outcome: nothing here is fixed.
  const flipped = structuredClone(report);
  flipped.stages[1]!.stateless.concluded = "H-PAID";
  flipped.stages[1]!.checks.stateless.changed = "retained";
  flipped.stages[1]!.checks.stateless.supportFromReplaced = ["EV-BNK-101"];
  assert.match(JSON.stringify(ui.findings(flipped)), /Stateless rule scoring: kept H-PAID.*still cites EV-BNK-101 as support, although EV-BNK-103 replaced it/);

  // The tour step waits for a real comparison and then describes it.
  const step = tour.TOUR_STEPS.find((item: any) => item.id === "compare");
  assert.equal(tour.stepDone(step, { comparison: null }), false);
  assert.equal(tour.stepDone(step, { comparison: { current: report, running: null } }), true);
  assert.equal(tour.stepDone(step, { comparison: { current: report, running: { startedAt: "now" } } }), false, "not done while a new one is running");
  assert.match(step.after({ comparison: { current: report } }).flat().join("\n"), /EV-BNK-103 replaces EV-BNK-101/);
  // The demo opens on it (the hotel chargeback, straight after the case), and the bank return,
  // worked by hand, ends on it; the disputed delivery has none.
  const cases = journey.JOURNEY.filter((part: any) => part.kind === "case");
  assert.deepEqual(cases.map((part: any) => part.steps.indexOf("compare")), [1, -1, cases[2].steps.length - 1]);
  assert.equal(tour.TOUR_STEPS.at(-2).id, "compare", "in the case tour it is the last step before the summary");
});

test("the evaluation summary reads the reports as written, lists missing ones, and counts saved comparisons", async () => {
  const root = tempDir();
  const results = path.join(root, "eval", "results");
  fs.mkdirSync(results, { recursive: true });
  const rate = (count: number, of: number) => ({ count, of, rate: of ? count / of : null });
  fs.writeFileSync(path.join(results, "fixture.json"), JSON.stringify({
    generatedAt: "2026-10-23T00:00:00.000Z", cases: [{ checkpoints: 2 }],
    systems: [{ system: "speck-desk/rules", metrics: { correctness: rate(2, 2), unsupportedClaims: rate(0, 1), model: null },
      checkpoints: [{ caseId: "c", stage: "s1", expected: "H", concluded: "H", tentative: null, error: null, correct: true, unsupportedClaim: false, staleSupport: [], presentedRefuted: [], invalidCitations: [] }] }],
    differences: ["d"]
  }));
  const report = await compare(BANK);
  saveComparison(path.join(results, "comparisons", "eval-correction-supersedes"), report);
  saveComparison(path.join(results, "comparisons", "eval-correction-supersedes"), { ...report, id: `${report.id}-2` });

  const summary = evaluationSummary(root);
  const fixture = summary.reports.find((item) => item.id === "fixture")!;
  assert.equal(fixture.available, true);
  assert.deepEqual(fixture.rows.map((row) => [row.id, row.values["speck-desk/rules"]?.count]), [["correctness", 2], ["unsupportedClaims", 0]], "only measures with a denominator are shown");
  assert.equal(fixture.perCheckpoint[0]!.results["speck-desk/rules"]!.concluded, "H");
  assert.equal(summary.reports.find((item) => item.id === "live")!.available, false);
  assert.equal(summary.reports.find((item) => item.id === "live")!.command, "npm run eval:live");

  const [group] = aggregateComparisons(path.join(results, "comparisons"));
  assert.equal(group!.samples, 2);
  assert.equal(group!.stages[1]!.approaches.speck.recordsWhy, 2);
  assert.equal(group!.stages[1]!.approaches.stateless.recordsWhy, 0);
  assert.equal(loadComparisons({ page: path.join(results, "comparisons", "eval-correction-supersedes"), command: path.join(results, "none") }, report.fingerprint).index.length, 2);
});

test("rewriting an evaluation report archives the previous one first", () => {
  const dir = tempDir();
  const file = path.join(dir, "fixture.json");
  writeReport(file, JSON.stringify({ generatedAt: "2026-10-22T10:00:00.000Z", n: 1 }));
  writeReport(file, JSON.stringify({ generatedAt: "2026-10-23T10:00:00.000Z", n: 2 }));
  writeReport(file, JSON.stringify({ generatedAt: "2026-10-23T10:00:00.000Z", n: 2 }));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).n, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, "history")), ["fixture-2026-10-22T10-00-00-000Z.json"], "the earlier report is kept once; an identical rewrite archives nothing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "history", "fixture-2026-10-22T10-00-00-000Z.json"), "utf8")).n, 1);
});

async function standIn(reply: (prompt: string) => unknown): Promise<{ url: string; prompts: string[]; close: () => void }> {
  const prompts: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const prompt = parsed.messages.at(-1).content as string;
      prompts.push(prompt);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: "assistant", content: JSON.stringify(reply(prompt)) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, prompts, close: () => server.close() };
}

test("results across models are read from the registered experiment folders, as their records report them", () => {
  const rows = acrossModels(path.join(ROOT_DIR, "eval", "results", "experiments"));
  const at = (suite: string, system: string) => rows.find((row) => row.suite.startsWith(suite) && row.system === system)!;
  const show = (rate: { count: number; of: number }) => `${rate.count}/${rate.of}`;
  // docs/set-7-conflicting-receipts.md, section 6a.
  assert.deepEqual([show(at("Set 7", "Stateless").models["bolt-e4b"]!.matches), show(at("Set 7", "Speck").models["bolt-e4b"]!.matches)], ["45/75", "33/75"]);
  assert.deepEqual([show(at("Set 7", "Stateless").models["nano-4b"]!.wrongExplanation), show(at("Set 7", "Speck").models["nano-4b"]!.wrongExplanation)], ["20/57", "0/57"]);
  assert.equal(show(at("Set 7", "Stateless").models["bolt-e4b"]!.replacedEvidenceKeptOut), "39/48");
  // docs/build-5-corroboration.md, 6a: a failed reply is not a conclusion.
  assert.equal(show(at("Set 5", "Stateless").models["nano-4b"]!.concludedWhereWaitingWasRight), "15/18");
  // docs/bolt-e4b.md, 2b.
  assert.deepEqual([show(at("Held-out", "Speck").models["bolt-e4b"]!.matches), show(at("Held-out", "Stateless").models["nano-4b"]!.matches)], ["42/48", "18/48"]);
  assert.ok(rows.every((row) => Object.values(row.models).every((cell) => cell && cell.reports === 3 || cell?.reports === 6)), "three repeats per suite and model (six reports where held-out and regression are separate files)");
});
