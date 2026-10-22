import type { EvidenceRecord } from "../evidence/types.js";
import type { HypothesisSpec } from "../scenario.js";

// How a piece of evidence bears on one hypothesis. Speck does the belief
// revision; a reasoner only proposes the relations.
export interface RelationJudgment {
  hypothesisKey: string;
  direction: "supports" | "contradicts";
  strength: number;
  decisive: boolean;
  basis: "rule" | "model";
  rationale: string;
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

export interface Reasoner {
  readonly kind: "rules" | "nemotron";
  describe(): ReasonerDescription;
  assess(input: { chunkPrompt: string; batch: EvidenceRecord[]; hypotheses: HypothesisSpec[] }): Promise<BatchAssessment>;
  // Absent when there is no model to explain with.
  explain?(prompt: string): Promise<Explanation>;
  usage(): ReasonerUsage | null;
}
