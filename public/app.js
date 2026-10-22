// Evidence Desk UI. Plain DOM; every value from the server is inserted as
// text, never as HTML.

const $ = (id) => document.getElementById(id);

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const badge = (text, kind) => el("span", { className: `badge ${kind ?? ""}` }, text);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { body });
  return body;
}

function showError(error) {
  const box = $("error");
  if (!error) { box.hidden = true; box.textContent = ""; return; }
  const body = error.body ?? {};
  box.hidden = false;
  box.textContent = [
    body.kind === "evidence" ? `Evidence access failed (${body.mode} mode). No fallback data was used.` : null,
    error.message,
    body.hint ? `What to do: ${body.hint}` : null,
    body.detail ? `Server said: ${body.detail}` : null
  ].filter(Boolean).join("\n");
}

let status = null;

function renderStatus() {
  $("case-title").textContent = `${status.case.title} (${status.case.caseId})`;
  $("case-question").textContent = status.case.question;
  const { evidence, reasoner, execution, speck } = status;
  const usage = reasoner.usage ? ` - ${reasoner.usage.successes} successful / ${reasoner.usage.calls} calls this session` : "";
  const rows = [
    ["Evidence", [badge(evidence.mode === "zetaris" ? "ZETARIS LIVE" : "FIXTURE", evidence.mode), " ", `${evidence.label} - ${evidence.target}`, evidence.problem ? [" ", badge(evidence.problem, "bad")] : null]],
    ["Reasoner", [badge(reasoner.kind, reasoner.ready ? "ok" : "bad"), " ", reasoner.model ? `${reasoner.label}: ${reasoner.model} @ ${reasoner.endpoint}${usage}` : reasoner.label, reasoner.problem ? [" ", badge(reasoner.problem, "bad")] : null]],
    ["Execution", `${execution.engine}; at most ${execution.maxChunks} chunks, ${execution.batchSize} record(s) per chunk`],
    ["Cognition", `Speck runtime, database ${speck.database}`]
  ];
  $("configuration").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]));
  $("stage").replaceChildren("Evidence stage: ", el("strong", {}, status.stage.label));
  const update = $("update-button");
  update.disabled = !status.nextStage || status.running;
  update.textContent = status.nextStage ? `Introduce prepared update: ${status.nextStage.label}` : "No further prepared updates";
  $("run-button").disabled = status.running;
}

function renderEvidence(listing) {
  const pending = new Set(listing.pending);
  $("evidence-summary").textContent = `${listing.records.length} record(s) available at stage "${listing.stage.label}" from ${listing.provider.label}; ${pending.size} not yet assessed.`;
  $("evidence-list").replaceChildren(...listing.records.map((record) => el("li", { className: record.supersededBy ? "superseded" : "" },
    el("div", { className: "record-head" },
      el("strong", {}, record.id),
      badge(record.retrieval.mode === "zetaris" ? "via Zetaris" : "fixture", record.retrieval.mode),
      record.assessed ? badge("assessed", "ok") : badge("not yet assessed", "pending"),
      record.supersededBy ? badge(`superseded by ${record.supersededBy}`, "warn") : null,
      el("span", { className: "muted" }, `${record.source.name} - ${when(record.observedAt)}`)),
    el("p", { className: "content" }, record.content),
    el("div", { className: "meta" }, badge("stated by source", "ok"), ` ${record.source.name}: ${Object.entries(record.facts).map(([key, value]) => `${key}=${value}`).join(", ") || "no structured facts"}`),
    renderAssessment(record),
    el("div", { className: "meta" }, `provenance: ${record.provenance.systemOfRecord} / ${record.provenance.recordRef} / author ${record.provenance.author}${record.provenance.supersedes.length ? ` / amends ${record.provenance.supersedes.join(", ")}` : ""}`),
    el("div", { className: "meta" }, `retrieved: ${record.retrieval.mode} from ${record.retrieval.location} at ${when(record.retrieval.retrievedAt)}${record.retrieval.queryToken ? ` (Zetaris query ${record.retrieval.queryToken})` : ""}`)
  )));
}

// How a record was weighed, keeping a checked rule apart from a model's reading.
function renderAssessment(record) {
  const a = record.assessment;
  if (!a) return el("div", { className: "meta" }, record.assessed ? "weighed: details unavailable" : "not yet weighed by Speck");
  return el("div", { className: "meta" },
    `Weighed in run ${a.runNumber} at reliability ${a.reliability}${a.recordedBy === "model" ? " (Speck's cap for model-judged evidence)" : ""}: `,
    a.judgments.length
      ? el("ul", { className: "refs" }, a.judgments.map((j) => el("li", {},
          badge(j.basis === "rule" ? "deterministic rule" : "model interpretation", j.basis === "rule" ? "ok" : "warn"),
          ` ${j.direction} `, el("code", {}, j.hypothesisKey), j.decisive ? " decisively" : "", j.basis === "model" ? ` (strength ${j.strength})` : "", ` - ${j.rationale}`)))
      : "no bearing on any hypothesis");
}

const refList = (refs) => refs.length
  ? el("ul", { className: "refs" }, refs.map((ref) => el("li", {}, el("code", {}, ref.recordId),
      ` ${ref.sourceName}, ${when(ref.observedAt)} (${ref.retrievalMode})`,
      ref.reliability !== undefined ? ` - weighed at reliability ${ref.reliability}${ref.judgedBy === "model" ? " (model-judged, capped by Speck)" : ""}` : "",
      ref.supersededBy ? ` - superseded by ${ref.supersededBy}` : "")))
  : el("p", { className: "muted" }, "none");

// What the evidence shows and how firmly it is justified are separate
// outcomes: evidence can point clearly at an explanation it does not justify.
function renderDirection(direction) {
  if (!direction) return null;
  return el("section", { className: "outcome" },
    el("h3", {}, "What the evidence shows"),
    el("p", {}, direction.summary),
    direction.pointsTo ? el("p", {}, "Points to: ", el("code", {}, direction.pointsTo.key), ` ${direction.pointsTo.statement}`) : null);
}

function renderJustification(justification) {
  if (!justification) return null;
  const t = justification.thresholds;
  return el("section", { className: "outcome" },
    el("h3", {}, "How firmly it is justified"),
    el("p", {}, badge(justification.established ? "established" : "not established", justification.established ? "supported" : "unresolved"),
      justification.confidence !== null ? ` Speck confidence ${justification.confidence} (${justification.status}). Supported needs ${t.supported}; leading needs ${t.leading} and a ${t.leadingMargin} margin.` : ""),
    justification.confidence !== null
      ? el("meter", { min: "0", max: "1", low: String(t.leading), high: String(t.supported), optimum: "1", value: String(justification.confidence), title: `confidence ${justification.confidence}` })
      : null,
    el("ul", {}, justification.reasons.map((reason) => el("li", {}, reason))),
    justification.wouldChange.length ? [el("h3", {}, "What would make it firm"), el("ul", {}, justification.wouldChange.map((item) => el("li", {}, item)))] : null);
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
  if (!e) {
    return [el("h3", {}, "Model explanation"), el("p", { className: "muted" }, run.reasoner.kind === "rules"
      ? "None: this run used the deterministic rule assessor and no reasoning model."
      : "None was produced for this run.")];
  }
  const stale = !sameBeliefs(run.conclusion, current);
  const agreement = e.agreement;
  const trusted = agreement?.agrees && !stale;
  const text = [el("p", {}, e.text), el("p", { className: "meta" }, `cites: ${e.citedEvidence.join(", ") || "nothing"}; states: ${e.statedConclusion ?? "?"}, ${e.statedEstablished ? "established" : "not established"}`)];
  return [
    el("h3", {}, `Model explanation (${run.reasoner.model}, run ${run.runNumber})`),
    el("p", { className: "meta" }, "The model's wording. Speck's belief state above is the conclusion; this text is checked against it, not the other way round."),
    !agreement ? el("p", {}, badge("not checked against Speck (recorded before checks existed)", "warn")) : null,
    agreement && !agreement.agrees ? el("div", {}, badge("does not match Speck's belief state", "bad"), el("ul", {}, agreement.problems.map((problem) => el("li", {}, problem)))) : null,
    stale ? el("p", {}, badge(`written for run ${run.runNumber}'s state, which has since changed`, "warn")) : null,
    trusted ? [badge("matches Speck's belief state", "ok"), ...text] : el("details", {}, el("summary", {}, "Show the model's text anyway"), ...text)
  ];
}

function renderConclusion(c, run, pending) {
  if (!c || !run) { $("conclusion").replaceChildren(el("p", { className: "muted" }, "No investigation has been run yet.")); return; }
  const u = c.uncertainty;
  // The hypothesis the evidence is about: the conclusion, or the explanation
  // the evidence points to when it is not yet a conclusion.
  const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
  const held = [...(c.hypothesis ? [c.hypothesis] : []), ...c.alternatives];
  $("conclusion").replaceChildren(
    el("div", {}, badge(c.state, c.state), " ", el("span", { className: "muted" }, `Speck's current belief state (persisted). Last run: ${run.runNumber} at ${when(run.finishedAt)}, stage "${run.stage.label}", ${run.execution.status}.`)),
    pending?.length ? el("p", {}, badge(`${pending.length} record(s) not yet assessed: ${pending.join(", ")}. These beliefs do not include them; run the investigation.`, "warn")) : null,
    el("p", { className: "headline" }, c.headline),
    renderDirection(c.direction),
    renderJustification(c.justification),
    el("h3", {}, subject ? `Supporting evidence for ${subject.key}` : "Supporting evidence"), refList(subject?.supporting ?? []),
    el("h3", {}, subject ? `Contradicting evidence for ${subject.key}` : "Contradicting evidence"), refList(subject?.contradicting ?? []),
    el("h3", {}, "Unresolved questions"),
    c.openQuestions.length ? el("ul", {}, c.openQuestions.map((q) => el("li", {}, q.text))) : el("p", { className: "muted" }, "none"),
    c.answeredQuestions.length ? [el("h3", {}, "Answered by evidence"), el("ul", {}, c.answeredQuestions.map((q) => el("li", {}, `${q.text} ${q.answer} (`, el("code", {}, q.recordId), ")")))] : null,
    el("h3", {}, "Notes"),
    el("ul", {},
      u.runnerUp ? el("li", {}, `Runner-up ${u.runnerUp.key} at ${u.runnerUp.confidence} (margin ${u.margin})`) : null,
      u.notes.map((note) => el("li", {}, note))),
    el("h3", {}, "Current beliefs (still held by Speck)"),
    held.length ? el("ul", { className: "refs" }, held.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
    el("h3", {}, "No longer held (refuted or superseded)"),
    c.rejected.length ? el("ul", { className: "refs" }, c.rejected.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
    ...renderExplanation(run, c),
    el("h3", {}, "How this run executed"),
    el("ul", {},
      el("li", {}, `Evidence: ${run.evidence.label} (${run.evidence.target}); ${run.assessed.length} new record(s) assessed`),
      el("li", {}, `Reasoner: ${run.reasoner.label}${run.reasoner.model ? ` - ${run.reasoner.model} @ ${run.reasoner.endpoint}` : ""}${run.reasonerUsage ? `; ${run.reasonerUsage.successes} successful of ${run.reasonerUsage.calls} model calls in this session` : ""}`),
      el("li", {}, `Execution: ${run.execution.engine}, status ${run.execution.status}, ${run.execution.chunks.length} of max ${run.execution.chunkConfig.maxChunks} chunks, ${run.execution.totalTokensUsed} tokens (${run.execution.tokenLabel}), ${run.execution.durationMs} ms`),
      run.execution.error ? el("li", {}, badge(`execution error: ${run.execution.error}`, "bad")) : null,
      run.unprocessed.length ? el("li", {}, badge(`not assessed: ${run.unprocessed.join(", ")}`, "warn")) : null,
      run.notes.map((note) => el("li", {}, note))),
    el("details", {}, el("summary", {}, "Meterless chunks and carryover"),
      run.execution.chunks.map((chunk) => el("div", {}, el("h3", {}, `Chunk ${chunk.id} (${chunk.tokens} tokens, estimated)`),
        chunk.carryover ? el("pre", {}, `carryover in:\n${chunk.carryover}`) : null, el("pre", {}, chunk.content))))
  );
}

let timeline = [];

function renderTimeline() {
  const all = $("timeline-all").checked;
  const shown = timeline.filter((entry) => all || entry.significant || ["stage", "conclusion"].includes(entry.kind));
  $("timeline").replaceChildren(...(shown.length ? shown : []).map((entry) => el("li", { className: `kind-${entry.kind}${entry.significant ? " significant" : ""}` },
    el("div", { className: "when" }, `${when(entry.at)} - #${entry.sequence}${entry.runNumber ? ` - run ${entry.runNumber}` : ""} - ${entry.actor}`),
    el("div", { className: "title" }, entry.title),
    entry.detail ? el("div", { className: "detail" }, entry.detail) : null)));
  if (!shown.length) $("timeline").replaceChildren(el("li", { className: "muted" }, "Nothing has happened yet."));
}

async function refresh() {
  try {
    status = await api("/api/status");
    renderStatus();
    const investigation = await api("/api/investigation");
    timeline = investigation.timeline;
    renderTimeline();
    // Evidence access can fail (live mode); the conclusion still renders, without the pending check.
    let listing = null;
    try {
      listing = await api("/api/evidence");
    } finally {
      renderConclusion(investigation.current, investigation.latestRun, listing?.pending ?? null);
    }
    renderEvidence(listing);
    showError(null);
  } catch (error) {
    showError(error);
  }
}

async function act(button, path) {
  button.disabled = true;
  $("progress").hidden = false;
  $("progress").textContent = "";
  try {
    await api(path, { method: "POST" });
    await refresh();
  } catch (error) {
    await refresh();
    showError(error);
  } finally {
    button.disabled = false;
    if (status) renderStatus();
  }
}

$("run-button").addEventListener("click", () => act($("run-button"), "/api/run"));
$("update-button").addEventListener("click", () => act($("update-button"), "/api/update"));
$("timeline-all").addEventListener("change", renderTimeline);

const events = new EventSource("/api/events");
events.addEventListener("progress", (event) => {
  const state = JSON.parse(event.data);
  $("progress").hidden = false;
  $("progress").textContent = `Meterless: ${state.phase} ${state.phaseDetail} (chunk ${state.currentChunk}/${state.maxChunks})\n${state.logs.slice(-6).join("\n")}`;
});

refresh();
