import { randomUUID } from "node:crypto";
import type { Worker } from "#speck";
import { Markovian, type Generator, type MarkovianRun, type ProgressState } from "../../vendor/meterless-markovian/src/index.js";
import type { CaseConfig } from "../config.js";
import { byObservation, type EvidenceFetch, type EvidenceProvider, type EvidenceRecord } from "../evidence/types.js";
import type { Explanation, ModelCallTrace, Reasoner } from "../reasoning/types.js";
import type { StageSpec } from "../scenario.js";
import { describeInvalidation, type Invalidation } from "./basis.js";
import type { CaseHandle, CaseState } from "./case-state.js";
import type { Conclusion, HypothesisView } from "./conclusion.js";
import { reconcile, revisionNotes } from "./reconcile.js";
import {
  ASSESSMENT_SCHEMA, MARKOVIAN_SOURCE, ReasonerNotReadyError, RUN_SCHEMA,
  type AssessedEvidence, type AssessmentAttempt, type ExplanationAgreement, type RunSnapshot
} from "./records.js";

// What a run needs from the case (EvidenceDesk).
export interface RunContext extends CaseHandle {
  readonly config: CaseConfig;
  readonly provider: EvidenceProvider;
  readonly reasoner: Reasoner;
  ensureCase(): Promise<Worker>;
  visibleEvidence(stage: StageSpec): Promise<EvidenceFetch>;
  emit(event: "progress" | "run", payload: unknown): boolean;
}

// One investigation run: one Meterless Markovian run whose generator assesses
// one batch of new evidence per chunk, saves the judgments in Speck, records
// the evidence in Speck's ledger and reconciles beliefs; then the run's
// snapshot, saved in Speck as episodic memory.
//
// Why it is built this way:
// - Meterless's Markovian engine runs the loop. The reasoning model is a
//   4-billion-parameter Nemotron working in a 4,096-token window. The engine
//   splits the work into bounded chunks (at most 4,000 tokens, at most 512
//   carried from one chunk to the next), and each chunk assesses one small
//   batch of records not yet assessed. What is carried over is a short state
//   block (assessed, remaining, current beliefs), never the history.
// - Assessment prompts do not grow with the case. Beliefs and history are
//   read from Speck, not replayed to the model, and a run assesses only new
//   records, two per chunk. Measured on the disputed delivery (README, "Small
//   model, small context"): about 950 prompt tokens per assessment in both
//   stages; the one explanation call per run, which lists the case's records,
//   was the largest prompt at 1,923 tokens.
// - Judgments are saved before evidence is recorded. Each chunk's judgments go
//   to Speck first, then its records enter the ledger, then beliefs are
//   reconciled. If the process dies at any point, the next run recovers
//   without asking the model again and without a record whose judgments are
//   unknown.
// - The model never decides the conclusion. It proposes relations (supports,
//   contradicts, how strongly); Speck revises beliefs from them; the
//   conclusion is read from Speck's state (conclusion.ts). The model's
//   explanation of that conclusion is checked against it (checkAgreement).
// - Failures are visible, never filled in. A failed chunk is saved as failed,
//   the records it did not reach stay pending, and the run's notes say so.
export async function executeRun(desk: RunContext): Promise<RunSnapshot> {
  const reasonerInfo = desk.reasoner.describe();
  if (!reasonerInfo.ready) throw new ReasonerNotReadyError(`${reasonerInfo.label} is not configured: ${reasonerInfo.problem}`);
  const worker = await desk.ensureCase();
  const before = desk.read();
  const stage = before.currentStage();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const previous = before.runs().at(-1) ?? null;
  const notes: string[] = [];
  const assessed: AssessedEvidence[] = [];
  // Set by the reflection pass inside the generator.
  const reflection: { explanation: RunSnapshot["explanation"]; call: ModelCallTrace | null } = { explanation: null, call: null };

  // Evidence access failures end the run here, visibly. Nothing is
  // substituted for the missing data.
  // Why: a run that silently fell back to other data (fixtures, a cached copy)
  // would present conclusions about evidence it never read.
  const { records: visible, summary } = await desk.visibleEvidence(stage);
  const retrieval = { ...summary, visible: visible.length };
  const recorded = before.recordedEvidence();
  const excluded = before.exclusions();
  const pending = visible.filter((record) => !recorded.has(record.id) && !excluded.has(record.id));
  const batches = chunk(pending, desk.config.execution.batchSize);
  // Runs interrupted before saving a snapshot: their judgments were saved
  // per chunk, so they are recovered here, and said so.
  const recovered = before.interruptedRuns();
  if (recovered.length) {
    const judged = recovered.flatMap((item) => item.recorded);
    notes.push(`Recovered ${recovered.length} interrupted run(s) (${recovered.map((item) => item.runId.slice(0, 8)).join(", ")}): `
      + `${judged.length ? `the saved judgments for ${judged.join(", ")} were kept and beliefs reconciled with them` : "no evidence had entered the ledger"}`
      + `${recovered.some((item) => item.unrecorded.length) ? `; not yet in the ledger, so assessed again: ${recovered.flatMap((item) => item.unrecorded).join(", ")}` : ""}.`);
  }
  await reconcile(desk, { correlationId: runId, trigger: "start of run", recovery: true });

  // Why these sizes: the local Nemotron runs in a 4,096-token window (Ollama's
  // default, the same inside Speck and standalone). The engine's chunk budget
  // and carryover limit keep every chunk inside it; in practice a two-record
  // chunk is under 1,000 prompt tokens. maxChunks bounds how much one run may
  // do; anything left over stays pending for the next run, and the notes say so.
  const markovian = new Markovian({
    chunkConfig: { maxChunks: desk.config.execution.maxChunks, chunkSize: 4000, carryoverTokens: 512 },
    historyDir: desk.config.historyDir
  });
  const unsubscribe = markovian.onProgress((state: ProgressState) => desk.emit("progress", { runId, ...state }));

  let next = 0;
  const generator: Generator = async (prompt, _attachments, systemPrompt) => {
    // Meterless calls the generator with a system prompt only for its
    // reflection pass: here, the model's explanation of Speck's conclusion.
    if (systemPrompt !== undefined) {
      if (!desk.reasoner.explain) return { text: "" };
      const now = desk.read();
      const conclusion = now.conclusion(assessed);
      const ledgerRecords = now.ledger(assessed).map((entry) => entry.record).sort(byObservation);
      let result: Explanation;
      try {
        result = await desk.reasoner.explain(explanationPrompt(prompt, conclusion, ledgerRecords, now.basis(assessed).invalid));
      } finally {
        reflection.call = desk.reasoner.takeTrace?.() ?? null;
      }
      const known = new Set(ledgerRecords.map((record) => record.id));
      const invalidCitations = result.citedEvidence.filter((id) => !known.has(id));
      reflection.explanation = { ...result, invalidCitations, agreement: checkAgreement(result, invalidCitations, conclusion) };
      return { text: result.text };
    }
    const batch = batches[next] ?? [];
    const chunkNumber = next + 1;
    next += 1;
    if (!batch.length) return { text: "No new evidence since the last run; belief state unchanged.\n[TASK_COMPLETE]" };
    let assessment: Awaited<ReturnType<Reasoner["assess"]>>;
    try {
      assessment = await desk.reasoner.assess({ chunkPrompt: prompt, batch, hypotheses: desk.scenario.hypotheses });
    } catch (error) {
      // Saved so the records show as failed, not merely pending, until a
      // later run assesses them.
      const message = error instanceof Error ? error.message : String(error);
      await saveAssessment(desk, worker, {
        schema: ASSESSMENT_SCHEMA, runId, at: new Date().toISOString(), judged: [], failed: batch.map((record) => ({ record, error: message })),
        chunk: chunkNumber, model: desk.reasoner.takeTrace?.() ?? null, notes: []
      });
      throw error;
    }
    notes.push(...assessment.notes);
    const judged: AssessedEvidence[] = [];
    const failed: AssessmentAttempt["failed"] = [];
    for (const record of batch) {
      // A record the reasoner returned nothing for is not recorded: a
      // missing judgment must not pass for "no bearing". It stays pending.
      const judgments = assessment.judgments[record.id];
      if (!judgments) {
        notes.push(`No judgment was returned for ${record.id}; it was not recorded and stays pending for the next run.`);
        failed.push({ record, error: "no judgment was returned" });
        continue;
      }
      // Why the source's reliability comes from the scenario, not the model:
      // how far a source is trusted is treated as a property of the source (a
      // carrier's tracking system, a customer's message), stated up front,
      // not something a model reassesses record by record.
      const reliability = desk.scenario.sources[record.source.system]?.reliability;
      if (reliability === undefined) notes.push(`Source "${record.source.system}" has no reliability in the scenario; ${record.id} was weighted 0.5.`);
      const recordedBy = judgments.some((judgment) => judgment.basis === "model") ? "model" as const : "rules" as const;
      judged.push({ record, reliability: reliability ?? 0.5, judgments, recordedBy });
    }
    // The judgments are saved before any of this chunk's evidence enters
    // Speck's ledger. If the run dies after that, nothing recorded lacks
    // its judgments; a record saved but not yet recorded is reassessed.
    await saveAssessment(desk, worker, {
      schema: ASSESSMENT_SCHEMA, runId, at: new Date().toISOString(), judged, failed,
      chunk: chunkNumber, model: desk.reasoner.takeTrace?.() ?? null, notes: assessment.notes
    });
    const recordedNow = new Set<string>();
    for (const { record, reliability, judgments, recordedBy } of judged) {
      // The evidence enters Speck's ledger without relations; reconcile()
      // applies the ones that take effect. A record with any model judgment
      // is recorded as the model's, so Speck caps its reliability
      // (beliefRevision.modelReliabilityCeiling) for every relation it
      // carries, including one withheld now and applied later.
      await desk.runtime.recordEvidence({
        workerId: worker.id,
        content: `[${record.id}] ${record.content}`,
        source: `${record.source.system}/${record.id}`,
        reliability,
        relations: [],
        actor: recordedBy === "model"
          ? { kind: "model", source: `nemotron/${desk.reasoner.describe().model}`, correlationId: runId }
          : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: runId }
      });
      assessed.push({ record, reliability, judgments, recordedBy });
      recordedNow.add(record.id);
    }
    const { basis, recomputation } = await reconcile(desk, { correlationId: runId, trigger: `run evidence ${[...recordedNow].join(", ") || "none"}`, inFlight: assessed, newRecords: recordedNow });
    notes.push(...revisionNotes(basis, recomputation, recordedNow));
    const done = next >= batches.length;
    return { text: `${assessment.narrative}\n\n${done ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\n${stateBlock(desk.read(), assessed, batches.slice(next).flat(), stage)}`}` };
  };

  let execution: MarkovianRun;
  try {
    execution = await markovian.run({
      goal: `Investigate case ${desk.scenario.caseId}: ${desk.scenario.question}`,
      mode: "RESEARCH",
      generator,
      // Why only the previous headline: it orients the engine, while the
      // evidence and beliefs themselves stay in Speck and are not replayed.
      memoryContext: previous ? `PRIOR CONCLUSION (Speck memory, run ${previous.runNumber}): ${previous.conclusion.headline}` : undefined,
      reflect: Boolean(desk.reasoner.explain)
    });
  } finally {
    unsubscribe();
  }
  // A failure inside a chunk (for example while reconciling) leaves beliefs
  // behind the ledger; try once more so the snapshot describes reconciled
  // state, and say so if that fails too.
  if (!desk.read().beliefsReconciled()) {
    try {
      await reconcile(desk, { correlationId: runId, trigger: "end of run", recovery: true });
    } catch (error) {
      notes.push(`Beliefs could not be reconciled with the evidence ledger: ${error instanceof Error ? error.message : String(error)}. They are reconciled when the desk is next opened or run.`);
    }
  }
  const reached = new Set(assessed.map((item) => item.record.id));
  const unprocessed = pending.filter((record) => !reached.has(record.id)).map((record) => record.id);
  if (unprocessed.length) notes.push(`${unprocessed.length} record(s) were not assessed in this run (${execution.status}): ${unprocessed.join(", ")}. They stay pending for the next run.`);
  const explanation = reflection.explanation;
  if (explanation && !explanation.agreement.agrees) {
    notes.push(`The model's explanation does not match Speck's belief state: ${explanation.agreement.problems.join(" ")}`);
  }

  const snapshot: RunSnapshot = {
    schema: RUN_SCHEMA,
    runId,
    runNumber: (previous?.runNumber ?? 0) + 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    stage: { id: stage.id, label: stage.label },
    evidence: desk.provider.describe(),
    reasoner: desk.reasoner.describe(),
    reasonerUsage: desk.reasoner.usage(),
    execution: {
      engine: MARKOVIAN_SOURCE,
      runId: execution.id,
      timestamp: execution.timestamp,
      status: execution.status,
      error: execution.error ?? null,
      chunkConfig: execution.chunkConfig,
      chunks: execution.chunks.map((item) => ({ id: item.id, tokens: item.tokens, carryover: item.carryover, content: item.content })),
      tokenLabel: execution.tokenLabel,
      totalTokensUsed: execution.totalTokensUsed,
      durationMs: execution.durationMs
    },
    assessed,
    unprocessed,
    recovered: recovered.map((item) => item.runId),
    notes: collapse(notes),
    conclusion: desk.read().conclusion(assessed),
    explanation,
    retrieval,
    explanationCall: reflection.call
  };
  await desk.runtime.recordMemory({
    workerId: worker.id, type: "episodic",
    content: `Run ${snapshot.runNumber} (${execution.status}): ${snapshot.conclusion.headline}`,
    data: snapshot as unknown as Record<string, unknown>,
    actor: { kind: "tool", source: "evidence-desk/run", correlationId: runId }
  });
  desk.emit("run", { runId, runNumber: snapshot.runNumber, status: execution.status });
  return snapshot;
}

async function saveAssessment(desk: RunContext, worker: Worker, attempt: AssessmentAttempt): Promise<void> {
  await desk.runtime.recordMemory({
    workerId: worker.id, type: "episodic",
    content: `Assessment in run ${attempt.runId.slice(0, 8)}: judged ${attempt.judged.map((item) => item.record.id).join(", ") || "none"}`
      + (attempt.failed.length ? `; failed ${attempt.failed.map((item) => item.record.id).join(", ")}` : ""),
    data: attempt as unknown as Record<string, unknown>,
    actor: { kind: "tool", source: "evidence-desk/assessment", correlationId: attempt.runId }
  });
}

// The carryover block Meterless passes from one chunk to the next.
// Why so short: it is the engine's [STATE_CHECKPOINT], and Speck holds the
// real state. Four lines are enough for the next chunk to know where the run
// is, and they keep the carryover far under its 512-token limit.
function stateBlock(state: CaseState, assessed: readonly AssessedEvidence[], remaining: readonly EvidenceRecord[], stage: StageSpec): string {
  const beliefs = state.rankedCurrent()
    .map((object) => `${String(object.data.key)} ${String(object.data.status)} ${object.confidence.toFixed(2)}`);
  return [
    `COMPLETED: assessed ${assessed.map((item) => item.record.id).join(", ") || "nothing"}`,
    `REMAINING: ${remaining.map((record) => record.id).join(", ") || "none"}`,
    `DECISIONS: ${beliefs.join("; ")}`,
    `CONTEXT: case ${state.scenario.caseId}, evidence stage ${stage.id}`
  ].join("\n");
}

// The model is asked to explain Speck's conclusion, not to reach one.
// Why it is given Speck's state in full (conclusion, direction, justification,
// every hypothesis with its support) and told not to change it: the
// explanation must describe the conclusion Speck holds, so the model is shown
// exactly what that is and what rests on it. Records that no longer count are
// marked as such, so the explanation can say they were set aside without
// relying on them.
function explanationPrompt(reflectionPrompt: string, conclusion: Conclusion, records: readonly EvidenceRecord[], invalid: ReadonlyMap<string, Invalidation>): string {
  const line = (view: HypothesisView) => `- ${view.key} [${view.status}, Speck confidence ${view.confidence}]: ${view.statement}`
    + ` supported by ${view.supporting.map((item) => item.recordId).join(", ") || "nothing"};`
    + ` contradicted by ${view.contradicting.map((item) => item.recordId).join(", ") || "nothing"}`;
  return [
    reflectionPrompt,
    "",
    `SPECK CONCLUSION STATE: ${conclusion.state}. ${conclusion.headline}`,
    `WHAT THE EVIDENCE SHOWS: ${conclusion.direction.summary}`,
    `HOW FIRMLY IT IS JUSTIFIED: ${conclusion.justification.established ? "established" : "not established"}. ${conclusion.justification.reasons.join(" ")}`,
    "HYPOTHESES:",
    ...[conclusion.hypothesis, ...conclusion.alternatives, ...conclusion.rejected].filter((view): view is HypothesisView => Boolean(view)).map(line),
    `OPEN QUESTIONS: ${conclusion.openQuestions.map((question) => question.text).join(" | ") || "none"}`,
    "EVIDENCE:",
    ...records.map((record) => {
      const invalidation = invalid.get(record.id);
      return `[${record.id}] ${record.source.name}, ${record.observedAt}: ${record.content}`
        + (invalidation ? ` (NO LONGER COUNTS: ${describeInvalidation(record.id, invalidation)})` : "");
    }),
    "",
    "Explain the current conclusion in three to five sentences for an investigator. Say what changed and which evidence is responsible.",
    "Evidence marked NO LONGER COUNTS has been withdrawn or replaced by its source: do not rely on it, though you may say it was set aside.",
    "Do not change the conclusion and do not add facts that are not in the evidence. If it is unresolved, say what the evidence points to and why that is not yet a firm conclusion.",
    "cited_evidence: the evidence ids your explanation relies on, only from the list above.",
    "stated_conclusion: the hypothesis key your explanation concludes, or \"unresolved\".",
    "stated_established: true only if your explanation presents that conclusion as established."
  ].join("\n");
}

// Checks the model's declared conclusion, firmness and citations against
// Speck's state. Why declared fields rather than reading the prose: parsing
// free text for a stance is itself a guess; the explanation contract makes the
// model state its conclusion and firmness explicitly, and those can be checked
// exactly.
export function checkAgreement(explanation: Explanation, invalidCitations: readonly string[], conclusion: Conclusion): ExplanationAgreement {
  const problems: string[] = [];
  const keys = [conclusion.hypothesis, ...conclusion.alternatives, ...conclusion.rejected].flatMap((view) => (view ? [view.key] : []));
  const stated = keys.find((key) => explanation.statedConclusion === key || explanation.statedConclusion.startsWith(`${key}:`))
    ?? (/^unresolved$/i.test(explanation.statedConclusion) ? "unresolved" : explanation.statedConclusion);
  const speck = conclusion.hypothesis?.key ?? "unresolved";
  // An unresolved case may be explained as pointing to its favoured
  // explanation, provided the text does not present it as established.
  const acceptable = new Set([speck, ...(conclusion.hypothesis ? [] : conclusion.direction.pointsTo ? [conclusion.direction.pointsTo.key] : [])]);
  if (!acceptable.has(stated)) problems.push(`It concludes "${stated}"; Speck's conclusion is "${speck}".`);
  if (explanation.statedEstablished !== conclusion.justification.established) {
    problems.push(`It presents the conclusion as ${explanation.statedEstablished ? "established" : "not established"}; Speck holds it as ${conclusion.justification.established ? "established" : "not established"}.`);
  }
  if (invalidCitations.length) problems.push(`It cites evidence that does not exist: ${invalidCitations.join(", ")}.`);
  return { agrees: problems.length === 0, problems };
}

function collapse(notes: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1);
  return [...counts].map(([note, count]) => (count > 1 ? `${note} (${count} times)` : note));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
