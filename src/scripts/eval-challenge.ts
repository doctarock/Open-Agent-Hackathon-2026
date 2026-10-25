import fs from "node:fs";
import path from "node:path";
import { CONCLUSION_RULES, loadConfig, loadDotEnv, ROOT_DIR, type ConclusionRule } from "../config.js";
import { CHALLENGE5_DIR, CHALLENGE_DIR, loadEvalCases } from "../eval/cases.js";
import { verifyLock } from "../eval/cross-domain.js";
import { runEvaluation, systemsFor, type EvalMode } from "../eval/harness.js";
import { printReport } from "../eval/print.js";
import { writeReport } from "../eval/results.js";
import { modelConfigProblem } from "../reasoning/nemotron.js";

// npm run eval:challenge                         deterministic (fact rules, no model)
// npm run eval:challenge -- --live [--repeats N]  the configured Nemotron endpoint
//   --set 5            the Build 5 set (eval/challenge-5/) instead of Build 4's
//   --rule <rule>      the corroboration rule (default corroborated-1)
//   --out <dir>        live: the directory for the repeats, under eval/results/experiments/
//
// The challenge cases (eval/challenge/README.md, eval/challenge-5/README.md),
// scored like the held-out cases. Refuses to run if a case file differs from
// its lock: the labels were fixed before any system was run on them.
// The deterministic report goes to eval/results/challenge[-5]-fixture.json
// (the previous one is archived); each live repeat is its own file under
// eval/results/experiments/challenge[-5]/<time or --out>/, never overwritten.

const option = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; };
const mode: EvalMode = process.argv.includes("--live") ? "live" : "fixture";
const repeats = mode === "live" && option("repeats") ? Math.max(1, Number(option("repeats")) || 1) : 1;
const set5 = option("set") === "5";
const rule = (option("rule") ?? "corroborated-1") as ConclusionRule;
if (!CONCLUSION_RULES.includes(rule)) throw new Error(`--rule must be one of ${CONCLUSION_RULES.join(", ")}`);
const casesDir = set5 ? CHALLENGE5_DIR : CHALLENGE_DIR;
const lock = verifyLock(casesDir, path.join(casesDir, "expectations.lock.json"));
console.log(`Challenge cases${set5 ? " (set 5)" : ""}: ${lock.files} files verified against the lock written ${lock.lockedAt}. Rule ${rule}.`);

let nemotron;
if (mode === "live") {
  loadDotEnv();
  nemotron = loadConfig().nemotron;
  const problem = modelConfigProblem(nemotron);
  if (problem) {
    console.log(`Live challenge evaluation skipped: ${problem} (run npm run configure, or see .env.example).`);
    process.exit(2);
  }
  console.log(`Live, ${repeats} repeat(s), against ${nemotron.model} @ ${nemotron.baseUrl} (provider ${nemotron.provider}, reasoning effort ${nemotron.reasoningEffort || "default"})`);
}

const group = set5 ? "challenge-5" : "challenge";
const dir = path.join(ROOT_DIR, "eval", "results", "experiments", group, option("out") ?? new Date().toISOString().replace(/[:.]/g, "-"));
for (let repeat = 1; repeat <= repeats; repeat++) {
  const began = Date.now();
  const report = await runEvaluation(mode, loadEvalCases(casesDir), systemsFor(mode, nemotron, rule), (message) => { if (mode === "live") console.log(`  ${message}`); });
  printReport(report, `challenge cases${set5 ? " (set 5)" : ""}${repeats > 1 ? `, repeat ${repeat}/${repeats}` : ""}`);
  const content = `${JSON.stringify({ generatedAt: new Date().toISOString(), group, rule, lock, repeat, wallMs: Date.now() - began, ...(nemotron ? { model: { provider: nemotron.provider, model: nemotron.model, endpoint: nemotron.baseUrl, reasoningEffort: nemotron.reasoningEffort || null, maxTokens: nemotron.maxTokens } } : {}), ...report }, null, 1)}\n`;
  const out = mode === "live" ? path.join(dir, `r${repeat}.json`) : path.join(ROOT_DIR, "eval", "results", `${group}-fixture${rule === "corroborated-1" ? "" : `-${rule}`}.json`);
  if (mode === "live") {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(out)) throw new Error(`${path.relative(ROOT_DIR, out)} exists; live reports are never overwritten`);
    fs.writeFileSync(out, content);
  } else {
    writeReport(out, content);
  }
  console.log(`\nFull report: ${path.relative(ROOT_DIR, out)}\n`);
}
