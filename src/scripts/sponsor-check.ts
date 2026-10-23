import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR } from "../config.js";
import { EvidenceDesk, MARKOVIAN_ENGINE } from "../investigation/desk.js";
import { findEngineRun, readEngineHistory, type RunTrace } from "../investigation/trace.js";
import { writeReport } from "../eval/results.js";

// npm run sponsors:verify
//
// Runs the real two-stage investigation against the services configured in
// .env, on throwaway storage (data/ is not touched), and checks each sponsor
// technology's contribution in the execution trace against an independent
// source: the records' own Zetaris query tokens, the Meterless engine's own
// history.json, the model names the endpoint reported, Speck's evidence
// objects and its raw event log. A contribution that cannot be observed is
// reported as NOT OBSERVED; nothing is simulated or substituted.

type Verdict = { sponsor: string; status: "OBSERVED" | "NOT OBSERVED" | "NOT A RUNTIME COMPONENT"; evidence: string[]; problems: string[] };

loadDotEnv();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-sponsors-"));
const config = loadConfig(process.env, { databasePath: path.join(dir, "desk.sqlite"), historyDir: path.join(dir, "meterless") });
console.log(`Sponsor verification: evidence=${config.evidenceMode}, reasoner=${config.reasoner}, scratch storage ${dir}\n`);

const verdicts: Verdict[] = [];
const verdict = (sponsor: string, evidence: string[], problems: string[], configured = true): Verdict => {
  const result: Verdict = { sponsor, status: configured && problems.length === 0 ? "OBSERVED" : "NOT OBSERVED", evidence, problems };
  verdicts.push(result);
  return result;
};

let runs: RunTrace[] = [];
let desk: EvidenceDesk | null = null;
let runError: string | null = null;
try {
  desk = await EvidenceDesk.open(config);
  await desk.run();
  await desk.introduceNextUpdate();
  await desk.run();
  runs = desk.trace().filter((entry): entry is RunTrace => entry.kind === "run");
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  console.log(`The investigation did not complete: ${runError}\n`);
}

// Zetaris: every record must have come through a Zetaris SELECT whose query
// token the trace shows.
{
  const evidence: string[] = [];
  const problems: string[] = [];
  if (config.evidenceMode !== "zetaris") problems.push("EVIDENCE_MODE is not zetaris: evidence came from the fixture file, so Zetaris was not used");
  if (runError && !runs.length) problems.push(`no run completed (${runError})`);
  for (const run of runs) {
    const snapshot = desk!.runs().find((item) => item.runId === run.runId)!;
    if (run.evidence?.mode !== "zetaris") { problems.push(`run ${run.runNumber}: evidence mode ${run.evidence?.mode ?? "unrecorded"}`); continue; }
    const tokens = new Set(run.evidence.sources.map((source) => source.queryToken).filter(Boolean));
    const foreign = snapshot.assessed.filter((item) => item.record.retrieval.mode !== "zetaris" || !tokens.has(item.record.retrieval.queryToken ?? ""));
    if (foreign.length) problems.push(`run ${run.runNumber}: ${foreign.map((item) => item.record.id).join(", ")} not traced to a SELECT of this run`);
    evidence.push(`run ${run.runNumber}: ${run.evidence.sources.length} SELECTs on ${run.evidence.target} (${run.evidence.sources.map((source) => `${source.location} ${source.rows} row(s), ${source.latencyMs} ms`).join("; ")}); `
      + `${snapshot.assessed.length} newly assessed record(s), each carrying one of this run's query tokens`);
  }
  verdict("Zetaris", evidence, problems, config.evidenceMode === "zetaris");
}

// Meterless: each run's id, status and chunk count must match the engine's own history file.
{
  const evidence: string[] = [];
  const problems: string[] = [];
  const history = readEngineHistory(path.join(config.historyDir, "history.json"));
  if (!history) problems.push("the engine's history.json could not be read");
  if (!runs.length) problems.push("no run completed");
  for (const run of runs) {
    // Matched by the engine's id and its own timestamp (ids restart per process).
    const snapshot = desk!.runs().find((item) => item.runId === run.runId)!;
    const engineRun = history ? findEngineRun(history, snapshot.execution) : null;
    if (!engineRun) { problems.push(`run ${run.runNumber}: Meterless run ${run.meterless?.runId ?? "?"} is not in the engine's history.json`); continue; }
    if (engineRun.chunks.length !== run.meterless!.chunks || engineRun.status !== run.meterless!.status) {
      problems.push(`run ${run.runNumber}: trace says ${run.meterless!.chunks} chunk(s) ${run.meterless!.status}, engine history says ${engineRun.chunks.length} ${engineRun.status}`);
    }
    evidence.push(`run ${run.runNumber}: engine run ${engineRun.id} (engine timestamp ${engineRun.timestamp}), ${engineRun.status}, ${engineRun.chunks.length} chunk(s), found in ${path.join(config.historyDir, "history.json")}`);
  }
  evidence.push(`engine: ${MARKOVIAN_ENGINE.name} ${MARKOVIAN_ENGINE.package}, upstream commit ${MARKOVIAN_ENGINE.commit}`);
  verdict("Meterless", evidence, problems);
}

// Nemotron: model calls the endpoint answered, naming a Nemotron model, whose
// judgments Speck stored as model-provenance evidence under its 0.4 cap.
{
  const evidence: string[] = [];
  const problems: string[] = [];
  if (config.reasoner !== "nemotron") problems.push("REASONER is not nemotron: the deterministic rule assessor judged the evidence, so no model was called");
  const calls = runs.flatMap((run) => run.steps.flatMap((step) => ((step.kind === "chunk" || step.kind === "explanation") && step.model ? [step.model] : [])));
  if (config.reasoner === "nemotron") {
    if (!calls.length) problems.push("no model call was recorded");
    const served = [...new Set(calls.flatMap((call) => call.servedModels))];
    if (calls.length && !served.length) problems.push("the endpoint never reported a model name");
    if (served.some((name) => !/nemotron/i.test(name))) problems.push(`the endpoint reported a non-Nemotron model: ${served.join(", ")}`);
    const workerId = desk?.runtime.listWorkers()[0]?.id;
    const modelEvidence = workerId ? desk!.runtime.mentalObjects.listForWorker(workerId).filter((object) => object.kind === "evidence" && object.provenance.kind === "model") : [];
    const overCap = modelEvidence.filter((object) => Number(object.data.reliability) > 0.4);
    if (!modelEvidence.length && calls.length) problems.push("no evidence in Speck carries model provenance");
    if (overCap.length) problems.push(`${overCap.length} model-judged evidence object(s) above Speck's 0.4 cap`);
    evidence.push(`${calls.length} call(s) to ${config.nemotron.baseUrl}; endpoint reported serving ${served.join(", ") || "nothing"}`);
    evidence.push(`${calls.reduce((sum, call) => sum + call.attempts, 0)} attempt(s): ${calls.reduce((sum, call) => sum + call.contractFailures, 0)} rejected by Speck's contract check, `
      + `${calls.reduce((sum, call) => sum + call.transportFailures, 0)} transport failure(s) (no usable answer), then retried; ${calls.filter((call) => call.outcome === "valid").length} of ${calls.length} call(s) ended with a valid reply`);
    evidence.push(`${modelEvidence.length} evidence object(s) in Speck with model provenance, all at reliability <= 0.4`);
  }
  verdict("NVIDIA Nemotron (local)", evidence, problems, config.reasoner === "nemotron");
}

// Speck: every belief revision in its raw event log appears in the trace once.
{
  const evidence: string[] = [];
  const problems: string[] = [];
  if (!runs.length) problems.push("no run completed");
  const workerId = desk?.runtime.listWorkers()[0]?.id;
  for (const run of runs) {
    const logged = workerId ? desk!.runtime.listEvents(workerId, 0, 10_000).filter((event) => event.type === "belief.revised" && event.correlationId === run.runId).length : 0;
    if (logged !== run.flags.revisions) problems.push(`run ${run.runNumber}: event log has ${logged} revision(s), trace shows ${run.flags.revisions}`);
    evidence.push(`run ${run.runNumber}: ${logged} belief revision(s) in Speck's event log, all in the trace`);
  }
  if (desk && runs.length) evidence.push(`current conclusion from Speck's state: ${desk.conclusionFromSpeck().headline}`);
  verdict("Speck", evidence, problems);
}

verdicts.push({ sponsor: "Cursor", status: "NOT A RUNTIME COMPONENT", evidence: ["a development tool; nothing in a run can observe it"], problems: [] });
desk?.close();

for (const item of verdicts) {
  console.log(`${item.status.padEnd(24)} ${item.sponsor}`);
  for (const line of item.evidence) console.log(`    ${line}`);
  for (const line of item.problems) console.log(`    !! ${line}`);
}
const out = path.join(ROOT_DIR, "eval", "results", "sponsor-check.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
writeReport(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), evidenceMode: config.evidenceMode, reasoner: config.reasoner, model: config.nemotron.model || null, verdicts, trace: runs }, null, 2)}\n`);
console.log(`\nFull report with the trace: ${path.relative(ROOT_DIR, out)}`);
process.exit(verdicts.some((item) => item.status === "NOT OBSERVED") ? 1 : 0);
