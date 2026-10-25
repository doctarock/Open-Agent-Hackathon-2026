import { hypothesisStatus, type MentalObject } from "#speck";
import type { EvidenceRecord } from "../evidence/types.js";
import type { RelationJudgment } from "../reasoning/types.js";
import type { QuestionSpec } from "../scenario.js";
import { describeInvalidation, type Invalidation } from "./basis.js";

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
//
// Why it is built this way:
// - Traceable by construction. Every statement in a conclusion names the
//   records and the Speck confidence behind it, because it is computed from
//   them; there is no free text to check.
// - Abstaining is a valid answer. "Unresolved" is a first-class outcome, and
//   it says what is missing: the gap to Speck's threshold, the cap on model-judged
//   evidence, the questions no record answers yet.
// - Direction and justification are separate because they really do differ.
//   With a small local model, Speck caps model-judged evidence at reliability
//   0.4, so a case can rule out every other explanation and still not reach
//   Speck's supported threshold. Reporting only one of the two would either
//   present a guess as a finding, or hide what the evidence plainly shows.
// - Confidence is shown as Speck's belief-revision score, and called that: it
//   is not a calibrated probability, and the notes say so every time.

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
  // The judgment behind this relation, and the confidence change Speck made
  // when it applied it to the current hypothesis.
  judgment: Pick<RelationJudgment, "basis" | "decisive" | "strength" | "rationale"> | null;
  delta: number | null;
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

// How an established conclusion was reached: Speck's own supported status, or
// rule corroborated-1 while Speck's confidence is still below its threshold.
export type ConclusionRoute = "speck-threshold" | "corroboration";

export interface Corroboration {
  rule: typeof CORROBORATION_RULE;
  holds: boolean;
  // The records that still count supporting the explanation, and their systems.
  records: string[];
  systems: string[];
  // Why it does not hold, in plain words; empty when it holds.
  missing: string[];
}

export interface Justification {
  established: boolean;
  route: ConclusionRoute | null;
  corroboration: Corroboration | null;
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
  // Assessed records that no longer count towards any current belief.
  noLongerCounted: NoLongerCounted[];
  // False when Speck's beliefs lag the evidence ledger (an interrupted run or
  // recomputation); set by the desk, which can check it.
  reconciled: boolean;
  uncertainty: {
    speckConfidence: number | null;
    speckStatus: string | null;
    runnerUp: { key: string; confidence: number } | null;
    margin: number | null;
    notes: string[];
  };
}

// An assessed record that no longer counts, and what that took away. A
// record is replaced or withdrawn whole, so this says which of its facts no
// counting record restates, which of its judgments stopped applying, and what
// that changed, so a fact the correction never addressed does not vanish
// unexplained.
// Why this matters: in the bank-return case the returned credit was also the
// only refutation of "partial payment". When the return replaced it, that
// explanation came back. Supersession is record-level by design (the source
// replaces the whole record), so the consequence is explained rather than
// hidden (README, "Known limits").
export interface NoLongerCounted {
  recordId: string;
  invalidation: Invalidation;
  reason: string;
  // Facts it stated that no record still counting states.
  unrestatedFacts: Array<{ fact: string; value: string }>;
  // Its judgments, none of which apply any more.
  lostJudgments: Array<{ hypothesisKey: string; direction: RelationJudgment["direction"]; decisive: boolean }>;
  // Effects on current belief, such as a refutation that no longer stands.
  consequences: string[];
  explanation: string;
}

// Speck's belief-revision settings the explanation refers to.
export interface BeliefSettings {
  supportedThreshold: number;
  supportBonus: number;
  modelReliabilityCeiling: number;
}

// A leading explanation must be at least this confident and this far ahead of
// the next live one; below that the case is unresolved.
// Why fixed constants: they are policy, the same for every case and stated on
// the page and in the README, so any conclusion can be checked against them by
// hand. They are not tuned per case.
export const LEADING_MIN_CONFIDENCE = 0.5;
export const LEADING_MIN_MARGIN = 0.1;
// Rule corroborated-1 (docs/build-4-bank-return.md), fixed as first written.
// When Speck holds no explanation as supported, the top explanation is
// concluded if at least CORROBORATION_MIN_SYSTEMS different source systems
// support it with records that still count, no record that still counts is
// against it, and every other explanation is ruled out or has no support.
// Why: with model-judged evidence capped at 0.4, each record moves a belief
// by at most 0.08, so from a prior of 0.3 Speck's threshold needs four
// unanimous records; whether a case could conclude depended on its prior, not
// its evidence. This rule uses no confidence value: it asks whether the
// support is independent, unanimous and unopposed. A single record never
// satisfies it, and any counting record against it, or for a rival, blocks it.
export const CORROBORATION_RULE = "corroborated-1";
export const CORROBORATION_MIN_SYSTEMS = 2;

const ESTABLISHED = new Set(["supported", "confirmed"]);
const OUT = new Set(["rejected", "superseded"]);

export function deriveConclusion(input: {
  ranked: readonly MentalObject[];
  assessed: readonly EvidenceRecord[];
  evidenceFor: (mentalObjectId: string, hypothesisKey: string) => {
    record: EvidenceRecord; reliability: number; judgedBy: "rules" | "model"; judgment?: RelationJudgment | undefined;
  } | undefined;
  questions: readonly QuestionSpec[];
  belief: BeliefSettings;
  // Records that no longer count. Without it, supersession is read from the
  // records' own claims.
  invalidated?: ReadonlyMap<string, Invalidation>;
  // The judgments recorded for an assessed record, to say what an
  // invalidated record's removal took away.
  judgmentsFor?: (recordId: string) => readonly RelationJudgment[];
}): Conclusion {
  const invalidated = input.invalidated ?? new Map<string, Invalidation>();
  const supersededBy = new Map<string, string>();
  if (input.invalidated) {
    for (const [id, invalidation] of invalidated) if (invalidation.kind === "superseded") supersededBy.set(id, invalidation.by);
  } else {
    for (const record of input.assessed) for (const id of record.provenance.supersedes) supersededBy.set(id, record.id);
  }
  const views = input.ranked.map((object): HypothesisView => {
    const key = String(object.data.key ?? object.id);
    const history = Array.isArray(object.data.revisionHistory) ? object.data.revisionHistory as Array<{ previousConfidence?: number; evidenceId?: string; delta?: number }> : [];
    const ref = (id: string): EvidenceRef[] => {
      const found = input.evidenceFor(id, key);
      if (!found) return [];
      const { record, judgment } = found;
      const delta = history.find((entry) => entry.evidenceId === id)?.delta;
      return [{
        recordId: record.id, sourceSystem: record.source.system, sourceName: record.source.name,
        observedAt: record.observedAt, retrievalMode: record.retrieval.mode, supersededBy: supersededBy.get(record.id) ?? null,
        reliability: found.reliability, judgedBy: found.judgedBy,
        judgment: judgment ? { basis: judgment.basis, decisive: judgment.decisive, strength: judgment.strength, rationale: judgment.rationale } : null,
        delta: typeof delta === "number" ? round(delta) : null
      }];
    };
    return {
      key,
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
  // Why "supported" needs Speck's own status: Speck decides when a belief is
  // established (its supported threshold, and whether the latest evidence
  // weakened it); this code reports that decision rather than making its own.
  let state: ConclusionState = "unresolved";
  let route: ConclusionRoute | null = null;
  if (top?.supporting.length && ESTABLISHED.has(top.status)) {
    state = "supported";
    route = "speck-threshold";
  } else if (top?.supporting.length && top.confidence >= LEADING_MIN_CONFIDENCE && (margin ?? 0) >= LEADING_MIN_MARGIN) state = "leading";
  const counts = (ref: EvidenceRef) => !invalidated.has(ref.recordId) && !ref.supersededBy;
  const corroboration = top && route === null ? corroborate(top, live, counts) : null;
  if (corroboration?.holds) {
    state = "supported";
    route = "corroboration";
  }

  const answeredQuestions: Conclusion["answeredQuestions"] = [];
  const openQuestions: Conclusion["openQuestions"] = [];
  // Only records that still count can answer a question.
  const counting = input.assessed.filter((record) => !invalidated.has(record.id));
  for (const question of input.questions) {
    const answering = [...counting].reverse().find((record) => record.facts[question.answeredBy] !== undefined);
    if (answering) answeredQuestions.push({ id: question.id, text: question.text, answer: answering.facts[question.answeredBy]!, recordId: answering.id });
    else openQuestions.push({ id: question.id, text: question.text });
  }

  // The evidence points to the top live explanation when it has support of
  // its own and is alone or clearly ahead, independent of its confidence.
  const favoured = top && top.supporting.length && (!runnerUp || (margin ?? 0) >= LEADING_MIN_MARGIN) ? top : null;
  const direction = describeDirection(favoured, live, rejected);
  const justification = justify({ state, route, corroboration, favoured, top, openQuestions, belief: input.belief });

  const notes = ["Confidence is Speck's belief-revision score from source reliability and evidence relations. It is not a calibrated probability."];
  if (top?.contradicting.length) notes.push(`${top.key} is contested by ${top.contradicting.map((item) => item.recordId).join(", ")}.`);
  const supersededSupport = top?.supporting.filter((item) => item.supersededBy) ?? [];
  if (supersededSupport.length) notes.push(`Support from ${supersededSupport.map((item) => `${item.recordId} (superseded by ${item.supersededBy})`).join(", ")} has been replaced by its source.`);
  const noLongerCounted = input.assessed.flatMap((record) => {
    const invalidation = invalidated.get(record.id);
    return invalidation ? [explainInvalidation(record, invalidation, counting, views, input.judgmentsFor?.(record.id) ?? [])] : [];
  });
  if (noLongerCounted.length) {
    notes.push(`No longer counted: ${noLongerCounted.map((item) => item.reason).join("; ")}. Current beliefs were recomputed from the remaining evidence; what these records contributed before is in the history, not here.`);
    for (const item of noLongerCounted) if (item.consequences.length) notes.push(item.explanation);
  }
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
    noLongerCounted,
    reconciled: true,
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

// A conclusion is not presented as firm while records the last run could not
// assess are still waiting: they may replace or refute what it rests on.
// Why: a failed model call leaves a newer record unassessed (live, 2026-10-25:
// a carrier correction and a claims decline). Speck's state then still holds
// the earlier conclusion, built without them; presenting it as current would
// pass a stale answer off as one that has seen the correction. Speck's belief
// state is not changed; the next run assesses the records and decides.
export function withholdForPending(conclusion: Conclusion, pending: readonly string[]): Conclusion {
  if (!pending.length || conclusion.state === "unresolved") return conclusion;
  const held = conclusion.hypothesis;
  const reason = `${pending.length} visible record(s) (${pending.join(", ")}) could not be assessed in the last run, so the conclusion is withheld until a run assesses them${held ? `; without them Speck would hold ${held.key} as ${conclusion.state === "supported" ? "established" : "leading"}` : ""}.`;
  return {
    ...conclusion,
    state: "unresolved",
    headline: `Unresolved: ${pending.length} newer record(s) not yet assessed (${pending.join(", ")}).${held ? ` Before them, the evidence pointed to "${held.statement}".` : ""}`,
    hypothesis: null,
    alternatives: held ? [held, ...conclusion.alternatives] : conclusion.alternatives,
    justification: { ...conclusion.justification, established: false, route: null, reasons: [reason, ...conclusion.justification.reasons], wouldChange: ["Run the investigation again to assess the waiting records.", ...conclusion.justification.wouldChange] },
    uncertainty: { ...conclusion.uncertainty, notes: [reason, ...conclusion.uncertainty.notes] }
  };
}

// Rule corroborated-1 applied to the top explanation; `counts` says whether a
// record still counts.
// Why every recorded contradiction blocks it, counting or not: once beliefs
// are reconciled Speck holds only counting records against a hypothesis, so
// this is the same rule; before they are (an interrupted recomputation) a
// contradiction Speck still applies must not be argued away here.
function corroborate(top: HypothesisView, live: readonly HypothesisView[], counts: (ref: EvidenceRef) => boolean): Corroboration {
  const support = top.supporting.filter(counts);
  const records = [...new Set(support.map((ref) => ref.recordId))];
  const systems = [...new Set(support.map((ref) => ref.sourceSystem))];
  const against = top.contradicting.map((ref) => ref.recordId);
  const rivals = live.filter((view) => view !== top && view.supporting.some(counts)).map((view) => view.key);
  const missing: string[] = [];
  if (systems.length < CORROBORATION_MIN_SYSTEMS) {
    missing.push(systems.length
      ? `its support comes from one source system (${systems[0]}); corroboration needs ${CORROBORATION_MIN_SYSTEMS} different ones`
      : "no record that still counts supports it");
  }
  if (against.length) missing.push(`${against.join(", ")} ${against.length === 1 ? "is" : "are"} recorded against it`);
  if (rivals.length) missing.push(`${rivals.join(", ")} still ha${rivals.length === 1 ? "s" : "ve"} support of ${rivals.length === 1 ? "its" : "their"} own`);
  return { rule: CORROBORATION_RULE, holds: missing.length === 0, records, systems, missing };
}

function justify(input: {
  state: ConclusionState;
  route: ConclusionRoute | null;
  corroboration: Corroboration | null;
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
  const { route, corroboration } = input;
  if (!subject) {
    reasons.push("There is no explanation left to justify.");
    return { established: false, route, corroboration, confidence: null, status: null, thresholds, gapToSupported: null, reasons, wouldChange };
  }
  if (route === "corroboration" && corroboration) {
    reasons.push(`Speck holds ${subject.key} as ${subject.status} at ${subject.confidence}, ${gap} short of its supported threshold of ${belief.supportedThreshold}; Speck itself has not established it.`);
    reasons.push(`Concluded by corroboration (rule ${corroboration.rule}): ${corroboration.records.join(", ")} from ${corroboration.systems.length} different sources (${corroboration.systems.join(", ")}) support it, no record that still counts is against it, and every other explanation is ruled out or has no support.`);
    const capped = subject.supporting.filter((item) => item.judgedBy === "model");
    if (capped.length) reasons.push(`The gap is Speck's cap on model-judged evidence: ${capped.map((item) => item.recordId).join(", ")} ${capped.length === 1 ? "was" : "were"} judged by the model, so each adds at most ${round(belief.supportBonus * belief.modelReliabilityCeiling)}.`);
    wouldChange.push(`Any record that still counts against ${subject.key}, or supports another explanation, withdraws this conclusion.`);
    for (const question of input.openQuestions) wouldChange.push(`Evidence answering: ${question.text}`);
  } else if (input.state === "supported") {
    reasons.push(`Speck holds ${subject.key} as ${subject.status} at ${subject.confidence}, at or above its supported threshold of ${belief.supportedThreshold}.`);
  } else if (input.state === "leading" && gap === 0) {
    // At or above the threshold but not established: Speck marks a belief
    // weakening when the latest evidence applied to it counted against it.
    reasons.push(`${subject.key} is at ${subject.confidence}, at or above Speck's supported threshold of ${belief.supportedThreshold}, but Speck holds it as ${subject.status}: the latest evidence applied to it counted against it, so it is not established.`);
  } else if (input.state === "leading") {
    reasons.push(`${subject.key} is at ${subject.confidence}: above the ${LEADING_MIN_CONFIDENCE} needed to lead, but ${gap} short of Speck's supported threshold of ${belief.supportedThreshold}.`);
  } else if (!subject.supporting.length) {
    reasons.push(`No assessed evidence supports ${subject.key}; its ${subject.confidence} is ${subject.confidence === subject.prior ? "its prior" : "what remains of its prior"}, not a finding.`);
  } else {
    reasons.push(`Speck's confidence in ${subject.key} is ${subject.confidence}, ${gap} short of its supported threshold of ${belief.supportedThreshold}`
      + (subject.confidence < LEADING_MIN_CONFIDENCE ? ` and below the ${LEADING_MIN_CONFIDENCE} needed even to call it leading.` : "."));
    if (!favoured) reasons.push("Other explanations remain too close to it to say the evidence favours it.");
  }
  if (input.state !== "supported" && corroboration && corroboration.missing.length) {
    reasons.push(`Not corroborated (rule ${corroboration.rule}): ${corroboration.missing.join("; ")}.`);
  }
  if (input.state !== "supported") {
    if (subject.prior < LEADING_MIN_CONFIDENCE) reasons.push(`It started from a low prior of ${subject.prior}, so its support has had further to climb.`);
    const capped = subject.supporting.filter((item) => item.judgedBy === "model");
    if (capped.length) {
      reasons.push(`Its support from ${capped.map((item) => item.recordId).join(", ")} was judged by the model. Speck caps model-judged evidence at reliability ${belief.modelReliabilityCeiling}, so each such record adds at most ${round(belief.supportBonus * belief.modelReliabilityCeiling)}.`);
    }
    for (const item of subject.contradicting) {
      reasons.push(item.supersededBy
        ? `${item.recordId} is still counted against it, although its source has superseded it with ${item.supersededBy}. This belief has not been recomputed since.`
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
    route,
    corroboration,
    confidence: subject.confidence,
    status: subject.status,
    thresholds,
    gapToSupported: gap,
    reasons,
    wouldChange
  };
}

function explainInvalidation(
  record: EvidenceRecord,
  invalidation: Invalidation,
  counting: readonly EvidenceRecord[],
  views: readonly HypothesisView[],
  judgments: readonly RelationJudgment[]
): NoLongerCounted {
  const reason = describeInvalidation(record.id, invalidation);
  const unrestatedFacts = Object.entries(record.facts)
    .filter(([fact, value]) => !counting.some((other) => other.facts[fact] === value))
    .map(([fact, value]) => ({ fact, value }));
  const lostJudgments = judgments.map((judgment) => ({ hypothesisKey: judgment.hypothesisKey, direction: judgment.direction, decisive: judgment.decisive }));
  const consequences: string[] = [];
  for (const judgment of lostJudgments) {
    const view = views.find((candidate) => candidate.key === judgment.hypothesisKey);
    if (!view) continue;
    // A refutation that came from this record and no longer stands.
    if (judgment.decisive && judgment.direction === "contradicts" && !OUT.has(view.status)) {
      consequences.push(`${view.key} is no longer ruled out: ${record.id} was its decisive refutation, and it is now ${view.status} at ${view.confidence}.`);
    }
  }
  const explanation = [
    invalidation.kind === "superseded" ? `${invalidation.by} replaces all of ${record.id}, not only the facts it restates.`
      : invalidation.kind === "restated" ? `${record.source.name} has since reported a newer value for every fact in ${record.id} (${invalidation.facts.map((item) => `${item.fact}: ${item.was} → ${item.now} in ${item.recordId}`).join("; ")}), so ${record.id} no longer describes the current state.`
      : `${record.id} was withdrawn (${invalidation.reason}).`,
    unrestatedFacts.length ? `No record that still counts states ${unrestatedFacts.map((item) => `${item.fact}=${item.value}`).join(", ")}.` : "",
    lostJudgments.length
      ? `Its judgments no longer apply: ${lostJudgments.map((item) => `${item.direction} ${item.hypothesisKey}${item.decisive ? " decisively" : ""}`).join("; ")}.`
      : "",
    ...consequences
  ].filter(Boolean).join(" ");
  return { recordId: record.id, invalidation, reason, unrestatedFacts, lostJudgments, consequences, explanation };
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
