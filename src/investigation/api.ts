import { comparisonFingerprint, loadComparisons, pageComparisonsDir, publishedComparisonsDir, runComparison, saveComparison, statelessAnswer, visibleRecords, type ComparisonProgress } from "../compare/comparison.js";
import { NemotronProcessor } from "../reasoning/nemotron.js";
import type { CaseConfig } from "../config.js";
import { EvidenceProviderError } from "../evidence/types.js";
import { EvidenceDesk, MARKOVIAN_ENGINE, MARKOVIAN_SOURCE, ReasonerNotReadyError, RunInProgressError, WithdrawalError } from "./desk.js";
import { UserCaseError } from "./user-cases.js";

// The JSON API both front ends serve: the standalone server (src/server.ts,
// under /api) and the Speck plugin (plugin/evidence-desk-plugin.ts, under
// /api/plugins/evidence-desk/cases/<case>). One set of operations, so the
// page receives the same payloads wherever it runs.

export class RequestError extends Error {}

export class NotFoundError extends Error {}

// One side-by-side comparison at a time in a process: on a live
// configuration both approaches call the same local model.
export class ComparisonInProgressError extends Error {
  constructor(caseId: string) { super(`A comparison is already running (case ${caseId}); wait for it to finish`); this.name = "ComparisonInProgressError"; }
}
let activeComparison: string | null = null;

export interface DeskApi {
  status(): unknown;
  evidence(): Promise<unknown>;
  trace(): unknown;
  investigation(): unknown;
  run(): Promise<unknown>;
  update(): Promise<unknown>;
  withdraw(body: unknown): Promise<unknown>;
  reset(): Promise<unknown>;
  progress(): unknown;
  // Speck beside the stateless baseline (src/compare/comparison.ts): the
  // saved comparisons and whether one is running; start one; read one.
  comparison(): unknown;
  compare(): unknown;
  comparisonReport(id: string): unknown;
  // Settles when the comparison started by compare() has finished (tests).
  comparisonDone(): Promise<void>;
  // Decisive mode (public/decisive.js): the stateless baseline's answer on the
  // case as it stands now, for the page to check against Speck's state. The
  // last one, and a new one.
  opinion(): unknown;
  requestOpinion(): Promise<unknown>;
}

// Every operation of one case's API, by method and path: under /api in the
// standalone server, under /api/plugins/evidence-desk/cases/<case> in Speck.
// Both hosts register exactly these, so they cannot drift apart.
export interface DeskRoute {
  method: "GET" | "POST";
  path: string;
  handle(api: DeskApi, request: { body: unknown; params: Record<string, string> }): unknown;
}
export const DESK_ROUTES: readonly DeskRoute[] = [
  { method: "GET", path: "/status", handle: (api) => api.status() },
  { method: "GET", path: "/evidence", handle: (api) => api.evidence() },
  { method: "GET", path: "/trace", handle: (api) => api.trace() },
  { method: "GET", path: "/investigation", handle: (api) => api.investigation() },
  { method: "POST", path: "/run", handle: (api) => api.run() },
  { method: "POST", path: "/update", handle: (api) => api.update() },
  { method: "POST", path: "/evidence/withdraw", handle: (api, { body }) => api.withdraw(body) },
  { method: "POST", path: "/reset", handle: (api) => api.reset() },
  { method: "GET", path: "/progress", handle: (api) => api.progress() },
  // Speck beside the stateless baseline on this case (src/compare/comparison.ts).
  { method: "GET", path: "/comparison", handle: (api) => api.comparison() },
  { method: "POST", path: "/comparison", handle: (api) => api.compare() },
  { method: "GET", path: "/comparison/:reportId", handle: (api, { params }) => api.comparisonReport(params.reportId ?? "") },
  // Decisive mode: the stateless baseline on the case as it stands (public/decisive.js).
  { method: "GET", path: "/opinion", handle: (api) => api.opinion() },
  { method: "POST", path: "/opinion", handle: (api) => api.requestOpinion() }
];

// speckDatabase: how to describe where the case is stored (a file path for
// the standalone desk; Speck's own database inside Speck).
export function deskApi(desk: EvidenceDesk, config: CaseConfig, speckDatabase: string): DeskApi {
  // The execution engine's latest progress report for the current or last
  // run, as Meterless emitted it. Nothing is estimated.
  let latest: { runId: string; phase: string; phaseDetail: string; currentChunk: number; maxChunks: number; at: string } | null = null;
  desk.on("progress", (state) => {
    latest = { runId: state.runId, phase: state.phase, phaseDetail: state.phaseDetail, currentChunk: state.currentChunk, maxChunks: state.maxChunks, at: new Date().toISOString() };
  });

  // Comparisons run on their own temporary Speck database, never on this case.
  const comparisonDirs = { page: pageComparisonsDir(config, desk.scenario.id), command: publishedComparisonsDir(config.rootDir, desk.scenario.id) };
  let comparing: { startedAt: string; progress: ComparisonProgress | null } | null = null;
  let comparingDone: Promise<void> = Promise.resolve();
  let comparisonFailure: { at: string; error: string; kind: string } | null = null;
  const saved = () => loadComparisons(comparisonDirs, comparisonFingerprint(config, desk.provider.describe()));

  // The latest second opinion, kept for this process only; the page asks for
  // a new one whenever the case has moved on since.
  let opinion: Record<string, unknown> | null = null;
  let opinionInFlight: Promise<Record<string, unknown>> | null = null;
  // Decisive mode's stateless call, with its own reasoning setting.
  const decisiveModel = { ...config.nemotron, reasoningEffort: config.nemotron.decisiveReasoningEffort };
  const processor = config.reasoner === "nemotron" ? new NemotronProcessor(decisiveModel) : null;

  return {
    status: () => ({
      case: { caseId: desk.scenario.caseId, title: desk.scenario.title, question: desk.scenario.question, scenarioId: desk.scenario.id, generation: desk.generation },
      stage: desk.currentStage(),
      nextStage: desk.nextStage(),
      // Every stage of the case in order, for the page's progress view.
      stages: desk.scenario.stages.map((stage) => ({ id: stage.id, label: stage.label, description: stage.description })),
      running: desk.isRunning,
      evidence: desk.provider.describe(),
      reasoner: { ...desk.reasoner.describe(), usage: desk.reasoner.usage() },
      execution: { engine: MARKOVIAN_SOURCE, identity: MARKOVIAN_ENGINE, maxChunks: config.execution.maxChunks, batchSize: config.execution.batchSize },
      speck: { database: speckDatabase }
    }),
    evidence: () => desk.listEvidence(),
    // What each component did, per run and per action, from persisted state.
    trace: () => ({ engine: MARKOVIAN_ENGINE, entries: desk.trace() }),
    investigation: () => {
      // Every view below from one read of Speck's state, so they agree.
      const state = desk.read();
      const runs = state.runs();
      return {
        // What Speck believes now, read from its persisted state. The page
        // shows this, not the copy stored with the last run. Shown whenever
        // Speck's ledger holds evidence, including after a run that was
        // interrupted before saving its snapshot.
        current: runs.length || state.recordedCount() ? state.conclusion() : null,
        latestRun: runs.at(-1) ?? null,
        runs: runs.map((run) => ({
          runNumber: run.runNumber, runId: run.runId, finishedAt: run.finishedAt, stage: run.stage,
          status: run.execution.status, conclusion: run.conclusion.state, hypothesis: run.conclusion.hypothesis?.key ?? null,
          evidenceMode: run.evidence.mode, reasoner: run.reasoner.kind, model: run.reasoner.model
        })),
        hypotheses: state.hypotheses(),
        // Beliefs no longer held because what they rested on was invalidated:
        // history, kept apart from the current state above.
        history: { recomputations: state.recomputations(), replaced: state.replacedHypotheses() },
        timeline: desk.timeline(state)
      };
    },
    run: () => desk.run(),
    update: async () => ({ stage: await desk.introduceNextUpdate(), next: desk.nextStage() }),
    withdraw: async (body) => {
      const { recordId, reason } = (body && typeof body === "object" ? body : {}) as { recordId?: unknown; reason?: unknown };
      if (typeof recordId !== "string" || typeof reason !== "string") throw new RequestError("recordId and reason are required");
      return { recomputation: await desk.withdrawRecord(recordId, reason) };
    },
    // A fresh copy of the demo case; nothing is deleted (EvidenceDesk.restartCase).
    reset: async () => {
      const result = await desk.restartCase();
      latest = null;
      return { ...result, stage: desk.currentStage(), runs: desk.runs().length };
    },
    progress: () => ({ running: desk.isRunning, progress: latest }),
    comparison: () => {
      const { current, index, unreadable } = saved();
      const reasoner = desk.reasoner.describe();
      return {
        running: comparing,
        // The newest comparison made with this case's current settings. Ones
        // made with other settings are listed, never presented as current.
        current,
        others: index.filter((entry) => entry.id !== current?.id),
        unreadable,
        // A failure after the newest saved comparison: nothing was saved for it.
        failure: comparisonFailure && (!current || comparisonFailure.at > current.finishedAt) ? comparisonFailure : null,
        willRun: {
          kind: reasoner.kind === "nemotron" || desk.provider.mode === "zetaris" ? "live" : "deterministic",
          evidence: desk.provider.describe(),
          assessor: { kind: reasoner.kind, model: reasoner.model, endpoint: reasoner.endpoint, ready: reasoner.ready, problem: reasoner.problem }
        }
      };
    },
    compare: () => {
      if (activeComparison) throw new ComparisonInProgressError(activeComparison);
      const reasoner = desk.reasoner.describe();
      if (!reasoner.ready) throw new ReasonerNotReadyError(reasoner.problem ?? "the assessor is not configured");
      activeComparison = desk.scenario.caseId;
      comparing = { startedAt: new Date().toISOString(), progress: null };
      comparisonFailure = null;
      comparingDone = (async () => {
        try {
          const report = await runComparison(config, { provider: desk.provider, onProgress: (progress) => { if (comparing) comparing.progress = progress; } });
          saveComparison(comparisonDirs.page, report);
        } catch (error) {
          const { body } = errorResponse(error);
          comparisonFailure = { at: new Date().toISOString(), error: String(body.error ?? error), kind: String(body.kind ?? "internal") };
        } finally {
          comparing = null;
          activeComparison = null;
        }
      })();
      return { started: true, startedAt: comparing.startedAt };
    },
    comparisonReport: (id) => {
      const report = saved().byId.get(id);
      if (!report) throw new NotFoundError(`No saved comparison "${id}" for this case`);
      return { report, matchesCurrent: report.fingerprint === comparisonFingerprint(config, desk.provider.describe()) };
    },
    comparisonDone: () => comparingDone,
    opinion: () => ({ opinion }),
    requestOpinion: async () => {
      if (desk.isRunning) throw new RunInProgressError();
      // Two requests for the same state share one call.
      opinionInFlight ??= (async () => {
        const runNumber = desk.runs().at(-1)?.runNumber ?? null;
        const stage = desk.currentStage().id;
        const { records, replaced } = await visibleRecords(desk);
        const answer = await statelessAnswer(config, desk.scenario, records, processor);
        return {
          at: new Date().toISOString(), runNumber, stage,
          visible: records.map((record) => record.id),
          replaced: [...replaced].map(([recordId, by]) => ({ recordId, by })),
          answer,
          kind: answer.method === "nemotron" ? "live" : "deterministic",
          model: answer.method === "nemotron" ? { model: config.nemotron.model, endpoint: config.nemotron.baseUrl, reasoningEffort: decisiveModel.reasoningEffort || null } : null
        };
      })();
      try {
        opinion = await opinionInFlight;
        return { opinion };
      } finally {
        opinionInFlight = null;
      }
    }
  };
}

// An error as the HTTP status and body the page understands.
export function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof EvidenceProviderError) {
    return { status: 502, body: { error: error.message, hint: error.hint, detail: error.detail, kind: "evidence", mode: error.mode } };
  }
  if (error instanceof RunInProgressError || error instanceof ComparisonInProgressError) return { status: 409, body: { error: error.message, kind: "busy" } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message, kind: "request" } };
  if (error instanceof ReasonerNotReadyError) return { status: 503, body: { error: error.message, hint: error.hint, kind: "reasoner" } };
  if (error instanceof RequestError || error instanceof WithdrawalError || error instanceof UserCaseError) return { status: 400, body: { error: error.message, kind: "request" } };
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error), kind: "internal" } };
}
