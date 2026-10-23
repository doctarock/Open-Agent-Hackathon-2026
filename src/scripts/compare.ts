import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR, type AppConfig } from "../config.js";
import { publishedComparisonsDir, runComparison, saveComparison, type ComparisonReport, type SideChecks } from "../compare/comparison.js";
import { loadScenario } from "../scenario.js";
import { createEvidenceProvider } from "../evidence/provider.js";

// npm run compare        Speck beside the stateless baseline on both prepared
//                        cases, deterministic (fixture evidence, rule assessor)
// npm run compare:live   the same with the settings in .env: the configured
//                        Nemotron endpoint for both cases, and the configured
//                        evidence source (Zetaris) for the disputed delivery
//
// Each report is saved as a new file under eval/results/comparisons/<scenario>/;
// none is ever overwritten. The page shows the same reports per case.

const live = process.argv.includes("--live");
if (live) loadDotEnv();


const cases = [
  // The bank return's evidence exists only as a fixture file.
  { id: "bank-return", scenarioDir: "eval/scenarios/correction-supersedes", fixtureOnly: true },
  { id: "disputed-delivery", scenarioDir: "fixtures/scenarios/disputed-delivery", fixtureOnly: false }
];

function configFor(scenarioDir: string, fixtureOnly: boolean): AppConfig {
  const env = live ? { ...process.env, ...(fixtureOnly ? { EVIDENCE_MODE: "fixture" } : {}) } : {};
  return loadConfig({ ...env, EVIDENCE_DESK_SCENARIO: scenarioDir });
}

if (live) {
  const nemotron = loadConfig().nemotron;
  if (!nemotron.baseUrl || !/nemotron/i.test(nemotron.model)) {
    console.log("Live comparison skipped: NEMOTRON_BASE_URL and a Nemotron NEMOTRON_MODEL must be set (see .env.example).");
    process.exit(2);
  }
}

let failed = false;
for (const item of cases) {
  const config = configFor(item.scenarioDir, item.fixtureOnly);
  if (live) config.reasoner = "nemotron";
  const provider = createEvidenceProvider(config);
  console.log(`\n${item.id}: ${provider.describe().label}; assessor ${config.reasoner}${config.reasoner === "nemotron" ? ` (${config.nemotron.model} @ ${config.nemotron.baseUrl})` : ""}`);
  try {
    const report = await runComparison(config, { provider, onProgress: (p) => console.log(`  ${p.stage}: ${p.step}`) });
    const file = saveComparison(publishedComparisonsDir(ROOT_DIR, loadScenario(config.scenarioDir).id), report);
    print(report);
    console.log(`  saved ${path.relative(ROOT_DIR, file)}`);
  } catch (error) {
    failed = true;
    console.log(`  comparison failed: ${error instanceof Error ? error.message : String(error)} (nothing saved)`);
  }
}
process.exit(failed ? 1 : 0);

function print(report: ComparisonReport): void {
  const held = (concluded: string | null, tentative: string | null, error: string | null) =>
    error ? `error: ${error.slice(0, 60)}` : concluded ?? (tentative ? `abstains (tentatively ${tentative})` : "abstains");
  const flags = (checks: SideChecks) => [
    checks.supportFromReplaced.length ? `relies on replaced ${checks.supportFromReplaced.join(",")}` : "",
    checks.unknownCitations.length ? `cites unknown ${checks.unknownCitations.join(",")}` : "",
    checks.changed !== "first" ? checks.changed : "",
    checks.recordsWhy ? "records why" : ""
  ].filter(Boolean).join("; ");
  console.log(`  ${report.kind} comparison, ${report.durationMs} ms`);
  for (const stage of report.stages) {
    console.log(`  [${stage.stage.label}] ${stage.visible.length} record(s)${stage.replaced.length ? `; replaced: ${stage.replaced.map((item) => `${item.recordId}->${item.by}`).join(", ")}` : ""}`);
    console.log(`    Speck:     ${held(stage.speck.concluded, stage.speck.tentative, stage.speck.error)}${stage.speck.confidence !== null ? ` (${stage.speck.state} ${stage.speck.confidence})` : ""}  ${flags(stage.checks.speck)}`);
    console.log(`    Stateless: ${held(stage.stateless.concluded, null, stage.stateless.error)}${stage.stateless.cited.length ? ` citing ${stage.stateless.cited.join(",")}` : ""}  ${flags(stage.checks.stateless)}`);
    if (stage.label) {
      const mark = (score: { correct: boolean; unsupportedClaim: boolean }) => `${score.correct ? "correct" : "not correct"}${score.unsupportedClaim ? ", unsupported claim" : ""}`;
      console.log(`    label: ${stage.label.speck.expected ?? "abstain"}  Speck ${mark(stage.label.speck)}; stateless ${mark(stage.label.stateless)}`);
    }
  }
}
