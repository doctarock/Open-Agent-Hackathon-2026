import { hypothesisStatus, type MentalObject } from "#speck";
import type { EvidenceRecord } from "../evidence/types.js";
import type { QuestionSpec } from "../scenario.js";

// The conclusion is read from Speck's belief state, never written by a model:
// Speck's ranked hypotheses, their status and confidence, and the evidence
// Speck recorded for and against each. When no hypothesis is established the
// conclusion says so instead of picking one.
//
// Two outcomes are kept apart. The direction is what the evidence shows:
// which explanations it rules out and which one it points to. The
// justification is how firmly Speck holds that explanation, and why it does
// or does not reach a conclusion. Evidence can point clearly at an
// explanation that it does not yet justify.

export interface EvidenceRef {
  recordId: string;
  sourceSystem: string;
  sourceName: string;
  observedAt: string;
  retrievalMode: EvidenceRecord["retrieval"]["mode"];
  // Set when a later record from the evidence says it replaces this one.
  supersededBy: string | null;
  // The reliability Speck applied, after its cap for model-judged evidence.
  reliability: number;
  judgedBy: "rules" | "model";
}

export interface HypothesisView {
  key: string;
  statement: string;
  status: string;
  confidence: number;
  prior: number;
  supporting: EvidenceRef[];
  contradicting: EvidenceRef[];
}

export type ConclusionState = "supported" | "leading" | "unresolved";

export interface Direction {
  // The explanation the evidence favours, whether or not it is established.
  pointsTo: { key: string; statement: string } | null;
  eliminated: Array<{ key: string; statement: string; refutedBy: string[] }>;
  surviving: string[];
  summary: string;
}

export interface Justification {
  established: boolean;
  confidence: number | null;
  status: string | null;
  thresholds: { supported: number; leading: number; leadingMargin: number };
  // How far the explanation the evidence points to is below "supported".
  gapToSupported: number | null;
  reasons: string[];
  wouldChange: string[];
}

export interface Conclusion {
  state: ConclusionState;
  headline: string;
  hypothesis: HypothesisView | null;
  alternatives: HypothesisView[];
  rejected: HypothesisView[];
  direction: Direction;
  justification: Justification;
  openQuestions: Array<{ id: string; text: string }>;
  answeredQuestions: Array<{ id: string; text: string; answer: string; recordId: string }>;
  uncertainty: {
    speckConfidence: number | null;
    speckStatus: string | null;
    runnerUp: { key: string; confidence: number } | null;
    margin: number | null;
    notes: string[];
  };
}

// Speck's belief-revision settings the explanation refers to.
export interface BeliefSettings {
  supportedThreshold: number;
  supportBonus: number;
  modelReliabilityCeiling: number;
}

// A leading explanation must be at least this confident and this far ahead of
// the next live one; below that the case is unresolved.
export const LEADING_MIN_CONFIDENCE = 0.5;
export const LEADING_MIN_MARGIN = 0.1;

const ESTABLISHED = new Set(["supported", "confirmed"]);
const OUT = new Set(["rejected", "superseded"]);

export function deriveConclusion(input: {
  ranked: readonly MentalObject[];
  assessed: readonly EvidenceRecord[];
  evidenceFor: (mentalObjectId: string) => { record: EvidenceRecord; reliability: number; judgedBy: "rules" | "model" } | undefined;
  questions: readonly QuestionSpec[];
  belief: BeliefSettings;
}): Conclusion {
  const supersededBy = new Map<string, string>();
  for (const record of input.assessed) for (const id of record.provenance.supersedes) supersededBy.set(id, record.id);
  const ref = (id: string): EvidenceRef[] => {
    const found = input.evidenceFor(id);
    if (!found) return [];
    const { record } = found;
    return [{
      recordId: record.id, sourceSystem: record.source.system, sourceName: record.source.name,
      observedAt: record.observedAt, retrievalMode: record.retrieval.mode, supersededBy: supersededBy.get(record.id) ?? null,
      reliability: found.reliability, judgedBy: found.judgedBy
    }];
  };
  const views = input.ranked.map((object): HypothesisView => {
    const history = Array.isArray(object.data.revisionHistory) ? object.data.revisionHistory as Array<{ previousConfidence?: number }> : [];
    return {
      key: String(object.data.key ?? object.id),
      statement: object.content,
      status: hypothesisStatus(object.data.status),
      confidence: round(object.confidence),
      prior: round(history[0]?.previousConfidence ?? object.confidence),
      supporting: ids(object.data.supportingEvidence).flatMap(ref),
      contradicting: ids(object.data.contradictoryEvidence).flatMap(ref)
    };
  });
  const live = views.filter((view) => !OUT.has(view.status));
  const rejected = views.filter((view) => OUT.has(view.status));
  const top = live[0] ?? null;
  const runnerUp = live[1] ?? null;
  const margin = top && runnerUp ? round(top.confidence - runnerUp.confidence) : top ? round(top.confidence) : null;

  // A hypothesis without supporting evidence never leads, however high its
  // prior: that would be a conclusion from assumptions alone.
  let state: ConclusionState = "unresolved";
  if (top?.supporting.length && ESTABLISHED.has(top.status)) state = "supported";
  else if (top?.supporting.length && top.confidence >= LEADING_MIN_CONFIDENCE && (margin ?? 0) >= LEADING_MIN_MARGIN) state = "leading";

  const answeredQuestions: Conclusion["answeredQuestions"] = [];
  const openQuestions: Conclusion["openQuestions"] = [];
  for (const question of input.questions) {
    const answering = [...input.assessed].reverse().find((record) => record.facts[question.answeredBy] !== undefined);
    if (answering) answeredQuestions.push({ id: question.id, text: question.text, answer: answering.facts[question.answeredBy]!, recordId: answering.id });
    else openQuestions.push({ id: question.id, text: question.text });
  }

  // The evidence points to the top live explanation when it has support of
  // its own and is alone or clearly ahead, independent of its confidence.
  const favoured = top && top.supporting.length && (!runnerUp || (margin ?? 0) >= LEADING_MIN_MARGIN) ? top : null;
  const direction = describeDirection(favoured, live, rejected);
  const justification = justify({ state, favoured, top, openQuestions, belief: input.belief });

  const notes = ["Confidence is Speck's belief-revision score from source reliability and evidence relations. It is not a calibrated probability."];
  if (top?.contradicting.length) notes.push(`${top.key} is contested by ${top.contradicting.map((item) => item.recordId).join(", ")}.`);
  const supersededSupport = top?.supporting.filter((item) => item.supersededBy) ?? [];
  if (supersededSupport.length) notes.push(`Support from ${supersededSupport.map((item) => `${item.recordId} (superseded by ${item.supersededBy})`).join(", ")} has been replaced by its source.`);
  if (openQuestions.length) notes.push(`${openQuestions.length} question(s) remain unanswered by any evidence.`);
  if (!input.assessed.length) notes.push("No evidence has been assessed yet.");

  const chosen = state === "unresolved" ? null : top;
  return {
    state,
    headline: state === "supported" ? top!.statement
      : state === "leading" ? `Leading, not established: ${top!.statement}`
      : favoured ? `Unresolved: the evidence points to "${favoured.statement}" but does not yet justify it as a conclusion.`
      : "Unresolved: the assessed evidence does not establish any explanation.",
    hypothesis: chosen,
    alternatives: live.filter((view) => view !== chosen),
    rejected,
    direction,
    justification,
    openQuestions,
    answeredQuestions,
    uncertainty: {
      speckConfidence: top ? top.confidence : null,
      speckStatus: top ? top.status : null,
      runnerUp: runnerUp ? { key: runnerUp.key, confidence: runnerUp.confidence } : null,
      margin,
      notes
    }
  };
}

function describeDirection(favoured: HypothesisView | null, live: readonly HypothesisView[], rejected: readonly HypothesisView[]): Direction {
  const eliminated = rejected.map((view) => ({
    key: view.key, statement: view.statement,
    // The evidence Speck recorded against it; a decisive item is among these.
    refutedBy: view.contradicting.map((item) => item.recordId)
  }));
  const ruledOut = eliminated.length
    ? `${eliminated.map((item) => `${item.key} is ruled out (by ${item.refutedBy.join(", ") || "recorded evidence"})`).join("; ")}. `
    : "";
  let summary: string;
  if (!favoured) {
    summary = `${ruledOut}The evidence does not yet favour one explanation${live.length ? ` among ${live.map((view) => view.key).join(", ")}` : ""}.`;
  } else if (live.length === 1) {
    summary = `${ruledOut}${favoured.key} is the only explanation still standing, supported by ${favoured.supporting.map((item) => item.recordId).join(", ")}.`;
  } else {
    summary = `${ruledOut}${favoured.key} leads the remaining explanations, supported by ${favoured.supporting.map((item) => item.recordId).join(", ")}.`;
  }
  return {
    pointsTo: favoured ? { key: favoured.key, statement: favoured.statement } : null,
    eliminated,
    surviving: live.map((view) => view.key),
    summary
  };
}

function justify(input: {
  state: ConclusionState;
  favoured: HypothesisView | null;
  top: HypothesisView | null;
  openQuestions: Conclusion["openQuestions"];
  belief: BeliefSettings;
}): Justification {
  const { belief, favoured } = input;
  const subject = favoured ?? input.top;
  const thresholds = { supported: belief.supportedThreshold, leading: LEADING_MIN_CONFIDENCE, leadingMargin: LEADING_MIN_MARGIN };
  const gap = subject ? round(Math.max(0, belief.supportedThreshold - subject.confidence)) : null;
  const reasons: string[] = [];
  const wouldChange: string[] = [];
  if (!subject) {
    reasons.push("There is no explanation left to justify.");
    return { established: false, confidence: null, status: null, thresholds, gapToSupported: null, reasons, wouldChange };
  }
  if (input.state === "supported") {
    reasons.push(`Speck holds ${subject.key} as ${subject.status} at ${subject.confidence}, at or above its supported threshold of ${belief.supportedThreshold}.`);
  } else if (input.state === "leading") {
    reasons.push(`${subject.key} is at ${subject.confidence}: above the ${LEADING_MIN_CONFIDENCE} needed to lead, but ${gap} short of Speck's supported threshold of ${belief.supportedThreshold}.`);
  } else if (!subject.supporting.length) {
    reasons.push(`No assessed evidence supports ${subject.key}; its ${subject.confidence} is ${subject.confidence === subject.prior ? "its prior" : "what remains of its prior"}, not a finding.`);
  } else {
    reasons.push(`Speck's confidence in ${subject.key} is ${subject.confidence}, ${gap} short of its supported threshold of ${belief.supportedThreshold}`
      + (subject.confidence < LEADING_MIN_CONFIDENCE ? ` and below the ${LEADING_MIN_CONFIDENCE} needed even to call it leading.` : "."));
    if (!favoured) reasons.push("Other explanations remain too close to it to say the evidence favours it.");
  }
  if (input.state !== "supported") {
    if (subject.prior < LEADING_MIN_CONFIDENCE) reasons.push(`It started from a low prior of ${subject.prior}, so its support has had further to climb.`);
    const capped = subject.supporting.filter((item) => item.judgedBy === "model");
    if (capped.length) {
      reasons.push(`Its support from ${capped.map((item) => item.recordId).join(", ")} was judged by the model. Speck caps model-judged evidence at reliability ${belief.modelReliabilityCeiling}, so each such record adds at most ${round(belief.supportBonus * belief.modelReliabilityCeiling)}.`);
    }
    for (const item of subject.contradicting) {
      reasons.push(item.supersededBy
        ? `${item.recordId} is still counted against it, although its source has superseded it with ${item.supersededBy}. Speck does not undo a revision already made.`
        : `${item.recordId} (${item.sourceName}) counts against it.`);
    }
    if (input.openQuestions.length) reasons.push(`Unanswered: ${input.openQuestions.map((question) => question.text).join(" ")}`);
    if (gap) {
      wouldChange.push(`Each further supporting record adds ${belief.supportBonus} × reliability × strength (at most ${round(belief.supportBonus * belief.modelReliabilityCeiling)} when the model judges it); ${gap} more is needed.`);
    }
    for (const question of input.openQuestions) wouldChange.push(`Evidence answering: ${question.text}`);
  }
  return {
    established: input.state === "supported",
    confidence: subject.confidence,
    status: subject.status,
    thresholds,
    gapToSupported: gap,
    reasons,
    wouldChange
  };
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
