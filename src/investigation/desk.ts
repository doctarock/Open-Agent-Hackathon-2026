import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SpeckRuntime, type ActorInput, type MentalObject, type MentalObjectId, type Worker, type WorkerId } from "#speck";
import type { AppConfig, CaseConfig, ConclusionRule } from "../config.js";
import { createEvidenceProvider } from "../evidence/provider.js";
import { byObservation, type EvidenceFetch, type EvidenceProvider } from "../evidence/types.js";
import { NemotronReasoner } from "../reasoning/nemotron.js";
import { RuleReasoner } from "../reasoning/rules.js";
import type { Reasoner } from "../reasoning/types.js";
import { loadScenario, type Scenario, type StageSpec } from "../scenario.js";
import { CaseState, GENERATION_TAG, generationOf } from "./case-state.js";
import type { Conclusion, HypothesisView } from "./conclusion.js";
import { caseSummary, linkCaseMemories, publishToSpeck } from "./publish.js";
import { reconcile } from "./reconcile.js";
import {
  EXCLUSION_SCHEMA, MARKOVIAN_ENGINE, RunInProgressError, STAGE_KEY, WithdrawalError,
  type AssessedEvidence, type EvidenceListing, type Exclusion, type Recomputation, type ReplacedHypothesis, type RunSnapshot
} from "./records.js";
import { executeRun } from "./run.js";
import type { TimelineEntry } from "./timeline.js";
import { buildTrace, readEngineHistory, type TraceEntry } from "./trace.js";

// The desk is split by job: records.ts (what is kept in Speck, and the
// errors), case-state.ts (reading the case), reconcile.ts (bringing beliefs
// in line with the evidence that counts), run.ts (an investigation run) and
// publish.ts (what Speck's memory and chat see). These are re-exported here
// so callers keep importing from desk.js.
export * from "./records.js";
export { CaseState } from "./case-state.js";
export { checkAgreement } from "./run.js";

export interface DeskOptions {
  provider?: EvidenceProvider;
  reasoner?: Reasoner | ((runtime: SpeckRuntime) => Reasoner);
  fetchImpl?: typeof fetch;
}

// One investigation desk over one scenario. Speck holds all state: the case
// is a Speck worker, the candidate explanations are its hypotheses, every
// assessed record is evidence in its ledger, the released evidence stage is
// world state, and each run's outcome is an episodic memory. Reopening the
// database resumes exactly where the last process left off.
//
// Why it is built this way:
// - One Speck worker per case. Speck's own views (task queue, world view,
//   memory map, event log, chat) then show the case with no special support,
//   beside Speck's other work, and Speck's background cognition runs over it
//   like any other worker.
// - The same desk inside Speck and standalone. attach() works on the runtime
//   Speck hands the plugin; open() makes its own for the standalone server,
//   tests, the evaluation and the comparison. Every path runs the same code.
// - Nothing is deleted. A reset makes a fresh copy of the case (a new
//   generation) and suspends the old one with its full history; a person's
//   own investigation, when deleted, is suspended and its files moved aside.
//   An investigation's record is what an audit needs, so it is never erased.
// - Changes never overlap. Every operation that changes the case goes through
//   change(): one at a time, under Speck's foreground lease.
export class EvidenceDesk extends EventEmitter {
  // The change to the case in progress, if any. Set synchronously on entry
  // (change()), so no two changes overlap: Speck's foreground lease only
  // keeps background jobs out, it does not order foreground work.
  private busy: { kind: "run" | "change"; label: string } | null = null;
  // Whether this desk opened the Speck runtime (standalone) or was handed
  // one (the Speck plugin), and so whether it may close it.
  // Why: inside Speck, closing the runtime would stop Speck itself.
  private ownsRuntime = false;

  private constructor(
    readonly config: CaseConfig,
    readonly runtime: SpeckRuntime,
    readonly scenario: Scenario,
    readonly provider: EvidenceProvider,
    readonly reasoner: Reasoner
  ) {
    super();
  }

  // Standalone: opens its own Speck runtime on config.databasePath.
  static async open(config: CaseConfig & Pick<AppConfig, "databasePath">, options: DeskOptions = {}): Promise<EvidenceDesk> {
    const runtime = new SpeckRuntime({ databasePath: config.databasePath });
    await runtime.initialize();
    const desk = await EvidenceDesk.attach(runtime, config, options);
    desk.ownsRuntime = true;
    return desk;
  }

  // Inside Speck: works on a runtime Speck already runs (the plugin is handed
  // Speck's own), alongside Speck's other workers. The case is one worker.
  static async attach(runtime: SpeckRuntime, config: CaseConfig, options: DeskOptions = {}): Promise<EvidenceDesk> {
    const scenario = loadScenario(config.scenarioDir);
    const provider = options.provider ?? createEvidenceProvider(config, options.fetchImpl);
    const reasoner = typeof options.reasoner === "function" ? options.reasoner(runtime)
      : options.reasoner ?? (config.reasoner === "nemotron" ? new NemotronReasoner(runtime, config.nemotron, nemotronOptions(config)) : new RuleReasoner());
    const desk = new EvidenceDesk(config, runtime, scenario, provider, reasoner);
    await desk.exclusive(async () => {
      await desk.ensureCase();
      // A run interrupted after recording evidence may have left current
      // beliefs behind the ledger. Reconciling is idempotent: on consistent
      // state it changes nothing.
      // Why on open: recovery should not depend on someone pressing Run. The
      // first thing any process does with a case is make its beliefs match
      // its evidence.
      await reconcile(desk, { correlationId: randomUUID(), trigger: "recovery on open", recovery: true });
    });
    return desk;
  }

  close(): void {
    if (this.ownsRuntime) this.runtime.close();
  }

  // Every change to the case runs under Speck's foreground lease
  // (withForegroundLease).
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    return withForegroundLease(this.runtime, work);
  }

  // Every operation that changes the case: refused while another is in
  // progress, then run under the foreground lease.
  // Why refuse rather than queue: a second click on Run, or an update pressed
  // during a run, is usually a repeated click; refusing with HTTP 409 tells the
  // person, where a queue would silently do the work twice.
  private async change<T>(kind: "run" | "change", label: string, work: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new RunInProgressError(this.busy.kind === "run" ? undefined : `${this.busy.label} is in progress; wait for it to finish`);
    }
    this.busy = { kind, label };
    try {
      return await this.exclusive(work);
    } finally {
      this.busy = null;
    }
  }

  // Whether an investigation run is in progress.
  get isRunning(): boolean { return this.busy?.kind === "run"; }

  // The case's state in Speck as it is now. A snapshot: read again after a
  // change. Read once to show several views that must agree.
  read(): CaseState {
    return new CaseState(this.runtime, this.scenario, this.worker(), this.config.conclusionRule);
  }

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
  // Speck with its full history.
  // Why a copy: a judge can replay the demo from the start as often as they
  // like, and every earlier attempt is still in Speck to inspect. Only this case's own worker is touched; the
  // evidence source (fixture file or Zetaris) is only ever read. A case still
  // at its starting state is left as it is, so repeating a reset is harmless.
  async restartCase(): Promise<{ restarted: boolean; generation: number; previousGeneration: number | null }> {
    return this.change("change", "A restart of the case", async () => {
      const state = this.read();
      const previous = state.worker;
      const generation = generationOf(previous);
      if (state.atStart()) return { restarted: false, generation, previousGeneration: null };
      const fresh = await this.createCaseWorker(generation + 1);
      if (this.findWorker()?.id !== fresh.id) throw new Error(`Restart did not take effect: the case's current copy is not generation ${generation + 1}`);
      await this.runtime.transitionWorker(previous.id, "suspended", { kind: "user", source: "evidence-desk/reset" },
        `Demo case restarted: replaced by a fresh copy (generation ${generation + 1})`);
      // The fresh copy has no conclusion: Speck's conversation stops recalling the old one.
      await publishToSpeck(this);
      return { restarted: true, generation: generation + 1, previousGeneration: generation };
    });
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
    return this.read().currentStage();
  }

  nextStage(): StageSpec | null {
    return this.read().nextStage();
  }

  // Releases the next prepared evidence update. Persisted in Speck, so the
  // next run (in this process or a later one) sees it.
  // Why updates are released by hand: the demo is about what happens when a
  // correction arrives after a conclusion was reached. Releasing it as a
  // separate step makes "before" and "after" two distinct runs to compare.
  async introduceNextUpdate(): Promise<StageSpec> {
    return this.change("change", "An evidence update", async () => {
      const next = this.nextStage();
      if (!next) throw new Error("There is no further prepared evidence update for this case");
      await this.runtime.setWorldState({
        workerId: this.worker().id, key: STAGE_KEY, value: next.id, epistemicStatus: "observed",
        actor: { kind: "user", source: "evidence-desk/update" }
      });
      return next;
    });
  }

  async listEvidence(): Promise<EvidenceListing> {
    const stage = this.currentStage();
    const { records: visible } = await this.visibleEvidence(stage);
    // Read after the fetch, so the listing describes the case as it is now.
    return { stage, provider: this.provider.describe(), ...this.read().listing(visible) };
  }

  async run(): Promise<RunSnapshot> {
    return this.change("run", "An investigation run", async () => {
      const snapshot = await executeRun(this);
      await linkCaseMemories(this);
      await publishToSpeck(this);
      return snapshot;
    });
  }

  // Withdraws an assessed record from the case (for example, it belongs to a
  // different case). Speck archives it; current beliefs are then recomputed
  // without it, and what it contributed before stays in the history.
  // Why a reason is required: a withdrawal changes what the case concludes,
  // so the audit trail must say who removed what, and why.
  async withdrawRecord(recordId: string, reason: string): Promise<Recomputation | null> {
    const why = reason.trim();
    if (!why) throw new WithdrawalError("A reason is required to withdraw evidence");
    return this.change("change", "A withdrawal", async () => {
      const state = this.read();
      const evidenceId = state.recordedEvidence().get(recordId);
      if (!evidenceId) return this.excludeRecord(state, recordId, why);
      // Withdrawing again is a no-op: the first reason stands and nothing is recomputed.
      if (state.object(evidenceId)?.data.withdrawn) return null;
      const correlationId = randomUUID();
      await this.runtime.withdrawEvidence({
        workerId: state.worker.id, evidenceId: evidenceId as MentalObjectId, reason: why,
        actor: { kind: "user", source: "evidence-desk/withdraw", correlationId }
      });
      const { recomputation } = await reconcile(this, { correlationId, trigger: `${recordId} withdrawn: ${why}` });
      await linkCaseMemories(this);
      await publishToSpeck(this);
      this.emit("revision", { recordId, recomputation: recomputation?.version ?? null });
      return recomputation;
    });
  }

  // Withdrawal of a record that is not in Speck's ledger: pending, or failed.
  // Nothing is judged for it; it is recorded as excluded and future runs skip
  // it. Beliefs cannot change, so nothing is recomputed.
  private async excludeRecord(state: CaseState, recordId: string, reason: string): Promise<null> {
    if (state.exclusions().has(recordId)) return null;
    const stage = state.currentStage();
    const { records: visible } = await this.visibleEvidence(stage);
    if (!visible.some((record) => record.id === recordId)) {
      throw new WithdrawalError(`${recordId} is not evidence available in this case at stage "${stage.label}", so there is nothing to withdraw`);
    }
    const exclusion: Exclusion = {
      schema: EXCLUSION_SCHEMA, recordId, reason, at: new Date().toISOString(),
      lastError: state.assessmentHistory().get(recordId)?.at(-1)?.error ?? null
    };
    await this.runtime.recordMemory({
      workerId: state.worker.id, type: "episodic",
      content: `${recordId} withdrawn before assessment: ${reason}`,
      data: exclusion as unknown as Record<string, unknown>,
      // Its own correlation id: Speck otherwise carries the previous
      // event's forward, which would attribute this to the last run.
      actor: { kind: "user", source: "evidence-desk/withdraw", correlationId: randomUUID() }
    });
    this.emit("revision", { recordId, recomputation: null });
    return null;
  }

  // Reads of the case as it is now. Each takes a fresh snapshot (read());
  // to show several views together, read once and use the snapshot.
  // Why these remain on the desk: tests, the evaluation and the scripts ask
  // one question at a time, and the desk is the one object they all hold.

  exclusions(): Map<string, Exclusion> { return this.read().exclusions(); }

  runs(): RunSnapshot[] { return this.read().runs(); }

  recordedCount(): number { return this.read().recordedCount(); }

  recomputations(): Recomputation[] { return this.read().recomputations(); }

  currentHypotheses(): Map<string, MentalObject> { return this.read().currentHypotheses(); }

  replacedHypotheses(): ReplacedHypothesis[] { return this.read().replacedHypotheses(); }

  hypotheses(): HypothesisView[] { return this.read().hypotheses(); }

  conclusionFromSpeck(inFlight: readonly AssessedEvidence[] = [], rule?: ConclusionRule): Conclusion { return this.read().conclusion(inFlight, rule); }

  beliefsReconciled(inFlight: readonly AssessedEvidence[] = []): boolean { return this.read().beliefsReconciled(inFlight); }

  caseSummary(): string { return caseSummary(this.read()); }

  timeline(state = this.read()): TimelineEntry[] { return state.timeline(); }

  // What each component did in each run, and in actions between runs, read
  // back from persisted state (see trace.ts).
  trace(state = this.read()): TraceEntry[] {
    return buildTrace({
      events: state.events(),
      objects: [...state.objects],
      runs: state.runs(),
      recomputations: state.recomputations(),
      engine: `${MARKOVIAN_ENGINE.name} ${MARKOVIAN_ENGINE.package}, upstream commit ${MARKOVIAN_ENGINE.commit.slice(0, 7)}, ${MARKOVIAN_ENGINE.vendored}`,
      // Run ids in the Meterless engine's own history file, or null if it
      // cannot be read (for example, a fresh history directory).
      meterlessHistory: readEngineHistory(path.join(this.config.historyDir, "history.json"))
    });
  }

  // The evidence visible at a stage, with what the fetch did.
  // Why it is fetched every time rather than cached: the evidence source is
  // the system of record. A live Zetaris case shows what Zetaris returns now,
  // and the fetch's own summary (each SELECT, its query token) goes with the
  // records into the trace.
  async visibleEvidence(stage: StageSpec): Promise<EvidenceFetch> {
    const cutoff = Date.parse(stage.asOf);
    const { records, summary } = await this.provider.fetchCaseEvidence(this.scenario.caseId);
    return { records: records.filter((record) => Date.parse(record.observedAt) <= cutoff).sort(byObservation), summary };
  }

  // The case's current copy: the latest generation of its workers.
  // Why workers are found by their constraints: the case's identity is stored
  // on the Speck worker itself, so any process that opens the database finds
  // the case without a separate index.
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
    return caseConstraints(this.scenario);
  }
}

function caseConstraints(scenario: Pick<Scenario, "id" | "caseId">): string[] {
  return [`evidence-desk:case=${scenario.caseId}`, `evidence-desk:scenario=${scenario.id}`];
}

// Takes a deleted case out of Speck's work without erasing it: every copy of
// its worker is suspended with its full history (as a reset does to the copy
// it replaces), and its published summary is archived, so Speck's queue and
// chat stop offering it. Works whether or not the case was ever opened.
export async function retireCase(runtime: SpeckRuntime, scenario: Pick<Scenario, "id" | "caseId">, reason: string): Promise<{ suspended: string[] }> {
  const actor: ActorInput = { kind: "user", source: "evidence-desk/delete" };
  const constraints = caseConstraints(scenario);
  return withForegroundLease(runtime, async () => {
    const workers = runtime.listWorkers().filter((worker) => constraints.every((constraint) => worker.objective.constraints.includes(constraint)));
    const suspended: string[] = [];
    for (const worker of workers) {
      if (worker.status === "suspended") continue;
      // A completed worker can only reopen; it is reopened, then suspended.
      if (worker.status === "completed") await runtime.transitionWorker(worker.id, "ready", actor, reason);
      await runtime.transitionWorker(worker.id, "suspended", actor, reason);
      suspended.push(worker.id);
    }
    const ids = new Set(workers.map((worker) => worker.id as string));
    for (const object of runtime.mentalObjects.listAll()) {
      const tag = object.data.evidenceDeskSummary as { caseId?: unknown } | undefined;
      const source = (object.data.sharedMemory as { sourceWorkerId?: string | null } | undefined)?.sourceWorkerId;
      if (object.workerId === null && object.status !== "archived" && tag?.caseId === scenario.caseId && (!source || ids.has(source))) {
        await runtime.archiveSharedMemory(object.id, actor);
      }
    }
    return { suspended };
  });
}

// Speck's background cognition reads a worker's objects, may await
// (embeddings), then writes whole objects back; a belief revised in between
// would be overwritten with the stale copy. The foreground lease stops new
// background jobs, and waiting for a job already running to finish closes the
// remaining window. Both are Speck's public runtime API.
async function withForegroundLease<T>(runtime: SpeckRuntime, work: () => Promise<T>): Promise<T> {
  const release = runtime.beginForegroundWork();
  try {
    while (runtime.backgroundScheduler.backgroundActive) await new Promise((resolve) => setImmediate(resolve));
    return await work();
  } finally {
    release();
  }
}

// The model is asked whether each judgment establishes its explanation only
// when rule corroborated-2 reads it; otherwise its prompt is Build 4's.
export function nemotronOptions(config: Pick<CaseConfig, "conclusionRule">): { establishes: boolean } {
  return { establishes: config.conclusionRule === "corroborated-2" };
}

export function relativeDataPath(config: CaseConfig, file: string): string {
  return path.relative(config.rootDir, file).split(path.sep).join("/");
}
