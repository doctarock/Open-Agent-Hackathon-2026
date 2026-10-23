import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SpeckRuntime, type ActorInput, type CognitiveEvent, type EvidenceRelation, type MentalObject, type MentalObjectId, type Worker, type WorkerId } from "#speck";
import { Markovian, type Generator, type MarkovianRun, type ProgressState } from "../../vendor/meterless-markovian/src/index.js";
import type { AppConfig } from "../config.js";
import { createEvidenceProvider } from "../evidence/provider.js";
import { byObservation, type EvidenceProvider, type EvidenceRecord, type FetchSummary, type ProviderDescription } from "../evidence/types.js";
import { NemotronReasoner } from "../reasoning/nemotron.js";
import { RuleReasoner } from "../reasoning/rules.js";
import type { Explanation, ModelCallTrace, Reasoner, ReasonerDescription, ReasonerUsage, RelationJudgment } from "../reasoning/types.js";
import { loadScenario, type Scenario, type StageSpec } from "../scenario.js";
import { deriveBasis, describeInvalidation, isPrefix, type BeliefBasis, type Invalidation, type LedgerEntry, type PlannedRelation } from "./basis.js";
import { deriveConclusion, type Conclusion, type HypothesisView } from "./conclusion.js";
import { retireHypothesis } from "./speck-compat.js";
import { buildTimeline, type TimelineEntry } from "./timeline.js";
import { buildTrace, readEngineHistory, type EngineHistoryEntry, type TraceEntry } from "./trace.js";

export const RUN_SCHEMA = "evidence-desk.run.v1";
export const RECOMPUTE_SCHEMA = "evidence-desk.recompute.v1";
export const ASSESSMENT_SCHEMA = "evidence-desk.assessment.v1";
export const EXCLUSION_SCHEMA = "evidence-desk.exclusion.v1";

// A record withdrawn before it was assessed (for example one whose assessment
// keeps failing). It never enters Speck's evidence ledger and no judgment is
// recorded for it: it is simply not assessed, so it cannot affect beliefs and
// supersedes nothing.
export interface Exclusion {
  schema: typeof EXCLUSION_SCHEMA;
  recordId: string;
  reason: string;
  at: string;
  // The failure that prompted it, if its last assessment failed.
  lastError: string | null;
}
export const STAGE_KEY = "evidence-desk.stage";
export const MARKOVIAN_SOURCE = "Meterless Markovian reference engine (vendored, commit 1742dec)";
// The engine's identity, as recorded in vendor/meterless-markovian/NOTICE.md.
export const MARKOVIAN_ENGINE = {
  name: "Meterless Markovian reference engine",
  package: "@meterless/markovian-reference@0.1.0",
  upstream: "https://github.com/Meterless/Meterless (engines/markovian/reference/src)",
  commit: "1742dec56a66e58eef9dda2d2b865823758ca8cd",
  vendored: "vendor/meterless-markovian/ (unmodified)"
} as const;

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
    // replaced: rebuilt from its prior as a new Speck hypothesis. extended:
    // the same hypothesis, with relations from records already in the ledger
    // applied (absent in records written before Build 3.1: replaced).
    mode?: "replaced" | "extended";
    previousId: string;
    // Resolved when read (recomputations()): the hypothesis that replaced
    // previousId, or null if an interruption stopped it being made.
    replacementId: string | null;
    carriedOut?: boolean;
    previous: { confidence: number; status: string };
    // Relations the old hypothesis carried that no longer apply, and why.
    dropped: Array<{ recordId: string; direction: string; reason: string }>;
    // Relations that apply now and did not before; reinstated ones were in
    // the ledger already and count again.
    added: Array<{ recordId: string; direction: string; reinstated: boolean }>;
    // What was applied: the whole plan from the prior when replaced, the
    // added relations when extended.
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
    // The engine's own timestamp for the run. Its run ids restart at run-1 in
    // every process, so id and timestamp together identify it in history.json.
    timestamp?: number;
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
  // Earlier runs that were interrupted before saving a snapshot, whose saved
  // judgments this run found and reconciled.
  recovered?: string[];
  notes: string[];
  conclusion: Conclusion;
  explanation: (Explanation & { invalidCitations: string[]; agreement: ExplanationAgreement }) | null;
  // What the evidence fetch at the start of this run did (each Zetaris
  // SELECT, or the fixture file), and the explanation's model call.
  retrieval?: (FetchSummary & { visible: number }) | null;
  explanationCall?: ModelCallTrace | null;
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
      // reliability: the source's, as configured; appliedReliability: what Speck
      // stored for the evidence, after its cap on model-judged evidence.
      runNumber: number | null; reliability: number; appliedReliability: number | null; recordedBy: "rules" | "model";
      judgments: Array<RelationJudgment & { effect: JudgmentEffect; refutedBy: string | null }>;
    } | null;
    // completed: in Speck's ledger with its judgments saved. failed: the last
    // attempt to assess it failed (it is retried by the next run). pending:
    // not yet assessed, or assessed by a run interrupted before recording it.
    status: AssessmentStatus;
    lastAttempt: { runId: string; at: string; outcome: "judged" | "failed"; error: string | null } | null;
  }>;
  // Records the next run will assess: pending and failed.
  pending: string[];
}

// withdrawn: withdrawn before it was assessed; it is never assessed.
export type AssessmentStatus = "pending" | "failed" | "completed" | "withdrawn";

// One chunk's assessment, saved in Speck before any of its evidence enters
// the ledger, so a run interrupted afterwards loses no judgment.
export interface AssessmentAttempt {
  schema: typeof ASSESSMENT_SCHEMA;
  runId: string;
  at: string;
  judged: AssessedEvidence[];
  failed: Array<{ record: EvidenceRecord; error: string }>;
  // The Meterless chunk (1-based step) whose generator call made this
  // assessment, the model call behind it (null for the rule assessor), and
  // the reasoner's notes on what it discarded. Absent before the trace existed.
  chunk?: number;
  model?: ModelCallTrace | null;
  notes?: string[];
}

export interface DeskOptions {
  provider?: EvidenceProvider;
  reasoner?: Reasoner | ((runtime: SpeckRuntime) => Reasoner);
  fetchImpl?: typeof fetch;
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
  // Whether this desk opened the Speck runtime (standalone) or was handed
  // one (the Speck plugin), and so whether it may close it.
  private ownsRuntime = false;

  private constructor(
    readonly config: AppConfig,
    readonly runtime: SpeckRuntime,
    readonly scenario: Scenario,
    readonly provider: EvidenceProvider,
    readonly reasoner: Reasoner
  ) {
    super();
  }

  // Standalone: opens its own Speck runtime on config.databasePath.
  static async open(config: AppConfig, options: DeskOptions = {}): Promise<EvidenceDesk> {
    const runtime = new SpeckRuntime({ databasePath: config.databasePath });
    await runtime.initialize();
    const desk = await EvidenceDesk.attach(runtime, config, options);
    desk.ownsRuntime = true;
    return desk;
  }

  // Inside Speck: works on a runtime Speck already runs (the plugin is handed
  // Speck's own), alongside Speck's other workers. The case is one worker.
  static async attach(runtime: SpeckRuntime, config: AppConfig, options: DeskOptions = {}): Promise<EvidenceDesk> {
    const scenario = loadScenario(config.scenarioDir);
    const provider = options.provider ?? createEvidenceProvider(config, options.fetchImpl);
    const reasoner = typeof options.reasoner === "function" ? options.reasoner(runtime)
      : options.reasoner ?? (config.reasoner === "nemotron" ? new NemotronReasoner(runtime, config.nemotron) : new RuleReasoner());
    const desk = new EvidenceDesk(config, runtime, scenario, provider, reasoner);
    await desk.exclusive(async () => {
      await desk.ensureCase();
      // A run interrupted after recording evidence may have left current
      // beliefs behind the ledger. Reconciling is idempotent: on consistent
      // state it changes nothing.
      await desk.reconcile({ correlationId: randomUUID(), trigger: "recovery on open", recovery: true });
    });
    return desk;
  }

  close(): void {
    if (this.ownsRuntime) this.runtime.close();
  }

  // Every change to the case runs here. Speck's background cognition reads
  // a worker's objects, may await (embeddings), then writes whole objects
  // back; a belief revised in between would be overwritten with the stale
  // copy. The foreground lease stops new background jobs, and waiting for a
  // job already running to finish closes the remaining window. Both are
  // Speck's public runtime API.
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const release = this.runtime.beginForegroundWork();
    try {
      while (this.runtime.backgroundScheduler.backgroundActive) await new Promise((resolve) => setImmediate(resolve));
      return await work();
    } finally {
      release();
    }
  }

  get isRunning(): boolean { return this.running; }

  // The case's Speck worker, created with its hypotheses on first use.
  async ensureCase(): Promise<Worker> {
    const existing = this.findWorker();
    if (existing) return this.settleWorker(existing);
    return this.createCaseWorker(1);
  }

  // A fresh copy of the case: a new worker at the first stage, hypotheses at
  // their priors. Generation 1 is the original; a restart makes the next.
  private async createCaseWorker(generation: number): Promise<Worker> {
    const actor: ActorInput = { kind: "user", source: `scenario/${this.scenario.id}` };
    const constraints = generation > 1 ? [...this.caseConstraints(), `${GENERATION_TAG}${generation}`] : this.caseConstraints();
    const worker = await this.runtime.createWorker(this.scenario.question, constraints, actor);
    for (const hypothesis of this.scenario.hypotheses) {
      await this.runtime.proposeHypothesis({
        workerId: worker.id, content: hypothesis.statement, confidence: hypothesis.prior,
        data: { key: hypothesis.key }, actor
      });
    }
    await this.runtime.setWorldState({
      workerId: worker.id, key: STAGE_KEY, value: this.scenario.stages[0]!.id, epistemicStatus: "observed", actor
    });
    return this.settleWorker(this.runtime.workers.require(worker.id));
  }

  // Which copy of the case this desk works on (1 for the original).
  get generation(): number {
    const worker = this.findWorker();
    return worker ? generationOf(worker) : 1;
  }

  // Restarts the demo case from the page, without deleting anything: a fresh
  // copy of the case becomes current, and the previous copy is suspended in
  // Speck with its full history. Only this case's own worker is touched; the
  // evidence source (fixture file or Zetaris) is only ever read. A case still
  // at its starting state is left as it is, so repeating a reset is harmless.
  async restartCase(): Promise<{ restarted: boolean; generation: number; previousGeneration: number | null }> {
    if (this.running) throw new RunInProgressError();
    this.running = true;
    try {
      return await this.exclusive(async () => {
        const previous = this.worker();
        const generation = generationOf(previous);
        if (this.atStart(previous)) return { restarted: false, generation, previousGeneration: null };
        const fresh = await this.createCaseWorker(generation + 1);
        if (this.findWorker()?.id !== fresh.id) throw new Error(`Restart did not take effect: the case's current copy is not generation ${generation + 1}`);
        await this.runtime.transitionWorker(previous.id, "suspended", { kind: "user", source: "evidence-desk/reset" },
          `Demo case restarted: replaced by a fresh copy (generation ${generation + 1})`);
        // The fresh copy has no conclusion: Speck's conversation stops recalling the old one.
        await this.publishToSpeck();
        return { restarted: true, generation: generation + 1, previousGeneration: generation };
      });
    } finally {
      this.running = false;
    }
  }

  // Links the case's memories in Speck's own association graph (Speck's
  // public reinforceAssociation), so Speck's activation and memory map see how
  // they relate:
  // - an assessment is derived-from each evidence record it judged;
  // - an evidence record supports, or contradicts, the conclusion of each run
  //   whose conclusion it bore on;
  // - a correcting record is inhibitory towards the record it replaced, so
  //   recalling the correction suppresses the outdated record.
  // Each link is made once: an existing one is left as it is.
  private async linkCaseMemories(): Promise<void> {
    const worker = this.worker();
    const actor: ActorInput = { kind: "runtime", source: "evidence-desk/links" };
    const evidence = this.recordedEvidence();
    const objects = new Map(this.runtime.mentalObjects.listForWorker(worker.id).map((object) => [object.id as string, object]));
    const link = async (sourceId: string | undefined, targetId: string | undefined, kind: "derived-from" | "supports" | "contradicts" | "inhibitory") => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      if (objects.get(sourceId)?.associations.some((edge) => edge.targetId === targetId && edge.kind === kind)) return;
      const updated = await this.runtime.reinforceAssociation({ workerId: worker.id, sourceId: sourceId as MentalObjectId, targetId: targetId as MentalObjectId, kind, actor });
      objects.set(updated.id, updated);
    };
    for (const object of [...objects.values()]) {
      const data = object.data as { schema?: unknown; judged?: AssessedEvidence[]; conclusion?: Conclusion };
      if (data.schema === ASSESSMENT_SCHEMA) {
        for (const item of data.judged ?? []) await link(object.id, evidence.get(item.record.id), "derived-from");
      }
      if (data.schema === RUN_SCHEMA && data.conclusion) {
        const c = data.conclusion;
        const subject = c.hypothesis ?? c.alternatives?.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
        for (const ref of subject?.supporting ?? []) await link(evidence.get(ref.recordId), object.id, "supports");
        for (const ref of subject?.contradicting ?? []) await link(evidence.get(ref.recordId), object.id, "contradicts");
      }
    }
    for (const entry of this.ledger()) {
      for (const replaced of entry.record.provenance.supersedes) await link(evidence.get(entry.record.id), evidence.get(replaced), "inhibitory");
    }
  }

  // What Speck's own conversation can recall about this case. A case's
  // memories belong to its worker, which Speck's chat does not search; the
  // chat recalls shared memories. So after every change to the case's
  // beliefs, one shared memory states the case's current conclusion and the
  // evidence behind it, read from Speck's state, and the previous one is
  // archived so an outdated conclusion is never recalled. A case with no
  // assessed evidence publishes nothing.
  private async publishToSpeck(): Promise<void> {
    const actor: ActorInput = { kind: "runtime", source: "evidence-desk/summary" };
    for (const object of this.runtime.mentalObjects.listAll()) {
      const tag = object.data.evidenceDeskSummary as { caseId?: unknown } | undefined;
      if (object.workerId === null && object.status !== "archived" && tag?.caseId === this.scenario.caseId) {
        await this.runtime.archiveSharedMemory(object.id, actor);
      }
    }
    if (!this.recordedCount()) return;
    const worker = this.worker();
    await this.runtime.recordSharedMemory({
      type: "semantic", content: this.caseSummary(), sourceWorkerId: worker.id, importance: 0.8, confidence: 1,
      data: { evidenceDeskSummary: { caseId: this.scenario.caseId, generation: generationOf(worker), runNumber: this.runs().at(-1)?.runNumber ?? null } },
      actor
    });
  }

  // The case's current state in plain words, from Speck's beliefs.
  caseSummary(): string {
    const c = this.conclusionFromSpeck();
    const content = new Map(this.ledger().map((entry) => [entry.record.id, entry.record]));
    const quote = (id: string) => {
      const record = content.get(id);
      return record ? `${id} (${record.source.name}): "${record.content.length > 160 ? `${record.content.slice(0, 157)}…` : record.content}"` : id;
    };
    const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
    const lines = [
      `Evidence Desk investigation ${this.scenario.caseId}, "${this.scenario.title}". Question: ${this.scenario.question}`,
      `Current conclusion (after run ${this.runs().at(-1)?.runNumber ?? "?"}, stage "${this.currentStage().label}"): ${c.headline}${c.justification?.confidence !== null && c.justification?.confidence !== undefined ? ` Speck confidence ${c.justification.confidence}, a belief-revision score, not a probability.` : ""}`,
      subject?.supporting.length ? `Evidence supporting ${subject.statement}: ${subject.supporting.map((ref) => quote(ref.recordId)).join("; ")}.` : null,
      subject?.contradicting.length ? `Evidence against it: ${subject.contradicting.map((ref) => quote(ref.recordId)).join("; ")}.` : null,
      c.rejected.length ? `Ruled out: ${c.rejected.map((view) => `${view.statement}${view.contradicting.length ? ` (refuted by ${view.contradicting.map((ref) => ref.recordId).join(", ")})` : ""}`).join("; ")}.` : null,
      c.noLongerCounted.length ? `No longer counts: ${c.noLongerCounted.map((item) => `${item.recordId}, ${item.invalidation.kind === "superseded" ? `replaced by its source with ${item.invalidation.by}` : `withdrawn (${item.invalidation.reason})`}`).join("; ")}.` : null,
      c.openQuestions.length ? `Still open: ${c.openQuestions.map((q) => q.text).join(" ")}` : null
    ];
    return lines.filter(Boolean).join("\n");
  }

  // At its starting state: the first stage, and nothing in Speck but the
  // proposed hypotheses (no evidence, judgments, runs or withdrawals).
  private atStart(worker: Worker): boolean {
    const objects = this.runtime.mentalObjects.listForWorker(worker.id);
    return worker.worldState[STAGE_KEY]?.value === this.scenario.stages[0]!.id
      && objects.length === this.scenario.hypotheses.length
      && objects.every((object) => object.kind === "hypothesis");
  }

  // A case is a worker waiting on evidence, not a task in Speck's queue.
  // Speck counts "created" and "ready" workers as queued, shows them as
  // pending tasks, and skips background cognition for every worker while
  // any is queued, so the case moves on to "waiting" through Speck's own
  // transitions (created -> ready -> waiting).
  private async settleWorker(worker: Worker): Promise<Worker> {
    const actor: ActorInput = { kind: "runtime", source: "evidence-desk/case" };
    let current = worker;
    if (current.status === "created") current = await this.runtime.transitionWorker(current.id, "ready", actor, "Investigation case opened");
    if (current.status === "ready") current = await this.runtime.transitionWorker(current.id, "waiting", actor, "Waiting for evidence");
    return current;
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
    await this.exclusive(() => this.runtime.setWorldState({
      workerId: this.worker().id, key: STAGE_KEY, value: next.id, epistemicStatus: "observed",
      actor: { kind: "user", source: "evidence-desk/update" }
    }));
    return next;
  }

  async listEvidence(): Promise<EvidenceListing> {
    const stage = this.currentStage();
    const visible = await this.visibleEvidence(stage);
    const recorded = this.recordedEvidence();
    const supersededBy = new Map<string, string>();
    for (const record of visible) for (const id of record.provenance.supersedes) supersededBy.set(id, record.id);
    const basis = this.basis();
    const history = this.assessmentHistory();
    const excluded = this.exclusions();
    const runNumbers = new Map(this.runs().map((run) => [run.runId, run.runNumber]));
    const records = visible.map((record) => {
      const attempts = history.get(record.id) ?? [];
      const last = attempts.at(-1) ?? null;
      // The judgments in force are the last ones saved before the record
      // entered the ledger; later attempts only happen while it is pending.
      const judged = [...attempts].reverse().find((attempt) => attempt.item);
      const inLedger = recorded.has(record.id);
      const exclusion = inLedger ? undefined : excluded.get(record.id);
      const status: AssessmentStatus = inLedger ? (judged ? "completed" : "failed") : exclusion ? "withdrawn" : last && !last.item ? "failed" : "pending";
      const assessment = inLedger && judged?.item ? {
        runNumber: runNumbers.get(judged.runId) ?? null, reliability: judged.item.reliability, recordedBy: judged.item.recordedBy,
        appliedReliability: numberOrNull(this.runtime.mentalObjects.get(recorded.get(record.id) as MentalObjectId)?.data.reliability),
        judgments: judged.item.judgments.map((judgment) => {
          const withheld = basis.withheld.find((entry) => entry.recordId === record.id && entry.hypothesisKey === judgment.hypothesisKey);
          const effect: JudgmentEffect = basis.invalid.has(record.id) ? "void" : withheld ? "withheld" : "applied";
          return { ...judgment, effect, refutedBy: withheld?.refutedBy ?? null };
        })
      } : null;
      return {
        ...record, assessed: inLedger, supersededBy: supersededBy.get(record.id) ?? null,
        invalidation: basis.invalid.get(record.id) ?? (exclusion ? { kind: "withdrawn" as const, reason: exclusion.reason, at: exclusion.at } : null),
        assessment,
        status,
        lastAttempt: last ? { runId: last.runId, at: last.at, outcome: last.item ? "judged" as const : "failed" as const, error: last.error ?? (inLedger && !judged ? "in Speck's ledger without saved judgments; it counts for nothing" : null) } : null
      };
    });
    return {
      stage,
      provider: this.provider.describe(),
      records,
      pending: records.filter((record) => record.status === "pending" || record.status === "failed").map((record) => record.id)
    };
  }

  async run(): Promise<RunSnapshot> {
    if (this.running) throw new RunInProgressError();
    this.running = true;
    try {
      return await this.exclusive(async () => {
        const snapshot = await this.execute();
        await this.linkCaseMemories();
        await this.publishToSpeck();
        return snapshot;
      });
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
    if (!evidenceId) return this.excludeRecord(recordId, why);
    // Withdrawing again is a no-op: the first reason stands and nothing is recomputed.
    if (this.runtime.mentalObjects.get(evidenceId as MentalObjectId)?.data.withdrawn) return null;
    this.running = true;
    try {
      const correlationId = randomUUID();
      const { recomputation } = await this.exclusive(async () => {
        await this.runtime.withdrawEvidence({
          workerId: this.worker().id, evidenceId: evidenceId as MentalObjectId, reason: why,
          actor: { kind: "user", source: "evidence-desk/withdraw", correlationId }
        });
        const result = await this.reconcile({ correlationId, trigger: `${recordId} withdrawn: ${why}` });
        await this.linkCaseMemories();
        await this.publishToSpeck();
        return result;
      });
      this.emit("revision", { recordId, recomputation: recomputation?.version ?? null });
      return recomputation;
    } finally {
      this.running = false;
    }
  }

  // Withdrawal of a record that is not in Speck's ledger: pending, or failed.
  // Nothing is judged for it; it is recorded as excluded and future runs skip
  // it. Beliefs cannot change, so nothing is recomputed.
  private async excludeRecord(recordId: string, reason: string): Promise<null> {
    if (this.exclusions().has(recordId)) return null;
    const visible = await this.visibleEvidence(this.currentStage());
    if (!visible.some((record) => record.id === recordId)) {
      throw new WithdrawalError(`${recordId} is not evidence available in this case at stage "${this.currentStage().label}", so there is nothing to withdraw`);
    }
    this.running = true;
    try {
      const exclusion: Exclusion = {
        schema: EXCLUSION_SCHEMA, recordId, reason, at: new Date().toISOString(),
        lastError: this.assessmentHistory().get(recordId)?.at(-1)?.error ?? null
      };
      await this.exclusive(() => this.runtime.recordMemory({
        workerId: this.worker().id, type: "episodic",
        content: `${recordId} withdrawn before assessment: ${reason}`,
        data: exclusion as unknown as Record<string, unknown>,
        // Its own correlation id: Speck otherwise carries the previous
        // event's forward, which would attribute this to the last run.
        actor: { kind: "user", source: "evidence-desk/withdraw", correlationId: randomUUID() }
      }));
      this.emit("revision", { recordId, recomputation: null });
      return null;
    } finally {
      this.running = false;
    }
  }

  // Records withdrawn before assessment, by record id.
  exclusions(): Map<string, Exclusion> {
    return new Map(this.runtime.mentalObjects.listForWorker(this.worker().id)
      .filter((object) => object.data.schema === EXCLUSION_SCHEMA)
      .map((object) => [String(object.data.recordId), object.data as unknown as Exclusion]));
  }

  runs(): RunSnapshot[] {
    return this.runtime.mentalObjects.listForWorker(this.worker().id)
      .filter((object) => object.data.schema === RUN_SCHEMA)
      .map((object) => object.data as unknown as RunSnapshot)
      .sort((left, right) => left.runNumber - right.runNumber);
  }

  // How many records are in Speck's evidence ledger for the case.
  recordedCount(): number {
    return this.recordedEvidence().size;
  }

  // Recomputation records, each with its replacements resolved: the record is
  // written before the replacements are made, so an interruption can leave
  // one not carried out (a later recomputation then redoes it).
  recomputations(): Recomputation[] {
    const objects = this.runtime.mentalObjects.listForWorker(this.worker().id);
    const hypotheses = objects.filter((object) => object.kind === "hypothesis");
    return objects
      .filter((object) => object.data.schema === RECOMPUTE_SCHEMA)
      .map((object) => object.data as unknown as Recomputation)
      .map((record) => ({
        ...record,
        hypotheses: record.hypotheses.map((entry) => {
          if (entry.mode === "extended") return { ...entry, carriedOut: true };
          const replacement = hypotheses.find((object) => object.data.replaces === entry.previousId && object.data.recomputation === record.version);
          // Records written before Build 3.1 name their replacement directly.
          const replacementId = replacement?.id ?? entry.replacementId ?? null;
          return { ...entry, replacementId, carriedOut: replacementId !== null };
        })
      }))
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
    // In the order they were replaced, then by key: creation times can tie.
    })).sort((left, right) => (left.recomputation ?? 0) - (right.recomputation ?? 0) || left.key.localeCompare(right.key));
  }

  hypotheses(): HypothesisView[] {
    const conclusion = this.conclusionFromSpeck();
    return [...(conclusion.hypothesis ? [conclusion.hypothesis] : []), ...conclusion.alternatives, ...conclusion.rejected];
  }

  timeline(): TimelineEntry[] {
    return buildTimeline({
      events: this.allEvents(),
      objects: this.runtime.mentalObjects.listForWorker(this.worker().id),
      scenario: this.scenario,
      runs: this.runs()
    });
  }

  // What each component did in each run, and in actions between runs, read
  // back from persisted state (see trace.ts).
  trace(): TraceEntry[] {
    return buildTrace({
      events: this.allEvents(),
      objects: this.runtime.mentalObjects.listForWorker(this.worker().id),
      runs: this.runs(),
      recomputations: this.recomputations(),
      engine: `${MARKOVIAN_ENGINE.name} ${MARKOVIAN_ENGINE.package}, upstream commit ${MARKOVIAN_ENGINE.commit.slice(0, 7)}, ${MARKOVIAN_ENGINE.vendored}`,
      meterlessHistory: this.meterlessHistory()
    });
  }

  // Run ids in the Meterless engine's own history file, or null if it cannot
  // be read (for example, a fresh history directory).
  private meterlessHistory(): EngineHistoryEntry[] | null {
    return readEngineHistory(path.join(this.config.historyDir, "history.json"));
  }

  private allEvents(): CognitiveEvent[] {
    const workerId = this.worker().id;
    const events: CognitiveEvent[] = [];
    let after = 0;
    for (;;) {
      const page = this.runtime.listEvents(workerId, after, 1000);
      events.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.sequence;
    }
    return events;
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
    const reflection: { explanation: RunSnapshot["explanation"]; call: ModelCallTrace | null } = { explanation: null, call: null };

    // Evidence access failures end the run here, visibly. Nothing is
    // substituted for the missing data.
    const visible = await this.visibleEvidence(stage);
    const fetched = this.provider.lastFetch?.() ?? null;
    const retrieval = fetched ? { ...fetched, visible: visible.length } : null;
    const recorded = this.recordedEvidence();
    const excluded = this.exclusions();
    const pending = visible.filter((record) => !recorded.has(record.id) && !excluded.has(record.id));
    const batches = chunk(pending, this.config.execution.batchSize);
    // Runs interrupted before saving a snapshot: their judgments were saved
    // per chunk, so they are recovered here, and said so.
    const recovered = this.interruptedRuns();
    if (recovered.length) {
      const judged = recovered.flatMap((item) => item.recorded);
      notes.push(`Recovered ${recovered.length} interrupted run(s) (${recovered.map((item) => item.runId.slice(0, 8)).join(", ")}): `
        + `${judged.length ? `the saved judgments for ${judged.join(", ")} were kept and beliefs reconciled with them` : "no evidence had entered the ledger"}`
        + `${recovered.some((item) => item.unrecorded.length) ? `; not yet in the ledger, so assessed again: ${recovered.flatMap((item) => item.unrecorded).join(", ")}` : ""}.`);
    }
    await this.reconcile({ correlationId: runId, trigger: "start of run", recovery: true });

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
        const ledgerRecords = this.ledger(assessed).map((entry) => entry.record).sort(byObservation);
        let result: Explanation;
        try {
          result = await this.reasoner.explain(explanationPrompt(prompt, conclusion, ledgerRecords, this.basis(assessed).invalid));
        } finally {
          reflection.call = this.reasoner.takeTrace?.() ?? null;
        }
        const known = new Set(ledgerRecords.map((record) => record.id));
        const invalidCitations = result.citedEvidence.filter((id) => !known.has(id));
        reflection.explanation = { ...result, invalidCitations, agreement: checkAgreement(result, invalidCitations, this.conclusionFromSpeck(assessed)) };
        return { text: result.text };
      }
      const batch = batches[next] ?? [];
      const chunkNumber = next + 1;
      next += 1;
      if (!batch.length) return { text: "No new evidence since the last run; belief state unchanged.\n[TASK_COMPLETE]" };
      let assessment: Awaited<ReturnType<Reasoner["assess"]>>;
      try {
        assessment = await this.reasoner.assess({ chunkPrompt: prompt, batch, hypotheses: this.scenario.hypotheses });
      } catch (error) {
        // Saved so the records show as failed, not merely pending, until a
        // later run assesses them.
        const message = error instanceof Error ? error.message : String(error);
        await this.saveAssessment({
          schema: ASSESSMENT_SCHEMA, runId, at: new Date().toISOString(), judged: [], failed: batch.map((record) => ({ record, error: message })),
          chunk: chunkNumber, model: this.reasoner.takeTrace?.() ?? null, notes: []
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
        const reliability = this.scenario.sources[record.source.system]?.reliability;
        if (reliability === undefined) notes.push(`Source "${record.source.system}" has no reliability in the scenario; ${record.id} was weighted 0.5.`);
        const recordedBy = judgments.some((judgment) => judgment.basis === "model") ? "model" as const : "rules" as const;
        judged.push({ record, reliability: reliability ?? 0.5, judgments, recordedBy });
      }
      // The judgments are saved before any of this chunk's evidence enters
      // Speck's ledger. If the run dies after that, nothing recorded lacks
      // its judgments; a record saved but not yet recorded is reassessed.
      await this.saveAssessment({
        schema: ASSESSMENT_SCHEMA, runId, at: new Date().toISOString(), judged, failed,
        chunk: chunkNumber, model: this.reasoner.takeTrace?.() ?? null, notes: assessment.notes
      });
      const recordedNow = new Set<string>();
      for (const { record, reliability, judgments, recordedBy } of judged) {
        // The evidence enters Speck's ledger without relations; reconcile()
        // applies the ones that take effect. A record with any model judgment
        // is recorded as the model's, so Speck caps its reliability
        // (beliefRevision.modelReliabilityCeiling) for every relation it
        // carries, including one withheld now and applied later.
        await this.runtime.recordEvidence({
          workerId: worker.id,
          content: `[${record.id}] ${record.content}`,
          source: `${record.source.system}/${record.id}`,
          reliability,
          relations: [],
          actor: recordedBy === "model"
            ? { kind: "model", source: `nemotron/${this.reasoner.describe().model}`, correlationId: runId }
            : { kind: "tool", source: "evidence-desk/fact-rules", correlationId: runId }
        });
        assessed.push({ record, reliability, judgments, recordedBy });
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
    // A failure inside a chunk (for example while reconciling) leaves beliefs
    // behind the ledger; try once more so the snapshot describes reconciled
    // state, and say so if that fails too.
    if (!this.beliefsReconciled()) {
      try {
        await this.reconcile({ correlationId: runId, trigger: "end of run", recovery: true });
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
      evidence: this.provider.describe(),
      reasoner: this.reasoner.describe(),
      reasonerUsage: this.reasoner.usage(),
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
      conclusion: this.conclusionFromSpeck(assessed),
      explanation,
      retrieval,
      explanationCall: reflection.call
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
    const ledger = this.ledger(inFlight);
    // Every record in Speck's ledger, including any from a run interrupted
    // before its snapshot was saved.
    const records = ledger.map((entry) => entry.record).sort(byObservation);
    const byRecordId = new Map(ledger.map((entry) => [entry.record.id, entry]));
    const objectToRecord = new Map<string, string>();
    for (const [recordId, objectId] of this.recordedEvidence()) objectToRecord.set(objectId, recordId);
    const { supportedThreshold, supportBonus, modelReliabilityCeiling } = this.runtime.config.beliefRevision;
    const conclusion = deriveConclusion({
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
      invalidated: deriveBasis(ledger, this.scenario.hypotheses.map((hypothesis) => hypothesis.key)).invalid,
      judgmentsFor: (recordId) => byRecordId.get(recordId)?.judgments ?? []
    });
    // Never present beliefs that lag the ledger as if they were current.
    if (!this.beliefsReconciled(inFlight)) {
      conclusion.reconciled = false;
      conclusion.uncertainty.notes.unshift("Speck's current beliefs do not yet reflect every recorded judgment (a run or recomputation was interrupted). They are reconciled when the desk is next opened or run.");
    }
    return conclusion;
  }

  // Makes Speck's current hypotheses equal a replay of the evidence and
  // judgments that still count (basis.ts). A hypothesis whose applied
  // relations are the start of its plan is extended. Any other is replaced:
  // a new hypothesis from the scenario prior, the whole plan replayed through
  // Speck's own revision, and the old one marked superseded. On consistent
  // state it does nothing.
  private async reconcile(input: {
    correlationId: string; trigger: string; inFlight?: readonly AssessedEvidence[]; newRecords?: ReadonlySet<string>;
    // Repairing state left by an interruption rather than responding to a change.
    recovery?: boolean;
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

    // Hypotheses extended with relations from records that were already in
    // the ledger: reinstated by an invalidation, or left unapplied by an
    // interrupted run. Unlike new evidence, these need explaining.
    const newRecords = input.newRecords ?? new Set<string>();
    const extended = this.scenario.hypotheses.flatMap((spec) => {
      if (!startAt.has(spec.key)) return [];
      const tail = basis.plan.get(spec.key)!.slice(startAt.get(spec.key));
      return tail.some((relation) => !newRecords.has(relation.recordId))
        ? [{ key: spec.key, hypothesis: current.get(spec.key)!, tail: tail.filter((relation) => !newRecords.has(relation.recordId)) }]
        : [];
    });

    const hypothesisIds = new Map([...current].map(([key, object]) => [key, object.id]));
    let recomputation: Recomputation | null = null;
    if (replace.length || extended.length) {
      const actor: ActorInput = { kind: "tool", source: "evidence-desk/recompute", correlationId: input.correlationId };
      const version = this.recomputations().length + 1;
      const entries: Recomputation["hypotheses"] = [];
      for (const item of replace) entries.push(describeReplacement(item, basis, newRecords, input.recovery === true));
      for (const item of extended) {
        const added = item.tail.map((relation) => ({ recordId: relation.recordId, direction: relation.direction, reinstated: input.recovery !== true }));
        entries.push({
          key: item.key, mode: "extended", previousId: item.hypothesis.id, replacementId: item.hypothesis.id,
          previous: { confidence: round(item.hypothesis.confidence), status: String(item.hypothesis.data.status) },
          dropped: [], added, replayed: added.map((relation) => `${relation.recordId} ${relation.direction}`),
          cause: input.recovery ? `${added.map((relation) => relation.recordId).join(", ")} applied after an interrupted run or recomputation`
            : `${[...new Set(added.map((relation) => relation.recordId))].join(", ")} count${added.length === 1 ? "s" : ""} again`
        });
      }
      recomputation = {
        schema: RECOMPUTE_SCHEMA, version, at: new Date().toISOString(), correlationId: input.correlationId,
        trigger: input.trigger, hypotheses: entries
      };
      // The record is written before anything changes, so every replacement
      // points at a record that explains it, and its version is never reused.
      // If the process stops before a replacement is made, a later
      // recomputation makes it and recomputations() shows this one as not
      // carried out.
      await this.runtime.recordMemory({
        workerId, type: "episodic",
        content: `Recomputation ${version}: ${entries.map((entry) => `${entry.key} (${entry.cause})`).join("; ")}`,
        data: recomputation as unknown as Record<string, unknown>, actor
      });
      for (const item of replace) {
        const replacement = await this.runtime.proposeHypothesis({
          workerId, content: item.statement, confidence: item.prior,
          data: { key: item.key, replaces: item.previous.id, recomputation: version }, actor
        });
        hypothesisIds.set(item.key, replacement.id);
        startAt.set(item.key, 0);
      }
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
      retireHypothesis(this.runtime, object.id, replacement?.id ?? null, now);
    }
  }

  private basis(inFlight: readonly AssessedEvidence[] = []): BeliefBasis {
    return deriveBasis(this.ledger(inFlight), this.scenario.hypotheses.map((hypothesis) => hypothesis.key));
  }

  // Every record in Speck's evidence ledger for the case, with the judgments
  // saved for it and whether it has been withdrawn. A record in the ledger
  // with no saved judgments (possible only in a database written before
  // judgments were saved per chunk) counts for nothing; the listing marks it
  // failed rather than letting it pass as "no bearing".
  private ledger(inFlight: readonly AssessedEvidence[] = []): LedgerEntry[] {
    const history = this.assessmentHistory();
    const inFlightById = new Map(inFlight.map((item) => [item.record.id, item]));
    const entries: LedgerEntry[] = [];
    for (const object of this.runtime.mentalObjects.listForWorker(this.worker().id)) {
      if (object.kind !== "evidence") continue;
      const recordId = recordIdOf(object);
      const item = inFlightById.get(recordId) ?? [...(history.get(recordId) ?? [])].reverse().find((attempt) => attempt.item)?.item;
      if (!item) continue;
      const marker = object.data.withdrawn as { reason?: unknown; at?: unknown } | undefined;
      entries.push({
        record: item.record, judgments: item.judgments,
        withdrawn: marker ? { reason: String(marker.reason ?? ""), at: String(marker.at ?? "") } : null
      });
    }
    return entries;
  }

  private async saveAssessment(attempt: AssessmentAttempt): Promise<void> {
    await this.runtime.recordMemory({
      workerId: this.worker().id, type: "episodic",
      content: `Assessment in run ${attempt.runId.slice(0, 8)}: judged ${attempt.judged.map((item) => item.record.id).join(", ") || "none"}`
        + (attempt.failed.length ? `; failed ${attempt.failed.map((item) => item.record.id).join(", ")}` : ""),
      data: attempt as unknown as Record<string, unknown>,
      actor: { kind: "tool", source: "evidence-desk/assessment", correlationId: attempt.runId }
    });
  }

  // Record id -> every attempt to assess it, oldest first: the per-chunk
  // assessments saved in Speck, and the run snapshots of runs that predate
  // them.
  private assessmentHistory(): Map<string, Array<{ runId: string; at: string; item: AssessedEvidence | null; error: string | null }>> {
    const objects = this.runtime.mentalObjects.listForWorker(this.worker().id);
    const attempts = objects.filter((object) => object.data.schema === ASSESSMENT_SCHEMA).map((object) => object.data as unknown as AssessmentAttempt);
    const covered = new Set(attempts.map((attempt) => attempt.runId));
    const legacy = this.runs().filter((run) => !covered.has(run.runId))
      .map((run): AssessmentAttempt => ({ schema: ASSESSMENT_SCHEMA, runId: run.runId, at: run.finishedAt, judged: run.assessed, failed: [] }));
    const history = new Map<string, Array<{ runId: string; at: string; item: AssessedEvidence | null; error: string | null }>>();
    const add = (recordId: string, entry: { runId: string; at: string; item: AssessedEvidence | null; error: string | null }) => {
      history.set(recordId, [...(history.get(recordId) ?? []), entry]);
    };
    for (const attempt of [...legacy, ...attempts].sort((left, right) => left.at.localeCompare(right.at))) {
      for (const item of attempt.judged) add(item.record.id, { runId: attempt.runId, at: attempt.at, item, error: null });
      for (const item of attempt.failed) add(item.record.id, { runId: attempt.runId, at: attempt.at, item: null, error: item.error });
    }
    return history;
  }

  // Runs that saved assessments but no snapshot (the process stopped first),
  // and not yet reported by a later run: which of their records entered the
  // ledger and which did not.
  private interruptedRuns(): Array<{ runId: string; recorded: string[]; unrecorded: string[] }> {
    const runs = this.runs();
    const finished = new Set(runs.map((run) => run.runId));
    const reported = new Set(runs.flatMap((run) => run.recovered ?? []));
    const recorded = this.recordedEvidence();
    const byRun = new Map<string, Set<string>>();
    for (const object of this.runtime.mentalObjects.listForWorker(this.worker().id)) {
      if (object.data.schema !== ASSESSMENT_SCHEMA) continue;
      const attempt = object.data as unknown as AssessmentAttempt;
      if (finished.has(attempt.runId) || reported.has(attempt.runId)) continue;
      const ids = byRun.get(attempt.runId) ?? new Set<string>();
      for (const item of attempt.judged) ids.add(item.record.id);
      byRun.set(attempt.runId, ids);
    }
    return [...byRun].map(([runId, ids]) => ({
      runId, recorded: [...ids].filter((id) => recorded.has(id)), unrecorded: [...ids].filter((id) => !recorded.has(id))
    }));
  }

  // Whether every current hypothesis carries exactly the relations its plan
  // calls for: false after an interrupted or failed reconciliation.
  beliefsReconciled(inFlight: readonly AssessedEvidence[] = []): boolean {
    const basis = this.basis(inFlight);
    const recordOf = new Map([...this.recordedEvidence()].map(([recordId, objectId]) => [objectId, recordId]));
    return [...this.currentHypotheses()].every(([key, hypothesis]) => {
      const applied = appliedRelations(hypothesis, recordOf);
      const plan = basis.plan.get(key) ?? [];
      return applied.length === plan.length && isPrefix(applied, plan);
    });
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
      if (object.kind === "evidence") recorded.set(recordIdOf(object), object.id);
    }
    return recorded;
  }

  // The case's current copy: the latest generation of its workers.
  private findWorker(): Worker | undefined {
    const constraints = this.caseConstraints();
    return this.runtime.listWorkers()
      .filter((worker) => constraints.every((constraint) => worker.objective.constraints.includes(constraint)))
      .sort((left, right) => generationOf(right) - generationOf(left))[0];
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

interface AppliedRelation { recordId: string; direction: string }

// Copies of a case after a restart carry "evidence-desk:generation=<n>".
const GENERATION_TAG = "evidence-desk:generation=";
function generationOf(worker: Worker): number {
  const tag = worker.objective.constraints.find((constraint) => constraint.startsWith(GENERATION_TAG));
  const value = tag ? Number(tag.slice(GENERATION_TAG.length)) : 1;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The evidence record a Speck evidence object was recorded for.
// Evidence is recorded with source "<system>/<record id>". A system name has
// no "/", but a record id may (ids derived from a source's own references, as
// the Zetaris USL makes them), so the id is everything after the first "/".
function recordIdOf(object: MentalObject): string {
  const source = String(object.data.source ?? "");
  return source.slice(source.indexOf("/") + 1);
}

// The relations Speck has applied to a hypothesis, in order, from its own
// revision history.
function appliedRelations(hypothesis: MentalObject, recordOf: ReadonlyMap<string, string>): AppliedRelation[] {
  const history = Array.isArray(hypothesis.data.revisionHistory) ? hypothesis.data.revisionHistory as Array<{ evidenceId?: string; direction?: string }> : [];
  return history.map((entry) => ({ recordId: recordOf.get(String(entry.evidenceId)) ?? `unknown:${entry.evidenceId}`, direction: String(entry.direction) }));
}

function describeReplacement(
  item: { key: string; previous: MentalObject; applied: AppliedRelation[] },
  basis: BeliefBasis,
  newRecords: ReadonlySet<string>,
  recovery: boolean
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
    .map((planned) => ({ recordId: planned.recordId, direction: planned.direction, reinstated: !recovery && !newRecords.has(planned.recordId) }));
  const reinstated = added.filter((entry) => entry.reinstated);
  const cause = dropped.length ? dropped.map((entry) => entry.reason).join("; ")
    : reinstated.length ? `${reinstated.map((entry) => entry.recordId).join(", ")} count${reinstated.length === 1 ? "s" : ""} again`
    : recovery ? "applied after an interrupted run or recomputation"
    : "evidence observed earlier arrived later; replayed in observation order";
  return {
    key: item.key, mode: "replaced", previousId: item.previous.id, replacementId: null,
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
    notes.push(entry.mode === "extended"
      ? `Revised ${entry.key} (was ${entry.previous.status} ${entry.previous.confidence}): ${entry.cause}.`
      : `Recomputed ${entry.key} from its prior (was ${entry.previous.status} ${entry.previous.confidence}): ${entry.cause}.`);
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
