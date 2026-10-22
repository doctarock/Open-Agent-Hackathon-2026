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
}

export const EVAL_DIR = path.join(ROOT_DIR, "eval", "scenarios");
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
  for (const checkpoint of checkpoints) {
    if (!stages.includes(checkpoint.afterStage)) throw new Error(`${where}: unknown stage ${checkpoint.afterStage}`);
    for (const key of [checkpoint.conclusion, ...checkpoint.notCurrent, ...checkpoint.unsupported]) {
      if (key !== null && !keys.has(key)) throw new Error(`${where}: unknown hypothesis ${key}`);
    }
  }
  return {
    id: expected.id, dir, category: expected.category, description: expected.description, scenario, checkpoints,
    forbiddenCitations: expected.forbiddenCitations ?? [],
    provider: expected.provider ?? "fixture",
    expectError: expected.expectError ?? null
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
