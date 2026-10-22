import fs from "node:fs";
import path from "node:path";

// A scenario is data: the case, its candidate hypotheses with the fact rules
// that bear on them, the open questions, and the stages in which evidence
// becomes available. The reasoning code reads it; it holds no scenario logic.

export interface RelationRule {
  fact: string;
  equals: string;
  direction: "supports" | "contradicts";
  strength?: number;
  // A deterministic counter-example: Speck refutes the hypothesis outright.
  decisive?: boolean;
}

export interface HypothesisSpec {
  key: string;
  statement: string;
  prior: number;
  rules: RelationRule[];
}

export interface QuestionSpec {
  id: string;
  text: string;
  // The evidence fact that answers the question.
  answeredBy: string;
}

export interface StageSpec {
  id: string;
  label: string;
  // Evidence observed at or before this time is available in the stage.
  asOf: string;
  description: string;
}

export interface Scenario {
  id: string;
  caseId: string;
  title: string;
  question: string;
  sources: Record<string, { name: string; reliability: number }>;
  hypotheses: HypothesisSpec[];
  questions: QuestionSpec[];
  stages: StageSpec[];
}

export function loadScenario(dir: string): Scenario {
  const file = path.join(dir, "scenario.json");
  const scenario = JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
  validateScenario(scenario, file);
  return scenario;
}

function validateScenario(scenario: Scenario, file: string): void {
  const fail = (message: string): never => { throw new Error(`${file}: ${message}`); };
  if (!scenario.caseId || !/^[A-Za-z0-9_-]+$/.test(scenario.caseId)) fail("caseId must be letters, digits, '-' or '_'");
  if (!scenario.hypotheses?.length) fail("at least one hypothesis is required");
  if (!scenario.stages?.length) fail("at least one stage is required");
  const keys = new Set<string>();
  for (const hypothesis of scenario.hypotheses) {
    if (keys.has(hypothesis.key)) fail(`duplicate hypothesis key ${hypothesis.key}`);
    keys.add(hypothesis.key);
    if (!(hypothesis.prior >= 0 && hypothesis.prior <= 1)) fail(`${hypothesis.key}: prior must be between 0 and 1`);
    for (const rule of hypothesis.rules) {
      if (rule.direction !== "supports" && rule.direction !== "contradicts") fail(`${hypothesis.key}: unknown rule direction`);
      if (rule.decisive && rule.direction !== "contradicts") fail(`${hypothesis.key}: only a contradiction can be decisive`);
    }
  }
  for (const [system, source] of Object.entries(scenario.sources ?? {})) {
    if (!(source.reliability >= 0 && source.reliability <= 1)) fail(`source ${system}: reliability must be between 0 and 1`);
  }
  const times = scenario.stages.map((stage) => Date.parse(stage.asOf));
  if (times.some((time) => Number.isNaN(time))) fail("every stage needs an ISO asOf time");
  if (times.some((time, index) => index > 0 && time <= times[index - 1]!)) fail("stages must be in increasing asOf order");
}
