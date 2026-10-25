import type { EvidenceRecord } from "../evidence/types.js";
import type { HypothesisSpec } from "../scenario.js";

// The reasoner interface: what an assessor (fact rules or a Nemotron model)
// is asked to do, and what it reports about each call.
//
// Why a reasoner only proposes relations: belief is Speck's job. A reasoner
// says how a record bears on each hypothesis (supports or contradicts, how
// strongly, whether decisively), and Speck's belief revision turns that into
// confidence and status. Swapping the deterministic rules for a model, or one
// model for another, therefore changes the judgments but never the way beliefs
// are formed, and every belief can be traced to the judgments behind it.
//
// Why so much is recorded per call (ModelCallTrace): a small local model is
// inconsistent. Attempts, contract rejections, latency and the model name the
// endpoint actually served are measured and shown in the trace, so a reader
// can see how reliable each run's judgments were, not just what they were.

// How a piece of evidence bears on one hypothesis. Speck does the belief
// revision; a reasoner only proposes the relations.
export interface RelationJudgment {
  hypothesisKey: string;
  direction: "supports" | "contradicts";
  strength: number;
  decisive: boolean;
  basis: "rule" | "model";
  rationale: string;
  // Model judgments only. false when the reply gave no usable strength and
  // the default 0.5 was used; absent otherwise.
  strengthReported?: false;
  // Model judgments made for rule corroborated-2 only: whether the model said
  // the record itself records the hypothesis as the case, rather than a
  // request, plan, expectation or someone else's report of it. Absent when
  // not asked (corroborated-1, judgments saved before Build 5).
  establishes?: boolean;
}

export interface BatchAssessment {
  // Keyed by evidence record id; every record in the batch has an entry.
  judgments: Record<string, RelationJudgment[]>;
  // Model output that was discarded, and why.
  notes: string[];
  narrative: string;
}

export interface ReasonerDescription {
  kind: "rules" | "nemotron";
  label: string;
  provider: string;
  model: string | null;
  endpoint: string | null;
  ready: boolean;
  problem: string | null;
}

export interface ReasonerUsage {
  calls: number;
  successes: number;
  failures: number;
  lastError: string | null;
  // Model names the endpoint reported serving, as returned in its responses.
  servedModels: string[];
  // Each HTTP call, measured: latency and whether answer content came back.
  httpCalls: Array<{ latencyMs: number; answered: boolean }>;
}

export interface Explanation {
  text: string;
  citedEvidence: string[];
  // What the model declares its text concludes: a hypothesis key or
  // "unresolved", and whether it presents that as established.
  statedConclusion: string;
  statedEstablished: boolean;
}

// One structured model call as it actually happened: what was asked for, how
// it was constrained, what Speck's model registry did with the replies, and
// what was kept. Measured, never estimated.
export interface ModelCallTrace {
  purpose: "relation-judgments" | "explanation";
  processor: string;
  requestedModel: string;
  // Model names the endpoint reported in its responses to this call.
  servedModels: string[];
  endpoint: string;
  constraints: {
    contract: string;
    // Every (evidence, hypothesis) pair the reply must cover; 0 for explanations.
    requiredPairs: number;
    temperature: number;
    maxAttempts: number;
    maxTokens: number;
    reasoningEffort: string | null;
  };
  // Attempts made by Speck's registry; a reply that fails the contract is retried.
  attempts: number;
  contractFailures: number;
  transportFailures: number;
  httpCalls: Array<{ latencyMs: number; answered: boolean }>;
  outcome: "valid" | "failed";
  error: string | null;
  // Relation judgments only: what the model returned and what was kept.
  judgments?: {
    returned: number;
    neutral: number;
    kept: number;
    discardedUnknown: number;
    // The model disagreed with a deterministic rule; the rule was kept.
    ruleKept: number;
    // A pair already judged, by an earlier answer or by an agreeing rule; the
    // existing judgment was kept.
    repeated: number;
    // Records the model said nothing about (left unjudged and pending).
    unanswered: string[];
  };
}

export interface Reasoner {
  readonly kind: "rules" | "nemotron";
  describe(): ReasonerDescription;
  assess(input: { chunkPrompt: string; batch: EvidenceRecord[]; hypotheses: HypothesisSpec[] }): Promise<BatchAssessment>;
  // Absent when there is no model to explain with.
  explain?(prompt: string): Promise<Explanation>;
  usage(): ReasonerUsage | null;
  // The trace of the most recent model call (assess or explain), whether it
  // succeeded or failed, then cleared. Absent for reasoners without a model.
  takeTrace?(): ModelCallTrace | null;
}
