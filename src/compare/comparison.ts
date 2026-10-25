import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repositoryRoot, type CaseConfig, type AppConfig } from "../config.js";

export { repositoryRoot };
import type { Checkpoint } from "../eval/cases.js";
import { statelessModelAnswer, statelessRulesAnswer } from "../eval/systems.js";
import type { EvidenceProvider, EvidenceRecord, ProviderDescription } from "../evidence/types.js";
import { deriveBasis } from "../investigation/basis.js";
import type { Conclusion, ConclusionState, EvidenceRef } from "../investigation/conclusion.js";
import { EvidenceDesk } from "../investigation/desk.js";
import { NemotronProcessor } from "../reasoning/nemotron.js";
import { loadScenario, type Scenario } from "../scenario.js";

// Speck beside a stateless baseline, on the same case.
//
// One comparison walks every stage of a case. At each stage both approaches
// see exactly the same records (the ones Speck's desk lists as visible), the
// same question and the same competing explanations, with the same assessor
// configuration:
// - Speck: Evidence Desk as built. One Speck case carried across the stages
//   (incremental evidence, belief revision, supersession, recomputation).
// - Stateless: the evaluation's own stateless baseline (src/eval/systems.ts),
//   called afresh at every stage with no memory of the previous answer: the
//   scenario's fact rules summed (rule assessor), or one Nemotron call over
//   all visible evidence (model assessor).
//
// It runs on throwaway storage (a temporary Speck database), so the case on
// the page is never touched. Nothing is simulated: every value is what the
// two approaches returned. Every check is defined the same way for both.
//
// Why it is built this way:
// - A fair baseline, not a strawman. The stateless side is the evaluation's
//   own baseline, the same code the scored evaluation runs, with the same
//   model settings. The page cannot show a weaker baseline than the one the
//   numbers come from.
// - Same inputs. Both sides see the records the desk lists as visible at each
//   stage, including the source's own "replaces ..." statement, so a
//   difference cannot come from one side seeing more.
// - Honest about what the difference means. The report's notes say that the
//   gap comes from Speck's whole policy (thresholds, decisive refutation,
//   supersession, the 0.4 cap), not from persistence alone, and that a live
//   comparison is one sample, not a rate.
// - Kept, never overwritten. Each comparison is its own file, including the
//   ones that favour the baseline (docs/comparison.md lists them all).

export const COMPARISON_SCHEMA = "evidence-desk.comparison.v1";
// Evidence Desk's evidence and conclusion policy the comparison ran under.
// Reports saved before Build 4 have none (they ran under Build 3: declared
// replacement only, Speck's threshold the only route to a conclusion).
// Why it is recorded and fingerprinted: samples made under different policies
// must never be counted together.
export const EVIDENCE_POLICY = "build-4 (restatement, corroborated-1)";
// The policy a configuration runs under: Build 4's name is kept for
// corroborated-1, so its samples still group with those saved before Build 5.
export const evidencePolicy = (config: Pick<CaseConfig, "conclusionRule">): string =>
  !config.conclusionRule || config.conclusionRule === "corroborated-1" ? EVIDENCE_POLICY : `build-5 (restatement, ${config.conclusionRule})`;

export interface ComparedRecord {
  id: string;
  source: string;
  observedAt: string;
  content: string;
  supersedes: string[];
  // Stated by a later visible record: it replaces this one. Derived from the
  // records alone (the same rule for both approaches).
  replacedBy: string | null;
  // Out of date: the same source later reported a new value for every fact in
  // it (docs/build-4-bank-return.md). Derived from the records alone.
  outdatedBy?: string | null;
  retrieval: { mode: EvidenceRecord["retrieval"]["mode"]; location: string; queryToken: string | null };
}

export interface SpeckSide {
  error: string | null;
  state: ConclusionState | null;
  headline: string;
  // Firm only when Speck holds the explanation as supported; a leading or
  // pointed-to explanation is tentative (the evaluation scores it as abstaining).
  concluded: string | null;
  // How a firm conclusion was reached: Speck's own supported status, or
  // corroboration while Speck's confidence is below its threshold.
  route?: "speck-threshold" | "corroboration" | null;
  tentative: string | null;
  confidence: number | null;
  // Why Speck concludes or does not, in its own words (the justification).
  reasons?: string[];
  support: Array<{ recordId: string; delta: number | null; basis: string | null; decisive: boolean; rationale: string | null }>;
  against: Array<{ recordId: string; delta: number | null; basis: string | null; decisive: boolean; rationale: string | null }>;
  ruledOut: Array<{ key: string; refutedBy: string[] }>;
  noLongerCounted: Array<{ recordId: string; explanation: string; consequences: string[] }>;
  // Beliefs rebuilt or extended by this stage's run, and why.
  revisions: Array<{ key: string; mode: string; before: { status: string; confidence: number }; cause: string; dropped: string[] }>;
  beliefs: Array<{ key: string; status: string; confidence: number }>;
  run: {
    runNumber: number; status: string; unprocessed: string[]; modelCalls: number | null;
    // Speck's model registry for this run: failed calls (after retries) and the models the endpoint reported serving.
    modelFailures?: number | null; servedModels?: string[];
  } | null;
  explanation: { text: string; agrees: boolean | null; problems: string[]; invalidCitations: string[] } | null;
}

export interface StatelessSide {
  method: "rules" | "nemotron";
  error: string | null;
  concluded: string | null;
  cited: string[];
  rationale: string | null;
  // Rule baseline: each explanation's summed score.
  scores: Record<string, number> | null;
  // Rule baseline: every record a rule scored (it has no notion of a replaced record).
  counted: string[] | null;
  model: { attempts: number; valid: number; latencyMs: number[]; servedModels: string[] } | null;
}

// The same definitions for both approaches.
export interface SideChecks {
  // A firm conclusion (Speck: supported only).
  commits: boolean;
  // No firm conclusion and no error.
  abstains: boolean;
  // Records offered as support for what is presented as current or favoured.
  presentedSupport: string[];
  // Of those, records not in the evidence at all.
  unknownCitations: string[];
  // Of those, records a later visible record replaced.
  supportFromReplaced: string[];
  // Of those, records whose source later reported a new value for every fact
  // in them (out of date, though not declared replaced).
  supportFromOutdated?: string[];
  // Whether the conclusion (firm or tentative) differs from the previous stage's.
  changed: "first" | "formed" | "revised" | "retained" | "withdrawn" | "still none";
  // Whether the approach itself recorded why its conclusion changed.
  recordsWhy: boolean;
}

export interface LabelScore {
  expected: string | null;
  correct: boolean;
  unsupportedClaim: boolean;
  presentedRuledOut: string[];
  // Whether concluding nothing was right here: "appropriate" when the label
  // is no conclusion, "inappropriate" when one was due; null when it concluded.
  abstention?: "appropriate" | "inappropriate" | null;
}

export interface StageComparison {
  stage: { id: string; label: string; asOf: string };
  visible: ComparedRecord[];
  arrived: string[];
  replaced: Array<{ recordId: string; by: string }>;
  speck: SpeckSide;
  stateless: StatelessSide;
  checks: { speck: SideChecks; stateless: SideChecks };
  // Pre-registered labels (eval cases only), written before any system ran.
  label: { checkpoint: Checkpoint; speck: LabelScore; stateless: LabelScore } | null;
  // Where the two differ, why, in plain words; null when they agree.
  disagreement?: string | null;
}

export interface ComparisonReport {
  schema: typeof COMPARISON_SCHEMA;
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  kind: "deterministic" | "live";
  case: { caseId: string; title: string; question: string; hypotheses: Array<{ key: string; statement: string; prior: number }> };
  configuration: {
    evidence: ProviderDescription;
    assessor: { kind: "rules" | "nemotron"; model: string | null; endpoint: string | null; temperature: number | null; maxTokens: number | null; reasoningEffort: string | null };
    speck: string;
    stateless: string;
    labels: string;
    policy?: string;
  };
  fingerprint: string;
  stages: StageComparison[];
  notes: string[];
}

export interface ComparisonProgress {
  stage: string;
  step: "speck" | "stateless";
  index: number;
  of: number;
}


// What decides whether a saved comparison still describes this case as
// configured now: the scenario, its fixture evidence, and the assessor's
// settings. (Live Zetaris evidence is not hashed; the report keeps the
// records it actually read.)
// Why: a comparison made with another model or other evidence is still
// listed, but never presented as the current result for this case.
export function comparisonFingerprint(config: CaseConfig, evidence: ProviderDescription): string {
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "");
  const hash = createHash("sha256");
  hash.update(COMPARISON_SCHEMA);
  hash.update(evidencePolicy(config));
  hash.update(read(path.join(config.scenarioDir, "scenario.json")));
  hash.update(evidence.mode);
  if (evidence.mode === "fixture") hash.update(read(path.join(config.scenarioDir, "evidence.json")));
  hash.update(JSON.stringify({ reasoner: config.reasoner, ...(config.reasoner === "nemotron"
    ? { model: config.nemotron.model, endpoint: config.nemotron.baseUrl, maxTokens: config.nemotron.maxTokens, effort: config.nemotron.reasoningEffort }
    : {}), execution: config.execution }));
  return hash.digest("hex").slice(0, 16);
}

// Pre-registered labels, when the case is an evaluation case.
function loadLabels(scenarioDir: string): Checkpoint[] | null {
  const file = path.join(scenarioDir, "expected.json");
  if (!fs.existsSync(file)) return null;
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { checkpoints?: Checkpoint[] }).checkpoints ?? null;
}

const plain = (record: EvidenceRecord): EvidenceRecord => ({
  id: record.id, caseId: record.caseId, source: record.source, observedAt: record.observedAt, content: record.content,
  facts: record.facts, provenance: record.provenance, retrieval: record.retrieval
});

// What a stateless baseline is given for a case as it stands: every record the
// desk lists as visible, less any the investigator withdrew; and which of them
// a later visible record replaces (derived from the records alone, so the same
// rule applies to both approaches).
export async function visibleRecords(desk: EvidenceDesk): Promise<{ records: EvidenceRecord[]; replaced: Map<string, string>; outdated: Map<string, string> }> {
  const listing = await desk.listEvidence();
  const records = listing.records.filter((record) => record.status !== "withdrawn" && record.invalidation?.kind !== "withdrawn").map(plain);
  const invalid = deriveBasis(records.map((record) => ({ record, judgments: [], withdrawn: null })), []).invalid;
  const of = (kind: "superseded" | "restated") => new Map([...invalid].flatMap(([id, why]) => (why.kind === kind ? [[id, why.by] as [string, string]] : [])));
  return { records, replaced: of("superseded"), outdated: of("restated") };
}

// The evaluation's stateless baseline on those records: one model call with
// the case's Nemotron settings, or the fact rules summed.
export async function statelessAnswer(config: CaseConfig, scenario: Scenario, records: readonly EvidenceRecord[], processor: NemotronProcessor | null): Promise<StatelessSide> {
  if (processor) {
    const callsBefore = processor.calls.length;
    try {
      const answer = await statelessModelAnswer(processor, config.nemotron, scenario, records);
      return {
        method: "nemotron", error: answer.error, concluded: answer.conclusion, cited: answer.cited, rationale: answer.rationale, scores: null, counted: null,
        model: { attempts: answer.attempts, valid: answer.valid, latencyMs: processor.calls.slice(callsBefore).map((call) => call.latencyMs), servedModels: [...processor.servedModels] }
      };
    } catch (error) {
      return { method: "nemotron", error: error instanceof Error ? error.message : String(error), concluded: null, cited: [], rationale: null, scores: null, counted: null, model: null };
    }
  }
  const answer = statelessRulesAnswer(scenario, records);
  return {
    method: "rules", error: null, concluded: answer.conclusion, cited: answer.conclusion ? answer.support[answer.conclusion] ?? [] : [],
    rationale: null, scores: answer.scores, counted: answer.scored, model: null
  };
}

const refOut = (ref: EvidenceRef) => ({
  recordId: ref.recordId, delta: ref.delta, basis: ref.judgment?.basis ?? null, decisive: ref.judgment?.decisive ?? false, rationale: ref.judgment?.rationale ?? null
});

function speckSide(desk: EvidenceDesk, c: Conclusion, run: Awaited<ReturnType<EvidenceDesk["run"]>>, revisions: SpeckSide["revisions"]): SpeckSide {
  const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction.pointsTo?.key) ?? null;
  const concluded = c.state === "supported" ? c.hypothesis?.key ?? null : null;
  return {
    error: run.execution.status === "errored" ? run.execution.error ?? "the run errored" : null,
    state: c.state,
    headline: c.headline,
    concluded,
    route: c.justification.route,
    tentative: concluded ? null : c.hypothesis?.key ?? c.direction.pointsTo?.key ?? null,
    confidence: subject ? subject.confidence : null,
    reasons: c.justification.reasons,
    support: (subject?.supporting ?? []).map(refOut),
    against: (subject?.contradicting ?? []).map(refOut),
    ruledOut: c.direction.eliminated.map((item) => ({ key: item.key, refutedBy: item.refutedBy })),
    noLongerCounted: c.noLongerCounted.map((item) => ({ recordId: item.recordId, explanation: item.explanation, consequences: item.consequences })),
    revisions,
    beliefs: desk.hypotheses().map((view) => ({ key: view.key, status: view.status, confidence: view.confidence })),
    run: {
      runNumber: run.runNumber, status: run.execution.status, unprocessed: run.unprocessed, modelCalls: run.reasonerUsage ? run.reasonerUsage.calls : null,
      modelFailures: run.reasonerUsage ? run.reasonerUsage.failures : null, servedModels: run.reasonerUsage?.servedModels ?? []
    },
    explanation: run.explanation
      ? { text: run.explanation.text, agrees: run.explanation.agreement?.agrees ?? null, problems: run.explanation.agreement?.problems ?? [], invalidCitations: run.explanation.invalidCitations }
      : null
  };
}

function failedSpeck(error: unknown): SpeckSide {
  return {
    error: error instanceof Error ? error.message : String(error), state: null, headline: "", concluded: null, tentative: null, confidence: null,
    support: [], against: [], ruledOut: [], noLongerCounted: [], revisions: [], beliefs: [], run: null, explanation: null
  };
}

function changeOf(previous: string | null | undefined, current: string | null): SideChecks["changed"] {
  if (previous === undefined) return "first";
  if (previous === null) return current === null ? "still none" : "formed";
  if (current === null) return "withdrawn";
  return previous === current ? "retained" : "revised";
}

function checks(input: {
  concluded: string | null; tentative: string | null; error: string | null; presentedSupport: string[];
  visible: Set<string>; replaced: Map<string, string>; outdated: Map<string, string>; previous: string | null | undefined; recordsWhy: boolean;
}): SideChecks {
  const held = input.concluded ?? input.tentative;
  return {
    commits: input.concluded !== null,
    abstains: input.concluded === null && !input.error,
    presentedSupport: input.presentedSupport,
    unknownCitations: input.presentedSupport.filter((id) => !input.visible.has(id)),
    supportFromReplaced: input.presentedSupport.filter((id) => input.replaced.has(id)),
    supportFromOutdated: input.presentedSupport.filter((id) => input.outdated.has(id)),
    changed: input.error ? "still none" : changeOf(input.previous, held),
    recordsWhy: input.recordsWhy
  };
}

// Scored exactly as src/eval/metrics.ts scores a checkpoint.
function labelScore(label: Checkpoint, concluded: string | null, presented: string[], support: string[], visible: Set<string>, error: string | null): LabelScore {
  return {
    expected: label.conclusion,
    correct: !error && concluded === label.conclusion,
    unsupportedClaim: concluded !== null && (label.unsupported.includes(concluded) || support.filter((id) => visible.has(id)).length === 0),
    presentedRuledOut: presented.filter((key) => label.notCurrent.includes(key)),
    abstention: concluded !== null || error ? null : label.conclusion === null ? "appropriate" : "inappropriate"
  };
}

// Why the two approaches differ at a stage, from what each returned.
// Why derived, not written by a model: it must say only what the two outputs
// show, for every stage of every saved comparison alike.
function disagreement(speck: SpeckSide, stateless: StatelessSide, checks: { speck: SideChecks; stateless: SideChecks }): string | null {
  if (speck.error || stateless.error) {
    return [speck.error ? `Speck's run failed (${speck.error.slice(0, 160)})` : "", stateless.error ? `the stateless call failed (${stateless.error.slice(0, 160)})` : ""].filter(Boolean).join("; ") + ".";
  }
  if (speck.concluded === stateless.concluded) return null;
  const parts: string[] = [];
  if (speck.concluded) {
    parts.push(`Speck concludes ${speck.concluded}${speck.route === "corroboration" ? " by corroboration (its own confidence is below its threshold)" : ""}`);
  } else {
    const blocking = (speck.reasons ?? []).find((reason) => reason.startsWith("Not corroborated")) ?? (speck.reasons ?? [])[0];
    parts.push(`Speck concludes nothing${speck.tentative ? ` (it points to ${speck.tentative})` : ""}${blocking ? `: ${blocking.replace(/\.$/, "")}` : ""}`);
  }
  if (stateless.concluded) {
    const stale = [...checks.stateless.supportFromReplaced, ...(checks.stateless.supportFromOutdated ?? [])];
    parts.push(`the stateless call concludes ${stateless.concluded} citing ${stateless.cited.join(", ") || "nothing"}${stale.length ? `, including ${stale.join(", ")}, which no longer count${stale.length === 1 ? "s" : ""}` : ""}`);
  } else {
    parts.push("the stateless call concludes nothing");
  }
  return `${parts.join("; ")}.`;
}

export async function runComparison(config: CaseConfig, options: {
  provider: EvidenceProvider;
  onProgress?: (progress: ComparisonProgress) => void;
}): Promise<ComparisonReport> {
  const started = new Date();
  const scenario: Scenario = loadScenario(config.scenarioDir);
  const labels = loadLabels(config.scenarioDir);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-compare-"));
  const deskConfig: CaseConfig & Pick<AppConfig, "databasePath"> = { ...config, databasePath: path.join(scratch, "speck.sqlite"), historyDir: path.join(scratch, "meterless") };
  const evidence = options.provider.describe();
  const processor = config.reasoner === "nemotron" ? new NemotronProcessor(config.nemotron) : null;
  const desk = await EvidenceDesk.open(deskConfig, { provider: options.provider });
  const stages: StageComparison[] = [];
  let previousSpeck: string | null | undefined;
  let previousStateless: string | null | undefined;
  let seenRecords = new Set<string>();
  try {
    for (const [index, stage] of scenario.stages.entries()) {
      if (index > 0) await desk.introduceNextUpdate();
      options.onProgress?.({ stage: stage.label, step: "speck", index, of: scenario.stages.length });

      // Speck: run the case it has carried from the previous stage.
      const recomputationsBefore = desk.recomputations().length;
      let speck: SpeckSide;
      try {
        const run = await desk.run();
        const revisions = desk.recomputations().slice(recomputationsBefore).flatMap((recomputation) => recomputation.hypotheses.map((item) => ({
          key: item.key, mode: item.mode ?? "replaced", before: { status: item.previous.status, confidence: item.previous.confidence },
          cause: item.cause, dropped: item.dropped.map((drop) => `${drop.recordId} (${drop.reason})`)
        })));
        speck = speckSide(desk, desk.conclusionFromSpeck(), run, revisions);
      } catch (error) {
        speck = failedSpeck(error);
      }

      // The records visible at this stage, exactly as Speck's desk lists them.
      const { records, replaced, outdated } = await visibleRecords(desk);
      const visible = new Set(records.map((record) => record.id));

      // Stateless: the same records, from scratch, with no memory of the last stage.
      options.onProgress?.({ stage: stage.label, step: "stateless", index, of: scenario.stages.length });
      const stateless = await statelessAnswer(config, scenario, records, processor);

      const speckPresented = [...new Set([speck.concluded, speck.tentative].filter((key): key is string => Boolean(key)))];
      const speckSupport = [...new Set(speck.support.map((ref) => ref.recordId))];
      const statelessSupport = stateless.concluded ? [...new Set(stateless.cited)] : [];
      const label = labels?.find((checkpoint) => checkpoint.afterStage === stage.id) ?? null;
      const stageChecks = {
        speck: checks({ concluded: speck.concluded, tentative: speck.tentative, error: speck.error, presentedSupport: speckSupport, visible, replaced, outdated, previous: previousSpeck,
          recordsWhy: speck.revisions.length > 0 || speck.noLongerCounted.length > 0 }),
        stateless: checks({ concluded: stateless.concluded, tentative: null, error: stateless.error, presentedSupport: statelessSupport, visible, replaced, outdated, previous: previousStateless, recordsWhy: false })
      };
      stages.push({
        stage: { id: stage.id, label: stage.label, asOf: stage.asOf },
        visible: records.map((record) => ({
          id: record.id, source: record.source.name, observedAt: record.observedAt, content: record.content, supersedes: record.provenance.supersedes,
          replacedBy: replaced.get(record.id) ?? null,
          outdatedBy: outdated.get(record.id) ?? null,
          retrieval: { mode: record.retrieval.mode, location: record.retrieval.location, queryToken: record.retrieval.queryToken ?? null }
        })),
        arrived: records.filter((record) => !seenRecords.has(record.id)).map((record) => record.id),
        replaced: [...replaced].map(([recordId, by]) => ({ recordId, by })),
        speck,
        stateless,
        checks: stageChecks,
        label: label ? {
          checkpoint: label,
          speck: labelScore(label, speck.concluded, speckPresented, speck.concluded ? speckSupport : [], visible, speck.error),
          stateless: labelScore(label, stateless.concluded, stateless.concluded ? [stateless.concluded] : [], statelessSupport, visible, stateless.error)
        } : null,
        disagreement: disagreement(speck, stateless, stageChecks)
      });
      if (!speck.error) previousSpeck = speck.concluded ?? speck.tentative;
      if (!stateless.error) previousStateless = stateless.concluded;
      seenRecords = new Set([...seenRecords, ...visible]);
    }
  } finally {
    desk.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS cleans its temporary folder */ }
  }

  const finished = new Date();
  const live = config.reasoner === "nemotron" || evidence.mode === "zetaris";
  return {
    schema: COMPARISON_SCHEMA,
    id: `${finished.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    kind: live ? "live" : "deterministic",
    case: {
      caseId: scenario.caseId, title: scenario.title, question: scenario.question,
      hypotheses: scenario.hypotheses.map((hypothesis) => ({ key: hypothesis.key, statement: hypothesis.statement, prior: hypothesis.prior }))
    },
    configuration: {
      evidence,
      assessor: config.reasoner === "nemotron"
        ? { kind: "nemotron", model: config.nemotron.model, endpoint: config.nemotron.baseUrl, temperature: 0.1, maxTokens: config.nemotron.maxTokens, reasoningEffort: config.nemotron.reasoningEffort || null }
        : { kind: "rules", model: null, endpoint: null, temperature: null, maxTokens: null, reasoningEffort: null },
      speck: "Evidence Desk as built: one Speck case carried across the stages on a temporary Speck database (the case on the page is not touched). Each stage's new records are assessed and Speck's beliefs revised; a record replaced by a later one stops counting and the beliefs that rested on it are rebuilt.",
      stateless: config.reasoner === "nemotron"
        ? "The evaluation's stateless model baseline: at each stage, one call to the same Nemotron endpoint with the question, the explanations and every visible record (its text, its facts, and \"replaces …\" where the source says so). It keeps nothing between stages."
        : "The evaluation's stateless rule baseline: at each stage, the same fact rules summed from scratch (reliability × strength, contradictions negative); the top positive score is its conclusion. It keeps nothing between stages and has no notion of a replaced record.",
      labels: labels ? "Pre-registered labels from the case's expected.json, written before any system was run on it." : "No pre-registered labels: this case is not an evaluation case.",
      policy: evidencePolicy(config)
    },
    fingerprint: comparisonFingerprint(config, evidence),
    stages,
    notes: [
      "Both approaches saw the same records at every stage, the same question and explanations, and the same assessor configuration.",
      "Speck counts a conclusion only when it holds it as supported; a leading or pointed-to explanation is tentative. The stateless baseline has no such threshold beyond answering \"unresolved\" (model) or a tie or non-positive score (rules).",
      "Differences come from Speck's explicit evidence and revision state and its conclusion policy (thresholds, decisive refutation, supersession), not from persistence alone: the evaluation's speck-fresh system, which rebuilds from scratch each time, reaches the same conclusions as speck-desk.",
      ...(config.reasoner === "nemotron" ? [
        "Live: model judgments vary between runs. This is one sample, not a rate. Speck calls the model per evidence chunk plus once for its explanation; the baseline calls it once per stage, so call counts and latency are not like for like.",
        "Speck caps model-judged evidence at reliability 0.4, so Speck's own confidence rarely reaches its 0.6 threshold live. Since Build 4 Evidence Desk can still conclude by corroboration (two or more source systems agree, nothing recorded against, every rival ruled out or unsupported); each such conclusion is marked, with Speck's own confidence beside it."
      ] : ["Deterministic: no model was called; the same inputs give the same result every time."])
    ]
  };
}

// ----- Saved comparisons -----
//
// Each comparison is saved as its own file and never overwritten, so earlier
// results stay. A file is written whole (temporary file, then rename), so an
// interrupted write never leaves a partial comparison that could be shown.
//
// Two places, both per scenario: comparisons run from the page (beside the
// case's other data), and comparisons run with npm run compare / compare:live
// (eval/results/comparisons/ in the repository). The page reads both.

export const publishedComparisonsDir = (rootDir: string, scenarioId: string) =>
  path.join(repositoryRoot(rootDir), "eval", "results", "comparisons", scenarioId);

export const pageComparisonsDir = (config: CaseConfig, scenarioId: string) =>
  path.join(path.dirname(config.historyDir), "comparisons", scenarioId);

export function saveComparison(dir: string, report: ComparisonReport): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return file;
}

export interface ComparisonIndexEntry {
  id: string;
  finishedAt: string;
  kind: ComparisonReport["kind"];
  // Whether it was made with this case's current scenario, evidence and assessor settings.
  matchesCurrent: boolean;
  origin: "page" | "command";
  evidence: string;
  assessor: string;
}

export interface SavedComparisons {
  // The newest comparison made with the current settings, if any.
  current: ComparisonReport | null;
  // Every readable comparison, newest first.
  index: ComparisonIndexEntry[];
  // Files that could not be read (an interrupted write leaves only a .tmp,
  // which is ignored; anything else unreadable is counted here).
  unreadable: number;
}

function readReports(dir: string): { reports: ComparisonReport[]; unreadable: number } {
  if (!fs.existsSync(dir)) return { reports: [], unreadable: 0 };
  let unreadable = 0;
  const reports: ComparisonReport[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ComparisonReport;
      if (report.schema !== COMPARISON_SCHEMA || !Array.isArray(report.stages)) throw new Error("not a comparison");
      reports.push(report);
    } catch {
      unreadable += 1;
    }
  }
  return { reports, unreadable };
}

export function loadComparisons(dirs: { page: string; command: string }, fingerprint: string): SavedComparisons & { byId: Map<string, ComparisonReport> } {
  const page = readReports(dirs.page);
  const command = path.resolve(dirs.command) === path.resolve(dirs.page) ? { reports: [], unreadable: 0 } : readReports(dirs.command);
  const all = [...page.reports.map((report) => ({ report, origin: "page" as const })), ...command.reports.map((report) => ({ report, origin: "command" as const }))]
    .sort((left, right) => right.report.finishedAt.localeCompare(left.report.finishedAt));
  return {
    current: all.find((item) => item.report.fingerprint === fingerprint)?.report ?? null,
    index: all.map(({ report, origin }) => ({
      id: report.id, finishedAt: report.finishedAt, kind: report.kind, matchesCurrent: report.fingerprint === fingerprint, origin,
      evidence: report.configuration.evidence.mode === "zetaris" ? "Zetaris live" : "fixture file",
      assessor: report.configuration.assessor.kind === "nemotron" ? `Nemotron ${report.configuration.assessor.model}` : "deterministic rules"
    })),
    unreadable: page.unreadable + command.unreadable,
    byId: new Map(all.map(({ report }) => [report.id, report]))
  };
}

