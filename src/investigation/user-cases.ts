import fs from "node:fs";
import path from "node:path";
import { loadScenario, type Scenario } from "../scenario.js";

// Investigations a person creates from the Evidence tab. Each is an ordinary
// scenario (scenario.json + evidence.json, the same format as the prepared
// cases) in its own folder, so the whole pipeline applies to it unchanged:
// a Speck worker, runs, corrections, history and the trace.
//
// What differs: the person writes the evidence as text, so records carry no
// structured facts and the scenario has no fact rules. Only a reasoning
// model can weigh them (and Speck caps model-judged evidence at reliability
// 0.4); the deterministic rule assessor finds nothing to apply.

export interface NewInvestigation {
  title: string;
  question: string;
  explanations: string[];
  evidence?: NewEvidence[];
}

export interface NewEvidence {
  source: string;
  content: string;
  // When the source observed it (ISO date or date-time); default now.
  observedAt?: string;
  // An earlier record of this case that this one corrects, by id.
  corrects?: string;
}

export class UserCaseError extends Error {}

export const USER_SOURCE_SYSTEM = "entered";
// Reliability of what a person enters, before Speck's 0.4 cap on
// model-judged evidence applies.
const ENTERED_RELIABILITY = 0.7;

const text = (value: unknown, field: string, max: number): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new UserCaseError(`${field} is required`);
  if (trimmed.length > max) throw new UserCaseError(`${field} is too long (at most ${max} characters)`);
  return trimmed;
};

export function listUserCases(dir: string): Array<{ id: string; label: string; scenarioDir: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "scenario.json")))
    .map((entry) => {
      const scenario = loadScenario(path.join(dir, entry.name));
      return { id: entry.name, label: scenario.title, scenarioDir: path.join(dir, entry.name) };
    })
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

export function createUserCase(dir: string, input: unknown, now = new Date()): { id: string; label: string; scenarioDir: string } {
  const body = (input && typeof input === "object" ? input : {}) as Partial<NewInvestigation>;
  const title = text(body.title, "A title", 120);
  const question = text(body.question, "The question", 600);
  const explanations = (Array.isArray(body.explanations) ? body.explanations : []).map((item, index) => text(item, `Explanation ${index + 1}`, 300));
  if (explanations.length < 2) throw new UserCaseError("Give at least two competing explanations");
  if (explanations.length > 5) throw new UserCaseError("Give at most five competing explanations");
  if (new Set(explanations.map((item) => item.toLowerCase())).size !== explanations.length) throw new UserCaseError("The explanations must differ");

  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set(fs.readdirSync(dir));
  let number = 1;
  while (taken.has(`my-${number}`)) number += 1;
  const id = `my-${number}`;
  const caseId = `MY-${number}`;
  const scenario: Scenario = {
    id: `user-${id}`, caseId, title, question,
    sources: { [USER_SOURCE_SYSTEM]: { name: "Entered in the Evidence tab", reliability: ENTERED_RELIABILITY } },
    // Equal priors: the person states no preference between them.
    hypotheses: explanations.map((statement, index) => ({ key: `H${index + 1}`, statement, prior: Math.round((1 / explanations.length) * 100) / 100, rules: [] })),
    questions: [],
    // One open stage: what is entered counts from the next run.
    stages: [{ id: "entered", label: "Evidence entered so far", asOf: "9999-12-31T23:59:59Z", description: "Everything entered for this investigation." }]
  };
  const scenarioDir = path.join(dir, id);
  fs.mkdirSync(scenarioDir);
  fs.writeFileSync(path.join(scenarioDir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  fs.writeFileSync(path.join(scenarioDir, "evidence.json"), `${JSON.stringify({ caseId, records: [] }, null, 2)}\n`);
  try {
    for (const item of body.evidence ?? []) addUserEvidence(scenarioDir, item, now);
    loadScenario(scenarioDir);
  } catch (error) {
    fs.rmSync(scenarioDir, { recursive: true, force: true });
    throw error;
  }
  return { id, label: title, scenarioDir };
}

export function addUserEvidence(scenarioDir: string, input: unknown, now = new Date()): { recordId: string } {
  const body = (input && typeof input === "object" ? input : {}) as Partial<NewEvidence>;
  const source = text(body.source, "The source", 120);
  const content = text(body.content, "What the evidence says", 1200);
  let observedAt = now.toISOString();
  if (body.observedAt !== undefined && body.observedAt !== null && String(body.observedAt).trim()) {
    const parsed = Date.parse(String(body.observedAt));
    if (Number.isNaN(parsed)) throw new UserCaseError("The date is not a valid date");
    if (parsed > now.getTime() + 60_000) throw new UserCaseError("The date cannot be in the future");
    observedAt = new Date(parsed).toISOString();
  }
  const file = path.join(scenarioDir, "evidence.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8")) as { caseId: string; records: Array<{ id: string; observedAt: string }> };
  const corrects = typeof body.corrects === "string" && body.corrects.trim() ? body.corrects.trim() : null;
  if (corrects) {
    const earlier = document.records.find((record) => record.id === corrects);
    if (!earlier) throw new UserCaseError(`${corrects} is not a record of this investigation`);
    if (Date.parse(earlier.observedAt) >= Date.parse(observedAt)) throw new UserCaseError(`A correction must be dated after the record it corrects (${corrects})`);
  }
  const recordId = `E-${document.records.length + 1}`;
  document.records.push({
    id: recordId, caseId: document.caseId,
    source: { system: USER_SOURCE_SYSTEM, name: source },
    observedAt, content, facts: {},
    provenance: { systemOfRecord: source, recordRef: `entered/${recordId}`, author: "entered in the Evidence tab", supersedes: corrects ? [corrects] : [] }
  } as never);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return { recordId };
}
