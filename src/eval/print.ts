import type { EvalReport } from "./harness.js";
import type { Rate } from "./metrics.js";

// The console report of an evaluation: the metrics with their denominators,
// then every checkpoint, then what each system got wrong. A Speck conclusion
// reached by corroboration (rule corroborated-1) is marked "(c)".

export function printReport(report: EvalReport, title: string): void {
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
      const shown = score.error ? `!${score.error.split(":")[0]}` : (score.concluded ?? "abstain") + (score.route === "corroboration" ? " (c)" : "") + (score.tentative ? ` ~${score.tentative}` : "");
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
