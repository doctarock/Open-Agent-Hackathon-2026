import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { renderReport, runCrossDomain } from "../eval/cross-domain.js";

// npm run eval:cross-domain
//
// The cross-domain suite (eval/cross-domain/), deterministic: fixture
// evidence, the scenarios' fact rules, no model and no network. Refuses to
// run if any case file differs from its locked expectations.

const report = await runCrossDomain();
const out = path.join(ROOT_DIR, "eval", "results");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "cross-domain.json"), `${JSON.stringify(report, null, 2)}\n`);
const markdown = renderReport(report);
fs.writeFileSync(path.join(out, "cross-domain.md"), markdown);
console.log(markdown.slice(0, markdown.indexOf("## Cases")).trimEnd());
console.log(`\nFull report: ${path.relative(ROOT_DIR, path.join(out, "cross-domain.md"))} (cases, evidence sequences, per-checkpoint conclusions)`);
console.log(`Data: ${path.relative(ROOT_DIR, path.join(out, "cross-domain.json"))}`);
