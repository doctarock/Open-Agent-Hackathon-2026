import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR } from "../config.js";
import { loadEvalCases, REGRESSION_DIR } from "../eval/cases.js";
import { runEvaluation, systemsFor, type EvalMode, type EvalReport } from "../eval/harness.js";
import type { Rate } from "../eval/metrics.js";

// npm run eval        deterministic fixture evaluation (no model, no credentials)
// npm run eval:live   the same cases with the configured Nemotron endpoint

const mode: EvalMode = process.argv.includes("--live") ? "live" : "fixture";
let nemotron;
if (mode === "live") {
  loadDotEnv();
  nemotron = loadConfig().nemotron;
  if (!nemotron.baseUrl || !nemotron.model || !/nemotron/i.test(nemotron.model)) {
    console.log("Live evaluation skipped: NEMOTRON_BASE_URL and a Nemotron NEMOTRON_MODEL must be set (see .env.example).");
    process.exit(2);
  }
  console.log(`Live evaluation against ${nemotron.model} @ ${nemotron.baseUrl}`);
}

// Two groups, reported separately: the seven held-out cases, and the
// correction-sequence regression cases added in Build 3.
for (const group of [
  { title: "held-out cases", cases: loadEvalCases(), file: `${mode}.json` },
  { title: "correction-sequence regression cases", cases: loadEvalCases(REGRESSION_DIR), file: `${mode}-regression.json` }
]) {
  const report = await runEvaluation(mode, group.cases, systemsFor(mode, nemotron), (message) => { if (mode === "live") console.log(`  ${message}`); });
  print(report, group.title);
  const out = path.join(ROOT_DIR, "eval", "results", group.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), group: group.title, ...report }, null, 2)}\n`);
  console.log(`\nFull report: ${path.relative(ROOT_DIR, out)}\n`);
}

function print(report: EvalReport, title: string): void {
  const show = (value: Rate) => (value.of ? `${value.count}/${value.of}` : "n/a");
  console.log(`\nEvidence Desk evaluation (${report.mode}): ${report.cases.length} ${title}, ${report.cases.reduce((sum, item) => sum + item.checkpoints, 0)} labelled checkpoints`);
  console.log("Counts over these checkpoints only; not a general accuracy measure.\n");
  const rows: Array<[string, (score: EvalReport["systems"][number]) => string]> = [
    ["conclusion correct", (s) => show(s.metrics.correctness)],
    ["valid citations", (s) => show(s.metrics.validCitations)],
    ["unsupported claims (of conclusions)", (s) => show(s.metrics.unsupportedClaims)],
    ["refuted claim kept out of current", (s) => show(s.metrics.correctionHandling)],
    ["invalidated evidence kept out of support", (s) => show(s.metrics.invalidatedExcluded)],
    ["abstained when it should", (s) => show(s.metrics.appropriateAbstention)],
    ["abstained when a conclusion was due", (s) => show(s.metrics.overAbstention)],
    ["provider failure surfaced", (s) => show(s.metrics.failureSurfaced)],
    ["explanation agrees with Speck", (s) => show(s.metrics.explanationAgreement)],
    ["model calls answered", (s) => (s.metrics.model ? show(s.metrics.model.answered) : "n/a")],
    ["model replies valid", (s) => (s.metrics.model ? show(s.metrics.model.contractValid) : "n/a")],
    ["latency ms mean/median/max", (s) => (s.metrics.model?.latencyMs ? `${s.metrics.model.latencyMs.mean}/${s.metrics.model.latencyMs.median}/${s.metrics.model.latencyMs.max}` : "n/a")]
  ];
  const width = Math.max(...report.systems.map((system) => system.system.length), ...report.systems.flatMap((system) => system.checkpoints.map((score) => (score.tentative?.length ?? 0) + (score.concluded ?? "abstain").length + 6)), 12);
  console.log(`${"".padEnd(42)}${report.systems.map((system) => system.system.padEnd(width + 2)).join("")}`);
  for (const [label, value] of rows) console.log(`${label.padEnd(42)}${report.systems.map((system) => value(system).padEnd(width + 2)).join("")}`);

  console.log("\nPer checkpoint (expected -> concluded; ~ tentative; ! error):");
  const first = report.systems[0]!;
  first.checkpoints.forEach((checkpoint, index) => {
    const cells = report.systems.map((system) => {
      const score = system.checkpoints[index]!;
      const shown = score.error ? `!${score.error.split(":")[0]}` : (score.concluded ?? "abstain") + (score.tentative ? ` ~${score.tentative}` : "");
      return `${score.correct ? "ok " : "NO "}${shown}`.padEnd(width + 2);
    });
    console.log(`${`${checkpoint.caseId}@${checkpoint.stage}`.padEnd(42)}${cells.join("")}  expected ${checkpoint.expected ?? "abstain"}`);
  });
  for (const system of report.systems) {
    const flagged = system.checkpoints.filter((score) => score.invalidCitations.length || score.forbiddenCited.length || score.presentedRefuted.length || score.staleSupport.length || score.unsupportedClaim);
    for (const score of flagged) {
      console.log(`  ${system.system} ${score.caseId}@${score.stage}:${score.unsupportedClaim ? " unsupported claim;" : ""}${score.invalidCitations.length ? ` invalid citations ${score.invalidCitations.join(",")};` : ""}${score.forbiddenCited.length ? ` cited non-existent ${score.forbiddenCited.join(",")};` : ""}${score.presentedRefuted.length ? ` presented refuted ${score.presentedRefuted.join(",")} as current;` : ""}${score.staleSupport.length ? ` support from invalidated ${score.staleSupport.join(",")};` : ""}`);
    }
  }
  console.log("\nDifferences between the systems:");
  for (const line of report.differences) console.log(`  - ${line}`);
}
