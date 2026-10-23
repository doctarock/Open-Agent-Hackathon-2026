// Evidence Desk UI. Plain DOM; every value from the server is inserted as
// text, never as HTML. It mounts into any element: the standalone page
// (index.html) or a tab inside Speck (the Evidence Desk plugin), which differ
// only in where the API lives and how requests are authorised.

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

// The page's fixed markup. Ids are prefixed so that, mounted inside another
// page (Speck), they cannot collide with the host's.
const TEMPLATE = `
<header>
  <h1 id="edk-case-title">Evidence Desk</h1>
  <p id="edk-case-question"></p>
  <dl id="edk-configuration" class="configuration"></dl>
</header>

<div id="edk-error" class="error" hidden></div>

<section class="controls">
  <button id="edk-run-button" type="button">Run investigation</button>
  <button id="edk-update-button" type="button">Introduce prepared update</button>
  <span id="edk-stage"></span>
  <div id="edk-progress" class="progress" hidden></div>
</section>

<main>
  <section class="panel" aria-labelledby="edk-evidence-heading">
    <h2 id="edk-evidence-heading">Evidence</h2>
    <p id="edk-evidence-summary" class="muted"></p>
    <ol id="edk-evidence-list" class="evidence-list"></ol>
  </section>

  <section class="panel" aria-labelledby="edk-conclusion-heading">
    <h2 id="edk-conclusion-heading">Conclusion</h2>
    <div id="edk-conclusion"><p class="muted">No investigation has been run yet.</p></div>
  </section>
</main>

<section class="panel" aria-labelledby="edk-trace-heading">
  <h2 id="edk-trace-heading">Execution trace</h2>
  <p class="muted">What each component did in each run, read back from what was saved: the evidence fetch, the Meterless run, each chunk's judgments (rule or model), and Speck's belief revisions. Evidence Desk's own steps are labelled as such.</p>
  <div id="edk-trace"></div>
</section>

<section class="panel" aria-labelledby="edk-timeline-heading">
  <h2 id="edk-timeline-heading">Revision timeline</h2>
  <label class="muted"><input id="edk-timeline-all" type="checkbox"> Show every event (not only changes)</label>
  <ol id="edk-timeline" class="timeline"></ol>
</section>
`;

// Mounts the page into root. apiBase: where the JSON API lives (/api
// standalone; the plugin's case route inside Speck). fetchImpl: how to call
// it (Speck passes its admin-authorised fetch). eventsUrl: a server-sent
// event stream for run progress, if the host has one.
export function mountEvidenceDesk(root, { apiBase = "/api", fetchImpl = fetch, eventsUrl = null } = {}) {
  root.classList.add("edk");
  root.innerHTML = TEMPLATE;
  const $ = (id) => root.querySelector(`#edk-${id}`);

  async function api(path, options = {}) {
    // Paths are written as /api/...; the host decides where the API lives.
    const response = await fetchImpl(apiBase + path.slice("/api".length), options);
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
      ["Evidence", [badge(evidence.mode === "zetaris" ? "ZETARIS LIVE" : "FIXTURE FILE - NOT ZETARIS", evidence.mode), " ", `${evidence.label} - ${evidence.target}`, evidence.problem ? [" ", badge(evidence.problem, "bad")] : null]],
      ["Reasoner", [badge(reasoner.kind, reasoner.ready ? "ok" : "bad"), " ", reasoner.model ? `${reasoner.label}: ${reasoner.model} @ ${reasoner.endpoint}${usage}` : reasoner.label, reasoner.problem ? [" ", badge(reasoner.problem, "bad")] : null]],
      ["Execution", `${execution.identity ? `${execution.identity.name} (${execution.identity.package}, commit ${execution.identity.commit.slice(0, 7)}, vendored)` : execution.engine}; at most ${execution.maxChunks} chunks, ${execution.batchSize} record(s) per chunk`],
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
    $("evidence-list").replaceChildren(...listing.records.map((record) => el("li", { className: record.invalidation || record.supersededBy ? "superseded" : "" },
      el("div", { className: "record-head" },
        el("strong", {}, record.id),
        badge(record.retrieval.mode === "zetaris" ? "Zetaris live" : "fixture file, not Zetaris", record.retrieval.mode),
        record.status === "completed" ? badge("assessed", "ok")
          : record.status === "failed" ? badge(record.assessed ? "assessed, judgments missing" : "assessment failed: retried next run", "bad")
          : record.status === "withdrawn" ? badge("withdrawn before assessment: not assessed", "warn")
          : badge(record.lastAttempt ? "not yet assessed (interrupted run)" : "not yet assessed", "pending"),
        record.supersededBy ? badge(`superseded by ${record.supersededBy}`, "warn") : null,
        record.invalidation ? badge(record.invalidation.kind === "withdrawn" ? "withdrawn: no longer counts" : "no longer counts", "bad") : null,
        el("span", { className: "muted" }, `${record.source.name} - ${when(record.observedAt)}`),
        // Any record not already withdrawn: an unassessed one is excluded from
        // assessment (no judgment is recorded), an assessed one stops counting.
        record.invalidation?.kind !== "withdrawn"
          ? el("button", { type: "button", className: "link", "data-withdraw": record.id, "data-assessed": record.assessed ? "yes" : "no" }, "Withdraw")
          : null),
      record.invalidation?.kind === "withdrawn" ? el("div", { className: "meta" }, `Withdrawn ${when(record.invalidation.at)}: ${record.invalidation.reason}`) : null,
      record.status === "failed" && record.lastAttempt?.error ? el("div", { className: "meta" }, `Last attempt ${when(record.lastAttempt.at)} failed: ${record.lastAttempt.error}`) : null,
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
    return el("section", { className: "outcome historical" },
      el("h3", {}, "Why this changed"),
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
        ? [el("h3", {}, "Earlier beliefs, no longer held"),
           el("ul", { className: "refs" }, replaced.map((h) => el("li", {}, badge("historical", "warn"), " ", el("code", {}, h.key),
             ` had reached ${h.statusWhenReplaced} ${h.confidence}; replaced in recomputation ${h.recomputation ?? "?"}`)))]
        : null);
  }

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

  function renderConclusion(c, run, pending, history) {
    if (!c) { $("conclusion").replaceChildren(el("p", { className: "muted" }, "No investigation has been run yet.")); return; }
    const u = c.uncertainty;
    // The hypothesis the evidence is about: the conclusion, or the explanation
    // the evidence points to when it is not yet a conclusion.
    const subject = c.hypothesis ?? c.alternatives.find((view) => view.key === c.direction?.pointsTo?.key) ?? null;
    const held = [...(c.hypothesis ? [c.hypothesis] : []), ...c.alternatives];
    // Built through el(), which drops null and flattens nested lists;
    // replaceChildren alone would render them as "null" and "[object ...]".
    $("conclusion").replaceChildren(el("div", {},
      el("div", {}, badge(c.state, c.state), " ", el("span", { className: "muted" }, run
        ? `Speck's current belief state (persisted). Last run: ${run.runNumber} at ${when(run.finishedAt)}, stage "${run.stage.label}", ${run.execution.status}.`
        : "Speck's current belief state (persisted). No run has completed: an earlier run was interrupted, and these beliefs come from the evidence it recorded.")),
      pending?.length ? el("p", {}, badge(`${pending.length} record(s) not yet assessed: ${pending.join(", ")}. These beliefs do not include them; run the investigation.`, "warn long")) : null,
      c.reconciled === false ? el("p", {}, badge("Beliefs lag the evidence ledger after an interruption; run the investigation to reconcile them.", "bad long")) : null,
      el("p", { className: "headline" }, c.headline),
      renderDirection(c.direction),
      renderJustification(c.justification),
      el("h3", {}, subject ? `Evidence currently supporting ${subject.key}` : "Supporting evidence"), refList(subject?.supporting ?? []),
      el("h3", {}, subject ? `Evidence currently against ${subject.key}` : "Contradicting evidence"), refList(subject?.contradicting ?? []),
      renderRevisions(c, history),
      el("h3", {}, "Unresolved questions"),
      c.openQuestions.length ? el("ul", {}, c.openQuestions.map((q) => el("li", {}, q.text))) : el("p", { className: "muted" }, "none"),
      c.answeredQuestions.length ? [el("h3", {}, "Answered by evidence"), el("ul", {}, c.answeredQuestions.map((q) => el("li", {}, `${q.text} ${q.answer} (`, el("code", {}, q.recordId), ")")))] : null,
      el("h3", {}, "Notes"),
      el("ul", {},
        u.runnerUp ? el("li", {}, `Runner-up ${u.runnerUp.key} at ${u.runnerUp.confidence} (margin ${u.margin})`) : null,
        u.notes.map((note) => el("li", {}, note))),
      el("h3", {}, "Current beliefs (still held by Speck)"),
      held.length ? el("ul", { className: "refs" }, held.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
      el("h3", {}, "Ruled out by the evidence that counts now"),
      c.rejected.length ? el("ul", { className: "refs" }, c.rejected.map(hypothesisLine)) : el("p", { className: "muted" }, "none"),
      run ? renderRun(run, c) : null
    ));
  }

  // The last completed run: its explanation and how it executed.
  function renderRun(run, c) {
    return [
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

  let timeline = [];

  function renderTimeline() {
    const all = $("timeline-all").checked;
    const shown = timeline.filter((entry) => all || entry.significant || ["stage", "conclusion"].includes(entry.kind));
    $("timeline").replaceChildren(...(shown.length ? shown : []).map((entry) => el("li", { className: `kind-${entry.kind}${entry.significant ? " significant" : ""}${entry.historical ? " historical" : ""}` },
      el("div", { className: "when" }, `${when(entry.at)} - #${entry.sequence}${entry.runNumber ? ` - run ${entry.runNumber}` : ""} - ${entry.actor}`),
      el("div", { className: "title" }, entry.historical ? [badge("historical: belief since replaced", "warn"), " "] : null, entry.title),
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
      // Evidence access can fail (live mode); the conclusion and the trace still
      // render, without the pending check, and the failure is then reported.
      let listing = null;
      let evidenceError = null;
      try {
        listing = await api("/api/evidence");
      } catch (error) {
        evidenceError = error;
      }
      renderConclusion(investigation.current, investigation.latestRun, listing?.pending ?? null, investigation.history);
      // After the conclusion, so a fresh trace never sits beside a stale conclusion.
      renderTrace(await api("/api/trace"));
      if (evidenceError) throw evidenceError;
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

  // Withdrawing a record recomputes the beliefs that rested on it.
  $("evidence-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-withdraw]");
    if (!button) return;
    const recordId = button.dataset.withdraw;
    const reason = window.prompt(button.dataset.assessed === "yes"
      ? `Withdraw ${recordId} from this case? Beliefs that rest on it will be recomputed without it. Reason:`
      : `Withdraw ${recordId} before it is assessed? It will not be assessed, no judgment is recorded for it, and current beliefs do not change. Reason:`);
    if (!reason?.trim()) return;
    button.disabled = true;
    try {
      await api("/api/evidence/withdraw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId, reason }) });
      await refresh();
    } catch (error) {
      await refresh();
      showError(error);
    }
  });

  // Live run progress, where the host offers a stream (the standalone server).
  const events = eventsUrl ? new EventSource(eventsUrl) : null;
  events?.addEventListener("progress", (event) => {
    const state = JSON.parse(event.data);
    $("progress").hidden = false;
    $("progress").textContent = `Meterless: ${state.phase} ${state.phaseDetail} (chunk ${state.currentChunk}/${state.maxChunks})\n${state.logs.slice(-6).join("\n")}`;
  });

  refresh();
  return { refresh, destroy: () => events?.close() };
}
