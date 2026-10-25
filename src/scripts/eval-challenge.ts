import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR } from "../config.js";
import { CHALLENGE_DIR, loadEvalCases } from "../eval/cases.js";
import { verifyLock } from "../eval/cross-domain.js";
import { runEvaluation, systemsFor, type EvalMode } from "../eval/harness.js";
import { printReport } from "../eval/print.js";
import { writeReport } from "../eval/results.js";
import { modelConfigProblem } from "../reasoning/nemotron.js";

// npm run eval:challenge                         deterministic (fact rules, no model)
// npm run eval:challenge -- --live [--repeats N]  the configured Nemotron endpoint
//
// The Build 4 challenge cases (eval/challenge/README.md), scored like the
// held-out cases. Refuses to run if a case file differs from its lock: the
// labels were fixed before any system was run on them.
// The deterministic report goes to eval/results/challenge-fixture.json (the
// previous one is archived); each live repeat is its own file under
// eval/results/experiments/challenge/<time>/, never overwritten.

const mode: EvalMode = process.argv.includes("--live") ? "live" : "fixture";
const repeatsAt = process.argv.indexOf("--repeats");
const repeats = mode === "live" && repeatsAt >= 0 ? Math.max(1, Number(process.argv[repeatsAt + 1]) || 1) : 1;
const lock = verifyLock(CHALLENGE_DIR, path.join(CHALLENGE_DIR, "expectations.lock.json"));
console.log(`Challenge cases: ${lock.files} files verified against the lock written ${lock.lockedAt}.`);

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

const dir = path.join(ROOT_DIR, "eval", "results", "experiments", "challenge", new Date().toISOString().replace(/[:.]/g, "-"));
for (let repeat = 1; repeat <= repeats; repeat++) {
  const began = Date.now();
  const report = await runEvaluation(mode, loadEvalCases(CHALLENGE_DIR), systemsFor(mode, nemotron), (message) => { if (mode === "live") console.log(`  ${message}`); });
  printReport(report, `challenge cases${repeats > 1 ? `, repeat ${repeat}/${repeats}` : ""}`);
  const content = `${JSON.stringify({ generatedAt: new Date().toISOString(), group: "challenge", lock, repeat, wallMs: Date.now() - began, ...(nemotron ? { model: { provider: nemotron.provider, model: nemotron.model, endpoint: nemotron.baseUrl, reasoningEffort: nemotron.reasoningEffort || null, maxTokens: nemotron.maxTokens } } : {}), ...report }, null, 1)}\n`;
  const out = mode === "live" ? path.join(dir, `r${repeat}.json`) : path.join(ROOT_DIR, "eval", "results", "challenge-fixture.json");
  if (mode === "live") {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, content);
  } else {
    writeReport(out, content);
  }
  console.log(`\nFull report: ${path.relative(ROOT_DIR, out)}\n`);
}
