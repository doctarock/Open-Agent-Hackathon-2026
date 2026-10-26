import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { loadScenario, type Scenario } from "../scenario.js";

// Held-out evaluation cases: eval/scenarios/<id>/{scenario,evidence,expected}.json.
// They are kept apart from the development fixtures, and the loader refuses
// any overlap with them, so tuning on fixtures cannot leak into evaluation.

export interface Checkpoint {
  // The stage after whose run the outcome is checked.
  afterStage: string;
  // The hypothesis a correct system concludes, or null when the right answer
  // is to abstain.
  conclusion: string | null;
  // Hypotheses the evidence has refuted or superseded by now: none may be
  // presented as the current or favoured explanation.
  notCurrent: string[];
  // Hypotheses the evidence does not support at all: concluding one is an
  // unsupported claim.
  unsupported: string[];
  // Regression cases only. Records the investigator withdraws before this
  // checkpoint's run, and records that no longer count by this checkpoint
  // (withdrawn or superseded): none may support what is presented as current.
  withdrawBefore?: Array<{ recordId: string; reason: string }>;
  invalidated?: string[];
}

export interface EvalCase {
  id: string;
  dir: string;
  category: string;
  description: string;
  scenario: Scenario;
  checkpoints: Checkpoint[];
  forbiddenCitations: string[];
  provider: "fixture" | "zetaris-unreachable";
  expectError: "evidence" | null;
  // Cross-domain suite only (eval/cross-domain/README.md). Records whose
  // assessment the harness makes fail, the case's domain, and the family of
  // cases sharing its records in another arrival order.
  failAssessment?: string[];
  domain?: string | null;
  family?: string | null;
  order?: string | null;
}

export const EVAL_DIR = path.join(ROOT_DIR, "eval", "scenarios");
// Correction-sequence regression cases (Build 3), reported apart from the
// held-out cases above.
export const REGRESSION_DIR = path.join(ROOT_DIR, "eval", "regression");
// The cross-domain suite, reported apart from both (npm run eval:cross-domain).
export const CROSS_DOMAIN_DIR = path.join(ROOT_DIR, "eval", "cross-domain");
// The Build 4 challenge cases, reported apart from all of the above (npm run eval:challenge).
export const CHALLENGE_DIR = path.join(ROOT_DIR, "eval", "challenge");
// The Build 5 challenge set (eval/challenge-5/README.md), reported apart again.
export const CHALLENGE5_DIR = path.join(ROOT_DIR, "eval", "challenge-5");
// Set 6: harder cases for the stateless baseline, with controls
// (eval/challenge-6/README.md, docs/set-6-harder-cases.md), reported apart again.
export const CHALLENGE6_DIR = path.join(ROOT_DIR, "eval", "challenge-6");
export const DEV_FIXTURES_DIR = path.join(ROOT_DIR, "fixtures", "scenarios");

export function loadEvalCases(dir = EVAL_DIR): EvalCase[] {
  if (path.resolve(dir).startsWith(path.resolve(DEV_FIXTURES_DIR))) throw new Error("Evaluation cases must not come from the development fixtures");
  const cases = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    .map((name) => loadCase(path.join(dir, name)));
  const overlap = leakage(cases);
  if (overlap.length) throw new Error(`Evaluation cases overlap the development fixtures: ${overlap.join(", ")}`);
  return cases;
}

function loadCase(dir: string): EvalCase {
  const scenario = loadScenario(dir);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
  const where = path.relative(ROOT_DIR, dir);
  const keys = new Set(scenario.hypotheses.map((hypothesis) => hypothesis.key));
  const stages = scenario.stages.map((stage) => stage.id);
  const checkpoints = expected.checkpoints as Checkpoint[];
  if (!checkpoints?.length) throw new Error(`${where}: expected.json needs checkpoints`);
  const recordIds = new Set((JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8")) as { records: Array<{ id: string }> }).records.map((record) => record.id));
  const failAssessment = (expected.failAssessment ?? []) as string[];
  for (const id of failAssessment) if (!recordIds.has(id)) throw new Error(`${where}: unknown record ${id}`);
  for (const checkpoint of checkpoints) {
    for (const id of [...(checkpoint.withdrawBefore ?? []).map((item) => item.recordId), ...(checkpoint.invalidated ?? [])]) {
      if (!recordIds.has(id)) throw new Error(`${where}: unknown record ${id}`);
    }
    if (!stages.includes(checkpoint.afterStage)) throw new Error(`${where}: unknown stage ${checkpoint.afterStage}`);
    for (const key of [checkpoint.conclusion, ...checkpoint.notCurrent, ...checkpoint.unsupported]) {
      if (key !== null && !keys.has(key)) throw new Error(`${where}: unknown hypothesis ${key}`);
    }
  }
  return {
    id: expected.id, dir, category: expected.category, description: expected.description, scenario, checkpoints,
    forbiddenCitations: expected.forbiddenCitations ?? [],
    provider: expected.provider ?? "fixture",
    expectError: expected.expectError ?? null,
    failAssessment, domain: expected.domain ?? null, family: expected.family ?? null, order: expected.order ?? null
  };
}

// Scenario ids, case ids and record ids shared with the development fixtures.
export function leakage(cases: readonly EvalCase[], devDir = DEV_FIXTURES_DIR): string[] {
  const dev = new Set<string>();
  for (const name of fs.readdirSync(devDir)) {
    const scenario = loadScenario(path.join(devDir, name));
    dev.add(scenario.id).add(scenario.caseId);
    const evidence = JSON.parse(fs.readFileSync(path.join(devDir, name, "evidence.json"), "utf8")) as { records: Array<{ id: string }> };
    for (const record of evidence.records) dev.add(record.id);
  }
  const shared: string[] = [];
  for (const item of cases) {
    const evidence = JSON.parse(fs.readFileSync(path.join(item.dir, "evidence.json"), "utf8")) as { records: Array<{ id: string }> };
    for (const id of [item.scenario.id, item.scenario.caseId, ...evidence.records.map((record) => record.id)]) if (dev.has(id)) shared.push(id);
  }
  return shared;
}
