import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR, type AppConfig } from "../config.js";
import { EvidenceDesk, MARKOVIAN_ENGINE } from "../investigation/desk.js";
import type { Conclusion } from "../investigation/conclusion.js";
import type { RunTrace } from "../investigation/trace.js";
import { loadScenario } from "../scenario.js";

// npm run investigate -- <case> [--live] [--output <file>] [--logs <dir>]
//
// Runs one investigation from structured input to structured output, stage
// by stage: the first stage's evidence, then each later stage's update, one
// Evidence Desk run per stage, on throwaway storage (data/ is not touched).
//
// <case> is a folder holding scenario.json and evidence.json (the format of
// every case in fixtures/ and eval/), or one JSON file {"scenario", "evidence"}.
//
// Sample mode (the default): the case's own evidence file and the
// deterministic rule assessor. No .env, credentials, network, Zetaris or
// model is used. --live reads .env instead, so the evidence and the model are
// whatever it configures.
//
// stdout is JSON Lines: "start", then per stage "stage" and one "trace" line
// per step of that run (evidence fetch, each engine chunk with its model call,
// validation and retries, the explanation), then "result". The same lines go
// to logs/<time>-<case>.jsonl. --output also writes the result alone.

export interface InvestigationResult {
  schema: "evidence-desk.investigation-result.v1";
  case: { scenarioId: string; caseId: string; title: string; question: string };
  mode: { evidence: string; reasoner: string; model: string | null };
  stages: StageResult[];
  final: ConclusionSummary;
}

export interface StageResult {
  stage: string;
  visibleRecords: string[];
  newlyAssessed: string[];
  // Records a later record replaces, or that were withdrawn.
  noLongerCounted: Array<{ recordId: string; reason: string }>;
  conclusion: ConclusionSummary;
  changedFromPreviousStage: boolean;
}

export interface ConclusionSummary {
  state: Conclusion["state"];
  hypothesis: string | null;
  statement: string | null;
  confidence: number | null;
  pointsTo: string | null;
  eliminated: string[];
  supportedBy: string[];
  contradictedBy: string[];
  headline: string;
}

export type TraceLine = Record<string, unknown> & { type: string };

const round = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);

export function summarise(conclusion: Conclusion): ConclusionSummary {
  const held = conclusion.hypothesis;
  return {
    state: conclusion.state,
    hypothesis: held?.key ?? null,
    statement: held?.statement ?? null,
    confidence: round(conclusion.justification.confidence),
    pointsTo: conclusion.direction.pointsTo?.key ?? null,
    // Sorted: Speck's order among equally timed revisions is not fixed.
    eliminated: conclusion.direction.eliminated.map((item) => item.key).sort(),
    supportedBy: (held?.supporting.map((ref) => ref.recordId) ?? []).sort(),
    contradictedBy: (held?.contradicting.map((ref) => ref.recordId) ?? []).sort(),
    headline: conclusion.headline
  };
}

// A folder as given, or a single {"scenario", "evidence"} file unpacked into a scratch folder.
export function caseFolder(input: string, scratch: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`${input}: no such file or folder`);
  if (fs.statSync(resolved).isDirectory()) return resolved;
  const body = JSON.parse(fs.readFileSync(resolved, "utf8")) as { scenario?: unknown; evidence?: unknown };
  if (!body.scenario || !body.evidence) throw new Error(`${input}: expected a JSON object with "scenario" and "evidence"`);
  const dir = path.join(scratch, "case");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(body.scenario));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(body.evidence));
  return dir;
}

// Each step of a run as its own line, read from the trace Evidence Desk built
// from persisted state (src/investigation/trace.ts).
function traceLines(run: RunTrace, stage: string): TraceLine[] {
  const lines: TraceLine[] = [{
    type: "trace", step: "run", stage, runId: run.runId, runNumber: run.runNumber, status: run.status,
    evidence: run.evidence, engine: run.meterless, reasoner: run.reasoner, flags: run.flags
  }];
  for (const step of run.steps) {
    if (step.kind === "chunk") {
      lines.push({
        type: "trace", step: "chunk", stage, runId: run.runId, chunk: step.chunk, engine: step.meterless, records: step.records,
        failed: step.failed, judgments: step.judgments, notes: step.notes, speck: step.speck,
        model: step.model && {
          requested: step.model.requestedModel, served: step.model.servedModels, endpoint: step.model.endpoint,
          attempts: step.model.attempts, contractFailures: step.model.contractFailures, transportFailures: step.model.transportFailures,
          outcome: step.model.outcome, error: step.model.error, latencyMs: step.model.httpCalls.map((call) => call.latencyMs)
        }
      });
    } else if (step.kind === "explanation") {
      lines.push({
        type: "trace", step: "explanation", stage, runId: run.runId, agreesWithSpeck: step.agrees, problems: step.problems,
        invalidCitations: step.invalidCitations, model: step.model && { requested: step.model.requestedModel, served: step.model.servedModels, attempts: step.model.attempts, outcome: step.model.outcome }
      });
    } else {
      lines.push({ type: "trace", step: `reconcile-${step.when}`, stage, runId: run.runId, by: step.by, speck: step.speck });
    }
  }
  return lines;
}

export async function investigate(caseDir: string, config: AppConfig, emit: (line: TraceLine) => void): Promise<InvestigationResult> {
  const desk = await EvidenceDesk.open({ ...config, scenarioDir: caseDir });
  try {
    const reasoner = desk.reasoner.describe();
    const evidence = desk.provider.describe();
    emit({
      type: "start", scenarioId: desk.scenario.id, caseId: desk.scenario.caseId, stages: desk.scenario.stages.map((stage) => stage.id),
      evidence, reasoner, engine: { ...MARKOVIAN_ENGINE, maxChunks: config.execution.maxChunks, batchSize: config.execution.batchSize }
    });
    const stages: StageResult[] = [];
    let previous: ConclusionSummary | null = null;
    for (;;) {
      const stage = desk.currentStage();
      emit({ type: "stage", stage: stage.id, label: stage.label, asOf: stage.asOf });
      const snapshot = await desk.run();
      const run = desk.trace().find((entry): entry is RunTrace => entry.kind === "run" && entry.runId === snapshot.runId);
      if (run) for (const line of traceLines(run, stage.id)) emit(line);
      const listing = await desk.listEvidence();
      const current = desk.conclusionFromSpeck();
      const conclusion = summarise(current);
      stages.push({
        stage: stage.id,
        visibleRecords: listing.records.map((record) => record.id),
        newlyAssessed: snapshot.assessed.map((item) => item.record.id),
        noLongerCounted: current.noLongerCounted.map((item) => ({ recordId: item.recordId, reason: item.reason })),
        conclusion,
        changedFromPreviousStage: previous !== null && (previous.state !== conclusion.state || previous.hypothesis !== conclusion.hypothesis)
      });
      previous = conclusion;
      if (!desk.nextStage()) break;
      await desk.introduceNextUpdate();
    }
    return {
      schema: "evidence-desk.investigation-result.v1",
      case: { scenarioId: desk.scenario.id, caseId: desk.scenario.caseId, title: desk.scenario.title, question: desk.scenario.question },
      mode: { evidence: evidence.mode, reasoner: reasoner.kind, model: reasoner.model ?? null },
      stages,
      final: previous!
    };
  } finally {
    desk.close();
  }
}

// Sample mode: settings fixed here, nothing read from .env.
export function sampleConfig(scratch: string): AppConfig {
  return loadConfig({ EVIDENCE_MODE: "fixture", REASONER: "rules" }, { databasePath: path.join(scratch, "desk.sqlite"), historyDir: path.join(scratch, "meterless") });
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return null; const [, value] = args.splice(index, 2); if (!value) throw new Error(`${name} needs a value`); return value; };
  const live = flag("--live");
  const output = option("--output");
  const logsDir = path.resolve(option("--logs") ?? path.join(ROOT_DIR, "logs"));
  const [input, ...rest] = args;
  if (!input || rest.length) {
    process.stderr.write("Usage: npm run investigate -- <case folder or case.json> [--live] [--output <file>] [--logs <dir>]\n");
    return 2;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-investigate-"));
  if (live) loadDotEnv();
  const config = live
    ? loadConfig(process.env, { databasePath: path.join(scratch, "desk.sqlite"), historyDir: path.join(scratch, "meterless") })
    : sampleConfig(scratch);
  const caseDir = caseFolder(input, scratch);
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logsDir, `${stamp}-${loadScenario(caseDir).id}.jsonl`);
  const log = fs.openSync(logFile, "a");
  const emit = (line: TraceLine) => {
    const text = `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`;
    process.stdout.write(text);
    fs.writeSync(log, text);
  };
  try {
    const result = await investigate(caseDir, config, emit);
    emit({ type: "result", result });
    if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\n${result.final.headline}\nTrace: ${path.relative(process.cwd(), logFile)}${output ? `\nResult: ${output}` : ""}\n`);
    return 0;
  } catch (error) {
    emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`\nThe investigation did not complete: ${error instanceof Error ? error.message : String(error)}\nTrace: ${path.relative(process.cwd(), logFile)}\n`);
    return 1;
  } finally {
    fs.closeSync(log);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "investigate.js")) {
  process.exitCode = await main(process.argv.slice(2));
}
