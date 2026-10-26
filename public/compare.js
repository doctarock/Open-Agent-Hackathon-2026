// Speck beside a stateless baseline, on the same case: the comparison panel and
// the evaluation results. Plain DOM, every server value inserted as text.
//
// The findings are sentences built from a saved comparison report
// (src/compare/comparison.ts): what each approach concluded at each stage,
// what the correction replaced, whether either leaned on the replaced record,
// and whether each recorded why it changed. Nothing here decides an outcome;
// the same templates describe whatever the two approaches actually returned.
// The pure functions are tested in test/compare.test.ts.

import { DECISIVE_EXPLANATION, decisiveForStage } from "./decisive.js";

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const badge = (text, kind) => el("span", { className: `badge ${kind ?? ""}` }, text);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const list = (items) => items.join(", ");

// ----- What the report says, in words (pure) -----

// What an approach holds at a stage: a firm conclusion, a tentative one
// (Speck's leading or pointed-to explanation), nothing, or an error.
export function heldAt(report, index, side) {
  const stage = report.stages[index];
  const outcome = stage[side];
  if (outcome.error) return { kind: "error", key: null, text: `stopped with an error (${outcome.error})` };
  if (outcome.concluded) {
    return { kind: "firm", key: outcome.concluded, text: side !== "speck" ? `concludes ${outcome.concluded}`
      : outcome.route === "corroboration" ? `concludes ${outcome.concluded} by corroboration (Speck's own confidence ${outcome.confidence} is below its threshold)`
      : `concludes ${outcome.concluded} (supported, ${outcome.confidence})` };
  }
  if (side === "speck" && outcome.tentative) {
    return { kind: "tentative", key: outcome.tentative, text: `${outcome.state === "leading" ? "leans towards" : "points to"} ${outcome.tentative} (${outcome.state}, ${outcome.confidence}) but does not conclude it` };
  }
  return { kind: "none", key: null, text: side === "speck" ? "concludes nothing: the evidence does not establish an explanation" : "answers \"unresolved\"" };
}

// The first stage at which a record replaces an earlier one, if any.
export function correctionIndex(report) {
  return report.stages.findIndex((stage, index) => stage.replaced.some((item) => !(report.stages[index - 1]?.replaced ?? []).some((before) => before.recordId === item.recordId)));
}

// The stateless side is a model call in live mode, and the same fact rules
// summed afresh in deterministic mode; it is named for what it was.
export const statelessName = (report) => (report.configuration.assessor.kind === "nemotron" ? "Stateless model call" : "Stateless rule scoring");

const statement = (report, key) => report.case.hypotheses.find((h) => h.key === key)?.statement ?? "";

// Short, factual findings for the top of the panel.
export function findings(report) {
  const out = [];
  const last = report.stages.length - 1;
  const first = { speck: heldAt(report, 0, "speck"), stateless: heldAt(report, 0, "stateless") };
  out.push({ id: "initial", title: `First, on the initial evidence (${report.stages[0].visible.length} records)`,
    lines: [`${statelessName(report)}: ${first.stateless.text}.`, `Speck: ${first.speck.text}.`,
      first.stateless.kind === "firm" && first.speck.kind !== "firm"
        ? `The stateless baseline commits where Speck does not: ${report.stages[0].speck.against.length ? `Speck counts ${list(report.stages[0].speck.against.map((ref) => ref.recordId))} against it` : "the evidence is not yet enough for Speck's threshold"}.`
        : null].filter(Boolean) });

  // Every stage at which a record replaces an earlier one. Why all of them:
  // in a case with several corrections (set 7's hotel chargeback) the one
  // that separates the approaches can be a later one.
  const corrections = report.stages.map((_, index) => index).filter((index) => index > 0 && report.stages[index].replaced.some((item) => !report.stages[index - 1].replaced.some((before) => before.recordId === item.recordId)));
  for (const [n, c] of corrections.entries()) {
    const stage = report.stages[c];
    const newly = stage.replaced.filter((item) => !report.stages[c - 1].replaced.some((before) => before.recordId === item.recordId));
    const lines = [];
    for (const side of ["stateless", "speck"]) {
      const before = heldAt(report, c - 1, side);
      const after = heldAt(report, c, side);
      const checks = stage.checks[side];
      const name = side === "speck" ? "Speck" : statelessName(report);
      const move = checks.changed === "revised" ? `revised: ${before.key} → ${after.key}`
        : checks.changed === "retained" ? `kept ${after.key}`
        : checks.changed === "withdrawn" ? `dropped ${before.key} and now concludes nothing`
        : checks.changed === "formed" ? `formed a view: ${after.key}`
        : after.kind === "error" ? "stopped with an error" : "still has no view";
      lines.push(`${name}: ${move}. Now it ${after.text}.`
        + (checks.supportFromReplaced.length ? ` It still cites ${list(checks.supportFromReplaced)} as support, although ${list(checks.supportFromReplaced.map((id) => stage.replaced.find((item) => item.recordId === id)?.by))} replaced it.` : ""));
    }
    const speck = stage.speck;
    lines.push(speck.noLongerCounted.length || speck.revisions.length
      ? `Only Speck records why: ${list(speck.noLongerCounted.map((item) => `${item.recordId} no longer counts`))}${speck.revisions.length ? `; it rebuilt ${list([...new Set(speck.revisions.map((r) => r.key))])} from the evidence that still counts` : ""}. The stateless baseline keeps no record of its earlier answer.`
      : "Neither approach recorded why its conclusion changed.");
    out.push({ id: n === 0 ? "correction" : `correction-${n + 1}`, title: `${n === 0 ? "Then the correction arrives" : `Then a further correction (${stage.stage.label})`}: ${list(newly.map((item) => `${item.by} replaces ${item.recordId}`))}`, lines });
  }
  if (!corrections.length) {
    out.push({ id: "correction", title: "No record in this case replaces another", lines: ["The comparison shows how each approach weighs evidence that only accumulates."] });
  }

  const labelled = report.stages.filter((stage) => stage.label);
  if (labelled.length) {
    const score = (side) => labelled.filter((stage) => stage.label[side].correct).length;
    const unsupported = (side) => labelled.filter((stage) => stage.label[side].unsupportedClaim).length;
    out.push({ id: "labels", title: "Against the pre-registered labels",
      lines: [`Matches the label: Speck ${score("speck")} of ${labelled.length} stages; stateless ${score("stateless")} of ${labelled.length}.`,
        `Unsupported conclusions: Speck ${unsupported("speck")}; stateless ${unsupported("stateless")}.`,
        "The labels were written before any system ran on this case. One case is an illustration, not an accuracy figure."] });
  }

  const end = { speck: heldAt(report, last, "speck"), stateless: heldAt(report, last, "stateless") };
  if (end.speck.key && end.speck.key === end.stateless.key) {
    out.push({ id: "same", title: `Both end on ${end.speck.key}`, lines: [
      `${statement(report, end.speck.key)}${end.speck.kind !== end.stateless.kind ? ` Speck ${end.speck.kind === "firm" ? "concludes it" : "holds it tentatively"}; the stateless baseline ${end.stateless.kind === "firm" ? "concludes it" : "does not"}.` : ""}`,
      "Here the difference is not the answer but what stands behind it: the records that count now, the one that stopped counting, and the revision that connects them."] });
  }
  return out;
}

// The six-step sequence, each described from the report.
export function sequence(report) {
  const c = correctionIndex(report);
  const at = c > 0 ? c : report.stages.length - 1;
  const stage = report.stages[at];
  const verdict = (side) => heldAt(report, at, side);
  const firstHeld = (side) => heldAt(report, 0, side);
  const replaced = stage.checks;
  return [
    { id: "observe", title: "Observe", text: `${report.stages[0].visible.length} records at "${report.stages[0].stage.label}"; the same records go to both.` },
    { id: "assess", title: "Assess", text: `Stateless: ${firstHeld("stateless").key ?? "no conclusion"} · Speck: ${firstHeld("speck").key ? `${firstHeld("speck").key} (${report.stages[0].speck.state})` : "no conclusion"}` },
    { id: "correct", title: "Correct", text: c > 0 ? list(stage.replaced.map((item) => `${item.by} replaces ${item.recordId}`)) : "no correction in this case" },
    { id: "revise", title: "Revise", text: `Stateless: ${replaced.stateless.changed} · Speck: ${replaced.speck.changed}` },
    { id: "verify", title: "Verify", text: `Cites a replaced record: stateless ${replaced.stateless.supportFromReplaced.length ? "yes" : "no"} · Speck ${replaced.speck.supportFromReplaced.length ? "yes" : "no"}` },
    { id: "explain", title: "Explain", text: `Records why it changed: stateless ${replaced.stateless.recordsWhy ? "yes" : "no"} · Speck ${replaced.speck.recordsWhy ? "yes" : "no"}`, final: verdict("speck") }
  ];
}

// How a report is labelled wherever it is shown.
export function provenanceLine(report) {
  const a = report.configuration.assessor;
  const evidence = report.configuration.evidence.mode === "zetaris" ? `live Zetaris evidence (${report.configuration.evidence.target})` : "the case's fixture file (not Zetaris)";
  return report.kind === "live"
    ? `Live run, ${when(report.finishedAt)}: ${evidence}; both approaches called ${a.model} at ${a.endpoint} (temperature ${a.temperature}). One sample: model judgments vary between runs.`
    : `Deterministic run, ${when(report.finishedAt)}: ${evidence}; the scenario's fact rules, no model. The same inputs give the same result every time.`;
}

// ----- The comparison panel -----

const SIDE_NOTE = {
  stateless: "Answers afresh at each stage from every visible record. Keeps nothing between stages.",
  speck: "One case carried across the stages: evidence, beliefs and every revision kept as inspectable state."
};

function recordChip(id, stageIndex) {
  return el("button", { type: "button", className: "chip", "data-cmp-jump": `${stageIndex}:${id}`, title: `Show ${id}` }, id);
}
const chips = (ids, stageIndex) => (ids.length ? ids.map((id) => [recordChip(id, stageIndex), " "]) : el("span", { className: "muted" }, "none"));

function outcomeBadge(report, index, side) {
  const held = heldAt(report, index, side);
  const label = held.kind === "firm" ? `concludes ${held.key}` : held.kind === "tentative" ? `${report.stages[index].speck.state}: ${held.key}, not concluded` : held.kind === "error" ? "error" : "no conclusion";
  return badge(label, held.kind === "firm" ? "supported state" : held.kind === "tentative" ? "leading state" : held.kind === "error" ? "bad" : "unresolved state");
}

function statelessColumn(report, index) {
  const stage = report.stages[index];
  const s = stage.stateless;
  const checks = stage.checks.stateless;
  return el("div", { className: "cmp-side cmp-stateless" },
    el("h4", {}, statelessName(report), " ", badge(s.method === "nemotron" ? `${/^meterless\//.test(report.configuration.assessor.model ?? "") ? "Meterless Runtime" : "Nemotron"}, one call` : "rule scores", s.method === "nemotron" ? "warn" : "ok")),
    el("p", { className: "cmp-verdict" }, outcomeBadge(report, index, "stateless")),
    s.error ? el("p", {}, badge(s.error, "bad long")) : null,
    el("div", { className: "meta" }, "Cites as support: ", chips(checks.presentedSupport, index)),
    checks.supportFromReplaced.length ? el("p", {}, badge(`relies on replaced record ${list(checks.supportFromReplaced)}`, "bad long")) : null,
    checks.supportFromOutdated?.length ? el("p", {}, badge(`relies on out-of-date record ${list(checks.supportFromOutdated)}`, "bad long")) : null,
    checks.unknownCitations.length ? el("p", {}, badge(`cites records that do not exist: ${list(checks.unknownCitations)}`, "bad long")) : null,
    s.rationale ? el("blockquote", { className: "cmp-rationale" }, badge("model's words", "warn"), " ", s.rationale) : null,
    s.scores ? el("div", { className: "meta" }, "Scores: ", Object.entries(s.scores).map(([key, value]) => `${key} ${value}`).join(" · "),
      s.counted?.some((id) => stage.replaced.some((item) => item.recordId === id))
        ? [" ", badge(`still counts ${list(s.counted.filter((id) => stage.replaced.some((item) => item.recordId === id)))} in its scores`, "warn long")] : null) : null,
    s.model ? el("div", { className: "meta" }, `${s.model.attempts} attempt(s), ${s.model.valid} valid; latency ${s.model.latencyMs.map((ms) => `${ms} ms`).join(" + ") || "n/a"}; served ${s.model.servedModels.join(", ") || "model not reported"}.`) : null,
    index > 0 ? el("p", { className: "meta" }, checks.recordsWhy ? "" : "Why it changed: not recorded. Each call starts from scratch.") : null,
    stage.label ? labelLine(stage.label.stateless) : null);
}

function speckColumn(report, index) {
  const stage = report.stages[index];
  const s = stage.speck;
  const ref = (item) => el("li", {}, recordChip(item.recordId, index),
    item.delta !== null ? ` ${item.delta > 0 ? "+" : ""}${item.delta}` : "",
    item.basis ? [" ", badge(item.basis === "rule" ? "rule" : "model", item.basis === "rule" ? "ok" : "warn")] : null,
    item.decisive ? " decisive" : "", item.rationale ? ` - ${item.rationale}` : "");
  return el("div", { className: "cmp-side cmp-speck" },
    el("h4", {}, "Speck", " ", badge(report.configuration.assessor.kind === "nemotron" ? `${/^meterless\//.test(report.configuration.assessor.model ?? "") ? "Meterless Runtime" : "Nemotron"} + Speck belief state` : "rules + Speck belief state", "ok")),
    el("p", { className: "cmp-verdict" }, outcomeBadge(report, index, "speck"),
      s.concluded && s.route === "corroboration" ? [" ", badge(`by corroboration; Speck's own confidence ${s.confidence}`, "warn long")] : null),
    s.error ? el("p", {}, badge(s.error, "bad long")) : null,
    s.headline ? el("p", { className: "meta" }, s.headline) : null,
    s.reasons?.length ? el("details", { className: "meta cmp-reasons", open: s.concluded ? null : "" }, el("summary", {}, s.concluded ? "Why Speck concludes this" : "Why Speck does not conclude"),
      el("ul", {}, s.reasons.map((reason) => el("li", {}, reason)))) : null,
    s.run?.modelCalls !== null && s.run?.modelCalls !== undefined
      ? el("div", { className: "meta" }, `${s.run.modelCalls} model call(s) this run${s.run.modelFailures ? `, ${s.run.modelFailures} failed after retries` : ""}; served ${s.run.servedModels?.join(", ") || "model not reported"}.`) : null,
    el("div", { className: "meta" }, `Evidence for ${s.concluded ?? s.tentative ?? "it"}:`, s.support.length ? el("ul", { className: "refs" }, s.support.map(ref)) : el("span", { className: "muted" }, " none")),
    s.against.length ? el("div", { className: "meta" }, "Against:", el("ul", { className: "refs" }, s.against.map(ref))) : null,
    s.ruledOut.length ? el("div", { className: "meta" }, "Ruled out: ", s.ruledOut.map((item) => [el("code", {}, item.key), " by ", chips(item.refutedBy, index)])) : null,
    s.noLongerCounted.length || s.revisions.length
      ? el("div", { className: "cmp-why" },
          el("strong", {}, "Why it changed (recorded by Speck)"),
          el("ul", {},
            s.noLongerCounted.map((item) => el("li", {}, badge("no longer counts", "bad"), " ", item.explanation, item.consequences.map((text) => [" ", badge(text, "warn long")]))),
            s.revisions.map((r) => el("li", {}, el("code", {}, r.key), ` ${r.mode === "extended" ? "revised" : "rebuilt from its prior"}: was ${r.before.status} ${r.before.confidence}. ${r.cause}.`))))
      : index > 0 ? el("p", { className: "meta" }, "Nothing stopped counting at this stage.") : null,
    s.explanation ? (s.explanation.agrees
      ? el("blockquote", { className: "cmp-rationale" }, badge("model explanation, matches Speck", "ok"), " ", s.explanation.text)
      : el("details", { className: "meta" }, el("summary", {}, badge("model explanation does not match Speck's state; hidden", "warn")), el("p", {}, s.explanation.text), el("ul", {}, s.explanation.problems.map((p) => el("li", {}, p)))))
      : null,
    stage.label ? labelLine(stage.label.speck) : null);
}

function labelLine(score) {
  return el("p", { className: "meta cmp-label" },
    badge(score.correct ? "matches the pre-registered label" : "does not match the pre-registered label", score.correct ? "ok" : "bad"),
    ` label: ${score.expected ?? "no conclusion is justified"}`,
    score.unsupportedClaim ? [" ", badge("unsupported conclusion", "bad")] : null,
    score.abstention === "appropriate" ? [" ", badge("abstained, rightly", "ok")] : score.abstention === "inappropriate" ? [" ", badge("abstained where a conclusion was due", "bad")] : null,
    score.presentedRuledOut.length ? [" ", badge(`presents ruled-out ${list(score.presentedRuledOut)}`, "bad")] : null);
}

// The decisive-mode switch. Both panels show one; they set the same preference.
export function decisiveSwitch(on) {
  return el("div", { className: "decisive-switch" },
    el("label", {},
      el("input", { type: "checkbox", role: "switch", "data-decisive-toggle": "", checked: on ? "" : null, "aria-checked": String(on) }),
      " ", el("strong", {}, "Decisive mode"), " ", badge("experimental", "warn")),
    el("details", { className: "help" }, el("summary", {}, "What is decisive mode?"), DECISIVE_EXPLANATION.map((text) => el("p", {}, text))));
}

// What decisive mode would have read at one stage of a comparison.
function decisiveBlock(report, index) {
  const reading = decisiveForStage(report.stages[index]);
  return el("div", { className: "cmp-decisive" },
    el("strong", {}, "Decisive mode would: "),
    badge(reading.conclusion ? `conclude ${reading.conclusion}` : "conclude nothing", reading.conclusion ? "supported state" : "unresolved state"), " ",
    badge(reading.basis === "agreement" ? "both agree, citations still count" : reading.basis === "speck" ? "Speck's own conclusion" : "no conclusion", reading.basis === "agreement" ? "ok" : "warn"),
    el("p", { className: "meta" }, reading.reason));
}

function stageBlock(report, index, decisive = false) {
  const stage = report.stages[index];
  const previous = report.stages[index - 1];
  const newlyReplaced = stage.replaced.filter((item) => !(previous?.replaced ?? []).some((before) => before.recordId === item.recordId));
  return el("section", { className: "cmp-stage", "data-cmp-stage": String(index) },
    el("h3", {}, `Stage ${index + 1}: ${stage.stage.label}`),
    newlyReplaced.length ? el("p", { className: "cmp-correction" }, badge("correction", "warn"), " ",
      newlyReplaced.map((item) => {
        const by = stage.visible.find((record) => record.id === item.by);
        return [el("strong", {}, `${item.by} replaces ${item.recordId}`), by ? `: "${by.content}" ` : " "];
      })) : null,
    el("details", { className: "cmp-records", open: newlyReplaced.length ? "" : null },
      el("summary", {}, `The ${stage.visible.length} records both approaches saw${stage.arrived.length && index > 0 ? ` (${stage.arrived.length} new)` : ""}`),
      el("ul", { className: "refs" }, stage.visible.map((record) => el("li", { "data-cmp-record": `${index}:${record.id}`, className: record.replacedBy ? "superseded" : "" },
        el("code", {}, record.id), " ", el("span", { className: "muted" }, `${record.source} · ${when(record.observedAt)}`), " ",
        index > 0 && stage.arrived.includes(record.id) ? badge("new", "pending") : null,
        record.replacedBy ? badge(`replaced by ${record.replacedBy}`, "bad") : null,
        record.outdatedBy ? badge(`out of date: its source now reports otherwise (${record.outdatedBy})`, "bad long") : null,
        badge(record.retrieval.mode === "zetaris" ? "Zetaris live" : "fixture", record.retrieval.mode),
        el("div", {}, record.content))))),
    el("div", { className: "cmp-columns" }, statelessColumn(report, index), speckColumn(report, index)),
    stage.disagreement ? el("p", { className: "cmp-disagreement" }, el("strong", {}, "Why they differ: "), stage.disagreement) : null,
    decisive ? decisiveBlock(report, index) : null);
}

// state: { data (GET comparison), viewing (a report opened from the list, or
// null for the current one), elapsedMs, starting }
export function renderComparison(container, state) {
  const data = state.data;
  const running = data?.running ?? null;
  const shown = state.viewing ?? data?.current ?? null;
  const willRun = data?.willRun;
  const head = el("div", { className: "cmp-head" },
    el("div", {},
      el("p", { className: "cmp-pitch" }, "A stateless baseline (a model call in live mode, the same fact rules in deterministic mode) answers from whatever evidence it is handed, from scratch every time. Speck keeps the evidence, its beliefs and every revision as state you can inspect. Run both on this case and see what each does when a record is corrected.")),
    el("div", { className: "cmp-action" },
      el("button", { type: "button", className: "primary", "data-cmp": "run", disabled: running || state.starting || (willRun && !willRun.assessor.ready) ? "" : null },
        running || state.starting ? "Comparing…" : shown ? "Run the comparison again" : "Run the side-by-side comparison"),
      willRun ? el("p", { className: "hint" }, willRun.kind === "live"
        ? `Live: real calls to ${willRun.assessor.model ?? "the model"}${willRun.evidence.mode === "zetaris" ? " and Zetaris" : ""}. Takes about 20-60 seconds.`
        : "Deterministic: fixture evidence and fact rules, no model. Takes a second.") : null,
      el("p", { className: "hint" }, "Runs on its own temporary copy of the case; this case is not changed."),
      decisiveSwitch(Boolean(state.decisive))));

  const body = [];
  if (running) {
    const p = running.progress;
    body.push(el("p", { className: "progress", role: "status" },
      `Comparing… ${Math.round((state.elapsedMs ?? 0) / 1000)} s. `,
      p ? `Stage ${p.index + 1} of ${p.of} ("${p.stage}"): ${p.step === "speck" ? "Speck is assessing the records" : "the stateless baseline is answering"}.` : "Starting.",
      shown ? " The results below are the previous comparison until this one finishes." : ""));
  }
  if (data?.failure) {
    body.push(el("div", { className: "error", role: "alert" }, el("strong", {}, "The last comparison did not finish, and nothing from it was saved."), el("p", {}, data.failure.error)));
  }
  if (!shown) {
    if (!running) body.push(el("div", { className: "empty" }, el("p", {}, "No comparison has been run with this case's current settings yet."),
      data?.others?.length ? el("p", { className: "meta" }, "Comparisons made with other settings are listed below.") : null));
  } else {
    const stale = state.viewing && !state.viewingMatches;
    body.push(el("div", { className: `cmp-result${running ? " cmp-dimmed" : ""}` },
      el("p", { className: "cmp-provenance" }, badge(shown.kind === "live" ? "LIVE MODEL CALLS" : "DETERMINISTIC", shown.kind === "live" ? "nemotron" : "fixture"), " ", provenanceLine(shown)),
      stale ? el("p", {}, badge("Made with settings other than this case's current ones; shown because you opened it.", "warn long"), " ",
        el("button", { type: "button", className: "link", "data-cmp": "current" }, "Back to the current comparison")) : null,
      el("ol", { className: "cmp-sequence" }, sequence(shown).map((step) => el("li", {}, el("strong", {}, step.title), el("span", {}, step.text)))),
      el("div", { className: "cmp-findings" }, findings(shown).map((finding) => el("div", { className: "cmp-finding", "data-finding": finding.id },
        el("h3", {}, finding.title), el("ul", {}, finding.lines.map((line) => el("li", {}, line)))))),
      el("p", { className: "cmp-legend meta" }, `Both columns saw the same records at each stage. ${statelessName(shown)}: ${SIDE_NOTE.stateless} Speck: ${SIDE_NOTE.speck}`),
      shown.stages.map((_, index) => stageBlock(shown, index, Boolean(state.decisive))),
      el("details", { className: "meta" }, el("summary", {}, "How this comparison was made, and what it does not show"),
        el("ul", {}, el("li", {}, shown.configuration.speck), el("li", {}, shown.configuration.stateless), el("li", {}, shown.configuration.labels),
          shown.notes.map((note) => el("li", {}, note)), el("li", {}, `Report ${shown.id}, ${shown.durationMs} ms.`)))));
  }
  const others = (data?.others ?? []).filter((entry) => entry.id !== shown?.id);
  if (others.length) {
    body.push(el("details", { className: "meta cmp-others" }, el("summary", {}, `Other saved comparisons for this case (${others.length})`),
      el("ul", { className: "refs" }, others.map((entry) => el("li", {},
        `${when(entry.finishedAt)} · ${entry.kind} · ${entry.evidence} · ${entry.assessor} · ${entry.origin === "command" ? "from npm run compare" : "from this page"} `,
        entry.matchesCurrent ? badge("current settings", "ok") : badge("other settings", "warn"), " ",
        el("button", { type: "button", className: "link", "data-cmp": "open", "data-id": entry.id }, "Open"))))));
  }
  if (data?.unreadable) body.push(el("p", { className: "meta" }, badge(`${data.unreadable} saved comparison file(s) could not be read and are not shown`, "warn long")));
  container.replaceChildren(head, ...body);
}

// Scrolls a record chip's target into view and marks it briefly.
export function jumpToRecord(container, key) {
  const row = container.querySelector(`[data-cmp-record="${CSS.escape(key)}"]`);
  if (!row) return;
  const details = row.closest("details");
  if (details) details.open = true;
  row.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  row.classList.add("cmp-flash");
  window.setTimeout(() => row.classList.remove("cmp-flash"), 1600);
}

// ----- Evaluation results -----

const show = (rate) => (rate && rate.of ? `${rate.count}/${rate.of}` : "n/a");
const systemName = (name) => name.replace(/^speck-desk\//, "Speck (persistent) / ").replace(/^speck-fresh\//, "Speck (rebuilt each time) / ").replace(/^baseline-stateless\//, "Stateless / ");

export function renderEvaluation(container, summary) {
  const reports = summary.reports;
  container.replaceChildren(
    el("p", {}, "The project's evaluation, read from the reports its commands wrote. Every figure is a count over these cases only, with its denominator; none is a general accuracy rate. Labels were written before any system ran on the cases."),
    el("p", { className: "meta" }, "Systems: Speck (persistent) is Evidence Desk as built; Speck (rebuilt each time) is the same pipeline on a fresh database at every checkpoint; Stateless is the baseline the comparison above uses. Persistence alone made no measurable difference: the two Speck systems agree."),
    acrossModelsTable(summary.acrossModels ?? []),
    comparisonAggregates(summary.comparisons),
    ...reports.map((report) => el("details", { className: "eval-report", open: report.id === "fixture" ? "" : null },
      el("summary", {}, el("strong", {}, report.title), " ",
        badge(report.kind === "live" ? "live model" : "deterministic", report.kind === "live" ? "nemotron" : "fixture"), " ",
        report.available ? `${report.cases} cases, ${report.checkpoints} checkpoints · generated ${when(report.generatedAt)}${report.models.length ? ` · ${report.models.join(", ")}` : ""}` : badge(`not generated here: run ${report.command}`, "warn long")),
      report.available ? [
        el("div", { className: "table-wrap" }, el("table", { className: "eval-table" },
          el("thead", {}, el("tr", {}, el("th", {}, "Measure"), report.systems.map((name) => el("th", {}, systemName(name))))),
          el("tbody", {}, report.rows.map((row) => el("tr", {}, el("th", { scope: "row", title: row.meaning }, row.label, el("div", { className: "meta" }, row.meaning)),
            report.systems.map((name) => el("td", {}, show(row.values[name])))))))),
        report.recovery ? el("p", { className: "meta" }, `Recovery after an interrupted run (Speck only): interrupted ${show(report.recovery.interrupted)}, identical to an uninterrupted run ${show(report.recovery.identical)}.`) : null,
        report.perCheckpoint.length ? el("details", {}, el("summary", {}, "Each case and checkpoint"),
          el("div", { className: "table-wrap" }, el("table", { className: "eval-table" },
            el("thead", {}, el("tr", {}, el("th", {}, "Case @ checkpoint"), el("th", {}, "Label"), report.systems.map((name) => el("th", {}, systemName(name))))),
            el("tbody", {}, report.perCheckpoint.map((row) => el("tr", {},
              el("th", { scope: "row" }, `${row.caseId} @ ${row.stage}`), el("td", {}, row.expected ?? "no conclusion"),
              report.systems.map((name) => {
                const r = row.results[name];
                return el("td", { className: r.correct ? "ok" : "bad" }, r.error ? `error: ${r.error.split(":")[0]}` : r.concluded ?? "none",
                  r.tentative ? el("div", { className: "meta" }, `tentatively ${r.tentative}`) : null,
                  r.unsupportedClaim ? el("div", {}, badge("unsupported", "bad")) : null,
                  r.staleSupport.length ? el("div", {}, badge(`uses ${list(r.staleSupport)}`, "bad")) : null,
                  r.presentedRefuted.length ? el("div", {}, badge(`presents ${list(r.presentedRefuted)}`, "bad")) : null);
              })))))))
          : null,
        report.differences.length ? el("details", { className: "meta" }, el("summary", {}, "What differs between the systems"), el("ul", {}, report.differences.map((line) => el("li", {}, line)))) : null
      ] : null)),
    el("p", { className: "meta" }, `Read from ${summary.resultsDir}.`));
}

// The registered live experiments, per suite, model and system: what changes
// when the model improves, and what does not.
const MODEL_NAMES = { "nano-4b": "Nemotron 3 Nano 4B (local)", "bolt-e4b": "Nemotron 3.5 Bolt E4B (Nightshift)" };
function acrossModelsTable(rows) {
  if (!rows.length) return null;
  const models = Object.keys(MODEL_NAMES);
  const cell = (row, model, key) => { const value = row.models[model]; return el("td", {}, value ? show(value[key]) : "n/a"); };
  return el("details", { className: "eval-report eval-models", open: "" },
    el("summary", {}, el("strong", {}, "Results across models"), " ", badge("live model", "nemotron"), " three repeats per suite and model, from the registered experiment folders"),
    el("p", { className: "meta" }, "The same cases, rules and labels on two models. The stateless call improves with the model; Speck's conclusions are set by its conclusion policy, so they barely move. Set 7 was written and locked to test receipts that conflict over time, with corrections that are themselves corrected."),
    el("div", { className: "table-wrap" }, el("table", { className: "eval-table" },
      el("thead", {},
        el("tr", {}, el("th", { rowspan: "2" }, "Suite"), el("th", { rowspan: "2" }, "System"),
          models.map((model) => el("th", { colspan: "4" }, MODEL_NAMES[model]))),
        el("tr", {}, models.flatMap(() => ["Matches the label", "Concluded where waiting was right", "Concluded the wrong explanation", "Replaced evidence kept out of support"].map((label) => el("th", {}, label))))),
      el("tbody", {}, rows.map((row, index) => el("tr", { className: row.suite.startsWith("Set 7") ? "eval-spotlight" : null },
        index % 2 === 0 ? el("th", { scope: "row", rowspan: "2" }, row.suite) : null,
        el("td", {}, row.system),
        models.flatMap((model) => ["matches", "concludedWhereWaitingWasRight", "wrongExplanation", "replacedEvidenceKeptOut"].map((key) => cell(row, model, key)))))))),
    el("p", { className: "meta" }, "On set 7 the better model's stateless call still concluded where it should have waited, concluded the wrong explanation, and leaned on replaced records; Speck did none of the last two on either model, but abstained so often where a conclusion was due that the stateless call matched the label more. Records: docs/set-7-conflicting-receipts.md, docs/bolt-e4b.md."));
}

function comparisonAggregates(groups) {
  if (!groups.length) return el("p", { className: "meta" }, badge("No saved side-by-side comparisons: run npm run compare (deterministic) or npm run compare:live", "warn long"));
  return el("details", { className: "eval-report", open: "" },
    el("summary", {}, el("strong", {}, "Side-by-side comparisons, Speck and the stateless baseline"), ` (${groups.reduce((sum, g) => sum + g.samples, 0)} saved by npm run compare / compare:live)`),
    el("p", { className: "meta" }, "Per case and configuration: how many of the saved comparisons (samples) showed each behaviour at each stage. Live samples differ because the model's judgments vary."),
    el("div", { className: "table-wrap" }, el("table", { className: "eval-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Case · configuration · stage"), el("th", {}, "Approach"), el("th", {}, "Concluded"), el("th", {}, "Relied on a replaced or out-of-date record"), el("th", {}, "Abstained where a conclusion was due"), el("th", {}, "Recorded why it changed"), el("th", {}, "Matches label"))),
      el("tbody", {}, groups.flatMap((group) => group.stages.flatMap((stage, index) => ["stateless", "speck"].map((side) => {
        const a = stage.approaches[side];
        return el("tr", {},
          side === "stateless" ? el("th", { scope: "row", rowspan: "2" }, `${group.title}`, el("div", { className: "meta" }, `${group.kind} · ${group.evidence} · ${group.assessor} · ${group.samples} sample(s)`), el("div", { className: "meta" }, group.policy), el("div", {}, `Stage ${index + 1}: ${stage.stage}`)) : null,
          el("td", {}, side === "speck" ? "Speck" : "Stateless"),
          el("td", {}, Object.entries(a.conclusions).map(([key, count]) => `${key} ×${count}`).join(", "), side === "speck" && a.corroborated ? el("div", { className: "meta" }, `${a.corroborated} by corroboration`) : null),
          el("td", {}, `${a.supportFromReplaced + (a.supportFromOutdated ?? 0)}/${group.samples}`),
          el("td", {}, a.inappropriateAbstentions === null || a.inappropriateAbstentions === undefined ? "no label" : `${a.inappropriateAbstentions}/${group.samples}`),
          el("td", {}, index === 0 ? "n/a" : `${a.recordsWhy}/${group.samples}`),
          el("td", {}, a.matchesLabel === null ? "no label" : `${a.matchesLabel}/${group.samples}`));
      })))))));
}
