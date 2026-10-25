import path from "node:path";
import { CONCLUSION_RULES, loadConfig, loadDotEnv, ROOT_DIR, type ConclusionRule } from "../config.js";
import { modelConfigProblem } from "../reasoning/nemotron.js";
import { loadEvalCases, REGRESSION_DIR } from "../eval/cases.js";
import { runEvaluation, systemsFor, type EvalMode } from "../eval/harness.js";
import { printReport as print } from "../eval/print.js";
import { writeReport } from "../eval/results.js";

// npm run eval        deterministic fixture evaluation (no model, no credentials)
// npm run eval:live   the same cases with the configured Nemotron endpoint
//   -- --rule <rule>  the corroboration rule (default corroborated-1)

const mode: EvalMode = process.argv.includes("--live") ? "live" : "fixture";
const ruleAt = process.argv.indexOf("--rule");
const rule = (ruleAt >= 0 ? process.argv[ruleAt + 1] : "corroborated-1") as ConclusionRule;
if (!CONCLUSION_RULES.includes(rule)) throw new Error(`--rule must be one of ${CONCLUSION_RULES.join(", ")}`);
let nemotron;
if (mode === "live") {
  loadDotEnv();
  nemotron = loadConfig().nemotron;
  const problem = modelConfigProblem(nemotron);
  if (problem) {
    console.log(`Live evaluation skipped: ${problem} (run npm run configure, or see .env.example).`);
    process.exit(2);
  }
  console.log(`Live evaluation against ${nemotron.model} @ ${nemotron.baseUrl}`);
}

// Two groups, reported separately: the seven held-out cases, and the
// correction-sequence regression cases added in Build 3.
for (const group of [
  { title: "held-out cases", cases: loadEvalCases(), file: `${mode}${rule === "corroborated-1" ? "" : `-${rule}`}.json` },
  { title: "correction-sequence regression cases", cases: loadEvalCases(REGRESSION_DIR), file: `${mode}-regression${rule === "corroborated-1" ? "" : `-${rule}`}.json` }
]) {
  const report = await runEvaluation(mode, group.cases, systemsFor(mode, nemotron, rule), (message) => { if (mode === "live") console.log(`  ${message}`); });
  print(report, group.title);
  const out = path.join(ROOT_DIR, "eval", "results", group.file);
  writeReport(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), group: group.title, ...report }, null, 2)}\n`);
  console.log(`\nFull report: ${path.relative(ROOT_DIR, out)}\n`);
}
