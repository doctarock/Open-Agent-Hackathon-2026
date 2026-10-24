// Evidence Desk UI. Plain DOM; every value from the server is inserted as
// text, never as HTML. It mounts into any element: the standalone page
// (index.html) or a tab inside Speck (the Evidence Desk plugin), which differ
// only in where the API lives and how requests are authorised.
//
// Layout, top to bottom: the case and what the page is for; Speck beside a
// stateless model call on the same case (./compare.js); the steps of the
// investigation and its two actions; the current conclusion beside the
// evidence; then history (revision timeline, execution trace) and the
// workspace's configuration, and the evaluation results. The guided tour and the feature guide
// (./tour.js) read the same state the page renders.

import { CONFIDENCE_MEANING, FEATURES, STATE_MEANING, TOUR_STEPS, featureStatus, progressStore, recordToInspect, stepDone } from "./tour.js";
import { describeFailure, describeProgress, describeRun } from "./status.js";
import { decisiveSwitch, jumpToRecord, renderComparison, renderEvaluation } from "./compare.js";
import { decisivePreference, decisiveReading, opinionCurrent } from "./decisive.js";

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
    "Provenance names the system of record, the record's own reference and its author; \"retrieved\" says how this workspace read it: a local fixture file or a live Zetaris query, with its query token."
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
  <div class="header-actions">
    <button id="edk-reset-button" class="link" type="button" aria-haspopup="dialog">Reset demo case…</button>
    <button id="edk-delete-button" class="link danger" type="button" aria-haspopup="dialog" hidden>Delete investigation…</button>
    <button id="edk-guide-button" class="secondary" type="button" aria-controls="edk-guide" aria-expanded="false">Guide</button>
  </div>
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
  <div id="edk-progress" class="progress" role="status" aria-live="polite" hidden></div>
</section>

<div class="workspace">
  <section class="panel conclusion-panel" id="edk-conclusion-panel" aria-labelledby="edk-conclusion-heading">
    <h2 id="edk-conclusion-heading">Current conclusion</h2>
    <div id="edk-decisive" class="decisive"></div>
    <div id="edk-conclusion"><p class="muted">Loading…</p></div>
  </section>

  <section class="panel evidence-panel" id="edk-evidence-panel" aria-labelledby="edk-evidence-heading">
    <h2 id="edk-evidence-heading">Evidence</h2>
    <p id="edk-evidence-summary" class="muted"></p>
    <div id="edk-evidence-help"></div>
    <div id="edk-add-evidence" hidden></div>
    <ol id="edk-evidence-list" class="evidence-list"></ol>
  </section>
</div>

<section class="panel" id="edk-timeline-panel" aria-labelledby="edk-timeline-heading">
  <h2 id="edk-timeline-heading">Revision timeline</h2>
  <div id="edk-timeline-help"></div>
  <label class="muted toggle"><input id="edk-timeline-all" type="checkbox"> Show every event, not only changes</label>
  <ol id="edk-timeline" class="timeline"></ol>
</section>

<section class="panel compare-panel" id="edk-compare-panel" aria-labelledby="edk-compare-heading">
  <div class="cmp-summary">
    <div>
      <h2 id="edk-compare-heading">Speck beside a stateless baseline</h2>
      <p class="muted" id="edk-compare-teaser">The same case, run again on the same records by a stateless baseline that answers from scratch each time, to show what Speck's kept state changes.</p>
    </div>
    <button id="edk-compare-toggle" class="secondary" type="button" aria-expanded="false" aria-controls="edk-compare">Show the comparison</button>
  </div>
  <div id="edk-compare" hidden><p class="muted">Loading the comparison…</p></div>
</section>

<section class="panel" id="edk-trace-panel" aria-labelledby="edk-trace-heading">
  <h2 id="edk-trace-heading">Execution trace</h2>
  <div id="edk-trace-help"></div>
  <div id="edk-trace"></div>
</section>

<details class="panel evaluation" id="edk-evaluation-panel" hidden>
  <summary><h2>Evaluation results</h2> <span class="muted">held-out cases, correction regressions, cross-domain suite, live samples and saved comparisons</span></summary>
  <div id="edk-evaluation"><p class="muted">Loading…</p></div>
</details>

<details class="panel system" id="edk-system">
  <summary>How this workspace is configured</summary>
  <dl id="edk-configuration" class="configuration"></dl>
</details>

<aside id="edk-coach" class="coach" aria-labelledby="edk-coach-title" hidden></aside>
<section id="edk-guide" class="guide" aria-labelledby="edk-guide-title" hidden></section>
<dialog id="edk-withdraw" class="withdraw-dialog" aria-labelledby="edk-withdraw-title"></dialog>
<dialog id="edk-reset" class="withdraw-dialog reset-dialog" aria-labelledby="edk-reset-title"></dialog>
<dialog id="edk-delete" class="withdraw-dialog" aria-labelledby="edk-delete-title"></dialog>
`;

// Mounts the page into root. apiBase: where the JSON API lives (/api
// standalone; the plugin's case route inside Speck). fetchImpl: how to call
// it (Speck passes its admin-authorised fetch). eventsUrl: a server-sent
// event stream for run progress, if the host has one.
// userCase: an investigation the person created (the plugin's own cases), to
// which they can add evidence from the page, and which they can delete.
// onDeleted: called with the API's answer once such an investigation is
// deleted; the host takes the page away.
// onReset: called after the case is reset outside a guided demo, so the host
// can set its own guidance up for the next person too.
// intro: false hides the first-run introduction (the host offers its own).
// guided: this page is one part of a longer guided demo the host runs
// (public/journey.js): { label, steps: tour step ids, finishLabel, start:
// "first" | "last" | "resume", onFinish, onBack, onExit }.
// onView: called with the page's state after every refresh.
// evaluationUrl: where the evaluation summary is served (none: no panel).
export function mountEvidenceDesk(root, { apiBase = "/api", fetchImpl = fetch, eventsUrl = null, userCase = false, intro = true, guided = null, onView = null, evaluationUrl = null, onDeleted = null, onReset = null } = {}) {
  root.classList.add("edk");
  root.innerHTML = TEMPLATE;
  const $ = (id) => root.querySelector(`#edk-${id}`);
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  // A guided part has its own steps, so its place is kept apart from the case's own tour.
  const progress = progressStore(storage, guided ? `${apiBase}#guided` : apiBase);
  const steps = guided?.steps ? TOUR_STEPS.filter((step) => guided.steps.includes(step.id)) : TOUR_STEPS;

  $("evidence-help").replaceChildren(help("What do these labels mean?", ...HELP.evidence));
  $("timeline-help").replaceChildren(help("What is this?", ...HELP.timeline));
  $("trace-help").replaceChildren(help("What is this?", ...HELP.trace));

  // Set when the host removes the page (another case, or the new-case form):
  // a request still in flight then resolves without touching the page.
  let destroyed = false;

  async function api(path, options = {}) {
    // Paths are written as /api/...; the host decides where the API lives.
    const response = await fetchImpl(apiBase + path.slice("/api".length), options);
    if (destroyed) throw Object.assign(new Error("The page was closed"), { closed: true });
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { body });
    return body;
  }

  function showError(error) {
    if (destroyed) return;
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
  const view = { status: null, investigation: null, listing: null, trace: null, comparison: null };
  let busy = null;

  function renderStatus() {
    const { status } = view;
    $("case-id").textContent = `· case ${status.case.caseId}`;
    $("case-title").textContent = status.case.title;
    $("case-question").textContent = status.case.question;
    const { evidence, reasoner, execution, speck } = status;
    // Through el(), which drops null; replaceChildren would print it.
    $("sources").replaceChildren(...el("span", {},
      badge(evidence.mode === "zetaris" ? "Evidence: Zetaris live" : "Evidence: fixture file, not Zetaris", evidence.mode),
      badge(reasoner.kind === "nemotron" ? `Assessor: ${reasoner.label} (${reasoner.model})` : "Assessor: deterministic rules", reasoner.ready ? "ok" : "bad"),
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
    $("reset-button").disabled = working;
    $("delete-button").disabled = working;
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

  // Adding evidence to the person's own investigation. Built once, so a
  // refresh never clears what is being typed; the records it can correct are
  // brought up to date on every refresh.
  let addForm = null;
  function renderAddEvidence() {
    const holder = $("add-evidence");
    if (!userCase) return;
    holder.hidden = false;
    if (!addForm) {
      const error = el("p", { className: "dialog-error", role: "alert", hidden: "" });
      addForm = el("form", { className: "add-evidence", novalidate: "" },
        el("h3", {}, "Add evidence"),
        el("p", { className: "meta", "data-assessor-note": "" }),
        el("label", { className: "field" }, "Source", el("input", { type: "text", name: "source", maxlength: "120", placeholder: "Where it comes from, e.g. Warehouse inbound log" })),
        el("label", { className: "field" }, "What it says", el("textarea", { name: "content", rows: "2", maxlength: "1200" })),
        el("label", { className: "field" }, "When the source recorded it (optional)", el("input", { type: "date", name: "observedAt" })),
        el("label", { className: "field" }, "This corrects an earlier record (optional)", el("select", { name: "corrects" })),
        error,
        el("div", { className: "dialog-actions" }, el("button", { type: "submit", className: "secondary" }, "Add evidence")));
      addForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = (name) => addForm.querySelector(`[name="${name}"]`).value.trim();
        const submit = addForm.querySelector("[type=submit]");
        submit.disabled = true;
        error.hidden = true;
        try {
          const result = await api("/api/evidence/add", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: value("source"), content: value("content"), ...(value("observedAt") ? { observedAt: value("observedAt") } : {}), ...(value("corrects") ? { corrects: value("corrects") } : {}) }) });
          const corrected = value("corrects");
          addForm.reset();
          await refresh();
          showOutcome({ tone: "ok", title: `${result.recordId} added.`,
            lines: [corrected ? `It corrects ${corrected}: once a run assesses ${result.recordId}, ${corrected} stops counting and the beliefs that rested on it are rebuilt.` : "It does not count until a run assesses it."],
            next: "Run the investigation to assess it." });
        } catch (failure) {
          error.hidden = false;
          error.textContent = `Not added: ${failure.message}`;
        } finally {
          submit.disabled = false;
        }
      });
      holder.replaceChildren(addForm);
    }
    const select = addForm.querySelector('[name="corrects"]');
    const chosen = select.value;
    select.replaceChildren(el("option", { value: "" }, "No, it is a new record"),
      ...(view.listing?.records ?? []).filter((record) => !record.invalidation).map((record) => el("option", { value: record.id }, `${record.id}: ${record.content.slice(0, 60)}${record.content.length > 60 ? "…" : ""}`)));
    select.value = [...select.options].some((option) => option.value === chosen) ? chosen : "";
    addForm.querySelector("[data-assessor-note]").textContent = view.status?.reasoner?.kind === "nemotron"
      ? "Your evidence is free text, so the model weighs it against each explanation; Speck caps model-judged evidence at reliability 0.4."
      : "This workspace uses the deterministic rule assessor, which matches structured facts. Your free-text evidence has none, so runs assess it but cannot weigh it: run npm run configure to choose a model (Meterless Runtime, local Ollama or NVIDIA's API) and restart Speck.";
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
        badge(record.retrieval.mode === "zetaris" ? "Zetaris live" : "fixture file, not Zetaris", record.retrieval.mode)),
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

  // Where a run's model calls went. Runs recorded before providers existed
  // carry "openai-compatible", and were local.
  function modelSponsor(provider) {
    if (provider === "meterless") return sponsor("METERLESS RUNTIME", "meterless");
    return sponsor(provider === "nvidia" ? "NEMOTRON (NVIDIA API)" : "NEMOTRON (local)", "nemotron");
  }

  function modelSummary(run) {
    const calls = run.steps.flatMap((step) => (step.kind === "chunk" || step.kind === "explanation") && step.model ? [step.model] : []);
    if (!calls.length) return run.reasoner?.kind === "rules" ? "rule assessor (no model)" : "no model call recorded";
    const served = [...new Set(calls.flatMap((call) => call.servedModels))].join(", ") || "model name not reported";
    return `${calls.some((call) => /^meterless\//.test(call.requestedModel)) ? `Meterless Runtime (${calls[0].requestedModel}) served` : "Nemotron"} ${served}: ${calls.length} call(s), ${run.flags.retries} retr${run.flags.retries === 1 ? "y" : "ies"}`;
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
        run.reasoner ? el("div", { className: "trace-row" }, run.reasoner.kind === "nemotron" ? modelSponsor(run.reasoner.provider) : badge("RULES", "ok"),
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
      /^meterless\//.test(call.requestedModel) ? sponsor("METERLESS RUNTIME", "meterless") : sponsor("NEMOTRON", "nemotron"), ` served ${call.servedModels.join(", ") || "(no model name reported)"} (requested ${call.requestedModel}); `,
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
    if (destroyed) return;
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
      renderDecisive();
      // After the conclusion, so a fresh trace never sits beside a stale conclusion.
      view.trace = await api("/api/trace");
      renderTrace(view.trace);
      await loadComparison();
      if (evidenceError) {
        $("evidence-summary").textContent = "The evidence could not be read; see the message above.";
        $("evidence-list").replaceChildren();
        throw evidenceError;
      }
      renderEvidence(view.listing);
      renderAddEvidence();
      showError(null);
      renderDecisive();
      ensureOpinion();
    } catch (error) {
      showError(error);
    }
    renderTour();
    renderGuide();
    if (!destroyed) onView?.(view);
  }

  function setProgress(text) {
    if (destroyed) return;
    const box = $("progress");
    box.hidden = !text;
    box.className = "progress";
    box.textContent = text ?? "";
  }

  // An outcome: what happened, in a tone, and what to do next.
  function showOutcome(outcome) {
    if (destroyed) return;
    const box = $("progress");
    if (!outcome) { setProgress(null); return; }
    box.hidden = false;
    box.className = `progress outcome-${outcome.tone}`;
    box.replaceChildren(...el("div", {},
      el("strong", {}, outcome.title),
      outcome.lines.map((line) => el("p", {}, line)),
      outcome.next ? el("p", { className: "next" }, outcome.next) : null).childNodes);
  }

  const liveRun = () => view.status?.reasoner?.kind === "nemotron" || view.status?.evidence?.mode === "zetaris";
  let engineProgress = null;
  let workingText = "";

  // While an action runs: elapsed time, and the execution engine's own
  // progress when the host provides it (a stream standalone, polling in Speck).
  function startWorking(kind) {
    const began = Date.now();
    engineProgress = null;
    const tick = async () => {
      if (kind === "run" && !eventsUrl) {
        try { engineProgress = (await api("/api/progress")).progress ?? engineProgress; } catch { /* keep the last report */ }
      }
      if (busy !== kind || destroyed) return;
      workingText = describeProgress(kind, Date.now() - began, engineProgress && engineProgress.at && Date.parse(engineProgress.at) >= began - 1000 ? engineProgress : null)
        + (kind === "run" && liveRun() ? " A live run can take up to about 35 seconds." : "");
      setProgress(workingText);
      const status = root.querySelector(".coach-status.working");
      if (status) status.textContent = workingText;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }

  async function act(kind, path) {
    busy = kind;
    renderWorkflow();
    renderTour();
    const stop = startWorking(kind);
    try {
      await api(path, { method: "POST" });
      stop();
      await refresh();
      if (kind === "run") showOutcome(describeRun(view));
      else {
        const pending = view.listing?.pending ?? [];
        showOutcome({ tone: "ok", title: `Introduced: ${view.status?.stage.label}.`,
          lines: pending.length ? [`${pending.length} new record(s) are waiting to be assessed: ${pending.join(", ")}. The conclusion does not include them yet.`] : [],
          next: pending.length ? "Run the investigation to assess them." : null });
      }
    } catch (error) {
      stop();
      await refresh();
      showOutcome(describeFailure(kind, error));
    } finally {
      busy = null;
      if (view.status) renderWorkflow();
      renderTour();
      ensureOpinion();
    }
  }

  $("run-button").addEventListener("click", () => act("run", "/api/run"));
  $("reset-button").addEventListener("click", () => openReset());
  $("delete-button").hidden = !userCase;
  $("delete-button").addEventListener("click", () => openDelete());
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

  // Resetting the demo case: a fresh copy becomes current; nothing is
  // deleted. What changes and what does not is said before anything happens.
  function openReset() {
    const dialog = $("reset");
    const generation = view.status?.case.generation ?? 1;
    const form = el("form", { method: "dialog" },
      el("h2", { id: "edk-reset-title" }, "Reset the demo case?"),
      el("p", {}, "This starts a fresh copy of this case: its evidence back at the first stage with nothing assessed, the competing explanations at their starting priors, no runs and no history. The guided tour starts again from the introduction."),
      el("p", {}, el("strong", {}, "Nothing is deleted. "),
        `The current copy (copy ${generation}) is kept in Speck, suspended, with its full history. Other cases, Speck's other work and the evidence source (the fixture file or Zetaris) are not touched.`),
      el("div", { className: "dialog-actions" },
        el("button", { type: "button", className: "secondary", "data-cancel": "" }, "Cancel"),
        el("button", { type: "submit", className: "primary" }, "Reset demo case")));
    dialog.replaceChildren(form);
    form.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    form.addEventListener("submit", (event) => { event.preventDefault(); dialog.close(); resetCase(); });
    dialog.showModal();
    form.querySelector("[type=submit]").focus();
  }

  // Deleting an investigation the person created. What goes and what is kept
  // is said before anything happens.
  function openDelete() {
    const dialog = $("delete");
    const title = view.status?.case.title ?? "this investigation";
    const error = el("p", { className: "dialog-error", role: "alert", hidden: "" });
    const form = el("form", { method: "dialog" },
      el("h2", { id: "edk-delete-title" }, `Delete "${title}"?`),
      el("p", {}, "It leaves the Evidence tab, with its evidence, runs and history. Speck stops offering it: its task is suspended and its chat summary archived."),
      el("p", {}, el("strong", {}, "It can be restored. "),
        "Its files are moved to the plugin's data/deleted-cases/ folder, and Speck keeps the suspended task with its full history. The prepared cases and Speck's other work are not touched."),
      error,
      el("div", { className: "dialog-actions" },
        el("button", { type: "button", className: "secondary", "data-cancel": "" }, "Cancel"),
        el("button", { type: "submit", className: "primary danger" }, "Delete investigation")));
    dialog.replaceChildren(form);
    form.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector("[type=submit]");
      submit.disabled = true;
      error.hidden = true;
      try {
        const result = await api("/api/delete", { method: "POST" });
        dialog.close();
        onDeleted?.(result);
      } catch (failure) {
        error.hidden = false;
        // A 404 without the server's own message: this Speck was started before the
        // plugin gained deleting (Speck loads plugin routes only at startup).
        error.textContent = failure.message === "HTTP 404"
          ? "The investigation was not deleted: this Speck was started before Evidence Desk was updated, so it does not offer deleting yet. Restart Speck (npm run speck) and try again."
          : `The investigation was not deleted: ${failure.message}`;
        submit.disabled = false;
      }
    });
    dialog.showModal();
    form.querySelector("[data-cancel]").focus();
  }

  async function resetCase() {
    busy = "reset";
    renderWorkflow();
    const stop = startWorking("reset");
    try {
      const result = await api("/api/reset", { method: "POST" });
      stop();
      await refresh();
      // Success is claimed only for what the API now shows.
      const firstStage = view.status?.stages?.[0]?.id;
      const fresh = view.status?.case.generation === result.generation && (view.investigation?.runs?.length ?? -1) === 0 && view.status?.stage.id === firstStage;
      if (!fresh) {
        showOutcome({ tone: "error", title: "The reset could not be confirmed.", lines: ["The server answered, but the page does not show a fresh case at its first stage."], next: "Reload the page to see the case as Speck holds it now." });
        return;
      }
      progress.resetForDemo();
      tourStep = null;
      coachCollapsed = false;
      renderTour();
      if (guided) goToStep(0);
      else { $("intro").hidden = !intro; onReset?.(); }
      showOutcome(result.restarted
        ? { tone: "ok", title: `Demo case reset: fresh copy ${result.generation} is at "${view.status.stage.label}".`, lines: [`Copy ${result.previousGeneration} is kept in Speck, suspended, with its history.`], next: "Start the guided investigation above, or run the investigation." }
        : { tone: "ok", title: "The demo case is already at its starting state.", lines: ["Nothing was changed."], next: "Start the guided investigation above, or run the investigation." });
      if (!guided && intro) $("intro-start").focus();
    } catch (error) {
      stop();
      await refresh();
      showOutcome(describeFailure("reset", error));
    } finally {
      busy = null;
      if (view.status) renderWorkflow();
      renderTour();
    }
  }

  // ----- Speck beside a stateless model call -----
  // The comparison runs on the server on its own temporary copy of the case;
  // the page polls until it finishes. A result is shown as current only when
  // it was made with this case's current settings.

  const comparisonState = { data: null, viewing: null, viewingMatches: true, starting: false, elapsedMs: 0 };
  let comparisonTimer = null;

  function drawComparison() {
    if (destroyed) return;
    renderComparison($("compare"), { ...comparisonState, decisive: decisiveOn });
    const latest = comparisonState.data?.current;
    $("compare-teaser").textContent = latest
      ? `The same case, run again on the same records by a stateless baseline that answers from scratch each time. Last compared ${new Date(latest.finishedAt).toLocaleString()} (${latest.kind === "live" ? "live model calls" : "deterministic"}).`
      : "The same case, run again on the same records by a stateless baseline that answers from scratch each time, to show what Speck's kept state changes.";
  }

  // A second layer: closed until asked for (or until the guide reaches it),
  // so the case itself comes first.
  function setComparisonOpen(open) {
    $("compare").hidden = !open;
    $("compare-toggle").setAttribute("aria-expanded", String(open));
    $("compare-toggle").textContent = open ? "Hide the comparison" : "Show the comparison";
  }
  $("compare-toggle").addEventListener("click", () => setComparisonOpen($("compare").hidden));

  async function loadComparison() {
    try {
      comparisonState.data = await api("/api/comparison");
      view.comparison = comparisonState.data;
    } catch (error) {
      if (error.closed) return;
      view.comparison = null;
      $("compare").replaceChildren(el("div", { className: "error", role: "alert" }, el("strong", {}, "The comparison could not be loaded."), el("p", {}, error.message)));
      return;
    }
    if (comparisonState.data.running && !comparisonTimer) pollComparison();
    drawComparison();
  }

  function pollComparison() {
    const began = Date.parse(comparisonState.data?.running?.startedAt ?? "") || Date.now();
    comparisonState.elapsedMs = Date.now() - began;
    comparisonTimer = window.setInterval(async () => {
      if (destroyed) { window.clearInterval(comparisonTimer); return; }
      comparisonState.elapsedMs = Date.now() - began;
      try {
        comparisonState.data = await api("/api/comparison");
        view.comparison = comparisonState.data;
      } catch { /* keep polling; the next answer replaces this */ }
      if (!comparisonState.data?.running) {
        window.clearInterval(comparisonTimer);
        comparisonTimer = null;
        comparisonState.viewing = null;
        renderTour();
      }
      drawComparison();
    }, 1000);
  }

  async function startComparison() {
    comparisonState.starting = true;
    drawComparison();
    try {
      await api("/api/comparison", { method: "POST" });
      comparisonState.data = await api("/api/comparison");
      view.comparison = comparisonState.data;
      if (comparisonState.data.running && !comparisonTimer) pollComparison();
    } catch (error) {
      if (error.closed) return;
      comparisonState.starting = false;
      drawComparison();
      $("compare").prepend(el("div", { className: "error", role: "alert" }, el("strong", {}, "The comparison did not start."), el("p", {}, error.message), error.body?.hint ? el("p", {}, `What to do: ${error.body.hint}`) : null));
      return;
    }
    comparisonState.starting = false;
    if (!comparisonState.data.running) comparisonState.viewing = null;
    drawComparison();
    renderTour();
  }

  $("compare").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-cmp], [data-cmp-jump]");
    if (!button) return;
    if (button.dataset.cmpJump) { jumpToRecord($("compare"), button.dataset.cmpJump); return; }
    const action = button.dataset.cmp;
    if (action === "run") startComparison();
    if (action === "current") { comparisonState.viewing = null; drawComparison(); }
    if (action === "open") {
      try {
        const { report, matchesCurrent } = await api(`/api/comparison/${encodeURIComponent(button.dataset.id)}`);
        comparisonState.viewing = report;
        comparisonState.viewingMatches = matchesCurrent;
        drawComparison();
        $("compare-panel").scrollIntoView({ block: "start" });
      } catch (error) {
        showError(error);
      }
    }
  });

  // The evaluation results, loaded when first opened.
  if (evaluationUrl) {
    $("evaluation-panel").hidden = false;
    let loaded = false;
    $("evaluation-panel").addEventListener("toggle", async () => {
      if (!$("evaluation-panel").open || loaded) return;
      try {
        const response = await fetchImpl(evaluationUrl);
        const summary = await response.json();
        if (!response.ok) throw new Error(summary.error ?? `HTTP ${response.status}`);
        if (destroyed) return;
        renderEvaluation($("evaluation"), summary);
        loaded = true;
      } catch (error) {
        $("evaluation").replaceChildren(el("p", {}, badge(`The evaluation results could not be loaded: ${error.message}`, "bad long")));
      }
    });
  }

  // ----- Decisive mode (experimental; ./decisive.js) -----
  // A second reading beside Speck's conclusion: the stateless baseline's
  // answer on the case as it stands, accepted only where every record it
  // cites still counts and Speck holds or points to the same explanation.
  // Speck's belief state is never changed by it.

  const decisivePref = decisivePreference(storage);
  let decisiveOn = decisivePref.on();
  const opinionState = { opinion: null, loading: false, error: null, requestedFor: null, fetched: false };

  const opinionKey = () => [view.investigation?.latestRun?.runNumber, view.status?.stage?.id, (view.listing?.records ?? []).map((record) => record.id).join(",")].join("|");

  async function ensureOpinion() {
    if (!decisiveOn || destroyed) return;
    if (!opinionState.fetched) {
      opinionState.fetched = true;
      try { opinionState.opinion = (await api("/api/opinion")).opinion; } catch { /* asked for below if needed */ }
    }
    const run = view.investigation?.latestRun;
    if (!run || view.status?.running || busy || (view.listing?.pending?.length ?? 1) > 0) { renderDecisive(); return; }
    if (opinionCurrent(opinionState.opinion, view) || opinionState.requestedFor === opinionKey()) { renderDecisive(); return; }
    opinionState.requestedFor = opinionKey();
    opinionState.loading = true;
    opinionState.error = null;
    renderDecisive();
    try {
      opinionState.opinion = (await api("/api/opinion", { method: "POST" })).opinion;
    } catch (error) {
      if (error.closed) return;
      opinionState.error = error.message;
    }
    opinionState.loading = false;
    renderDecisive();
  }

  function renderDecisive() {
    if (destroyed) return;
    const holder = $("decisive");
    const parts = [decisiveSwitch(decisiveOn)];
    if (!decisiveOn) {
      parts.push(el("p", { className: "meta" }, "Off: Speck's conclusion below is the only reading."));
    } else if (!view.investigation?.latestRun) {
      parts.push(el("p", { className: "meta" }, "Run the investigation first: decisive mode reads Speck's state after a run."));
    } else if (view.listing?.pending?.length) {
      parts.push(el("p", { className: "meta" }, `${view.listing.pending.length} record(s) are not yet assessed. Run the investigation; decisive mode then checks again.`));
    } else if (opinionState.loading) {
      parts.push(el("p", { className: "meta", role: "status" }, view.status?.reasoner?.kind === "nemotron"
        ? "Asking the stateless baseline: one live model call with reasoning, usually a few seconds…" : "Asking the stateless baseline (fact rules)…"));
    } else if (opinionState.error) {
      parts.push(el("p", {}, badge(`The stateless answer could not be obtained: ${opinionState.error}. Speck's conclusion below stands.`, "bad long")),
        el("button", { type: "button", className: "link", "data-decisive-retry": "" }, "Try again"));
    } else if (!opinionCurrent(opinionState.opinion, view)) {
      parts.push(el("p", { className: "meta" }, "Waiting for a stateless answer on the case as it stands now."));
    } else {
      const c = view.investigation.current;
      const o = opinionState.opinion;
      const reading = decisiveReading({
        speck: { concluded: c?.state === "supported" ? c.hypothesis?.key ?? null : null, tentative: c?.hypothesis?.key ?? c?.direction?.pointsTo?.key ?? null },
        stateless: o.answer,
        replaced: new Map(o.replaced.map((item) => [item.recordId, item.by])),
        visible: o.visible
      });
      parts.push(el("div", { className: `decisive-reading ${reading.conclusion ? "concludes" : "none"}` },
        el("p", { className: "decisive-headline" }, badge("decisive mode reading", "warn"), " ",
          reading.conclusion ? `Concludes ${reading.conclusion}` : "No conclusion", " ",
          badge(reading.basis === "agreement" ? "Speck and the stateless answer agree" : reading.basis === "speck" ? "Speck's own conclusion" : "nothing established", reading.basis === "agreement" ? "ok" : "warn")),
        reading.conclusion ? el("p", {}, (view.investigation.hypotheses ?? []).find((h) => h.key === reading.conclusion)?.statement ?? "") : null,
        el("p", { className: "meta" }, reading.reason),
        el("p", { className: "meta" }, `Stateless answer (${o.kind === "live" ? `live call to ${o.model?.model}${o.model?.reasoningEffort && o.model.reasoningEffort !== "none" ? ", reasoning on" : ""}` : "fact rules, no model"}, ${when(o.at)}): ${o.answer.error ? `error: ${o.answer.error}` : o.answer.concluded ?? "unresolved"}${o.answer.cited?.length ? `, citing ${o.answer.cited.join(", ")}` : ""}.`),
        o.answer.rationale ? el("blockquote", { className: "cmp-rationale" }, badge("model's words", "warn"), " ", o.answer.rationale) : null,
        el("p", { className: "meta" }, "Speck's belief state below is unchanged; this reading is not saved in Speck.")));
    }
    holder.replaceChildren(...parts);
  }

  root.addEventListener("change", (event) => {
    const toggle = event.target.closest?.("[data-decisive-toggle]");
    if (!toggle) return;
    decisiveOn = toggle.checked;
    decisivePref.set(decisiveOn);
    opinionState.requestedFor = null;
    renderDecisive();
    drawComparison();
    ensureOpinion();
    root.querySelector(`#edk-${toggle.closest("#edk-compare") ? "compare" : "decisive"} [data-decisive-toggle]`)?.focus();
  });
  root.addEventListener("click", (event) => {
    if (!event.target.closest?.("[data-decisive-retry]")) return;
    opinionState.requestedFor = null;
    ensureOpinion();
  });

  // ----- Guided investigation -----

  const TARGETS = {
    case: () => $("case"),
    compare: () => { setComparisonOpen(true); return $("compare-panel"); },
    "run-button": () => $("run-button"),
    "update-button": () => $("update-button"),
    conclusion: () => $("conclusion-panel"),
    evidence: () => $("evidence-panel"),
    why: () => root.querySelector("#edk-why") ?? $("conclusion-panel"),
    timeline: () => $("timeline-panel"),
    trace: () => $("trace-panel"),
    "guide-button": () => $("guide-button"),
    "reset-button": () => $("reset-button"),
    record: () => {
      const record = recordToInspect(view);
      return record ? root.querySelector(`[data-record-id="${CSS.escape(record.id)}"]`) : $("evidence-panel");
    }
  };
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // The workspace's one-column layout (see style.css: the same 980px container width).
  const oneColumn = () => root.getBoundingClientRect().width < 980;
  let tourStep = progress.tourStep();
  if (tourStep !== null && tourStep >= steps.length) tourStep = null;
  let coachCollapsed = progress.coachCollapsed();
  let spotlit = null;
  // The step last scrolled to: a refresh re-renders the step without moving the page.
  let scrolledFor = null;

  function spotlight(target, scroll = true) {
    spotlit?.classList.remove("edk-spotlight");
    spotlit = target ?? null;
    if (!spotlit) return;
    spotlit.classList.add("edk-spotlight");
    // In the one-column layout the tour is a bottom sheet: bring the target
    // to the top of the view, above the sheet, instead of the centre.
    if (scroll) spotlit.scrollIntoView({ block: oneColumn() ? "start" : "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function paragraphs(items) {
    return items.map((item) => Array.isArray(item)
      ? (item.length ? el("ul", {}, item.map((line) => el("li", {}, line))) : null)
      : el("p", {}, item));
  }

  function renderTour() {
    if (destroyed) return;
    const coach = $("coach");
    if (tourStep === null) { coach.hidden = true; spotlight(null); scrolledFor = null; return; }
    const step = steps[tourStep];
    const done = stepDone(step, view);
    const waiting = step.action && !done;
    const working = step.action === "compare" ? Boolean(view.comparison?.running) || comparisonState.starting : busy === step.action;
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
        el("p", { className: "eyebrow" }, `${guided?.label ?? "Guided investigation"} · step ${tourStep + 1} of ${steps.length}`),
        el("button", { type: "button", className: "link", "data-tour": "collapse", "aria-expanded": String(!coachCollapsed) }, coachCollapsed ? "Expand" : "Minimise")),
      el("h2", { id: "edk-coach-title", tabindex: "-1" }, step.title),
      coachCollapsed ? null : el("div", { className: "coach-body" }, paragraphs(done && step.after ? [...(step.action ? [] : step.body(view)), ...step.after(view)] : step.body(view))),
      step.action && !coachCollapsed ? el("p", { className: `coach-status ${working ? "working" : done ? "done" : "waiting"}`, role: "status" },
        working ? (workingText || "Working… the page updates when it finishes.")
          : done ? "Done. This is the real result, read from Speck."
          : step.action === "run" && view.investigation?.latestRun && (view.listing?.pending?.length ?? 0) && view.investigation.latestRun.stage.id === view.status?.stage.id
            ? `Not done yet: ${view.listing.pending.length} record(s) are still pending after run ${view.investigation.latestRun.runNumber}. Click Run investigation again to retry them.`
            : `Waiting for you: click ${step.actionLabel ?? (step.action === "run" ? "Run investigation" : "Introduce prepared update")} on the page.`) : null,
      coachCollapsed ? null : el("div", { className: "coach-actions" },
        el("button", { type: "button", className: "secondary", "data-tour": "back", disabled: tourStep === 0 && !guided?.onBack ? "" : null }, "Back"),
        waiting ? el("button", { type: "button", className: "link", "data-tour": "skip" }, "Skip this step") : null,
        el("button", { type: "button", className: "primary", "data-tour": "next", disabled: waiting || working ? "" : null },
          tourStep === steps.length - 1 ? guided?.finishLabel ?? "Finish" : "Next"),
        el("button", { type: "button", className: "link", "data-tour": "exit" }, guided ? "Exit the demo" : "Exit tour"))).childNodes);
    fitCoachToHost();
    const key = `${tourStep}:${step.id === "record" ? recordToInspect(view)?.id : ""}`;
    spotlight(TARGETS[step.target]?.(), scrolledFor !== key);
    scrolledFor = key;
  }

  // Inside a host page with fixed furniture (Speck's floating message bar and
  // its rail), keep the tour clear of it by measuring where it actually is;
  // the host moves it between layouts. With no such furniture, the
  // stylesheet's placement stands.
  function fitCoachToHost() {
    const coach = $("coach");
    coach.style.bottom = coach.style.left = coach.style.maxHeight = "";
    if (coach.hidden) return;
    const bar = document.querySelector("#quickComposer");
    const box = bar?.getBoundingClientRect();
    if (!box || !box.height || box.top >= innerHeight) return;
    const bottom = Math.ceil(innerHeight - box.top + 8);
    coach.style.bottom = `${bottom}px`;
    if (oneColumn()) {
      // A bottom sheet: never above the top 35% of the view, so the case stays visible.
      coach.style.maxHeight = `${Math.max(160, Math.floor(Math.min(innerHeight * 0.42, box.top - 8 - innerHeight * 0.35)))}px`;
      const rail = document.querySelector(".rail")?.getBoundingClientRect();
      coach.style.left = rail && rail.height > rail.width && rail.right < innerWidth / 3 ? `${Math.ceil(rail.right + 8)}px` : "8px";
    } else {
      coach.style.maxHeight = `${Math.max(200, Math.floor(Math.min(560, box.top - 16 - innerHeight * 0.1)))}px`;
    }
  }
  window.addEventListener("resize", () => { if (tourStep !== null) fitCoachToHost(); });

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
    else if (action === "back" && guided?.onBack) { exitTour(); guided.onBack(); }
    if (action === "next" || action === "skip") {
      if (tourStep < steps.length - 1) goToStep(tourStep + 1);
      else { exitTour(); guided?.onFinish?.(); }
    }
    if (action === "exit") { exitTour(); guided?.onExit?.(); }
    if (action === "collapse") { coachCollapsed = !coachCollapsed; progress.setCoachCollapsed(coachCollapsed); renderTour(); root.querySelector("[data-tour=collapse]")?.focus(); }
  });

  // ----- First-run introduction and the feature guide -----

  $("intro").hidden = !intro || guided !== null || progress.introDismissed() || tourStep !== null;
  $("intro-start").addEventListener("click", () => startTour(0));
  $("intro-dismiss").addEventListener("click", () => { progress.dismissIntro(); $("intro").hidden = true; $("guide-button").focus(); });

  let guideOpen = false;
  function renderGuide() {
    if (destroyed) return;
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
        el("button", { type: "button", className: "primary", "data-guide": "tour" }, saved !== null ? `Resume the tour (step ${saved + 1} of ${steps.length})` : "Start the guided investigation"),
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
  // The engine's report is shown by the running status's next tick.
  events?.addEventListener("progress", (event) => {
    if (busy !== "run") return;
    const state = JSON.parse(event.data);
    engineProgress = { ...state, at: new Date().toISOString() };
  });

  // A guided part opens at its first step, its last (coming back from the
  // next part), or where it was left.
  if (guided) {
    progress.dismissIntro();
    goToStep(guided.start === "last" ? steps.length - 1 : guided.start === "resume" ? tourStep ?? 0 : 0);
  }

  refresh();
  return { refresh, destroy: () => { destroyed = true; events?.close(); spotlight(null); if (comparisonTimer) window.clearInterval(comparisonTimer); } };
}
