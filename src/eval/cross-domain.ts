import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EvidenceDesk, RUN_SCHEMA } from "../investigation/desk.js";
import { loadEvalCases, CROSS_DOMAIN_DIR, type EvalCase } from "./cases.js";
import { scoreSystem, type Rate, type SystemScore } from "./metrics.js";
import {
  caseConfig, deskOptions, speckDesk, speckFresh, speckInfluencing, speckOutcome, statelessRules, visibleIds,
  type CheckpointOutcome, type EvalSystem, type SystemResult
} from "./systems.js";

// The cross-domain suite (eval/cross-domain/README.md): the same three
// deterministic systems as the fixture evaluation, scored on the same
// checkpoint labels, plus the measures this suite adds and an interruption
// sweep over Evidence Desk. Everything is a count over these checkpoints.

export const LOCK_FILE = path.join(CROSS_DOMAIN_DIR, "expectations.lock.json");

// The labels were fixed before the first run; any change to a case file since
// then must be visible, so scoring refuses to run on unlocked files.
export function verifyLock(dir = CROSS_DOMAIN_DIR, lockFile = LOCK_FILE): { lockedAt: string; files: number } {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { lockedAt: string; files: Record<string, string> };
  const present: string[] = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    for (const file of ["scenario.json", "evidence.json", "expected.json"]) present.push(`${name}/${file}`);
  }
  const problems = [
    ...present.filter((file) => !(file in lock.files)).map((file) => `${file} is not in the lock`),
    ...Object.keys(lock.files).filter((file) => !present.includes(file)).map((file) => `${file} is locked but missing`),
    ...present.filter((file) => file in lock.files && sha256(path.join(dir, file)) !== lock.files[file]).map((file) => `${file} changed since ${lock.lockedAt}`)
  ];
  if (problems.length) throw new Error(`Cross-domain expectations differ from ${path.basename(lockFile)}: ${problems.join("; ")}`);
  return { lockedAt: lock.lockedAt, files: present.length };
}

// Line endings are normalised, so a checkout that converts them still matches.
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");

export const CROSS_DOMAIN_SYSTEMS = (): EvalSystem[] => [speckDesk({ kind: "rules" }), speckFresh({ kind: "rules" }), statelessRules()];

export const CROSS_DOMAIN_DIFFERENCES = [
  "All three systems read the same records from the same files at each checkpoint, apply the same scenario fact rules, and use no model.",
  "speck-desk is Evidence Desk as built: one persistent Speck case, evidence introduced stage by stage, withdrawals applied before the checkpoint's run.",
  "speck-fresh is the same pipeline on a new database at every checkpoint, given everything visible at once, then every withdrawal so far. It separates persistence from Speck's revision policy.",
  "baseline-stateless/rules is the existing stateless baseline, unchanged: it scores every visible, non-withdrawn record afresh. It does not read a record's `supersedes` list, so a record replaced by its source still counts for it. A stateless system that did read it would differ; none was added.",
  "Speck systems conclude only when Speck holds a hypothesis as supported (confidence >= 0.6); the baseline concludes its top positive score when it is strictly ahead. Differences reflect those policies as well as revision.",
  "Failed assessment: every system gets an assessor that fails on the named records. Evidence Desk fails the batch holding the record (as with a model failure); the baselines assess everything in one pass, so the whole checkpoint fails.",
  "Interruption is applied to Evidence Desk only. The stateless baseline keeps no state between checkpoints, so there is nothing for an interruption to damage; it is not scored on recovery."
];

export interface CaseRun { item: EvalCase; result: SystemResult }

export interface SystemExtras {
  system: string;
  // Checkpoints where a refuted or replaced hypothesis was concluded or presented as current.
  staleOrRefuted: Rate;
  // Checkpoints with invalidated records where at least one still bears on a current belief.
  invalidatedInfluencing: Rate;
  // Checkpoints where the label's conclusion differs from the previous checkpoint's, and the system followed it.
  correctRevisions: Rate;
  // Checkpoints labelled with a conclusion where the system abstained without an error.
  unnecessaryAbstentions: Rate;
  // Checkpoints labelled with a conclusion where the system returned an error.
  errorsWhereConclusionDue: Rate;
  citationValidity: Rate;
  // Families of the same records in different orders where every variant's final checkpoint is correct and identical.
  orderConsistent: Rate;
}

export interface RecoveryResult {
  caseId: string;
  interruptedAt: string;
  // The interrupted run actually died before its snapshot was written.
  interrupted: boolean;
  // Every checkpoint from the interruption on equals the uninterrupted run's
  // (conclusion, what is presented, and the records behind current beliefs).
  identical: boolean;
  // ...and is correct against the label.
  correct: boolean;
  detail: string;
}

export interface CrossDomainReport {
  generatedAt: string;
  lock: { lockedAt: string; files: number };
  cases: Array<{ id: string; domain: string | null; family: string | null; order: string | null; category: string; checkpoints: number }>;
  systems: SystemScore[];
  extras: SystemExtras[];
  recovery: { results: RecoveryResult[]; interrupted: Rate; identical: Rate; correct: Rate };
  divergences: Divergence[];
  differences: string[];
  runs: Record<string, Array<{ caseId: string; checkpoints: CheckpointOutcome[] }>>;
}

export interface Divergence {
  caseId: string;
  // The first checkpoint where speck-desk and the baseline conclude differently.
  firstDisagreement: string | null;
  // The first checkpoint each system gets wrong.
  firstWrong: Record<string, string | null>;
}

const rate = (count: number, of: number): Rate => ({ count, of, rate: of ? Math.round((count / of) * 1000) / 1000 : null });

export async function runCrossDomain(onProgress?: (message: string) => void): Promise<CrossDomainReport> {
  const lock = verifyLock();
  const cases = loadEvalCases(CROSS_DOMAIN_DIR);
  const systems = CROSS_DOMAIN_SYSTEMS();
  const runs = new Map<string, CaseRun[]>();
  for (const system of systems) {
    const results: CaseRun[] = [];
    for (const item of cases) {
      onProgress?.(`${system.name}: ${item.id}`);
      results.push({ item, result: await system.run(item) });
    }
    runs.set(system.name, results);
  }
  const scores = systems.map((system) => scoreSystem(system.name, runs.get(system.name)!));
  const extras = systems.map((system, index) => extrasFor(system.name, runs.get(system.name)!, scores[index]!));
  const reference = runs.get(systems[0]!.name)!;
  const recovery: RecoveryResult[] = [];
  for (const { item, result } of reference) {
    for (const index of item.checkpoints.keys()) {
      onProgress?.(`recovery: ${item.id} interrupted at ${item.checkpoints[index]!.afterStage}`);
      recovery.push(await interruptedRun(item, index, result.checkpoints));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    lock,
    cases: cases.map((item) => ({ id: item.id, domain: item.domain ?? null, family: item.family ?? null, order: item.order ?? null, category: item.category, checkpoints: item.checkpoints.length })),
    systems: scores,
    extras,
    recovery: {
      results: recovery,
      interrupted: rate(recovery.filter((item) => item.interrupted).length, recovery.length),
      identical: rate(recovery.filter((item) => item.interrupted && item.identical).length, recovery.filter((item) => item.interrupted).length),
      correct: rate(recovery.filter((item) => item.interrupted && item.correct).length, recovery.filter((item) => item.interrupted).length)
    },
    divergences: cases.map((item) => divergence(item, systems.map((system) => system.name), runs)),
    differences: CROSS_DOMAIN_DIFFERENCES,
    runs: Object.fromEntries([...runs].map(([name, results]) => [name, results.map(({ item, result }) => ({ caseId: item.id, checkpoints: result.checkpoints }))]))
  };
}

function extrasFor(system: string, results: CaseRun[], score: SystemScore): SystemExtras {
  let stale = 0, staleOf = 0, influencing = 0, influencingOf = 0, revisions = 0, revisionsOf = 0, abstained = 0, errored = 0, due = 0;
  for (const { item, result } of results) {
    item.checkpoints.forEach((label, index) => {
      const outcome = result.checkpoints[index]!;
      const presented = new Set([...outcome.presentedAsCurrent, ...(outcome.conclusion ? [outcome.conclusion] : [])]);
      if (label.notCurrent.length) {
        staleOf += 1;
        if (label.notCurrent.some((key) => presented.has(key))) stale += 1;
      }
      if (label.invalidated?.length) {
        influencingOf += 1;
        if (label.invalidated.some((id) => (outcome.influencing ?? []).includes(id))) influencing += 1;
      }
      if (index > 0 && label.conclusion !== item.checkpoints[index - 1]!.conclusion) {
        revisionsOf += 1;
        if (!outcome.error && outcome.conclusion === label.conclusion) revisions += 1;
      }
      if (label.conclusion !== null) {
        due += 1;
        if (outcome.error) errored += 1;
        else if (outcome.conclusion === null) abstained += 1;
      }
    });
  }
  const families = new Map<string, Array<{ correct: boolean; conclusion: string | null }>>();
  for (const { item, result } of results) {
    if (!item.family) continue;
    const last = item.checkpoints.length - 1;
    const outcome = result.checkpoints[last]!;
    families.set(item.family, [...(families.get(item.family) ?? []), { correct: !outcome.error && outcome.conclusion === item.checkpoints[last]!.conclusion, conclusion: outcome.conclusion }]);
  }
  const consistent = [...families.values()].filter((variants) => variants.every((variant) => variant.correct && variant.conclusion === variants[0]!.conclusion)).length;
  return {
    system,
    staleOrRefuted: rate(stale, staleOf),
    invalidatedInfluencing: rate(influencing, influencingOf),
    correctRevisions: rate(revisions, revisionsOf),
    unnecessaryAbstentions: rate(abstained, due),
    errorsWhereConclusionDue: rate(errored, due),
    citationValidity: score.metrics.validCitations,
    orderConsistent: rate(consistent, families.size)
  };
}

function divergence(item: EvalCase, systems: string[], runs: Map<string, CaseRun[]>): Divergence {
  const outcomesOf = (system: string) => runs.get(system)!.find((run) => run.item.id === item.id)!.result.checkpoints;
  const shown = (outcome: CheckpointOutcome) => (outcome.error ? `error` : outcome.conclusion ?? "abstain");
  const desk = outcomesOf(systems[0]!);
  const baseline = outcomesOf(systems.at(-1)!);
  const disagreement = item.checkpoints.findIndex((_, index) => shown(desk[index]!) !== shown(baseline[index]!));
  return {
    caseId: item.id,
    firstDisagreement: disagreement === -1 ? null : item.checkpoints[disagreement]!.afterStage,
    firstWrong: Object.fromEntries(systems.map((system) => {
      const outcomes = outcomesOf(system);
      const wrong = item.checkpoints.findIndex((label, index) => outcomes[index]!.error !== null || outcomes[index]!.conclusion !== label.conclusion);
      return [system, wrong === -1 ? null : item.checkpoints[wrong]!.afterStage];
    }))
  };
}

// The process dies during checkpoint `at`'s run: Speck's recordEvidence fails
// after one call, and the run snapshot is never written (as in
// test/recovery.test.ts). Speck is reopened on the same database, the run
// repeated, and the case continued to its end.
async function interruptedRun(item: EvalCase, at: number, uninterrupted: CheckpointOutcome[]): Promise<RecoveryResult> {
  const config = caseConfig(item, { kind: "rules" });
  const open = () => EvidenceDesk.open(config, deskOptions(item, config, { kind: "rules" }));
  let desk = await open();
  const outcomes: CheckpointOutcome[] = [];
  let interrupted = false;
  try {
    for (const [index, checkpoint] of item.checkpoints.entries()) {
      while (desk.currentStage().id !== checkpoint.afterStage) await desk.introduceNextUpdate();
      for (const withdrawal of checkpoint.withdrawBefore ?? []) await desk.withdrawRecord(withdrawal.recordId, withdrawal.reason);
      if (index === at) {
        crash(desk);
        interrupted = await desk.run().then(() => false, () => true);
        desk.close();
        desk = await open();
      }
      const run = await desk.run();
      outcomes.push(speckOutcome(checkpoint.afterStage, desk.conclusionFromSpeck(), run, await visibleIds(desk), speckInfluencing(desk)));
    }
  } finally {
    desk.close();
  }
  const key = (outcome: CheckpointOutcome) => JSON.stringify([outcome.conclusion, outcome.tentative, [...outcome.presentedAsCurrent].sort(), outcome.influencing ?? []]);
  const differing = outcomes.map((outcome, index) => index).filter((index) => index >= at && key(outcomes[index]!) !== key(uninterrupted[index]!));
  const wrong = outcomes.map((outcome, index) => index).filter((index) => index >= at && outcomes[index]!.conclusion !== item.checkpoints[index]!.conclusion);
  return {
    caseId: item.id, interruptedAt: item.checkpoints[at]!.afterStage, interrupted,
    identical: differing.length === 0, correct: wrong.length === 0,
    detail: [
      interrupted ? "" : "the run completed: no interruption point was reached",
      ...differing.map((index) => `${item.checkpoints[index]!.afterStage}: ${outcomes[index]!.conclusion ?? "abstain"} vs uninterrupted ${uninterrupted[index]!.conclusion ?? "abstain"}`)
    ].filter(Boolean).join("; ")
  };
}

function crash(desk: EvidenceDesk): void {
  const runtime = desk.runtime as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = runtime.recordEvidence!.bind(desk.runtime);
  let calls = 0;
  runtime.recordEvidence = async (...args) => { if (++calls > 1) throw new Error("simulated crash"); return original(...args); };
  const recordMemory = desk.runtime.recordMemory.bind(desk.runtime);
  desk.runtime.recordMemory = async (input) => { if (input.data?.schema === RUN_SCHEMA) throw new Error("process died"); return recordMemory(input); };
}

// The report: each case, its evidence sequence, every system's conclusion at
// each checkpoint, and where they part.
export function renderReport(report: CrossDomainReport): string {
  const cases = loadEvalCases(CROSS_DOMAIN_DIR);
  const show = (value: Rate) => (value.of ? `${value.count}/${value.of}` : "n/a");
  const names = report.systems.map((system) => system.system);
  const lines: string[] = [
    "# Cross-domain evidence revision: results",
    "",
    `Generated ${report.generatedAt}. Expectations locked ${report.lock.lockedAt} (${report.lock.files} case files verified unchanged).`,
    `${report.cases.length} cases, ${report.cases.reduce((sum, item) => sum + item.checkpoints, 0)} labelled checkpoints. Counts over these checkpoints only; not a general accuracy measure.`,
    "",
    "## Summary",
    "",
    `| Measure | ${names.join(" | ")} |`,
    `|---|${names.map(() => "---").join("|")}|`
  ];
  const row = (label: string, value: (index: number) => string) => lines.push(`| ${label} | ${names.map((_, index) => value(index)).join(" | ")} |`);
  row("Conclusion correct", (i) => show(report.systems[i]!.metrics.correctness));
  row("Correct revisions (label changed from previous checkpoint)", (i) => show(report.extras[i]!.correctRevisions));
  row("Stale or refuted hypothesis concluded or presented as current", (i) => show(report.extras[i]!.staleOrRefuted));
  row("Invalidated record still bearing on a current belief", (i) => show(report.extras[i]!.invalidatedInfluencing));
  row("Unnecessary abstentions (conclusion due, abstained)", (i) => show(report.extras[i]!.unnecessaryAbstentions));
  row("Errors where a conclusion was due", (i) => show(report.extras[i]!.errorsWhereConclusionDue));
  row("Abstained when it should", (i) => show(report.systems[i]!.metrics.appropriateAbstention));
  row("Unsupported claims (of conclusions)", (i) => show(report.systems[i]!.metrics.unsupportedClaims));
  row("Valid citations", (i) => show(report.extras[i]!.citationValidity));
  row("Same records, different orders: final answer correct and identical", (i) => show(report.extras[i]!.orderConsistent));
  lines.push("", "### Recovery after interruption (speck-desk)", "",
    `Every checkpoint of every case was interrupted in turn (${report.recovery.results.length} runs).`,
    `- Interruption reached: ${show(report.recovery.interrupted)}`,
    `- Identical to the uninterrupted run from the interruption on: ${show(report.recovery.identical)}`,
    `- Correct against the labels from the interruption on: ${show(report.recovery.correct)}`);
  const notIdentical = report.recovery.results.filter((item) => item.interrupted && !item.identical);
  if (notIdentical.length) for (const item of notIdentical) lines.push(`- Not identical: ${item.caseId} interrupted at ${item.interruptedAt}: ${item.detail}`);
  lines.push("", "### Differences between the systems", "", ...report.differences.map((line) => `- ${line}`), "", "## Cases");
  for (const item of cases) {
    const divergence = report.divergences.find((entry) => entry.caseId === item.id)!;
    const records = (JSON.parse(fs.readFileSync(path.join(item.dir, "evidence.json"), "utf8")) as { records: Array<{ id: string; observedAt: string; content: string; source: { name: string }; provenance: { supersedes: string[] } }> }).records;
    lines.push("", `### ${item.id}`, "", `*${item.domain} · ${item.category}${item.order ? ` · order: ${item.order}` : ""}.* ${item.description}`, "", item.scenario.question, "");
    lines.push("Hypotheses: " + item.scenario.hypotheses.map((hypothesis) => `**${hypothesis.key}** ${hypothesis.statement}`).join(" "), "");
    let previous = Number.NEGATIVE_INFINITY;
    for (const stage of item.scenario.stages) {
      const until = Date.parse(stage.asOf);
      const arriving = records.filter((record) => Date.parse(record.observedAt) > previous && Date.parse(record.observedAt) <= until);
      previous = until;
      const checkpoint = item.checkpoints.find((entry) => entry.afterStage === stage.id);
      lines.push(`**${stage.label}** (\`${stage.id}\`)`, "");
      for (const record of arriving) {
        lines.push(`- \`${record.id}\` ${record.source.name}: ${record.content}${record.provenance.supersedes.length ? ` *Replaces ${record.provenance.supersedes.join(", ")}.*` : ""}${item.failAssessment?.includes(record.id) ? " *Assessment fails (injected).*" : ""}`);
      }
      for (const withdrawal of checkpoint?.withdrawBefore ?? []) lines.push(`- Investigator withdraws \`${withdrawal.recordId}\`: ${withdrawal.reason}`);
      if (!arriving.length && !(checkpoint?.withdrawBefore ?? []).length) lines.push("- (no new records)");
      if (checkpoint) {
        const index = item.checkpoints.indexOf(checkpoint);
        lines.push("", `| | Expected | ${names.join(" | ")} |`, `|---|---|${names.map(() => "---").join("|")}|`);
        lines.push(`| Conclusion | ${checkpoint.conclusion ?? "abstain"} | ${names.map((name) => cell(report.runs[name]!.find((run) => run.caseId === item.id)!.checkpoints[index]!, checkpoint.conclusion)).join(" | ")} |`);
        lines.push(`| Records behind current beliefs | ${checkpoint.invalidated?.length ? `not ${checkpoint.invalidated.join(", ")}` : ""} | ${names.map((name) => {
          const outcome = report.runs[name]!.find((run) => run.caseId === item.id)!.checkpoints[index]!;
          return (outcome.influencing ?? []).map((id) => (checkpoint.invalidated ?? []).includes(id) ? `**${id}** (invalidated)` : id).join(", ") || "none";
        }).join(" | ")} |`);
      }
      lines.push("");
    }
    lines.push(`Where they part: ${divergence.firstDisagreement ? `speck-desk and the baseline first disagree at \`${divergence.firstDisagreement}\`.` : "speck-desk and the baseline agree at every checkpoint."} First wrong checkpoint: ${Object.entries(divergence.firstWrong).map(([system, stage]) => `${system} ${stage ? `\`${stage}\`` : "none"}`).join("; ")}.`);
    const recoveries = report.recovery.results.filter((entry) => entry.caseId === item.id);
    lines.push("", `Interrupted runs: ${recoveries.map((entry) => `\`${entry.interruptedAt}\` ${!entry.interrupted ? "not reached" : entry.identical ? "identical" : `differs (${entry.detail})`}`).join("; ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

function cell(outcome: CheckpointOutcome, expected: string | null): string {
  const shown = outcome.error ? `error (${outcome.error.replace(/^\w+: /, "")})` : outcome.conclusion ?? (outcome.tentative ? `abstain (leaning ${outcome.tentative})` : "abstain");
  return `${!outcome.error && outcome.conclusion === expected ? "✓" : "✗"} ${shown}`;
}
