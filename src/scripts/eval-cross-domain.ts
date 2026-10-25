import fs from "node:fs";
import path from "node:path";
import { CONCLUSION_RULES, ROOT_DIR, type ConclusionRule } from "../config.js";
import { renderReport, runCrossDomain } from "../eval/cross-domain.js";
import { writeReport } from "../eval/results.js";

// npm run eval:cross-domain [-- --rule corroborated-2]
//
// The cross-domain suite (eval/cross-domain/), deterministic: fixture
// evidence, the scenarios' fact rules, no model and no network. Refuses to
// run if any case file differs from its locked expectations.

const ruleAt = process.argv.indexOf("--rule");
const rule = (ruleAt >= 0 ? process.argv[ruleAt + 1] : "corroborated-1") as ConclusionRule;
if (!CONCLUSION_RULES.includes(rule)) throw new Error(`--rule must be one of ${CONCLUSION_RULES.join(", ")}`);
const suffix = rule === "corroborated-1" ? "" : `-${rule}`;
const report = await runCrossDomain(undefined, rule);
const out = path.join(ROOT_DIR, "eval", "results");
fs.mkdirSync(out, { recursive: true });
writeReport(path.join(out, `cross-domain${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`);
const markdown = renderReport(report);
writeReport(path.join(out, `cross-domain${suffix}.md`), markdown);
console.log(markdown.slice(0, markdown.indexOf("## Cases")).trimEnd());
console.log(`\nFull report: ${path.relative(ROOT_DIR, path.join(out, `cross-domain${suffix}.md`))} (cases, evidence sequences, per-checkpoint conclusions)`);
console.log(`Data: ${path.relative(ROOT_DIR, path.join(out, `cross-domain${suffix}.json`))}`);
