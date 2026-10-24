import type { MarkovianRun } from "../../vendor/meterless-markovian/src/index.js";
import type { EvidenceRecord, FetchSummary, ProviderDescription } from "../evidence/types.js";
import type { Explanation, ModelCallTrace, ReasonerDescription, ReasonerUsage, RelationJudgment } from "../reasoning/types.js";
import type { StageSpec } from "../scenario.js";
import type { Invalidation } from "./basis.js";
import type { Conclusion } from "./conclusion.js";

// What Evidence Desk keeps in Speck for a case, beside Speck's own
// hypotheses and evidence: each kind of record is a memory whose data carries
// one of these schemas. Also the identity of the execution engine, and the
// errors the desk's operations raise.

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

export class RunInProgressError extends Error {
  constructor(message = "An investigation run is already in progress") { super(message); this.name = "RunInProgressError"; }
}

export class WithdrawalError extends Error {
  constructor(message: string) { super(message); this.name = "WithdrawalError"; }
}

export class ReasonerNotReadyError extends Error {
  readonly hint = "Set the NEMOTRON_* settings in .env (see .env.example), or set REASONER=rules for the deterministic assessor.";
  constructor(message: string) { super(message); this.name = "ReasonerNotReadyError"; }
}
