// Evidence Desk UI. Plain DOM; every value from the server is inserted as
// text, never as HTML. It mounts into any element: the standalone page
// (index.html) or a tab inside Speck (the Evidence Desk plugin), which differ
// only in where the API lives and how requests are authorised.
//
// Layout, top to bottom: the case and what the page is for; the steps of the
// investigation and its two actions; the current conclusion beside the
// evidence; then history (revision timeline, execution trace) and the
// workspace's configuration. The guided tour and the feature guide
// (./tour.js) read the same state the page renders.

import { CONFIDENCE_MEANING, FEATURES, STATE_MEANING, TOUR_STEPS, featureStatus, progressStore, recordToInspect, stepDone } from "./tour.js";

function el(tag, attributes = {}, ...children) {
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

// Short explanations at the point of use. Visible text, opened on demand; no
// status is hidden behind them.
const help = (summary, ...paragraphs) => el("details", { className: "help" },
  el("summary", {}, summary), ...paragraphs.map((text) => el("p", {}, text)));

const HELP = {
  evidence: [
    "Each record comes from a named source system. \"Stated by source\" lists the facts the record itself states: an observation, not an interpretation.",
    "How it was weighed: a deterministic rule is a fact rule written into the case; a model interpretation is a reasoning model's reading, which Speck caps at reliability 0.4. \"In effect\" means the judgment counts now; \"void\" means its record no longer counts; \"withheld\" means a decisive refutation overrides it.",
    "Provenance names the system of record, the record's own reference and its author; \"retrieved\" says how this workspace read it: a local fixture file or a live Zetaris query, with its query token.",
    "\"Zetaris USL\" means the record came through a Zetaris Unified Semantic Layer: one query over a semantic model that maps every source system into the same evidence shape. The layer resolved the record's case and derived its facts from the source's own fields; the reference shown is the source's own, so it can be traced back."
  ],
  states: [
    STATE_MEANING.supported, STATE_MEANING.leading, STATE_MEANING.unresolved,
    "\"Contested\" is not a separate state: the notes say when the leading explanation also has evidence against it.",
    CONFIDENCE_MEANING
  ],
  changes: [
    "When a source corrects a record, the new record names the one it replaces. The replaced record stops counting, along with every fact and judgment it carried, and the beliefs that rested on it are rebuilt from the evidence that still counts.",
    "Withdrawing a record has the same effect. Earlier beliefs are kept as history, marked historical, and are never presented as current."
  ],
  timeline: [
    "Speck's own event log for this case, in order: stages introduced, records recorded, beliefs revised, recomputations. By default only changes are shown.",
    "Entries about beliefs that have since been replaced are marked historical."
  ],
  trace: [
    "What each component did in each run, read back from what was saved: the evidence fetch, the execution engine's run, each chunk's judgments (rule or model) and Speck's belief revisions. Evidence Desk's own steps, such as recovery, are labelled as such.",
    "Failed assessments show here and in the evidence list: the record stays \"not yet assessed\" and is retried on the next run. A run interrupted before it finished is shown as interrupted, and its saved judgments are reconciled on the next run or restart."
  ]
};

// The page's fixed markup. Ids are prefixed so that, mounted inside another
// page (Speck), they cannot collide with the host's.
const TEMPLATE = `
<header class="case-header" id="edk-case">
  <div class="case-identity">
    <p class="eyebrow">Evidence Desk <span id="edk-case-id"></span></p>
    <h1 id="edk-case-title">Evidence Desk</h1>
    <p id="edk-case-question" class="question"></p>
    <p id="edk-sources" class="sources"></p>
  </div>
  <button id="edk-guide-button" class="secondary" type="button" aria-controls="edk-guide" aria-expanded="false">Guide</button>
</header>

<section id="edk-intro" class="intro" aria-labelledby="edk-intro-title" hidden>
  <h2 id="edk-intro-title">Investigate a case where the evidence keeps changing</h2>
  <p>Evidence Desk is a workspace for investigating cases whose records can conflict, be corrected or be withdrawn.</p>
  <ul>
    <li>Every conclusion is tied to the records behind it: their source, provenance and how each was weighed.</li>
    <li>Uncertainty is stated: a conclusion is supported, leading or unresolved, never more certain than its evidence.</li>
    <li>When a record is corrected or withdrawn, the beliefs that rested on it are recomputed, and the page says what changed and why.</li>
  </ul>
  <p>The guided investigation takes about five minutes: run this case, see why its conclusion holds, bring in the next update, and watch what changes.</p>
  <div class="intro-actions">
    <button id="edk-intro-start" class="primary" type="button">Start the guided investigation</button>
    <button id="edk-intro-dismiss" class="secondary" type="button">Explore on my own</button>
  </div>
</section>

<div id="edk-error" class="error" role="alert" hidden></div>

<section class="workflow" aria-label="Investigation steps">
  <ol id="edk-stages" class="stages"></ol>
  <div class="actions">
    <div class="action">
      <button id="edk-run-button" class="primary" type="button">Run investigation</button>
      <p id="edk-run-hint" class="hint"></p>
    </div>
    <div class="action">
      <button id="edk-update-button" class="secondary" type="button">Introduce prepared update</button>
      <p id="edk-update-hint" class="hint"></p>
    </div>
  </div>
  <p id="edk-progress" class="progress" role="status" aria-live="polite" hidden></p>
</section>

<div class="workspace">
  <section class="panel conclusion-panel" id="edk-conclusion-panel" aria-labelledby="edk-conclusion-heading">
    <h2 id="edk-conclusion-heading">Current conclusion</h2>
    <div id="edk-conclusion"><p class="muted">Loading…</p></div>
  </section>

  <section class="panel evidence-panel" id="edk-evidence-panel" aria-labelledby="edk-evidence-heading">
    <h2 id="edk-evidence-heading">Evidence</h2>
    <p id="edk-evidence-summary" class="muted"></p>
    <div id="edk-evidence-help"></div>
    <ol id="edk-evidence-list" class="evidence-list"></ol>
  </section>
</div>

<section class="panel" id="edk-timeline-panel" aria-labelledby="edk-timeline-heading">
  <h2 id="edk-timeline-heading">Revision timeline</h2>
  <div id="edk-timeline-help"></div>
  <label class="muted toggle"><input id="edk-timeline-all" type="checkbox"> Show every event, not only changes</label>
  <ol id="edk-timeline" class="timeline"></ol>
</section>

<section class="panel" id="edk-trace-panel" aria-labelledby="edk-trace-heading">
  <h2 id="edk-trace-heading">Execution trace</h2>
  <div id="edk-trace-help"></div>
  <div id="edk-trace"></div>
</section>

<details class="panel system" id="edk-system">
  <summary>How this workspace is configured</summary>
  <dl id="edk-configuration" class="configuration"></dl>
</details>

<aside id="edk-coach" class="coach" aria-labelledby="edk-coach-title" hidden></aside>
<section id="edk-guide" class="guide" aria-labelledby="edk-guide-title" hidden></section>
<dialog id="edk-withdraw" class="withdraw-dialog" aria-labelledby="edk-withdraw-title"></dialog>
`;

// Mounts the page into root. apiBase: where the JSON API lives (/api
// standalone; the plugin's case route inside Speck). fetchImpl: how to call
// it (Speck passes its admin-authorised fetch). eventsUrl: a server-sent
// event stream for run progress, if the host has one.
export function mountEvidenceDesk(root, { apiBase = "/api", fetchImpl = fetch, eventsUrl = null } = {}) {
  root.classList.add("edk");
  root.innerHTML = TEMPLATE;
  const $ = (id) => root.querySelector(`#edk-${id}`);
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const progress = progressStore(storage, apiBase);

  $("evidence-help").replaceChildren(help("What do these labels mean?", ...HELP.evidence));
  $("timeline-help").replaceChildren(help("What is this?", ...HELP.timeline));
  $("trace-help").replaceChildren(help("What is this?", ...HELP.trace));

  async function api(path, options = {}) {
    // Paths are written as /api/...; the host decides where the API lives.
    const response = await fetchImpl(apiBase + path.slice("/api".length), options);
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { body });
    return body;
  }

  function showError(error) {
    const box = $("error");
    if (!error) { box.hidden = true; box.replaceChildren(); return; }
    const body = error.body ?? {};
    box.hidden = false;
    box.replaceChildren(...el("div", {},
      el("strong", {}, body.kind === "evidence" ? `Evidence access failed (${body.mode} mode). No fallback data was used.` : "Something went wrong."),
      el("p", {}, error.message),
      body.hint ? el("p", {}, `What to do: ${body.hint}`) : null,
      body.detail ? el("p", { className: "meta" }, `Server said: ${body.detail}`) : null,
      el("button", { type: "button", className: "link", "data-dismiss-error": "" }, "Dismiss")).childNodes);
  }
  $("error").addEventListener("click", (event) => { if (event.target.closest("[data-dismiss-error]")) showError(null); });

  // The latest state, as the API returned it; the tour and guide read this.
  const view = { status: null, investigation: null, listing: null, trace: null };
  let busy = null;

  function renderStatus() {
    const { status } = view;
    $("case-id").textContent = `· case ${status.case.caseId}`;
    $("case-title").textContent = status.case.title;
    $("case-question").textContent = status.case.question;
    const { evidence, reasoner, execution, speck } = status;
    // Through el(), which drops null; replaceChildren would print it.
    $("sources").replaceChildren(...el("span", {},
      badge(evidence.mode === "zetaris" ? (/Unified Semantic Layer/.test(evidence.label) ? "Evidence: Zetaris USL (live)" : "Evidence: Zetaris live") : "Evidence: fixture file, not Zetaris", evidence.mode),
      badge(reasoner.kind === "nemotron" ? `Assessor: Nemotron (${reasoner.model})` : "Assessor: deterministic rules", reasoner.ready ? "ok" : "bad"),
      evidence.problem ? badge(evidence.problem, "bad long") : null,
      reasoner.problem ? badge(reasoner.problem, "bad long") : null).childNodes);
    const usage = reasoner.usage ? ` - ${reasoner.usage.successes} successful / ${reasoner.usage.calls} calls this session` : "";
    const rows = [
      ["Evidence", [badge(evidence.mode === "zetaris" ? "ZETARIS LIVE" : "FIXTURE FILE - NOT ZETARIS", evidence.mode), " ", `${evidence.label} - ${evidence.target}`, evidence.problem ? [" ", badge(evidence.problem, "bad")] : null]],
      ["Assessor", [badge(reasoner.kind, reasoner.ready ? "ok" : "bad"), " ", reasoner.model ? `${reasoner.label}: ${reasoner.model} @ ${reasoner.endpoint}${usage}` : reasoner.label, reasoner.problem ? [" ", badge(reasoner.problem, "bad")] : null]],
      ["Execution", `${execution.identity ? `${execution.identity.name} (${execution.identity.package}, commit ${execution.identity.commit.slice(0, 7)}, vendored)` : execution.engine}; at most ${execution.maxChunks} chunks, ${execution.batchSize} record(s) per chunk`],
      ["Cognition", `Speck runtime, database ${speck.database}`]
    ];
    $("configuration").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]));
    renderWorkflow();
  }

  // The case's stages as steps, and what each action will do now.
  function renderWorkflow() {
    const { status } = view;
    if (!status) return;
    const stages = status.stages ?? [status.stage];
    const currentIndex = stages.findIndex((stage) => stage.id === status.stage.id);
    $("stages").replaceChildren(...stages.map((stage, index) => el("li", {
      className: index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming",
      "aria-current": index === currentIndex ? "step" : null
    }, el("span", { className: "stage-label" }, stage.label),
      el("span", { className: "stage-state" }, index < currentIndex ? "introduced" : index === currentIndex ? "current stage" : "not yet introduced"),
      stage.description ? el("span", { className: "stage-description" }, stage.description) : null)));

    const pending = view.listing?.pending ?? [];
    const runs = view.investigation?.runs?.length ?? 0;
    const working = Boolean(busy) || status.running;
    $("run-button").disabled = working;
    $("update-button").disabled = working || !status.nextStage;
    $("run-button").textContent = busy === "run" || status.running ? "Running…" : "Run investigation";
    $("update-button").textContent = busy === "update" ? "Introducing…" : status.nextStage ? "Introduce prepared update" : "No further updates";
    $("run-hint").textContent = pending.length
      ? `Assesses the ${pending.length} record(s) waiting at this stage and updates Speck's beliefs.`
      : runs ? "Every record at this stage is assessed; running again changes nothing." : "Assesses the evidence at this stage and forms Speck's first beliefs.";
    $("update-hint").textContent = status.nextStage
      ? `Releases the next stage, "${status.nextStage.label}". New records arrive unassessed.`
      : "Every prepared update for this case has been introduced.";
  }

  // Whether a record still counts, said once and plainly.
  function countingBadge(record, byId) {
    if (record.invalidation?.kind === "superseded") return badge(`no longer counts: replaced by ${record.invalidation.by}`, "bad");
    if (record.invalidation?.kind === "withdrawn") return badge("withdrawn: no longer counts", "bad");
    if (record.supersededBy) {
      // The page's listing names a replacement even when that replacement no
      // longer counts itself, or arrived before this record; the record then
      // still counts, and the badge says so rather than striking it through.
      const replacement = byId.get(record.supersededBy);
      return badge(replacement?.invalidation
        ? `its replacement ${record.supersededBy} no longer counts, so this record counts again`
        : `${record.supersededBy} says it replaces this record, but this record arrived later and still counts`, "warn long");
    }
    return null;
  }

  function statusBadge(record) {
    if (record.status === "completed") return badge("assessed", "ok");
    if (record.status === "failed") return badge(record.assessed ? "assessed, judgments missing" : "assessment failed: retried next run", "bad");
    if (record.status === "withdrawn") return badge("withdrawn before assessment: not assessed", "warn");
    return badge(record.lastAttempt ? "not yet assessed (interrupted run)" : "not yet assessed", "pending");
  }

  function renderEvidence(listing) {
    const pending = new Set(listing.pending);
    const byId = new Map(listing.records.map((record) => [record.id, record]));
    $("evidence-summary").textContent = `${listing.records.length} record(s) at stage "${listing.stage.label}", from ${listing.provider.label}. ${pending.size ? `${pending.size} not yet assessed.` : "All assessed."}`;
    if (!listing.records.length) {
      $("evidence-list").replaceChildren(el("li", { className: "muted" }, "No records are available at this stage."));
      return;
    }
    $("evidence-list").replaceChildren(...listing.records.map((record) => el("li", { className: record.invalidation ? "superseded" : "", "data-record-id": record.id },
      el("div", { className: "record-head" },
        el("strong", {}, record.id),
        el("span", { className: "muted" }, `${record.source.name} · ${when(record.observedAt)}`)),
      el("div", { className: "record-badges" },
        statusBadge(record),
        countingBadge(record, byId),
        badge(record.retrieval.mode === "zetaris" ? (record.retrieval.location.startsWith("lightning.metastore.") ? "Zetaris USL" : "Zetaris live") : "fixture file, not Zetaris", record.retrieval.mode)),
      record.invalidation?.kind === "withdrawn" ? el("div", { className: "meta" }, `Withdrawn ${when(record.invalidation.at)}: ${record.invalidation.reason}`) : null,
      record.status === "failed" && record.lastAttempt?.error ? el("div", { className: "meta" }, `Last attempt ${when(record.lastAttempt.at)} failed: ${record.lastAttempt.error}`) : null,
      el("p", { className: "content" }, record.content),
      el("details", { className: "record-details", "data-feature": "provenance" },
        el("summary", {}, "Source, provenance and how it was weighed"),
        el("div", { className: "meta" }, badge("stated by source", "ok"), ` ${record.source.name}: ${Object.entries(record.facts).map(([key, value]) => `${key}=${value}`).join(", ") || "no structured facts"}`),
        renderAssessment(record),
        el("div", { className: "meta" }, `provenance: ${record.provenance.systemOfRecord} / ${record.provenance.recordRef} / author ${record.provenance.author}${record.provenance.supersedes.length ? ` / amends ${record.provenance.supersedes.join(", ")}` : ""}`),
        el("div", { className: "meta" }, `retrieved: ${record.retrieval.mode} from ${record.retrieval.location} at ${when(record.retrieval.retrievedAt)}${record.retrieval.queryToken ? ` (Zetaris query ${record.retrieval.queryToken})` : ""}`),
        // Any record not already withdrawn: an unassessed one is excluded from
        // assessment (no judgment is recorded), an assessed one stops counting.
        record.invalidation?.kind !== "withdrawn" && record.status !== "withdrawn"
          ? el("button", { type: "button", className: "link danger", "data-withdraw": record.id, "data-assessed": record.assessed ? "yes" : "no" }, `Withdraw ${record.id}…`)
          : null)
    )));
  }

  // How a record was weighed, keeping a checked rule apart from a model's reading.
  function renderAssessment(record) {
    const a = record.assessment;
    if (!a) return el("div", { className: "meta" }, record.assessed ? "weighed: details unavailable" : "not yet weighed by Speck");
    return el("div", { className: "meta" },
      `Weighed ${a.runNumber === null ? "in a run that was interrupted" : `in run ${a.runNumber}`}: source reliability ${a.reliability}`
        + (a.recordedBy === "model" && a.appliedReliability !== null && a.appliedReliability !== a.reliability ? `, applied by Speck at ${a.appliedReliability} (its cap for model-judged evidence)` : "")
        + ": ",
      a.judgments.length
        ? el("ul", { className: "refs" }, a.judgments.map((j) => el("li", {},
            badge(j.basis === "rule" ? "deterministic rule" : "model interpretation", j.basis === "rule" ? "ok" : "warn"),
            ` ${j.direction} `, el("code", {}, j.hypothesisKey), j.decisive ? " decisively" : "", j.basis === "model" ? ` (strength ${j.strength})` : "", ` - ${j.rationale} `,
            effectBadge(j))))
        : "no bearing on any hypothesis");
  }

  // Whether a judgment counts towards current belief now.
  function effectBadge(judgment) {
    if (judgment.effect === "withheld") return badge(`withheld: ${judgment.refutedBy} refutes ${judgment.hypothesisKey} decisively`, "warn");
    if (judgment.effect === "void") return badge("void: its record no longer counts", "bad");
    return badge("in effect", "ok");
  }

  const signed = (delta) => (delta > 0 ? `+${delta}` : String(delta));

  // Each record that currently counts, with the judgment behind it and the
  // change Speck made to the current belief when it applied it.
  const refList = (refs) => refs.length
    ? el("ul", { className: "refs" }, refs.map((ref) => el("li", {}, el("code", {}, ref.recordId),
        ` ${ref.sourceName}, ${when(ref.observedAt)} (${ref.retrievalMode})`,
        ref.judgment ? [" ", badge(ref.judgment.basis === "rule" ? "deterministic rule" : "model interpretation", ref.judgment.basis === "rule" ? "ok" : "warn"),
          ref.judgment.decisive ? " decisive" : "", ` - ${ref.judgment.rationale}`] : "",
        ref.delta !== null && ref.delta !== undefined ? ` - ${signed(ref.delta)} confidence` : "",
        ref.reliability !== undefined ? ` at reliability ${ref.reliability}${ref.judgedBy === "model" ? " (model-judged, capped by Speck)" : ""}` : "",
        ref.supersededBy ? ` - superseded by ${ref.supersededBy}` : "")))
    : el("p", { className: "muted" }, "none");

  // Why current belief differs from what was believed before: records that no
  // longer count, and hypotheses rebuilt without them. Shown as history; none
  // of it is current reasoning.
  function renderRevisions(c, history) {
    const recomputations = history?.recomputations ?? [];
    const replaced = history?.replaced ?? [];
    if (!c.noLongerCounted?.length && !recomputations.length) return null;
    return el("section", { className: "outcome changed", id: "edk-why" },
      el("h3", {}, "Why this changed"),
      help("How corrections work", ...HELP.changes),
      c.noLongerCounted?.length
        ? el("ul", {}, c.noLongerCounted.map((item) => el("li", {}, el("code", {}, item.recordId), " no longer counts: ",
            item.invalidation.kind === "superseded" ? `its source superseded it with ${item.invalidation.by}.` : `withdrawn (${item.invalidation.reason}).`,
            // A record is replaced whole: say which of its facts went with it, and what that changed.
            item.unrestatedFacts?.length ? el("div", { className: "meta" }, `Facts it stated that no counting record restates: ${item.unrestatedFacts.map((f) => `${f.fact}=${f.value}`).join(", ")}.`) : null,
            item.lostJudgments?.length ? el("div", { className: "meta" }, `Judgments no longer applied: ${item.lostJudgments.map((j) => `${j.direction} ${j.hypothesisKey}${j.decisive ? " decisively" : ""}`).join("; ")}.`) : null,
            (item.consequences ?? []).map((text) => el("div", {}, badge(text, "warn long"))))))
        : null,
      recomputations.map((r) => el("details", {},
        el("summary", {}, `Recomputation ${r.version} (${when(r.at)}): ${r.hypotheses.map((h) => `${h.key} ${h.mode === "extended" ? "revised" : "rebuilt from its prior"}`).join(", ")}`),
        el("ul", {}, r.hypotheses.map((h) => el("li", {},
          el("code", {}, h.key), ` was ${h.previous.status} ${h.previous.confidence}${h.mode === "extended" ? "" : " (no longer held)"}. Cause: ${h.cause}.`,
          h.carriedOut === false ? [" ", badge("interrupted before the rebuild was made; a later recomputation made it", "warn long")] : null,
          h.dropped.length ? ` Stopped applying: ${h.dropped.map((d) => `${d.recordId} ${d.direction}`).join(", ")}.` : "",
          h.added.filter((a) => a.reinstated).length ? ` Counts again: ${h.added.filter((a) => a.reinstated).map((a) => `${a.recordId} ${a.direction}`).join(", ")}.` : "",
          h.mode === "extended" ? ` Applied: ${h.replayed.join(", ")}.` : ` Replayed: ${h.replayed.join(", ") || "nothing (prior only)"}.`))))),
      replaced.length
        ? [el("h4", {}, "Earlier beliefs, no longer held"),
           el("ul", { className: "refs" }, replaced.map((h) => el("li", {}, badge("historical", "warn"), " ", el("code", {}, h.key),
             ` had reached ${h.statusWhenReplaced} ${h.confidence}; replaced in recomputation ${h.recomputation ?? "?"}`)))]
        : null);
  }

  function renderJustification(justification) {
    if (!justification) return null;
    const t = justification.thresholds;
    return el("div", { className: "confidence" },
      el("p", {}, badge(justification.established ? "established" : "not established", justification.established ? "supported" : "unresolved"),
        justification.confidence !== null ? ` Speck confidence ${justification.confidence} (${justification.status}). Supported needs ${t.supported}; leading needs ${t.leading} and a ${t.leadingMargin} margin.` : ""),
      justification.confidence !== null
        ? el("meter", { min: "0", max: "1", low: String(t.leading), high: String(t.supported), optimum: "1", value: String(justification.confidence), "aria-label": `Speck confidence ${justification.confidence}` })
        : null,
      el("ul", {}, justification.reasons.map((reason) => el("li", {}, reason))),
      justification.wouldChange.length ? [el("h4", {}, "What would make it firm"), el("ul", {}, justification.wouldChange.map((item) => el("li", {}, item)))] : null);
  }

  const hypothesisLine = (view) => el("li", {},
    badge(view.status, view.status === "rejected" ? "rejected" : ""), " ", el("code", {}, view.key), ` ${view.statement} (Speck confidence ${view.confidence})`,
    view.status === "rejected" && view.contradicting.length ? ` - refuted by ${view.contradicting.map((ref) => ref.recordId).join(", ")}` : "");

  // Whether two conclusions describe the same belief state.
  const sameBeliefs = (left, right) => left.state === right.state
    && left.hypothesis?.key === right.hypothesis?.key
    && left.direction?.pointsTo?.key === right.direction?.pointsTo?.key
    && left.uncertainty.speckConfidence === right.uncertainty.speckConfidence;

  function renderExplanation(run, current) {
    const e = run.explanation;
    if (!e) return null;
    const stale = !sameBeliefs(run.conclusion, current);
    const agreement = e.agreement;
    const trusted = agreement?.agrees && !stale;
    const text = [el("p", {}, e.text), el("p", { className: "meta" }, `cites: ${e.citedEvidence.join(", ") || "nothing"}; states: ${e.statedConclusion ?? "?"}, ${e.statedEstablished ? "established" : "not established"}`)];
    return el("section", { className: "outcome" },
      el("h3", {}, `Model explanation (${run.reasoner.model}, run ${run.runNumber})`),
      el("p", { className: "meta" }, badge("model-generated", "warn"), " The model's wording. Speck's belief state above is the conclusion; this text is checked against it, not the other way round."),
      !agreement ? el("p", {}, badge("not checked against Speck (recorded before checks existed)", "warn")) : null,
      agreement && !agreement.agrees ? el("div", {}, badge("does not match Speck's belief state", "bad"), el("ul", {}, agreement.problems.map((problem) => el("li", {}, problem)))) : null,
      stale ? el("p", {}, badge(`written for run ${run.runNumber}'s state, which has since changed`, "warn")) : null,
      trusted ? [badge("matches Speck's belief state", "ok"), ...text] : el("details", {}, el("summary", {}, "Show the model's text anyway"), ...text));
  }

  function competingExplanations(hypotheses) {
    return el("ul", { className: "refs explanations" }, hypotheses.map((h) => el("li", {},
      el("code", {}, h.key), ` ${h.statement} `, el("span", { className: "muted" }, `(prior ${h.confidence})`))));
  }

  function renderConclusion() {
    const { investigation } = view;
    const c = investigation?.current ?? null;
    const run = investigation?.latestRun ?? null;
    const pending = view.listing?.pending ?? null;
    if (!c) {
      $("conclusion").replaceChildren(el("div", { className: "empty" },
        el("p", { className: "headline" }, "No conclusion yet"),
        el("p", {}, "Run the investigation to assess the evidence at this stage. Until then, these are the competing explanations, at the priors the case starts from:"),
        competingExplanations(investigation?.hypotheses ?? [])));
      return;
    }
    const u = c.uncertainty;
    // The hypothesis the evidence is about: the conclusion, or the explanation
    // the evidence points to when it is not yet a conclusion.
    const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
    const held = [...(c.hypothesis ? [c.hypothesis] : []), ...c.alternatives];
    // Built through el(), which drops null and flattens nested lists;
    // replaceChildren alone would render them as "null" and "[object ...]".
    $("conclusion").replaceChildren(el("div", {},
      el("div", { className: "state-row" }, badge(c.state, `${c.state} state`),
        el("span", { className: "muted" }, run
          ? `Speck's current belief state. Last run: ${run.runNumber} at ${when(run.finishedAt)}, stage "${run.stage.label}", ${run.execution.status}.`
          : "Speck's current belief state. No run has completed: an earlier run was interrupted, and these beliefs come from the evidence it recorded.")),
      pending?.length ? el("p", {}, badge(`${pending.length} record(s) not yet assessed: ${pending.join(", ")}. These beliefs do not include them yet; run the investigation.`, "warn long")) : null,
      c.reconciled === false ? el("p", {}, badge("Beliefs lag the evidence ledger after an interruption; run the investigation to reconcile them.", "bad long")) : null,
      el("p", { className: "headline" }, c.headline),
      el("p", { className: "state-meaning" }, STATE_MEANING[c.state] ?? ""),
      renderJustification(c.justification),
      help("What do supported, leading and unresolved mean?", ...HELP.states),
      el("div", { id: "edk-support" },
        el("h3", {}, subject ? `Evidence currently supporting ${subject.key}` : "Supporting evidence"), refList(subject?.supporting ?? []),
        el("h3", {}, subject ? `Evidence currently against ${subject.key}` : "Contradicting evidence"), refList(subject?.contradicting ?? [])),
      renderRevisions(c, investigation.history),
      el("h3", {}, "Competing explanations"),
      el("h4", {}, "Still held"),
      held.length ? el("ul", { className: "refs" }, held.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
      el("h4", {}, "Ruled out by the evidence that counts now"),
      c.rejected.length ? el("ul", { className: "refs" }, c.rejected.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
      el("h3", {}, "Open questions"),
      c.openQuestions.length ? el("ul", {}, c.openQuestions.map((q) => el("li", {}, q.text))) : el("p", { className: "muted" }, "none"),
      c.answeredQuestions.length ? [el("h4", {}, "Answered by evidence"), el("ul", {}, c.answeredQuestions.map((q) => el("li", {}, `${q.text} ${q.answer} (`, el("code", {}, q.recordId), ")")))] : null,
      run ? renderExplanation(run, c) : null,
      el("details", { className: "more" },
        el("summary", {}, "More detail: what the evidence shows, notes, and how the last run executed"),
        c.direction ? [el("h4", {}, "What the evidence shows"), el("p", {}, c.direction.summary),
          c.direction.pointsTo ? el("p", {}, "Points to: ", el("code", {}, c.direction.pointsTo.key), ` ${c.direction.pointsTo.statement}`) : null] : null,
        el("h4", {}, "Notes"),
        el("ul", {},
          u.runnerUp ? el("li", {}, `Runner-up ${u.runnerUp.key} at ${u.runnerUp.confidence} (margin ${u.margin})`) : null,
          u.notes.map((note) => el("li", {}, note))),
        run ? renderRun(run) : null)
    ));
  }

  // The last completed run: how it executed.
  function renderRun(run) {
    return [
      el("h4", {}, "How the last run executed"),
      el("ul", {},
        el("li", {}, `Evidence: ${run.evidence.label} (${run.evidence.target}); ${run.assessed.length} new record(s) assessed`),
        el("li", {}, `Assessor: ${run.reasoner.label}${run.reasoner.model ? ` - ${run.reasoner.model} @ ${run.reasoner.endpoint}` : ""}${run.reasonerUsage ? `; ${run.reasonerUsage.successes} successful of ${run.reasonerUsage.calls} model calls in this session` : ""}`),
        el("li", {}, `Execution: ${run.execution.engine}, status ${run.execution.status}, ${run.execution.chunks.length} of max ${run.execution.chunkConfig.maxChunks} chunks, ${run.execution.totalTokensUsed} tokens (${run.execution.tokenLabel}), ${run.execution.durationMs} ms`),
        run.execution.error ? el("li", {}, badge(`execution error: ${run.execution.error}`, "bad long")) : null,
        run.unprocessed.length ? el("li", {}, badge(`not assessed: ${run.unprocessed.join(", ")}`, "warn")) : null,
        run.notes.map((note) => el("li", {}, note)),
        run.reasoner.kind === "rules" ? el("li", {}, "Model explanation: none, because this run used the deterministic rule assessor and no reasoning model.") : null),
      el("details", {}, el("summary", {}, "Meterless chunks and carryover"),
        run.execution.chunks.map((chunk) => el("div", {}, el("h4", {}, `Chunk ${chunk.id} (${chunk.tokens} tokens, estimated)`),
          chunk.carryover ? el("pre", {}, `carryover in:\n${chunk.carryover}`) : null, el("pre", {}, chunk.content))))
    ];
  }

  // Execution trace: one entry per run or action, newest first, the latest
  // open. Each component is named for what it actually did; nothing is shown
  // that was not saved.
  function renderTrace(trace) {
    const entries = [...(trace?.entries ?? [])].reverse();
    if (!entries.length) { $("trace").replaceChildren(el("p", { className: "muted" }, "Nothing has run yet.")); return; }
    const latestRun = entries.find((entry) => entry.kind === "run");
    $("trace").replaceChildren(...entries.map((entry) => entry.kind === "run" ? renderRunTrace(entry, entry === latestRun) : renderActionTrace(entry)));
  }

  const sponsor = (name, kind) => badge(name, `sponsor ${kind ?? ""}`);

  function evidenceSummary(evidence) {
    if (!evidence) return "evidence: not recorded";
    return evidence.mode === "zetaris"
      ? `Zetaris LIVE: ${evidence.sources.length} SELECT(s), ${evidence.sources.reduce((sum, item) => sum + item.rows, 0)} row(s)`
      : "FIXTURE FILE (not Zetaris)";
  }

  function modelSummary(run) {
    const calls = run.steps.flatMap((step) => (step.kind === "chunk" || step.kind === "explanation") && step.model ? [step.model] : []);
    if (!calls.length) return run.reasoner?.kind === "rules" ? "rule assessor (no model)" : "no model call recorded";
    const served = [...new Set(calls.flatMap((call) => call.servedModels))].join(", ") || "model name not reported";
    return `Nemotron ${served}: ${calls.length} call(s), ${run.flags.retries} retr${run.flags.retries === 1 ? "y" : "ies"}`;
  }

  function renderRunTrace(run, open) {
    const f = run.flags;
    const recorded = run.steps.reduce((sum, step) => sum + (step.speck?.recorded.length ?? 0), 0);
    return el("details", { className: "trace-entry", open: open ? "" : null },
      el("summary", {},
        el("strong", {}, run.runNumber ? `Run ${run.runNumber}` : "Interrupted run"), ` ${run.status} - `,
        evidenceSummary(run.evidence), " -> ",
        run.meterless ? `Meterless ${run.meterless.runId} (${run.meterless.chunks} chunk${run.meterless.chunks === 1 ? "" : "s"})` : "Meterless: no record (run did not finish)", " -> ",
        modelSummary(run), " -> ",
        `Speck: ${recorded} recorded, ${f.revisions} revision(s)`,
        f.recomputations.length ? `, recomputation ${f.recomputations.join(", ")}` : "",
        " ",
        run.status === "interrupted" ? badge("interrupted before it finished", "bad") : null,
        f.pending.length ? badge(`${f.pending.length} pending`, "warn") : null,
        f.failed.length ? badge(`${f.failed.length} failed`, "bad") : null,
        f.retries ? badge(`${f.retries} model retr${f.retries === 1 ? "y" : "ies"}`, "warn") : null,
        f.invalidCitations.length ? badge(`invalid citations: ${f.invalidCitations.join(", ")}`, "bad") : null,
        f.recovered.length ? badge(`recovered ${f.recovered.length} interrupted run(s)`, "warn") : null),
      el("div", { className: "trace-body" },
        renderTraceEvidence(run.evidence),
        run.meterless ? el("div", { className: "trace-row" }, sponsor("METERLESS", "meterless"),
          ` ${run.meterless.engine}. Run ${run.meterless.runId}: ${run.meterless.status}, ${run.meterless.chunks} of at most ${run.meterless.maxChunks} chunks, ${run.meterless.durationMs} ms`,
          run.meterless.reflection ? "; reflection pass used for the explanation" : "",
          run.meterless.inHistory === true ? " - present in the engine's history.json" : run.meterless.inHistory === false ? [" ", badge("not found in the engine's history.json", "bad")] : " - engine history not readable")
          : el("div", { className: "trace-row" }, sponsor("METERLESS", "meterless"), " The run stopped before the engine recorded it; only its saved assessments remain."),
        run.reasoner ? el("div", { className: "trace-row" }, run.reasoner.kind === "nemotron" ? sponsor("NEMOTRON (local)", "nemotron") : badge("RULES", "ok"),
          run.reasoner.kind === "nemotron" ? ` requested ${run.reasoner.model} at ${run.reasoner.endpoint}` : " deterministic fact rules; no model was called") : null,
        el("ol", { className: "trace-steps" }, run.steps.map(renderTraceStep)))
    );
  }

  function renderTraceEvidence(evidence) {
    if (!evidence) return el("div", { className: "trace-row" }, badge("EVIDENCE", "warn"), " not recorded for this run");
    if (evidence.mode === "zetaris") {
      return el("div", { className: "trace-row" }, sponsor("ZETARIS LIVE", "zetaris"), ` ${evidence.label} at ${evidence.target}; ${evidence.visible ?? "?"} record(s) visible at this stage.`,
        el("ul", { className: "refs" }, evidence.sources.map((source) => el("li", {}, el("code", {}, source.location), ` ${source.rows} row(s)`,
          source.latencyMs !== null ? `, ${source.latencyMs} ms` : "", source.queryToken ? [", query token ", el("code", {}, `${source.queryToken.slice(0, 12)}...`)] : ""))));
    }
    return el("div", { className: "trace-row" }, badge("FIXTURE FILE - NOT ZETARIS", "fixture"),
      ` Read from ${evidence.sources.map((source) => source.location).join(", ") || evidence.target}; ${evidence.visible ?? "?"} record(s) visible at this stage. No Zetaris query was made.`);
  }

  function renderModelCall(call) {
    const c = call.constraints;
    const j = call.judgments;
    return el("div", { className: "meta" },
      sponsor("NEMOTRON", "nemotron"), ` served ${call.servedModels.join(", ") || "(no model name reported)"} (requested ${call.requestedModel}); `,
      call.outcome === "valid" ? badge("reply valid", "ok") : badge(`failed: ${call.error}`, "bad long"),
      ` ${call.attempts} attempt(s)${call.contractFailures ? `, ${call.contractFailures} rejected by Speck's contract check` : ""}${call.transportFailures ? `, ${call.transportFailures} transport failure(s)` : ""}; `,
      `latency ${call.httpCalls.map((item) => `${item.latencyMs} ms`).join(" + ") || "n/a"}.`,
      el("div", {}, `Constrained by: Speck contract "${c.contract}"${c.requiredPairs ? ` covering all ${c.requiredPairs} evidence/hypothesis pairs with enumerated ids` : ""}, temperature ${c.temperature}, at most ${c.maxAttempts} attempts, ${c.maxTokens} output tokens${c.reasoningEffort ? `, reasoning effort ${c.reasoningEffort}` : ""}.`),
      j ? el("div", {}, `Returned ${j.returned}: kept ${j.kept} as model judgments, ${j.neutral} neutral, ${j.repeated} already judged, ${j.discardedUnknown} discarded (unknown id), ${j.ruleKept} overruled by a deterministic rule`,
        j.unanswered.length ? `; no answer for ${j.unanswered.join(", ")} (left pending)` : "", ". Speck caps model-judged evidence at reliability 0.4.") : null);
  }

  function renderSpeck(speck) {
    if (!speck || (!speck.recorded.length && !speck.revisions.length && !speck.recomputations.length)) return null;
    return el("div", { className: "meta" }, sponsor("SPECK", "speck"),
      speck.recorded.length ? ` recorded ${speck.recorded.join(", ")};` : "",
      speck.recomputations.length ? [" ", badge(`Evidence Desk recomputation ${speck.recomputations.join(", ")}`, "warn")] : "",
      speck.revisions.length ? el("ul", { className: "refs" }, speck.revisions.map((revision) => el("li", { className: revision.historical ? "muted" : "" },
        el("code", {}, revision.hypothesisKey), ` ${revision.from} -> ${revision.to}`, revision.recordId ? ` (${revision.recordId})` : "", revision.historical ? " - belief since replaced" : ""))) : null);
  }

  function renderTraceStep(step) {
    if (step.kind === "reconcile") {
      return el("li", {}, badge("EVIDENCE DESK", "desk"), ` reconciled beliefs at the ${step.when} of the run (recovery, not a sponsor component).`, renderSpeck(step.speck));
    }
    if (step.kind === "explanation") {
      return el("li", {}, el("strong", {}, "Explanation"), step.model ? renderModelCall(step.model) : " (no model call recorded)",
        step.agrees === null ? null : el("div", { className: "meta" }, step.agrees ? badge("matches Speck's belief state", "ok") : badge(`does not match Speck: ${step.problems.join(" ")}`, "bad long")),
        step.invalidCitations.length ? el("div", { className: "meta" }, badge(`invented citations: ${step.invalidCitations.join(", ")}`, "bad")) : null);
    }
    return el("li", {},
      el("strong", {}, `Chunk ${step.chunk}`),
      step.meterless ? ` (Meterless step, ${step.meterless.tokens} tokens estimated${step.meterless.carryoverIn ? ", with carryover in" : ""})` : " (not recorded by Meterless: run interrupted)",
      `: ${step.records.join(", ") || "no record judged"}`,
      step.failed.length ? [" ", badge(`failed: ${step.failed.map((item) => `${item.recordId} (${item.error})`).join("; ")}`, "bad long")] : null,
      step.model ? renderModelCall(step.model) : el("div", { className: "meta" }, `${step.judgments.rule} rule judgment(s); no model call.`),
      step.model ? el("div", { className: "meta" }, `${step.judgments.model} model and ${step.judgments.rule} rule judgment(s) saved before the evidence entered Speck.`) : null,
      step.judgments.noBearing.length ? el("div", { className: "meta" }, `No bearing on any hypothesis: ${step.judgments.noBearing.join(", ")}.`) : null,
      renderSpeck(step.speck));
  }

  function renderActionTrace(action) {
    const what = action.action === "withdrawal" ? `${action.recordId} withdrawn (${action.reason})`
      : action.action === "withdrawal-before-assessment" ? `${action.recordId} withdrawn before assessment (${action.reason}); no judgment recorded`
      : "Beliefs reconciled after an interrupted run (on open)";
    return el("details", { className: "trace-entry" },
      el("summary", {}, badge("EVIDENCE DESK", "desk"), ` ${when(action.at)}: ${what}`,
        action.speck.revisions.length ? ` - ${action.speck.revisions.length} Speck revision(s)` : ""),
      el("div", { className: "trace-body" }, renderSpeck(action.speck) ?? el("p", { className: "muted" }, "No belief changed.")));
  }

  function renderTimeline() {
    const timeline = view.investigation?.timeline ?? [];
    const all = $("timeline-all").checked;
    const shown = timeline.filter((entry) => all || entry.significant || ["stage", "conclusion"].includes(entry.kind));
    if (!shown.length) { $("timeline").replaceChildren(el("li", { className: "muted" }, "Nothing has happened yet.")); return; }
    $("timeline").replaceChildren(...shown.map((entry) => el("li", { className: `kind-${entry.kind}${entry.significant ? " significant" : ""}${entry.historical ? " historical" : ""}` },
      el("div", { className: "when" }, `${when(entry.at)} - #${entry.sequence}${entry.runNumber ? ` - run ${entry.runNumber}` : ""} - ${entry.actor}`),
      el("div", { className: "title" }, entry.historical ? [badge("historical: belief since replaced", "warn"), " "] : null, entry.title),
      entry.detail ? el("div", { className: "detail" }, entry.detail) : null)));
  }

  async function refresh() {
    try {
      view.status = await api("/api/status");
      view.investigation = await api("/api/investigation");
      // Evidence access can fail (live mode); the conclusion and the trace still
      // render, without the pending check, and the failure is then reported.
      let evidenceError = null;
      try {
        view.listing = await api("/api/evidence");
      } catch (error) {
        evidenceError = error;
        view.listing = null;
      }
      renderStatus();
      renderTimeline();
      renderConclusion();
      // After the conclusion, so a fresh trace never sits beside a stale conclusion.
      view.trace = await api("/api/trace");
      renderTrace(view.trace);
      if (evidenceError) {
        $("evidence-summary").textContent = "The evidence could not be read; see the message above.";
        $("evidence-list").replaceChildren();
        throw evidenceError;
      }
      renderEvidence(view.listing);
      showError(null);
    } catch (error) {
      showError(error);
    }
    renderTour();
    renderGuide();
  }

  function setProgress(text) {
    $("progress").hidden = !text;
    $("progress").textContent = text ?? "";
  }

  const WORKING = {
    run: () => view.status?.reasoner?.kind === "nemotron" || view.status?.evidence?.mode === "zetaris"
      ? "Running the investigation… a live run can take up to about 35 seconds."
      : "Running the investigation…",
    update: () => "Introducing the next update…"
  };

  async function act(kind, path) {
    busy = kind;
    renderWorkflow();
    renderTour();
    setProgress(WORKING[kind]());
    try {
      await api(path, { method: "POST" });
      await refresh();
      const run = view.investigation?.latestRun;
      setProgress(kind === "run" && run ? `Run ${run.runNumber} finished (${run.execution.status}).` : kind === "update" ? `Introduced: ${view.status?.stage.label}.` : null);
    } catch (error) {
      await refresh();
      setProgress(null);
      showError(error);
    } finally {
      busy = null;
      if (view.status) renderWorkflow();
      renderTour();
    }
  }

  $("run-button").addEventListener("click", () => act("run", "/api/run"));
  $("update-button").addEventListener("click", () => act("update", "/api/update"));
  $("timeline-all").addEventListener("change", renderTimeline);

  // Withdrawing a record recomputes the beliefs that rested on it. Its
  // consequence is stated before anything happens.
  $("evidence-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-withdraw]");
    if (button) openWithdraw(button.dataset.withdraw, button.dataset.assessed === "yes");
  });
  $("evidence-list").addEventListener("toggle", (event) => {
    if (event.target.matches?.("details[data-feature]") && event.target.open) { progress.markViewed(event.target.dataset.feature); renderGuide(); }
  }, true);

  function openWithdraw(recordId, assessed) {
    const dialog = $("withdraw");
    const reason = el("textarea", { id: "edk-withdraw-reason", rows: "3", required: "" });
    const error = el("p", { className: "dialog-error", role: "alert", hidden: "" });
    const form = el("form", { method: "dialog", novalidate: "" },
      el("h2", { id: "edk-withdraw-title" }, `Withdraw ${recordId}?`),
      el("p", {}, assessed
        ? "This record stops counting in this case. Every belief that rested on it is recomputed from the evidence that still counts, and the change is recorded in the history."
        : "This record has not been assessed. It will be excluded from assessment: no judgment is recorded for it, and current beliefs do not change."),
      el("p", {}, el("strong", {}, "This cannot be undone from this page.")),
      el("label", { for: "edk-withdraw-reason" }, "Reason (recorded with the withdrawal)"),
      reason, error,
      el("div", { className: "dialog-actions" },
        el("button", { type: "button", className: "secondary", "data-cancel": "" }, "Cancel"),
        el("button", { type: "submit", className: "danger" }, "Withdraw record")));
    dialog.replaceChildren(form);
    form.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!reason.value.trim()) { error.hidden = false; error.textContent = "Give a reason; it is kept with the withdrawal."; return; }
      form.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      try {
        await api("/api/evidence/withdraw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId, reason: reason.value.trim() }) });
        dialog.close();
        await refresh();
        setProgress(`${recordId} withdrawn.`);
      } catch (failure) {
        error.hidden = false;
        error.textContent = failure.message;
        form.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      }
    });
    dialog.showModal();
    reason.focus();
  }

  // ----- Guided investigation -----

  const TARGETS = {
    case: () => $("case"),
    "run-button": () => $("run-button"),
    "update-button": () => $("update-button"),
    conclusion: () => $("conclusion-panel"),
    evidence: () => $("evidence-panel"),
    why: () => root.querySelector("#edk-why") ?? $("conclusion-panel"),
    timeline: () => $("timeline-panel"),
    trace: () => $("trace-panel"),
    "guide-button": () => $("guide-button"),
    record: () => {
      const record = recordToInspect(view);
      return record ? root.querySelector(`[data-record-id="${CSS.escape(record.id)}"]`) : $("evidence-panel");
    }
  };
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let tourStep = progress.tourStep();
  let coachCollapsed = false;
  let spotlit = null;
  // The step last scrolled to: a refresh re-renders the step without moving the page.
  let scrolledFor = null;

  function spotlight(target, scroll = true) {
    spotlit?.classList.remove("edk-spotlight");
    spotlit = target ?? null;
    if (!spotlit) return;
    spotlit.classList.add("edk-spotlight");
    if (scroll) spotlit.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function paragraphs(items) {
    return items.map((item) => Array.isArray(item)
      ? (item.length ? el("ul", {}, item.map((line) => el("li", {}, line))) : null)
      : el("p", {}, item));
  }

  function renderTour() {
    const coach = $("coach");
    if (tourStep === null) { coach.hidden = true; spotlight(null); scrolledFor = null; return; }
    const step = TOUR_STEPS[tourStep];
    const done = stepDone(step, view);
    const waiting = step.action && !done;
    const working = busy === step.action;
    if (step.id === "record") {
      const target = TARGETS.record();
      const details = target?.querySelector?.("details.record-details");
      if (details && !details.open) details.open = true;
    }
    coach.hidden = false;
    coach.classList.toggle("collapsed", coachCollapsed);
    // Through el(), which drops null; replaceChildren would print it.
    coach.replaceChildren(...el("div", {},
      el("div", { className: "coach-head" },
        el("p", { className: "eyebrow" }, `Guided investigation · step ${tourStep + 1} of ${TOUR_STEPS.length}`),
        el("button", { type: "button", className: "link", "data-tour": "collapse", "aria-expanded": String(!coachCollapsed) }, coachCollapsed ? "Expand" : "Minimise")),
      el("h2", { id: "edk-coach-title", tabindex: "-1" }, step.title),
      coachCollapsed ? null : el("div", { className: "coach-body" }, paragraphs(done && step.after ? [...(step.action ? [] : step.body(view)), ...step.after(view)] : step.body(view))),
      step.action && !coachCollapsed ? el("p", { className: `coach-status ${working ? "working" : done ? "done" : "waiting"}`, role: "status" },
        working ? "Working… the page updates when it finishes."
          : done ? "Done. This is the real result, read from Speck."
          : `Waiting for you: click ${step.action === "run" ? "Run investigation" : "Introduce prepared update"} on the page.`) : null,
      coachCollapsed ? null : el("div", { className: "coach-actions" },
        el("button", { type: "button", className: "secondary", "data-tour": "back", disabled: tourStep === 0 ? "" : null }, "Back"),
        waiting ? el("button", { type: "button", className: "link", "data-tour": "skip" }, "Skip this step") : null,
        el("button", { type: "button", className: "primary", "data-tour": "next", disabled: waiting || working ? "" : null },
          tourStep === TOUR_STEPS.length - 1 ? "Finish" : "Next"),
        el("button", { type: "button", className: "link", "data-tour": "exit" }, "Exit tour"))).childNodes);
    const key = `${tourStep}:${step.id === "record" ? recordToInspect(view)?.id : ""}`;
    spotlight(TARGETS[step.target]?.(), scrolledFor !== key);
    scrolledFor = key;
  }

  function goToStep(step) {
    tourStep = step;
    progress.setTourStep(step);
    renderTour();
    if (step !== null) root.querySelector("#edk-coach-title")?.focus({ preventScroll: true });
  }

  function startTour(fromStep = 0) {
    progress.dismissIntro();
    $("intro").hidden = true;
    closeGuide();
    goToStep(fromStep);
  }

  function exitTour() {
    tourStep = null;
    progress.setTourStep(null);
    renderTour();
    renderGuide();
    $("guide-button").focus();
  }

  $("coach").addEventListener("click", (event) => {
    const action = event.target.closest("[data-tour]")?.dataset.tour;
    if (!action) return;
    if (action === "back" && tourStep > 0) goToStep(tourStep - 1);
    if (action === "next" || action === "skip") {
      if (tourStep >= TOUR_STEPS.length - 1) exitTour();
      else goToStep(tourStep + 1);
    }
    if (action === "exit") exitTour();
    if (action === "collapse") { coachCollapsed = !coachCollapsed; renderTour(); root.querySelector("[data-tour=collapse]")?.focus(); }
  });

  // ----- First-run introduction and the feature guide -----

  $("intro").hidden = progress.introDismissed() || tourStep !== null;
  $("intro-start").addEventListener("click", () => startTour(0));
  $("intro-dismiss").addEventListener("click", () => { progress.dismissIntro(); $("intro").hidden = true; $("guide-button").focus(); });

  let guideOpen = false;
  function renderGuide() {
    const guide = $("guide");
    $("guide-button").setAttribute("aria-expanded", String(guideOpen));
    guide.hidden = !guideOpen;
    if (!guideOpen) return;
    const viewed = progress.viewed();
    const saved = progress.tourStep();
    guide.replaceChildren(
      el("div", { className: "guide-head" },
        el("h2", { id: "edk-guide-title", tabindex: "-1" }, "Guide"),
        el("button", { type: "button", className: "link", "data-guide": "close" }, "Close")),
      el("p", {}, "Evidence Desk investigates a case whose records can conflict, change or be withdrawn, and keeps every conclusion tied to the evidence behind it."),
      el("div", { className: "guide-actions" },
        el("button", { type: "button", className: "primary", "data-guide": "tour" }, saved !== null ? `Resume the tour (step ${saved + 1} of ${TOUR_STEPS.length})` : "Start the guided investigation"),
        saved !== null ? el("button", { type: "button", className: "secondary", "data-guide": "restart" }, "Restart from the beginning") : null,
        el("button", { type: "button", className: "link", "data-guide": "intro" }, "Show the introduction")),
      el("h3", {}, "Features"),
      el("p", { className: "meta" }, "\"Demonstrated\" means this case's real state shows it happened. \"Viewed\" means it has been opened on this page, by you or by the tour."),
      el("ul", { className: "features" }, FEATURES.map((feature) => {
        const s = featureStatus(feature, view, viewed);
        return el("li", {},
          el("div", { className: "feature-head" },
            el("strong", {}, feature.title),
            badge(s.state === "demonstrated" ? "demonstrated in this case" : s.state === "viewed" ? "viewed" : "not yet", s.state === "demonstrated" ? "ok" : s.state === "viewed" ? "pending" : "")),
          el("p", {}, feature.text),
          s.note ? el("p", { className: "meta" }, s.available ? "" : badge("not available here", "warn"), " ", s.note) : null,
          el("button", { type: "button", className: "link", "data-guide": "show", "data-feature": feature.id }, "Show me"));
      })));
  }

  function openGuide() { guideOpen = true; renderGuide(); root.querySelector("#edk-guide-title")?.focus(); }
  function closeGuide() { guideOpen = false; renderGuide(); }

  $("guide-button").addEventListener("click", () => (guideOpen ? closeGuide() : openGuide()));
  $("guide").addEventListener("click", (event) => {
    const button = event.target.closest("[data-guide]");
    if (!button) return;
    const action = button.dataset.guide;
    if (action === "close") { closeGuide(); $("guide-button").focus(); }
    if (action === "tour") startTour(progress.tourStep() ?? 0);
    if (action === "restart") startTour(0);
    if (action === "intro") { progress.showIntroAgain(); $("intro").hidden = false; closeGuide(); $("intro").scrollIntoView({ block: "start" }); $("intro-start").focus(); }
    if (action === "show") {
      const feature = FEATURES.find((item) => item.id === button.dataset.feature);
      progress.markViewed(feature.id);
      closeGuide();
      const target = TARGETS[feature.target]?.();
      spotlight(target);
      target?.focus?.({ preventScroll: true });
      window.setTimeout(() => { if (spotlit === target && tourStep === null) spotlight(null); }, 2500);
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && guideOpen) { closeGuide(); $("guide-button").focus(); }
  });

  // Live run progress, where the host offers a stream (the standalone server).
  const events = eventsUrl ? new EventSource(eventsUrl) : null;
  events?.addEventListener("progress", (event) => {
    if (busy !== "run") return;
    const state = JSON.parse(event.data);
    setProgress(`${WORKING.run()} Meterless: ${state.phase} ${state.phaseDetail} (chunk ${state.currentChunk}/${state.maxChunks}).`);
  });

  refresh();
  return { refresh, destroy: () => { events?.close(); spotlight(null); } };
}
