import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SpeckRuntime, type ActorInput, type MentalObject, type Worker, type WorkerId } from "#speck";
import { Markovian, type Generator, type MarkovianRun, type ProgressState } from "../../vendor/meterless-markovian/src/index.js";
import type { AppConfig } from "../config.js";
import { createEvidenceProvider } from "../evidence/provider.js";
import { byObservation, type EvidenceProvider, type EvidenceRecord, type ProviderDescription } from "../evidence/types.js";
import { NemotronReasoner } from "../reasoning/nemotron.js";
import { RuleReasoner } from "../reasoning/rules.js";
import type { Explanation, Reasoner, ReasonerDescription, ReasonerUsage, RelationJudgment } from "../reasoning/types.js";
import { loadScenario, type Scenario, type StageSpec } from "../scenario.js";
import { deriveConclusion, type Conclusion, type HypothesisView } from "./conclusion.js";
import { buildTimeline, type TimelineEntry } from "./timeline.js";

export const RUN_SCHEMA = "evidence-desk.run.v1";
export const STAGE_KEY = "evidence-desk.stage";
export const MARKOVIAN_SOURCE = "Meterless Markovian reference engine (vendored, commit 1742dec)";

export interface AssessedEvidence {
  record: EvidenceRecord;
  reliability: number;
  judgments: RelationJudgment[];
  recordedBy: "rules" | "model";
}

export interface RunSnapshot {
  schema: typeof RUN_SCHEMA;
  runId: string;
  runNumber: number;
  startedAt: string;
  finishedAt: string;
  stage: { id: string; label: string };
  evidence: ProviderDescription;
  reasoner: ReasonerDescription;
  reasonerUsage: ReasonerUsage | null;
  execution: {
    engine: string;
    runId: string;
    status: MarkovianRun["status"];
    error: string | null;
    chunkConfig: MarkovianRun["chunkConfig"];
    chunks: Array<{ id: number; tokens: number; carryover: string; content: string }>;
    tokenLabel: MarkovianRun["tokenLabel"];
    totalTokensUsed: number;
    durationMs: number;
  };
  assessed: AssessedEvidence[];
  // Visible evidence this run did not reach (the chunk limit, or an error).
  unprocessed: string[];
  notes: string[];
  conclusion: Conclusion;
  explanation: (Explanation & { invalidCitations: string[]; agreement: ExplanationAgreement }) | null;
}

// Whether the model's explanation says what Speck believes. Checked on the
// model's declared stance and its citations; the prose itself is not parsed.
export interface ExplanationAgreement {
  agrees: boolean;
  problems: string[];
}

export interface EvidenceListing {
  stage: StageSpec;
  provider: ProviderDescription;
  records: Array<EvidenceRecord & {
    assessed: boolean;
    supersededBy: string | null;
    // How the record was weighed when it was assessed: rule or model
    // judgments, and the reliability Speck applied.
    assessment: { runNumber: number; reliability: number; recordedBy: "rules" | "model"; judgments: RelationJudgment[] } | null;
  }>;
  pending: string[];
}

export class RunInProgressError extends Error {
  constructor() { super("An investigation run is already in progress"); this.name = "RunInProgressError"; }
}

export class ReasonerNotReadyError extends Error {
  readonly hint = "Set the NEMOTRON_* settings in .env (see .env.example), or set REASONER=rules for the deterministic assessor.";
  constructor(message: string) { super(message); this.name = "ReasonerNotReadyError"; }
}

// One investigation desk over one scenario. Speck holds all state: the case
// is a Speck worker, the candidate explanations are its hypotheses, every
// assessed record is evidence in its ledger, the released evidence stage is
// world state, and each run's outcome is an episodic memory. Reopening the
// database resumes exactly where the last process left off.
export class EvidenceDesk extends EventEmitter {
  private running = false;

  private constructor(
    readonly config: AppConfig,
    readonly runtime: SpeckRuntime,
    readonly scenario: Scenario,
    readonly provider: EvidenceProvider,
    readonly reasoner: Reasoner
  ) {
    super();
  }

  static async open(config: AppConfig, options: { provider?: EvidenceProvider; reasoner?: Reasoner | ((runtime: SpeckRuntime) => Reasoner); fetchImpl?: typeof fetch } = {}): Promise<EvidenceDesk> {
    const runtime = new SpeckRuntime({ databasePath: config.databasePath });
    await runtime.initialize();
    const scenario = loadScenario(config.scenarioDir);
    const provider = options.provider ?? createEvidenceProvider(config, options.fetchImpl);
    const reasoner = typeof options.reasoner === "function" ? options.reasoner(runtime)
      : options.reasoner ?? (config.reasoner === "nemotron" ? new NemotronReasoner(runtime, config.nemotron) : new RuleReasoner());
    const desk = new EvidenceDesk(config, runtime, scenario, provider, reasoner);
    await desk.ensureCase();
    return desk;
  }

  close(): void {
    this.runtime.close();
  }

  get isRunning(): boolean { return this.running; }

  // The case's Speck worker, created with its hypotheses on first use.
  async ensureCase(): Promise<Worker> {
    const existing = this.findWorker();
    if (existing) return existing;
    const actor: ActorInput = { kind: "user", source: `scenario/${this.scenario.id}` };
    const worker = await this.runtime.createWorker(this.scenario.question, this.caseConstraints(), actor);
    for (const hypothesis of this.scenario.hypotheses) {
      await this.runtime.proposeHypothesis({
        workerId: worker.id, content: hypothesis.statement, confidence: hypothesis.prior,
        data: { key: hypothesis.key }, actor
      });
    }
    await this.runtime.setWorldState({
      workerId: worker.id, key: STAGE_KEY, value: this.scenario.stages[0]!.id, epistemicStatus: "observed", actor
    });
    return this.runtime.workers.require(worker.id);
  }

  currentStage(): StageSpec {
    const id = this.worker().worldState[STAGE_KEY]?.value;
    return this.scenario.stages.find((stage) => stage.id === id) ?? this.scenario.stages[0]!;
  }

  nextStage(): StageSpec | null {
    const index = this.scenario.stages.findIndex((stage) => stage.id === this.currentStage().id);
    return this.scenario.stages[index + 1] ?? null;
  }

  // Releases the next prepared evidence update. Persisted in Speck, so the
  // next run (in this process or a later one) sees it.
  async introduceNextUpdate(): Promise<StageSpec> {
    if (this.running) throw new RunInProgressError();
    const next = this.nextStage();
    if (!next) throw new Error("There is no further prepared evidence update for this case");
    await this.runtime.setWorldState({
      workerId: this.worker().id, key: STAGE_KEY, value: next.id, epistemicStatus: "observed",
      actor: { kind: "user", source: "evidence-desk/update" }
    });
    return next;
  }

  async listEvidence(): Promise<EvidenceListing> {
    const stage = this.currentStage();
    const visible = await this.visibleEvidence(stage);
    const recorded = this.recordedEvidence();
    const supersededBy = new Map<string, string>();
    for (const record of visible) for (const id of record.provenance.supersedes) supersededBy.set(id, record.id);
    const assessments = new Map<string, NonNullable<EvidenceListing["records"][number]["assessment"]>>();
    for (const run of this.runs()) {
      for (const item of run.assessed) {
        assessments.set(item.record.id, { runNumber: run.runNumber, reliability: item.reliability, recordedBy: item.recordedBy, judgments: item.judgments });
      }
    }
    return {
      stage,
      provider: this.provider.describe(),
      records: visible.map((record) => ({
        ...record, assessed: recorded.has(record.id), supersededBy: supersededBy.get(record.id) ?? null,
        assessment: assessments.get(record.id) ?? null
      })),
      pending: visible.filter((record) => !recorded.has(record.id)).map((record) => record.id)
    };
  }

  async run(): Promise<RunSnapshot> {
    if (this.running) throw new RunInProgressError();
    this.running = true;
    try {
      return await this.execute();
    } finally {
      this.running = false;
    }
  }

  runs(): RunSnapshot[] {
    return this.runtime.mentalObjects.listForWorker(this.worker().id)
      .filter((object) => object.data.schema === RUN_SCHEMA)
      .map((object) => object.data as unknown as RunSnapshot)
      .sort((left, right) => left.runNumber - right.runNumber);
  }

  hypotheses(): HypothesisView[] {
    const conclusion = this.conclusionFromSpeck();
    return [...(conclusion.hypothesis ? [conclusion.hypothesis] : []), ...conclusion.alternatives, ...conclusion.rejected];
  }

  timeline(): TimelineEntry[] {
    const workerId = this.worker().id;
    const events = [];
    let after = 0;
    for (;;) {
      const page = this.runtime.listEvents(workerId, after, 1000);
      events.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.sequence;
    }
    return buildTimeline({
      events,
      objects: this.runtime.mentalObjects.listForWorker(workerId),
      scenario: this.scenario,
      runs: this.runs()
    });
  }

  private async execute(): Promise<RunSnapshot> {
    const reasoner = this.reasoner.describe();
    if (!reasoner.ready) throw new ReasonerNotReadyError(`${reasoner.label} is not configured: ${reasoner.problem}`);
    const worker = await this.ensureCase();
    const stage = this.currentStage();
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const previous = this.runs().at(-1) ?? null;
    const notes: string[] = [];
    const assessed: AssessedEvidence[] = [];
    // Set by the reflection pass inside the generator.
    const reflection: { explanation: RunSnapshot["explanation"] } = { explanation: null };

    // Evidence access failures end the run here, visibly. Nothing is
    // substituted for the missing data.
    const visible = await this.visibleEvidence(stage);
    const recorded = this.recordedEvidence();
    const pending = visible.filter((record) => !recorded.has(record.id));
    const batches = chunk(pending, this.config.execution.batchSize);
    const hypothesisIds = this.hypothesisIdsByKey();

    const markovian = new Markovian({
      chunkConfig: { maxChunks: this.config.execution.maxChunks, chunkSize: 4000, carryoverTokens: 512 },
      historyDir: this.config.historyDir
    });
    const unsubscribe = markovian.onProgress((state: ProgressState) => this.emit("progress", { runId, ...state }));

    let next = 0;
    const generator: Generator = async (prompt, _attachments, systemPrompt) => {
      // Meterless calls the generator with a system prompt only for its
      // reflection pass: here, the model's explanation of Speck's conclusion.
      if (systemPrompt !== undefined) {
        if (!this.reasoner.explain) return { text: "" };
        const conclusion = this.conclusionFromSpeck();
        const result = await this.reasoner.explain(explanationPrompt(prompt, conclusion, assessedRecords(this.runs(), assessed)));
        const known = new Set(assessedRecords(this.runs(), assessed).map((record) => record.id));
        const invalidCitations = result.citedEvidence.filter((id) => !known.has(id));
        reflection.explanation = { ...result, invalidCitations, agreement: checkAgreement(result, invalidCitations, this.conclusionFromSpeck(assessed)) };
        return { text: result.text };
      }
      const batch = batches[next] ?? [];
      next += 1;
      if (!batch.length) return { text: "No new evidence since the last run; belief state unchanged.\n[TASK_COMPLETE]" };
      const assessment = await this.reasoner.assess({ chunkPrompt: prompt, batch, hypotheses: this.scenario.hypotheses });
      notes.push(...assessment.notes);
      for (const record of batch) {
        // Speck keeps only "superseded" final: later support moves a
        // "rejected" hypothesis back to active. A decisive counter-example is
        // a checked fact, so nothing short of withdrawing it may revive the
        // hypothesis it refuted; support for it is withheld. Further
        // contradictions are harmless and still recorded.
        const refuted = this.decisivelyRefuted(assessed);
        const judgments = (assessment.judgments[record.id] ?? []).filter((judgment) => {
          if (judgment.direction !== "supports" || !refuted.has(judgment.hypothesisKey)) return true;
          notes.push(`Withheld from Speck: ${record.id} ${judgment.direction} ${judgment.hypothesisKey} (${judgment.basis}), which ${refuted.get(judgment.hypothesisKey)} already refuted decisively.`);
          return false;
        });
        const reliability = this.scenario.sources[record.source.system]?.reliability;
        if (reliability === undefined) notes.push(`Source "${record.source.system}" has no reliability in the scenario; ${record.id} was weighted 0.5.`);
        const recordedBy = judgments.some((judgment) => judgment.basis === "model") ? "model" as const : "rules" as const;
        await this.runtime.recordEvidence({
          workerId: worker.id,
          content: `[${record.id}] ${record.content}`,
          source: `${record.source.system}/${record.id}`,
          reliability: reliability ?? 0.5,
          relations: judgments.map((judgment) => ({
            hypothesisId: hypothesisIds.get(judgment.hypothesisKey)!,
            direction: judgment.direction, strength: judgment.strength, decisive: judgment.decisive
          })),
          // A model-judged relation is recorded as the model's, so Speck caps
          // its reliability (beliefRevision.modelReliabilityCeiling).
          actor: recordedBy === "model"
            ? { kind: "model", source: `nemotron/${this.reasoner.describe().model}`, correlationId: runId }
            : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: runId }
        });
        assessed.push({ record, reliability: reliability ?? 0.5, judgments, recordedBy });
      }
      const done = next >= batches.length;
      return { text: `${assessment.narrative}\n\n${done ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\n${this.stateBlock(assessed, batches.slice(next).flat(), stage)}`}` };
    };

    let execution: MarkovianRun;
    try {
      execution = await markovian.run({
        goal: `Investigate case ${this.scenario.caseId}: ${this.scenario.question}`,
        mode: "RESEARCH",
        generator,
        memoryContext: previous ? `PRIOR CONCLUSION (Speck memory, run ${previous.runNumber}): ${previous.conclusion.headline}` : undefined,
        reflect: Boolean(this.reasoner.explain)
      });
    } finally {
      unsubscribe();
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
      evidence: this.provider.describe(),
      reasoner: this.reasoner.describe(),
      reasonerUsage: this.reasoner.usage(),
      execution: {
        engine: MARKOVIAN_SOURCE,
        runId: execution.id,
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
      notes: collapse(notes),
      conclusion: this.conclusionFromSpeck(assessed),
      explanation
    };
    await this.runtime.recordMemory({
      workerId: worker.id, type: "episodic",
      content: `Run ${snapshot.runNumber} (${execution.status}): ${snapshot.conclusion.headline}`,
      data: snapshot as unknown as Record<string, unknown>,
      actor: { kind: "tool", source: "evidence-desk/run", correlationId: runId }
    });
    this.emit("run", { runId, runNumber: snapshot.runNumber, status: execution.status });
    return snapshot;
  }

  // Speck's current belief state as a conclusion.
  conclusionFromSpeck(inFlight: readonly AssessedEvidence[] = []): Conclusion {
    const records = assessedRecords(this.runs(), inFlight);
    const byRecordId = new Map(records.map((record) => [record.id, record]));
    const objectToRecord = new Map<string, string>();
    for (const [recordId, objectId] of this.recordedEvidence()) objectToRecord.set(objectId, recordId);
    const { supportedThreshold, supportBonus, modelReliabilityCeiling } = this.runtime.config.beliefRevision;
    return deriveConclusion({
      ranked: this.runtime.rankHypotheses(this.worker().id),
      assessed: records,
      evidenceFor: (objectId) => {
        const record = byRecordId.get(objectToRecord.get(objectId) ?? "");
        const object = this.runtime.mentalObjects.get(objectId as MentalObject["id"]);
        return record && object ? {
          record,
          reliability: Number(object.data.reliability ?? 0.5),
          judgedBy: object.provenance.kind === "model" ? "model" : "rules"
        } : undefined;
      },
      questions: this.scenario.questions,
      belief: { supportedThreshold, supportBonus, modelReliabilityCeiling }
    });
  }

  // Hypothesis key -> the record that decisively refuted it, for hypotheses
  // Speck currently holds as rejected.
  private decisivelyRefuted(inFlight: readonly AssessedEvidence[]): Map<string, string> {
    const rejected = new Set(this.runtime.rankHypotheses(this.worker().id)
      .filter((object) => object.data.status === "rejected").map((object) => String(object.data.key)));
    const refuted = new Map<string, string>();
    for (const item of [...this.runs().flatMap((run) => run.assessed), ...inFlight]) {
      for (const judgment of item.judgments) {
        if (judgment.decisive && rejected.has(judgment.hypothesisKey) && !refuted.has(judgment.hypothesisKey)) refuted.set(judgment.hypothesisKey, item.record.id);
      }
    }
    return refuted;
  }

  private stateBlock(assessed: readonly AssessedEvidence[], remaining: readonly EvidenceRecord[], stage: StageSpec): string {
    const beliefs = this.runtime.rankHypotheses(this.worker().id)
      .map((object) => `${String(object.data.key)} ${String(object.data.status)} ${object.confidence.toFixed(2)}`);
    return [
      `COMPLETED: assessed ${assessed.map((item) => item.record.id).join(", ") || "nothing"}`,
      `REMAINING: ${remaining.map((record) => record.id).join(", ") || "none"}`,
      `DECISIONS: ${beliefs.join("; ")}`,
      `CONTEXT: case ${this.scenario.caseId}, evidence stage ${stage.id}`
    ].join("\n");
  }

  private async visibleEvidence(stage: StageSpec): Promise<EvidenceRecord[]> {
    const cutoff = Date.parse(stage.asOf);
    return (await this.provider.fetchCaseEvidence(this.scenario.caseId))
      .filter((record) => Date.parse(record.observedAt) <= cutoff)
      .sort(byObservation);
  }

  // Record id -> Speck evidence object id, for evidence already in the ledger.
  private recordedEvidence(): Map<string, string> {
    const recorded = new Map<string, string>();
    for (const object of this.runtime.mentalObjects.listForWorker(this.worker().id)) {
      if (object.kind !== "evidence") continue;
      const source = String(object.data.source ?? "");
      recorded.set(source.slice(source.lastIndexOf("/") + 1), object.id);
    }
    return recorded;
  }

  private hypothesisIdsByKey(): Map<string, MentalObject["id"]> {
    return new Map(this.runtime.rankHypotheses(this.worker().id).map((object) => [String(object.data.key), object.id]));
  }

  private findWorker(): Worker | undefined {
    const constraints = this.caseConstraints();
    return this.runtime.listWorkers().find((worker) => constraints.every((constraint) => worker.objective.constraints.includes(constraint)));
  }

  private worker(): Worker {
    const worker = this.findWorker();
    if (!worker) throw new Error(`Case ${this.scenario.caseId} has no Speck worker`);
    return this.runtime.workers.require(worker.id as WorkerId);
  }

  private caseConstraints(): string[] {
    return [`evidence-desk:case=${this.scenario.caseId}`, `evidence-desk:scenario=${this.scenario.id}`];
  }
}

function assessedRecords(runs: readonly RunSnapshot[], inFlight: readonly AssessedEvidence[]): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const run of runs) for (const item of run.assessed) byId.set(item.record.id, item.record);
  for (const item of inFlight) byId.set(item.record.id, item.record);
  return [...byId.values()].sort(byObservation);
}

function explanationPrompt(reflectionPrompt: string, conclusion: Conclusion, records: readonly EvidenceRecord[]): string {
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
    ...records.map((record) => `[${record.id}] ${record.source.name}, ${record.observedAt}: ${record.content}`),
    "",
    "Explain the current conclusion in three to five sentences for an investigator. Say what changed and which evidence is responsible.",
    "Do not change the conclusion and do not add facts that are not in the evidence. If it is unresolved, say what the evidence points to and why that is not yet a firm conclusion.",
    "cited_evidence: the evidence ids your explanation relies on, only from the list above.",
    "stated_conclusion: the hypothesis key your explanation concludes, or \"unresolved\".",
    "stated_established: true only if your explanation presents that conclusion as established."
  ].join("\n");
}

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

export function relativeDataPath(config: AppConfig, file: string): string {
  return path.relative(config.rootDir, file).split(path.sep).join("/");
}
