import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SpeckRuntime, type ActorInput, type EvidenceRelation, type MentalObject, type MentalObjectId, type Worker, type WorkerId } from "#speck";
import { Markovian, type Generator, type MarkovianRun, type ProgressState } from "../../vendor/meterless-markovian/src/index.js";
import type { AppConfig } from "../config.js";
import { createEvidenceProvider } from "../evidence/provider.js";
import { byObservation, type EvidenceProvider, type EvidenceRecord, type ProviderDescription } from "../evidence/types.js";
import { NemotronReasoner } from "../reasoning/nemotron.js";
import { RuleReasoner } from "../reasoning/rules.js";
import type { Explanation, Reasoner, ReasonerDescription, ReasonerUsage, RelationJudgment } from "../reasoning/types.js";
import { loadScenario, type Scenario, type StageSpec } from "../scenario.js";
import { deriveBasis, describeInvalidation, isPrefix, type BeliefBasis, type Invalidation, type LedgerEntry, type PlannedRelation } from "./basis.js";
import { deriveConclusion, type Conclusion, type HypothesisView } from "./conclusion.js";
import { buildTimeline, type TimelineEntry } from "./timeline.js";

export const RUN_SCHEMA = "evidence-desk.run.v1";
export const RECOMPUTE_SCHEMA = "evidence-desk.recompute.v1";
export const STAGE_KEY = "evidence-desk.stage";
export const MARKOVIAN_SOURCE = "Meterless Markovian reference engine (vendored, commit 1742dec)";

export interface AssessedEvidence {
  record: EvidenceRecord;
  reliability: number;
  // The reasoner's judgments as given. Which of them currently take effect is
  // derived from the whole ledger (basis.ts), not decided when recorded.
  judgments: RelationJudgment[];
  recordedBy: "rules" | "model";
}

// Hypotheses rebuilt from the evidence that still counts, because something
// they rested on was invalidated or evidence arrived out of observation
// order. Stored in Speck as a memory. The replaced hypotheses stay in Speck,
// marked superseded, with their own revision history.
export interface Recomputation {
  schema: typeof RECOMPUTE_SCHEMA;
  version: number;
  at: string;
  correlationId: string;
  trigger: string;
  hypotheses: Array<{
    key: string;
    previousId: string;
    replacementId: string;
    previous: { confidence: number; status: string };
    // Relations the old hypothesis carried that no longer apply, and why.
    dropped: Array<{ recordId: string; direction: string; reason: string }>;
    // Relations that apply now and did not before; reinstated ones were in
    // the ledger already and count again.
    added: Array<{ recordId: string; direction: string; reinstated: boolean }>;
    // Everything replayed from the prior, in order.
    replayed: string[];
    cause: string;
  }>;
}

// A hypothesis no longer current: what it had reached when it was replaced.
export interface ReplacedHypothesis {
  key: string;
  id: string;
  statement: string;
  confidence: number;
  statusWhenReplaced: string;
  supersededBy: string | null;
  recomputation: number | null;
}

export type JudgmentEffect = "applied" | "withheld" | "void";

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
    // Why an assessed record no longer counts towards current beliefs.
    invalidation: Invalidation | null;
    // How the record was weighed when it was assessed: rule or model
    // judgments, the reliability Speck applied, and whether each judgment
    // takes effect now.
    assessment: {
      runNumber: number; reliability: number; recordedBy: "rules" | "model";
      judgments: Array<RelationJudgment & { effect: JudgmentEffect; refutedBy: string | null }>;
    } | null;
  }>;
  pending: string[];
}

export class RunInProgressError extends Error {
  constructor() { super("An investigation run is already in progress"); this.name = "RunInProgressError"; }
}

export class WithdrawalError extends Error {
  constructor(message: string) { super(message); this.name = "WithdrawalError"; }
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
    const basis = this.basis();
    const assessments = new Map<string, NonNullable<EvidenceListing["records"][number]["assessment"]>>();
    for (const run of this.runs()) {
      for (const item of run.assessed) {
        const judgments = item.judgments.map((judgment) => {
          const withheld = basis.withheld.find((entry) => entry.recordId === item.record.id && entry.hypothesisKey === judgment.hypothesisKey);
          const effect: JudgmentEffect = basis.invalid.has(item.record.id) ? "void" : withheld ? "withheld" : "applied";
          return { ...judgment, effect, refutedBy: withheld?.refutedBy ?? null };
        });
        assessments.set(item.record.id, { runNumber: run.runNumber, reliability: item.reliability, recordedBy: item.recordedBy, judgments });
      }
    }
    return {
      stage,
      provider: this.provider.describe(),
      records: visible.map((record) => ({
        ...record, assessed: recorded.has(record.id), supersededBy: supersededBy.get(record.id) ?? null,
        invalidation: basis.invalid.get(record.id) ?? null,
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

  // Withdraws an assessed record from the case (for example, it belongs to a
  // different case). Speck archives it; current beliefs are then recomputed
  // without it, and what it contributed before stays in the history.
  async withdrawRecord(recordId: string, reason: string): Promise<Recomputation | null> {
    if (this.running) throw new RunInProgressError();
    const why = reason.trim();
    if (!why) throw new WithdrawalError("A reason is required to withdraw evidence");
    const evidenceId = this.recordedEvidence().get(recordId);
    if (!evidenceId) throw new WithdrawalError(`${recordId} has not been assessed in this case, so there is nothing to withdraw`);
    this.running = true;
    try {
      const correlationId = randomUUID();
      await this.runtime.withdrawEvidence({
        workerId: this.worker().id, evidenceId: evidenceId as MentalObjectId, reason: why,
        actor: { kind: "user", source: "evidence-desk/withdraw", correlationId }
      });
      const { recomputation } = await this.reconcile({ correlationId, trigger: `${recordId} withdrawn: ${why}` });
      this.emit("revision", { recordId, recomputation: recomputation?.version ?? null });
      return recomputation;
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

  recomputations(): Recomputation[] {
    return this.runtime.mentalObjects.listForWorker(this.worker().id)
      .filter((object) => object.data.schema === RECOMPUTE_SCHEMA)
      .map((object) => object.data as unknown as Recomputation)
      .sort((left, right) => left.version - right.version);
  }

  // The current hypothesis for each key: the one no other hypothesis
  // replaces. Every view of current belief reads only these.
  currentHypotheses(): Map<string, MentalObject> {
    const all = this.allHypotheses();
    const replaced = new Set(all.flatMap((object) => (object.data.replaces ? [String(object.data.replaces)] : [])));
    const current = new Map<string, MentalObject>();
    for (const object of all) if (!replaced.has(object.id)) current.set(String(object.data.key), object);
    return current;
  }

  replacedHypotheses(): ReplacedHypothesis[] {
    const current = new Set([...this.currentHypotheses().values()].map((object) => object.id));
    return this.allHypotheses().filter((object) => !current.has(object.id)).map((object) => ({
      key: String(object.data.key), id: object.id, statement: object.content, confidence: round(object.confidence),
      statusWhenReplaced: String(object.data.statusWhenReplaced ?? object.data.status),
      supersededBy: object.data.supersededBy ? String(object.data.supersededBy) : null,
      recomputation: Number(this.allHypotheses().find((other) => other.data.replaces === object.id)?.data.recomputation) || null
    }));
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
        const conclusion = this.conclusionFromSpeck(assessed);
        const result = await this.reasoner.explain(explanationPrompt(prompt, conclusion, assessedRecords(this.runs(), assessed), this.basis(assessed).invalid));
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
      const recordedNow = new Set<string>();
      for (const record of batch) {
        // A record the reasoner returned nothing for is not recorded: a
        // missing judgment must not pass for "no bearing". It stays pending.
        const judgments = assessment.judgments[record.id];
        if (!judgments) {
          notes.push(`No judgment was returned for ${record.id}; it was not recorded and stays pending for the next run.`);
          continue;
        }
        const reliability = this.scenario.sources[record.source.system]?.reliability;
        if (reliability === undefined) notes.push(`Source "${record.source.system}" has no reliability in the scenario; ${record.id} was weighted 0.5.`);
        const recordedBy = judgments.some((judgment) => judgment.basis === "model") ? "model" as const : "rules" as const;
        // The evidence enters Speck's ledger without relations; reconcile()
        // applies the ones that take effect. A record with any model judgment
        // is recorded as the model's, so Speck caps its reliability
        // (beliefRevision.modelReliabilityCeiling) for every relation it
        // carries, including one withheld now and applied later.
        await this.runtime.recordEvidence({
          workerId: worker.id,
          content: `[${record.id}] ${record.content}`,
          source: `${record.source.system}/${record.id}`,
          reliability: reliability ?? 0.5,
          relations: [],
          actor: recordedBy === "model"
            ? { kind: "model", source: `nemotron/${this.reasoner.describe().model}`, correlationId: runId }
            : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: runId }
        });
        assessed.push({ record, reliability: reliability ?? 0.5, judgments, recordedBy });
        recordedNow.add(record.id);
      }
      const { basis, recomputation } = await this.reconcile({ correlationId: runId, trigger: `run evidence ${[...recordedNow].join(", ") || "none"}`, inFlight: assessed, newRecords: recordedNow });
      notes.push(...revisionNotes(basis, recomputation, recordedNow));
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
    const ledger = this.ledger(inFlight);
    const byRecordId = new Map(ledger.map((entry) => [entry.record.id, entry]));
    const objectToRecord = new Map<string, string>();
    for (const [recordId, objectId] of this.recordedEvidence()) objectToRecord.set(objectId, recordId);
    const { supportedThreshold, supportBonus, modelReliabilityCeiling } = this.runtime.config.beliefRevision;
    return deriveConclusion({
      ranked: this.rankedCurrent(),
      assessed: records,
      evidenceFor: (objectId, hypothesisKey) => {
        const entry = byRecordId.get(objectToRecord.get(objectId) ?? "");
        const object = this.runtime.mentalObjects.get(objectId as MentalObject["id"]);
        return entry && object ? {
          record: entry.record,
          reliability: Number(object.data.reliability ?? 0.5),
          judgedBy: object.provenance.kind === "model" ? "model" : "rules",
          judgment: entry.judgments.find((judgment) => judgment.hypothesisKey === hypothesisKey)
        } : undefined;
      },
      questions: this.scenario.questions,
      belief: { supportedThreshold, supportBonus, modelReliabilityCeiling },
      invalidated: deriveBasis(ledger, this.scenario.hypotheses.map((hypothesis) => hypothesis.key)).invalid
    });
  }

  // Makes Speck's current hypotheses equal a replay of the evidence and
  // judgments that still count (basis.ts). A hypothesis whose applied
  // relations are the start of its plan is extended. Any other is replaced:
  // a new hypothesis from the scenario prior, the whole plan replayed through
  // Speck's own revision, and the old one marked superseded. On consistent
  // state it does nothing.
  private async reconcile(input: {
    correlationId: string; trigger: string; inFlight?: readonly AssessedEvidence[]; newRecords?: ReadonlySet<string>;
  }): Promise<{ basis: BeliefBasis; recomputation: Recomputation | null }> {
    const workerId = this.worker().id;
    const ledger = this.ledger(input.inFlight);
    const basis = deriveBasis(ledger, this.scenario.hypotheses.map((hypothesis) => hypothesis.key));
    const recorded = this.recordedEvidence();
    const recordOf = new Map([...recorded].map(([recordId, objectId]) => [objectId, recordId]));
    const current = this.currentHypotheses();
    const capacity = this.runtime.config.beliefRevision.revisionHistoryCapacity;
    const startAt = new Map<string, number>();
    const replace: Array<{ key: string; statement: string; prior: number; previous: MentalObject; applied: AppliedRelation[] }> = [];
    for (const spec of this.scenario.hypotheses) {
      const hypothesis = current.get(spec.key);
      if (!hypothesis) throw new Error(`Case ${this.scenario.caseId} has no Speck hypothesis for ${spec.key}`);
      const applied = appliedRelations(hypothesis, recordOf);
      // Speck keeps the last `capacity` revisions; a full history may be
      // truncated and cannot be checked, so it is replayed instead.
      if (applied.length < capacity && isPrefix(applied, basis.plan.get(spec.key)!)) startAt.set(spec.key, applied.length);
      else replace.push({ key: spec.key, statement: spec.statement, prior: spec.prior, previous: hypothesis, applied });
    }

    const hypothesisIds = new Map([...current].map(([key, object]) => [key, object.id]));
    let recomputation: Recomputation | null = null;
    if (replace.length) {
      const actor: ActorInput = { kind: "tool", source: "evidence-desk/recompute", correlationId: input.correlationId };
      const version = this.recomputations().length + 1;
      const entries: Recomputation["hypotheses"] = [];
      for (const item of replace) {
        const replacement = await this.runtime.proposeHypothesis({
          workerId, content: item.statement, confidence: item.prior,
          data: { key: item.key, replaces: item.previous.id, recomputation: version }, actor
        });
        hypothesisIds.set(item.key, replacement.id);
        startAt.set(item.key, 0);
        entries.push(describeReplacement(item, replacement.id, basis, input.newRecords ?? new Set()));
      }
      recomputation = {
        schema: RECOMPUTE_SCHEMA, version, at: new Date().toISOString(), correlationId: input.correlationId,
        trigger: input.trigger, hypotheses: entries
      };
      await this.runtime.recordMemory({
        workerId, type: "episodic",
        content: `Recomputation ${version}: ${entries.map((entry) => `${entry.key} (${entry.cause})`).join("; ")}`,
        data: recomputation as unknown as Record<string, unknown>, actor
      });
    }
    this.retireReplaced();

    // Apply each record's outstanding relations in canonical order. Each
    // hypothesis's revisions depend only on its own sequence, so this equals
    // replaying every plan from the start.
    const outstanding = new Map<string, EvidenceRelation[]>();
    for (const [key, plan] of basis.plan) {
      for (const relation of plan.slice(startAt.get(key))) {
        const list = outstanding.get(relation.recordId) ?? [];
        list.push({ hypothesisId: hypothesisIds.get(key)!, direction: relation.direction, strength: relation.strength, decisive: relation.decisive });
        outstanding.set(relation.recordId, list);
      }
    }
    for (const entry of [...ledger].sort((left, right) => byObservation(left.record, right.record))) {
      const relations = outstanding.get(entry.record.id);
      if (!relations) continue;
      const evidenceId = recorded.get(entry.record.id)! as MentalObjectId;
      const evidence = this.runtime.mentalObjects.get(evidenceId)!;
      await this.runtime.reviseHypothesesFromEvidence({
        workerId, evidenceId, relations,
        actor: evidence.provenance.kind === "model"
          ? { kind: "model", source: evidence.provenance.source, correlationId: input.correlationId }
          : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: input.correlationId }
      });
    }
    return { basis, recomputation };
  }

  // A replaced hypothesis is marked superseded in Speck, the way Speck's own
  // mind component retires a contradicted fact. It keeps its revision
  // history and the status it had reached, for the audit trail.
  private retireReplaced(): void {
    const all = this.allHypotheses();
    const current = new Set([...this.currentHypotheses().values()].map((object) => object.id));
    const now = new Date().toISOString();
    for (const object of all) {
      if (current.has(object.id) || object.data.status === "superseded") continue;
      const replacement = all.find((other) => other.data.replaces === object.id);
      this.runtime.mentalObjects.update({
        ...object, status: "superseded",
        data: { ...object.data, status: "superseded", statusWhenReplaced: object.data.status, supersededBy: replacement?.id ?? null, supersededAt: now }
      });
    }
  }

  private basis(inFlight: readonly AssessedEvidence[] = []): BeliefBasis {
    return deriveBasis(this.ledger(inFlight), this.scenario.hypotheses.map((hypothesis) => hypothesis.key));
  }

  // Every record in Speck's evidence ledger for the case, with the judgments
  // the reasoner gave it and whether it has been withdrawn.
  private ledger(inFlight: readonly AssessedEvidence[] = []): LedgerEntry[] {
    const withdrawn = new Map<string, { reason: string; at: string }>();
    for (const object of this.runtime.mentalObjects.listForWorker(this.worker().id)) {
      const marker = object.data.withdrawn as { reason?: unknown; at?: unknown } | undefined;
      if (object.kind !== "evidence" || !marker) continue;
      const source = String(object.data.source ?? "");
      withdrawn.set(source.slice(source.lastIndexOf("/") + 1), { reason: String(marker.reason ?? ""), at: String(marker.at ?? "") });
    }
    const latest = new Map<string, AssessedEvidence>();
    for (const run of this.runs()) for (const item of run.assessed) latest.set(item.record.id, item);
    for (const item of inFlight) latest.set(item.record.id, item);
    return [...latest.values()].map((item) => ({ record: item.record, judgments: item.judgments, withdrawn: withdrawn.get(item.record.id) ?? null }));
  }

  private allHypotheses(): MentalObject[] {
    return this.runtime.mentalObjects.listForWorker(this.worker().id)
      .filter((object) => object.kind === "hypothesis")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private rankedCurrent(): MentalObject[] {
    const current = new Set([...this.currentHypotheses().values()].map((object) => object.id));
    return this.runtime.rankHypotheses(this.worker().id).filter((object) => current.has(object.id));
  }

  private stateBlock(assessed: readonly AssessedEvidence[], remaining: readonly EvidenceRecord[], stage: StageSpec): string {
    const beliefs = this.rankedCurrent()
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

interface AppliedRelation { recordId: string; direction: string }

// The relations Speck has applied to a hypothesis, in order, from its own
// revision history.
function appliedRelations(hypothesis: MentalObject, recordOf: ReadonlyMap<string, string>): AppliedRelation[] {
  const history = Array.isArray(hypothesis.data.revisionHistory) ? hypothesis.data.revisionHistory as Array<{ evidenceId?: string; direction?: string }> : [];
  return history.map((entry) => ({ recordId: recordOf.get(String(entry.evidenceId)) ?? `unknown:${entry.evidenceId}`, direction: String(entry.direction) }));
}

function describeReplacement(
  item: { key: string; previous: MentalObject; applied: AppliedRelation[] },
  replacementId: string,
  basis: BeliefBasis,
  newRecords: ReadonlySet<string>
): Recomputation["hypotheses"][number] {
  const plan = basis.plan.get(item.key)!;
  const same = (left: AppliedRelation, right: AppliedRelation | PlannedRelation) => left.recordId === right.recordId && left.direction === right.direction;
  const dropped = item.applied.filter((applied) => !plan.some((planned) => same(applied, planned))).map((applied) => {
    const invalidation = basis.invalid.get(applied.recordId);
    const withheld = basis.withheld.find((entry) => entry.recordId === applied.recordId && entry.hypothesisKey === item.key);
    const reason = invalidation ? describeInvalidation(applied.recordId, invalidation)
      : withheld ? `support withheld: ${withheld.refutedBy} refutes ${item.key} decisively`
      : "no longer judged to bear on it";
    return { ...applied, reason };
  });
  const added = plan.filter((planned) => !item.applied.some((applied) => same(applied, planned)))
    .map((planned) => ({ recordId: planned.recordId, direction: planned.direction, reinstated: !newRecords.has(planned.recordId) }));
  const reinstated = added.filter((entry) => entry.reinstated);
  const cause = dropped.length ? dropped.map((entry) => entry.reason).join("; ")
    : reinstated.length ? `${reinstated.map((entry) => entry.recordId).join(", ")} count${reinstated.length === 1 ? "s" : ""} again`
    : "evidence observed earlier arrived later; replayed in observation order";
  return {
    key: item.key, previousId: item.previous.id, replacementId,
    previous: { confidence: round(item.previous.confidence), status: String(item.previous.data.status) },
    dropped, added, replayed: plan.map((planned) => `${planned.recordId} ${planned.direction}`), cause
  };
}

// Run notes for what the basis did to this chunk's evidence.
function revisionNotes(basis: BeliefBasis, recomputation: Recomputation | null, recordedNow: ReadonlySet<string>): string[] {
  const notes = basis.withheld
    .filter((entry) => recordedNow.has(entry.recordId) || recordedNow.has(entry.refutedBy))
    .map((entry) => `Withheld from Speck: ${entry.recordId} supports ${entry.hypothesisKey} (${entry.basis}), which ${entry.refutedBy} refutes decisively.`);
  for (const entry of recomputation?.hypotheses ?? []) {
    notes.push(`Recomputed ${entry.key} from its prior (was ${entry.previous.status} ${entry.previous.confidence}): ${entry.cause}.`);
  }
  return notes;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

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
