// The guided investigation and the feature guide. Pure definitions over the
// page's real state (the same API payloads the page renders), so the tour
// never shows a scripted result: every sentence about the case is built from
// what Speck currently holds, and an action step is complete only when the
// state shows its action happened. app.js renders it.
//
// view = { status, investigation, listing, trace, comparison }, any of which may be null.

import { findings } from "./compare.js";

const runs = (view) => view.investigation?.runs ?? [];
const current = (view) => view.investigation?.current ?? null;
const latestRun = (view) => view.investigation?.latestRun ?? null;
const pending = (view) => view.listing?.pending ?? [];
const stages = (view) => view.status?.stages ?? [];
const stageMoved = (view) => Boolean(view.status && stages(view).length && view.status.stage.id !== stages(view)[0].id);
const records = (view) => view.listing?.records ?? [];

// The explanation the conclusion is about: the conclusion itself, or the one
// the evidence points to while it is not yet established.
export function subjectOf(conclusion) {
  if (!conclusion) return null;
  return conclusion.hypothesis ?? conclusion.alternatives?.find((view) => view.key === conclusion.direction?.pointsTo?.key) ?? null;
}

export const STATE_MEANING = {
  supported: "Supported: Speck holds this explanation at or above its supported threshold, and evidence that still counts supports it.",
  leading: "Leading: this explanation is ahead of the others by a clear margin, but not established. Treat it as the current best reading, not a finding.",
  unresolved: "Unresolved: no explanation is far enough ahead to point to. The evidence conflicts, or there is not enough of it."
};

export const CONFIDENCE_MEANING = "Confidence is Speck's belief-revision score: each record that counts moves it by an amount set by its source's reliability and how it bears on the explanation. It is not a calibrated probability.";

function modeLines(view) {
  const evidence = view.status?.evidence;
  const reasoner = view.status?.reasoner;
  return [
    evidence?.mode === "zetaris"
      ? "Evidence is queried live from Zetaris for this case."
      : "Evidence comes from this case's local fixture file (not from Zetaris).",
    reasoner?.kind === "nemotron"
      ? `Records are weighed by the model (${reasoner.label}, ${reasoner.model}), with the scenario's decisive rules taking precedence. A live run can take up to about 35 seconds.`
      : "Records are weighed by the scenario's deterministic fact rules; no model is called."
  ];
}

function runSummary(view) {
  const run = latestRun(view);
  const c = current(view);
  if (!run || !c) return [];
  return [
    `Run ${run.runNumber} finished with status "${run.execution.status}" and assessed ${run.assessed.length} new record(s).`,
    `Speck's conclusion now: ${c.headline}`
  ];
}

const describeInvalidation = (item) => item.invalidation.kind === "superseded"
  ? `its source replaced it with ${item.invalidation.by}`
  : `it was withdrawn (${item.invalidation.reason})`;

// The record the tour opens: the first one currently supporting the subject,
// or else the first assessed record.
export function recordToInspect(view) {
  const subject = subjectOf(current(view));
  const supportingId = subject?.supporting?.[0]?.recordId;
  return records(view).find((record) => record.id === supportingId)
    ?? records(view).find((record) => record.assessed && !record.invalidation) ?? null;
}

export const TOUR_STEPS = [
  {
    id: "case",
    title: "The case and its competing explanations",
    target: "case",
    body: (view) => {
      const hypotheses = view.investigation?.hypotheses ?? [];
      return [
        view.status ? `${view.status.case.title}. ${view.status.case.question}` : "Loading the case…",
        `Evidence Desk weighs competing explanations against the evidence, rather than asking for one answer. This case has ${hypotheses.length}:`,
        hypotheses.map((h) => `${h.key}: ${h.statement}`),
        "Each starts from a prior the scenario sets; every record that counts then moves them up or down."
      ];
    }
  },
  {
    id: "run",
    title: "Run the investigation",
    target: "run-button",
    action: "run",
    goal: (view) => runs(view).length >= 1,
    body: (view) => [
      "Run investigation reads the evidence available at the current stage, judges how each record bears on each explanation, and records the results in Speck, the reasoning runtime that holds the case.",
      ...modeLines(view),
      "Click Run investigation."
    ],
    after: (view) => runSummary(view)
  },
  {
    id: "conclusion",
    title: "Read the current conclusion",
    target: "conclusion",
    body: (view) => {
      const c = current(view);
      if (!c) return ["No conclusion yet: run the investigation first."];
      const subject = subjectOf(c);
      const t = c.justification?.thresholds;
      return [
        c.headline,
        STATE_MEANING[c.state] ?? c.state,
        c.justification?.confidence !== null && c.justification?.confidence !== undefined
          ? `Speck confidence ${c.justification.confidence}${t ? ` (supported needs ${t.supported}; leading needs ${t.leading} and a ${t.leadingMargin} margin)` : ""}. ${CONFIDENCE_MEANING}`
          : CONFIDENCE_MEANING,
        subject?.supporting?.length
          ? [`Supporting ${subject.key} now: ${subject.supporting.map((ref) => `${ref.recordId} (${ref.sourceName})`).join(", ")}.`]
          : [],
        subject?.contradicting?.length
          ? [`Against it: ${subject.contradicting.map((ref) => `${ref.recordId} (${ref.sourceName})`).join(", ")}.`]
          : [],
        "Every line of the conclusion is tied to the records behind it."
      ].flat();
    }
  },
  {
    id: "record",
    title: "Open an evidence record",
    target: "record",
    body: (view) => {
      const record = recordToInspect(view);
      if (!record) return ["Evidence appears here once the case's records have been read."];
      const judgments = record.assessment?.judgments ?? [];
      return [
        `${record.id}, from ${record.source.name}: "${record.content}"`,
        `Stated by the source: ${Object.entries(record.facts).map(([key, value]) => `${key}=${value}`).join(", ") || "no structured facts"}. These are the record's own claims, not anyone's interpretation.`,
        judgments.length
          ? `How it was weighed: ${judgments.map((j) => `${j.basis === "rule" ? "a deterministic rule" : "a model interpretation"} says it ${j.direction} ${j.hypothesisKey}${j.decisive ? " decisively" : ""}`).join("; ")}.`
          : "It has no bearing on any explanation.",
        `Provenance: ${record.provenance.systemOfRecord}, reference ${record.provenance.recordRef}, author ${record.provenance.author}. Read ${record.retrieval.mode === "zetaris" ? "live from Zetaris" : "from the local fixture file"}.`
      ];
    }
  },
  {
    id: "update",
    title: "Introduce the prepared update",
    target: "update-button",
    action: "update",
    goal: stageMoved,
    body: (view) => {
      const next = view.status?.nextStage;
      const nextStage = stages(view).find((stage) => stage.id === next?.id);
      return [
        next ? `The next stage of this case is "${next.label}"${nextStage?.description ? `: ${nextStage.description}` : "."}` : "This case has no further prepared update.",
        "Introducing it releases the records observed by then, as they arrived in the case. They arrive unassessed: no belief changes until the investigation runs again.",
        "Click Introduce prepared update."
      ];
    },
    after: (view) => [
      `Stage now: ${view.status?.stage.label}.`,
      pending(view).length ? `Waiting to be assessed: ${pending(view).join(", ")}. The conclusion above still reflects the earlier evidence.` : "Every record at this stage is already assessed."
    ]
  },
  {
    id: "rerun",
    title: "Run it again",
    target: "run-button",
    action: "run",
    goal: (view) => stageMoved(view) && pending(view).length === 0 && latestRun(view)?.stage?.id === view.status?.stage.id,
    body: () => ["Run the investigation again to assess the new records. Click Run investigation."],
    after: (view) => {
      const list = runs(view);
      const previous = list.at(-2);
      return [
        ...runSummary(view),
        previous ? `Before this run, run ${previous.runNumber} had concluded: ${previous.conclusion}${previous.hypothesis ? ` ${previous.hypothesis}` : ""}.` : null
      ].filter(Boolean);
    }
  },
  {
    id: "changed",
    title: "See what no longer counts, and why",
    target: "why",
    body: (view) => {
      const c = current(view);
      const items = c?.noLongerCounted ?? [];
      const recomputations = view.investigation?.history?.recomputations ?? [];
      if (!items.length) return ["No record has stopped counting in this case so far. When a source corrects a record, it appears here."];
      return [
        ...items.map((item) => `${item.recordId} no longer counts: ${describeInvalidation(item)}.${item.lostJudgments?.length ? ` Judgments no longer applied: ${item.lostJudgments.map((j) => `${j.direction} ${j.hypothesisKey}`).join("; ")}.` : ""}`),
        recomputations.length
          ? `Speck rebuilt the affected explanations from the evidence that still counts (${recomputations.length} recomputation${recomputations.length === 1 ? "" : "s"}), instead of leaving the old record's effect in place.`
          : null,
        "In the evidence list, the replaced record is struck through and marked as no longer counting; its history is kept."
      ].filter(Boolean);
    }
  },
  {
    id: "history",
    title: "History and remaining uncertainty",
    target: "timeline",
    body: (view) => {
      const c = current(view);
      const replaced = view.investigation?.history?.replaced ?? [];
      return [
        "The revision timeline is Speck's own event log: every stage, record and belief change, in order. Entries about beliefs since replaced are marked historical.",
        replaced.length ? `${replaced.length} earlier belief(s) are kept as history and never presented as current.` : null,
        c?.justification?.wouldChange?.length ? `What would make the conclusion firmer: ${c.justification.wouldChange.join(" ")}` : null,
        c?.openQuestions?.length ? `Still open: ${c.openQuestions.map((q) => q.text).join(" ")}` : null
      ].filter(Boolean);
    }
  },
  {
    id: "compare",
    title: "One more view: the same case through a stateless baseline",
    target: "compare",
    action: "compare",
    actionLabel: "Run the side-by-side comparison",
    goal: (view) => Boolean(view.comparison?.current) && !view.comparison?.running,
    body: (view) => [
      "You have seen Speck revise this case. The panel opened at the bottom of the page runs the whole case again on the same records, stage by stage: once as a stateless baseline that answers from scratch each time (a model call when the case is live, the fact rules otherwise), and once through Speck, which keeps the evidence, its beliefs and every revision.",
      "Watch the correction stage: whether each approach changes its answer, whether it still leans on the record that was replaced, and whether it can say why it changed.",
      view.comparison?.willRun?.kind === "live"
        ? "This case is live: both approaches make real model calls, so it takes about 20-60 seconds and the result can differ from run to run."
        : "This case is deterministic (fixture evidence, fact rules), so it finishes in a second.",
      "It runs on a temporary copy; the case above is not changed. Click Run the side-by-side comparison."
    ],
    after: (view) => {
      const report = view.comparison?.current;
      if (!report) return [];
      return [
        `${report.kind === "live" ? "Live" : "Deterministic"} comparison of ${new Date(report.finishedAt).toLocaleString()}:`,
        ...findings(report).map((finding) => [`${finding.title}.`, finding.lines]),
        "The panel stays at the bottom of every case, closed until you open it."
      ].flat();
    }
  },
  {
    id: "more",
    title: "Everything else",
    target: "guide-button",
    body: () => [
      "Withdraw: any record can be withdrawn, for example one filed against the wrong case. Beliefs that rested on it are recomputed without it. It cannot be undone from this page, so the tour does not do it.",
      "Failed assessments and recovery: a record that cannot be assessed stays \"not yet assessed\" and is retried on the next run; nothing is guessed for it. Judgments are saved before evidence enters Speck, so an interrupted run is reconciled on the next run or restart.",
      "Execution trace: what each component did in each run, read back from what was saved.",
      "The Guide button reopens this tour and lists every feature, marking the ones this case has actually demonstrated.",
      "Reset demo case starts a fresh copy of the case for the next person, without deleting anything."
    ]
  }
];

// Whether a step is complete in the current state. Steps without an action
// are complete once shown.
export function stepDone(step, view) {
  return step.goal ? Boolean(step.goal(view)) : true;
}

// Features that exist in this product, each with a real-state test for
// "demonstrated" and, where it depends on configuration, availability.
export const FEATURES = [
  { id: "compare", title: "Speck beside a stateless baseline", target: "compare",
    text: "Runs the case twice on the same records: a stateless baseline from scratch at each stage, and Speck with its evidence, beliefs and revisions. Shows what each concludes, what it cites, and what happens at the correction.",
    demonstrated: (view) => Boolean(view.comparison?.current) },
  { id: "decisive", title: "Decisive mode (experimental)", target: "conclusion",
    text: "An optional second reading beside Speck's conclusion: a stateless answer is accepted only if every record it cites still counts and Speck holds or points to the same explanation. Switch it on at the top of the conclusion (or in the comparison panel). Its one model call is made with reasoning on. It never changes Speck's belief state, and it has not been evaluated beyond the cases it was designed on." },
  { id: "run", title: "Run an investigation", target: "run-button",
    text: "Assesses the evidence available at the current stage and updates Speck's beliefs.",
    demonstrated: (view) => runs(view).length >= 1 },
  { id: "update", title: "Introduce a prepared update", target: "update-button",
    text: "Releases the next stage of the case's evidence, as it arrived. Records arrive unassessed.",
    demonstrated: stageMoved },
  { id: "provenance", title: "Evidence sources and provenance", target: "evidence",
    text: "Each record shows its source, the facts it states, its system of record and how it was retrieved." },
  { id: "judgments", title: "Rules versus model interpretations", target: "evidence",
    text: "Each judgment is labelled as a deterministic rule or a model interpretation. Speck caps model-judged evidence at reliability 0.4.",
    available: (view) => view.status?.reasoner?.kind === "nemotron"
      ? { ok: true }
      : { ok: true, note: "This case uses the rule assessor, so every judgment here is a deterministic rule. Model interpretations appear when a model provider is configured (npm run configure)." },
    demonstrated: (view) => records(view).some((record) => record.assessment?.judgments?.some((j) => j.basis === "model")) },
  { id: "confidence", title: "Conclusion states and confidence", target: "conclusion",
    text: "Supported, leading or unresolved, with Speck's confidence score. The score is not a calibrated probability." },
  { id: "supersession", title: "Replaced evidence and why a conclusion changed", target: "why",
    text: "When a source corrects a record, the old one stops counting and the beliefs that rested on it are rebuilt.",
    demonstrated: (view) => (current(view)?.noLongerCounted ?? []).some((item) => item.invalidation.kind === "superseded") },
  { id: "withdraw", title: "Withdraw a record", target: "evidence",
    text: "Removes a record from the case; beliefs that rested on it are recomputed. Cannot be undone from this page.",
    demonstrated: (view) => records(view).some((record) => record.invalidation?.kind === "withdrawn" || record.status === "withdrawn") },
  { id: "recovery", title: "Failed assessments and recovery", target: "evidence",
    text: "Unassessable records stay pending and are retried; an interrupted run is reconciled from what was saved. Shown here only when it happens.",
    demonstrated: (view) => records(view).some((record) => record.status === "failed")
      || (view.trace?.entries ?? []).some((entry) => entry.status === "interrupted" || entry.flags?.recovered?.length) },
  { id: "timeline", title: "Revision timeline", target: "timeline",
    text: "Speck's event log for the case: stages, records and belief changes, with replaced beliefs marked historical." },
  { id: "trace", title: "Execution trace", target: "trace",
    text: "What the evidence source, the execution engine, the assessor and Speck did in each run, read back from saved state." },
  { id: "reset", title: "Reset the demo case", target: "reset-button",
    text: "Starts a fresh copy of the case at its first stage. Nothing is deleted: the previous copy is kept in Speck, suspended, with its history.",
    demonstrated: (view) => (view.status?.case?.generation ?? 1) > 1 },
  { id: "zetaris", title: "Live evidence from Zetaris", target: "evidence",
    text: "Records queried live from a Zetaris platform, each with its query token.",
    available: (view) => view.status?.evidence?.mode === "zetaris"
      ? { ok: true }
      : { ok: false, note: "This case reads its local fixture file. Live Zetaris evidence needs EVIDENCE_MODE=zetaris and a running Zetaris platform." },
    demonstrated: (view) => records(view).some((record) => record.retrieval?.mode === "zetaris") },
  { id: "explanation", title: "Model explanation, checked against Speck", target: "conclusion",
    text: "The model's written explanation, shown only when it matches Speck's belief state.",
    available: (view) => view.status?.reasoner?.kind === "nemotron"
      ? { ok: true }
      : { ok: false, note: "Needs the Nemotron assessor; the rule assessor writes no explanation." },
    demonstrated: (view) => Boolean(latestRun(view)?.explanation) }
];

export function featureStatus(feature, view, viewed) {
  const availability = feature.available ? feature.available(view) : { ok: true };
  const demonstrated = feature.demonstrated ? Boolean(feature.demonstrated(view)) : false;
  return {
    available: availability.ok,
    note: availability.note ?? null,
    state: demonstrated ? "demonstrated" : viewed.has(feature.id) ? "viewed" : "not yet"
  };
}

// Per-viewer progress (first-run card dismissed, tour step, features viewed),
// kept in browser storage. Storage can be unavailable; then nothing is kept
// and the page still works.
export function progressStore(storage, scope) {
  const key = (name) => `edk:${scope}:${name}`;
  const read = (name, fallback) => {
    try { const value = storage?.getItem(key(name)); return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
  };
  const write = (name, value) => { try { storage?.setItem(key(name), JSON.stringify(value)); } catch { /* not kept */ } };
  return {
    introDismissed: () => read("intro-dismissed", false) === true,
    dismissIntro: () => write("intro-dismissed", true),
    showIntroAgain: () => write("intro-dismissed", false),
    tourStep: () => { const step = read("tour-step", null); return Number.isInteger(step) && step >= 0 && step < TOUR_STEPS.length ? step : null; },
    setTourStep: (step) => write("tour-step", step),
    viewed: () => new Set(read("viewed", [])),
    markViewed: (id) => { const set = new Set(read("viewed", [])); set.add(id); write("viewed", [...set]); },
    coachCollapsed: () => read("coach-collapsed", false) === true,
    setCoachCollapsed: (collapsed) => write("coach-collapsed", Boolean(collapsed)),
    // After the demo case is reset: the next person starts from the introduction.
    resetForDemo: () => { write("intro-dismissed", false); write("tour-step", null); write("viewed", []); write("coach-collapsed", false); }
  };
}
