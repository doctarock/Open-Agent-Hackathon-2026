import type { AppConfig } from "../config.js";
import { EvidenceProviderError } from "../evidence/types.js";
import { EvidenceDesk, MARKOVIAN_ENGINE, MARKOVIAN_SOURCE, ReasonerNotReadyError, RunInProgressError, WithdrawalError } from "./desk.js";

// The JSON API both front ends serve: the standalone server (src/server.ts,
// under /api) and the Speck plugin (plugin/evidence-desk-plugin.ts, under
// /api/plugins/evidence-desk/cases/<case>). One set of operations, so the
// page receives the same payloads wherever it runs.

export class RequestError extends Error {}

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
}

// speckDatabase: how to describe where the case is stored (a file path for
// the standalone desk; Speck's own database inside Speck).
export function deskApi(desk: EvidenceDesk, config: AppConfig, speckDatabase: string): DeskApi {
  // The execution engine's latest progress report for the current or last
  // run, as Meterless emitted it. Nothing is estimated.
  let latest: { runId: string; phase: string; phaseDetail: string; currentChunk: number; maxChunks: number; at: string } | null = null;
  desk.on("progress", (state) => {
    latest = { runId: state.runId, phase: state.phase, phaseDetail: state.phaseDetail, currentChunk: state.currentChunk, maxChunks: state.maxChunks, at: new Date().toISOString() };
  });
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
      const runs = desk.runs();
      return {
        // What Speck believes now, read from its persisted state. The page
        // shows this, not the copy stored with the last run. Shown whenever
        // Speck's ledger holds evidence, including after a run that was
        // interrupted before saving its snapshot.
        current: runs.length || desk.recordedCount() ? desk.conclusionFromSpeck() : null,
        latestRun: runs.at(-1) ?? null,
        runs: runs.map((run) => ({
          runNumber: run.runNumber, runId: run.runId, finishedAt: run.finishedAt, stage: run.stage,
          status: run.execution.status, conclusion: run.conclusion.state, hypothesis: run.conclusion.hypothesis?.key ?? null,
          evidenceMode: run.evidence.mode, reasoner: run.reasoner.kind, model: run.reasoner.model
        })),
        hypotheses: desk.hypotheses(),
        // Beliefs no longer held because what they rested on was invalidated:
        // history, kept apart from the current state above.
        history: { recomputations: desk.recomputations(), replaced: desk.replacedHypotheses() },
        timeline: desk.timeline()
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
    progress: () => ({ running: desk.isRunning, progress: latest })
  };
}

// An error as the HTTP status and body the page understands.
export function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof EvidenceProviderError) {
    return { status: 502, body: { error: error.message, hint: error.hint, detail: error.detail, kind: "evidence", mode: error.mode } };
  }
  if (error instanceof RunInProgressError) return { status: 409, body: { error: error.message, kind: "busy" } };
  if (error instanceof ReasonerNotReadyError) return { status: 503, body: { error: error.message, hint: error.hint, kind: "reasoner" } };
  if (error instanceof RequestError || error instanceof WithdrawalError) return { status: 400, body: { error: error.message, kind: "request" } };
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error), kind: "internal" } };
}
