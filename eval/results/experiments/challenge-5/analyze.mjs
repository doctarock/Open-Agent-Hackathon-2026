// Sums live eval reports (one or more directories, searched recursively for
// r*.json) per system: the pre-registered measures (docs/build-5-corroboration.md, 4b)
// and every checkpoint's outcomes across samples.
import fs from "node:fs";
import path from "node:path";
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : /\.json$/.test(e.name) ? [path.join(dir, e.name)] : []);
const reports = process.argv.slice(2).flatMap(files).map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(f, "utf8")) }));
const by = new Map();
for (const report of reports) for (const s of report.systems) {
  const t = by.get(s.system) ?? { samples: 0, cks: new Map(), m: {}, model: [0, 0], files: new Set() };
  t.files.add(report.file);
  for (const k of ["correctness", "unsupportedClaims", "correctionHandling", "invalidatedExcluded", "appropriateAbstention", "overAbstention"]) {
    const r = s.metrics[k]; t.m[k] = [(t.m[k]?.[0] ?? 0) + r.count, (t.m[k]?.[1] ?? 0) + r.of];
  }
  if (s.metrics.model) { t.model[0] += s.metrics.model.contractValid.count; t.model[1] += s.metrics.model.contractValid.of; }
  for (const c of s.checkpoints) {
    const key = `${c.caseId}@${c.stage}`;
    const e = t.cks.get(key) ?? { expected: c.expected, out: [] };
    e.out.push(c.error ? `!${c.error.slice(0, 40)}` : (c.concluded ?? "abstain") + (c.route === "corroboration" ? "(c)" : ""));
    t.cks.set(key, e);
    t.extra ??= { concludedWhenAbstainDue: [0, 0], wrongExplanation: [0, 0], correctWhereDue: [0, 0], errors: 0 };
    if (c.expected === null) { t.extra.concludedWhenAbstainDue[1]++; if (c.concluded) t.extra.concludedWhenAbstainDue[0]++; }
    else if (!String(c.expected).startsWith("error:")) {
      t.extra.correctWhereDue[1]++; t.extra.wrongExplanation[1]++;
      if (c.concluded === c.expected) t.extra.correctWhereDue[0]++;
      if (c.concluded && c.concluded !== c.expected) t.extra.wrongExplanation[0]++;
    }
    if (c.error) t.extra.errors++;
  }
  by.set(s.system, t);
}
for (const [system, t] of by) {
  console.log(`\n## ${system} (${t.files.size} report(s))`);
  for (const [k, v] of Object.entries(t.m)) console.log(`  ${k}: ${v[0]}/${v[1]}`);
  console.log(`  concluded where abstention was due: ${t.extra.concludedWhenAbstainDue.join("/")}; correct where a conclusion was due: ${t.extra.correctWhereDue.join("/")}; concluded the wrong explanation where one was due: ${t.extra.wrongExplanation.join("/")}; checkpoint errors: ${t.extra.errors}; model replies valid: ${t.model.join("/")}`);
  for (const [key, e] of t.cks) console.log(`  ${key.padEnd(44)} label ${String(e.expected ?? "abstain").padEnd(14)} ${e.out.join(", ")}`);
}
