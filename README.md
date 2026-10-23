# Open-Agent-Hackathon-2026 — Speck Evidence Desk

> **For judges:** Evidence Desk is a **Speck plugin**. Start Speck (`npm run speck`) and open the
> **Evidence** tab in its rail.
> - [docs/SUBMISSION.md](docs/SUBMISSION.md): what it does, verified sponsor use, and results,
>   in one page.
> - [DEMO.md](DEMO.md): the 3-minute walkthrough.
> - `npm run sponsors:verify`: checks each sponsor technology in a real run, and reports what it
>   could not observe.

Evidence Desk investigates a disputed delivery whose evidence conflicts and changes over time.
When a later record contradicts or replaces an earlier claim, it:
- revises what it believes;
- says which evidence caused the revision;
- keeps the old belief on record as history, rather than presenting both claims side by side.

Its evaluation finds no measurable accuracy difference between keeping beliefs across runs and
recomputing them from scratch (see *Evaluation*). What it does provide is an auditable record of
how and why each conclusion changed.

It runs inside Speck as a plugin:
- **A case is a Speck worker** in Speck's own database, beside Speck's other work.
- **The page is a tab** in Speck's interface, and it is the interface's home: Speck opens on it.
- **Three project-local changes to Speck**, kept in this repository as patches in `patches/`. They
  are applied by `npm run setup` and never committed to Speck; the submodule stays pinned to
  upstream Speck.
  - `speck-home-view.patch`: a general `SPECK_HOME_VIEW` setting chooses the view Speck's
    interface opens on and returns to.
  - `speck-remove-plugins.patch`: removes Speck's bundled demonstration plugins (Social Media
    Manager, AirChat, Information Agent) and their two dedicated tests, so Evidence Desk is the
    only plugin.
  - `speck-chat-investigations.patch`: adds an *Evidence Desk investigations* component to
    Speck's chat. When a message names an investigation, the chat is given the case summaries
    Evidence Desk published to Speck and told to answer only from them (see *Inside Speck*).

  Everything else Evidence Desk needs is Speck's existing plugin system and memory API.

A standalone server serving the same page remains, for development and as a fallback.

### Using the interface for the first time

The page explains itself; no walkthrough from a developer is needed.

- **A first-run introduction** says what Evidence Desk is for and offers one action, *Start the
  guided investigation*. It can be dismissed, and is not shown again to the same browser.
- **The guided investigation** works on the real case, using the page's own buttons:
  1. the competing explanations;
  2. a real run;
  3. the conclusion and its confidence;
  4. one record's source and provenance;
  5. the prepared update;
  6. a second run;
  7. which record no longer counts and why;
  8. the history;
  9. the remaining capabilities.

  An action step completes only when the case's real state shows the action happened. Every
  sentence about the case is read from that state, so a live run is described as it actually
  came out. It can be stepped back, skipped, minimised, exited, and resumed after a reload. It
  never withdraws anything.
- **The Guide** (top right) restarts or resumes the tour, and lists each feature that exists.
  - A feature is marked *demonstrated* only when the case's state shows it happened, and
    *viewed* when it has been opened.
  - It is marked *not available here*, with the reason, when its integration (live Zetaris,
    the Nemotron assessor) is not configured.
- **Short "What does this mean?" explanations** sit next to evidence labels, conclusion states,
  confidence (Speck's belief-revision score, not a calibrated probability), corrections,
  withdrawal, recovery and the history.
- **Withdrawing a record** states its consequence in a dialog first and requires a reason.
- **Reset demo case** (top right) restarts the case for the next person, from the page.
  - Nothing is deleted. A fresh copy of the case (a new Speck worker) becomes current: the first
    stage, nothing assessed, the competing explanations at their priors.
  - The previous copy is suspended in Speck with its full history. Other cases, Speck's other
    work and the evidence source are not touched.
  - A case still at its starting state is left alone, so a repeated reset is harmless. A reset is
    refused while a run is in progress.
  - Because nothing is deleted, it is safe inside Speck's shared database as well as standalone.
  - `npm run db:reset` remains the way to wipe a standalone database entirely.
- **Run status** shows the elapsed time while a run is in progress, and the execution engine's
  own progress (its phase and chunk) when the host provides it: a stream standalone, polling
  inside Speck. Nothing is estimated.
  - Afterwards it says what happened and what to do next.
  - A completed run with an unresolved conclusion is reported as a result, not a failure.
  - A failed assessment is reported as a stopped run with its records pending to retry.
  - An interrupted earlier run is called recovered only when Speck's beliefs are reconciled with
    the evidence ledger.
- **On narrow screens** (when the workspace is one column) the tour is a bottom sheet. Its text
  scrolls while its controls stay in view, and inside Speck it is placed clear of Speck's message
  bar and rail.
- **Not built: a live recovery demonstration.** Showing recovery from the page would need a
  fault-injection switch in the server's write path, so it was left out. Recovery is exercised
  by `test/recovery.test.ts` and `test/interruption.test.ts` (every Speck write point of a run
  and of a withdrawal, interrupted again during recovery).

The tour's step definitions are in `public/tour.js` and are tested against real API payloads in
`test/tour.test.ts`. Progress is kept in the browser's local storage, per case.

### Inside Speck: the guided demo, Speck's views, and your own investigations

Inside Speck the Evidence tab replaces the per-case introduction with one **guided demo**. It is
offered at the top of the tab (*Start the guided demo* or *Explore on my own*), and the *Guided
demo* link beside the case picker starts or resumes it.

1. **Disputed delivery:** the case tour above, without its last overview step.
2. **Bank return:** the explanations, a run, the prepared update (the bank's return of the
   payment), a second run, and which record no longer counts.
3. **Speck's world view:** the demo opens it. Each investigation is a Speck task, and its runs'
   actions (Hypothesis Proposed, Memory Recorded, Belief Revised, Association Reinforced) are laid
   out in time; right-drag travels back. The panel quotes Speck's own timeline status and each
   case's run count and current conclusion, read from the plugin's API.
4. **The memory map:** the demo switches to it. The lines are the links Evidence Desk makes
   (below); the panel quotes Speck's own count of memories and associations.
5. **Talk to Speck:** a question about the bank return is put in Speck's message bar. The step
   completes when Speck replies (Speck's `speck:reply` event); it does not judge the reply, and
   says to check it against the case page.
6. **Your own investigation:** the new-investigation form opens; the step completes when it is
   created, and the last step when it has been run.

Each part that asks for an action waits for the real state; Back, Skip, Exit and resume work
across Speck's views and after a reload (the place is kept in local storage). The definitions
are in `public/journey.js` (tested in `test/journey.test.ts`); the tab
(`plugin/ui/evidence-desk-ui.js`) drives Speck's interface through its rail and world-mode
buttons. The standalone page keeps the per-case introduction and tour.

**What Speck sees.** After each run (and each withdrawal) Evidence Desk:
- **links the case's memories** with Speck's own `reinforceAssociation`: each run's assessment is
  `derived-from` every record it judged; each record `supports` or `contradicts` the conclusion
  of the run that weighed it; a correction is `inhibitory` towards the record it replaced. Each
  link is made once. These are the memory map's lines.
- **publishes a case summary** as a shared semantic memory (replacing its previous one, which is
  archived): the question, the current conclusion and its confidence (not a probability), the
  evidence for and against with its content, what was ruled out, what no longer counts and why,
  the run history, what is still open, and which records are not yet assessed.

**Speck's chat** (`speck-chat-investigations.patch`). Speck's chat recalls only its own mind's
memories, so it could not see a case; and with a small model it invented details. The patch adds
a chat component, after memory, that supplies the matching case summaries when a message names a
case identifier (such as `ORD-1042`) or mentions an investigation, dispute or evidence, and tells
the model to answer only from them. Other messages take Speck's ordinary path. Speck's own tests
cover it (`src/tests/investigations-component.test.ts`).

Speck's chat needs a model of its own. This setup uses the local Nemotron Nano 9B through Ollama,
set in Speck's System view (or `POST /api/brains/config`) as a processor for Speck's roles. Speck
saves that in `speck/data/genesis-runtime/model-processors.json`, which is runtime data and not
committed; restart Speck after changing it. The 4B model used for assessments was tried first and
invented details more often.

**Your own investigations.** *+ New investigation* takes a title, the question, two to five
competing explanations (equal priors) and optionally the first evidence.
- It is written as an ordinary scenario under the installed plugin's
  `data/user-cases/my-N/` and investigated by the same pipeline, as case `MY-N`.
- *Add evidence* adds a record (source, text, optional date), or a correction of an earlier record,
  which then supersedes it. Added records are assessed on the next run.
- The evidence is free text, so only the Nemotron assessor can weigh it (capped at reliability
  0.4 like all model-judged evidence). Under the rule assessor the records are assessed but weigh
  nothing, and the page says so.
- The code is `src/investigation/user-cases.ts`, tested in `test/user-cases.test.ts`.

## The scenario

Case `DISPUTE-1042` (`fixtures/scenarios/disputed-delivery/`). Order ORD-1042 shipped to
41 Lydiard St South. The evidence comes from four source systems, in two stages:

| Stage | Record | Source | Says |
|---|---|---|---|
| Initial (14 Oct) | `EV-OMS-001` | order system | order placed, ship-to address |
| | `EV-WMS-002` | warehouse | parcel handed to the carrier |
| | `EV-CAR-003` | carrier tracking | **delivered**, left at front door |
| | `EV-SUP-004` | support inbox | customer: nothing arrived |
| Update (16 Oct) | `EV-CAR-005` | carrier tracking | POD review: GPS 380 m away, at 41 Lydiard St **North**; scan amended (supersedes `EV-CAR-003`) |
| | `EV-SUP-006` | support inbox | the resident at No. 41 North is holding the parcel |

Three candidate explanations (`H-DELIVERED`, `H-MISDELIVERED`, `H-NOT-SHIPPED`) are fixture
data, each with the fact rules that bear on it. A rule marked `decisive` is a deterministic
counter-example: Speck refutes the hypothesis outright instead of nudging its confidence.

With the deterministic rule assessor the outcome is:

1. **Run 1:** *Leading, not established:* H-DELIVERED (0.61, contested by `EV-SUP-004`).
   H-NOT-SHIPPED is refuted by the warehouse handover. Whether the parcel went to the correct
   address is an open question.
2. **Introduce the update.**
3. **Run 2:** H-DELIVERED is **rejected**, decisively, by `EV-CAR-005`. *Supported:*
   H-MISDELIVERED (0.70). The timeline shows the revision and the record responsible.

## Architecture

```
  Speck (speck/; npm run speck, home view = the Evidence tab)
  ├─ Speck's interface ── Evidence tab, first in the rail (plugin/ui/evidence-desk-ui.js → public/app.js)
  └─ plugin: speck/plugins/evidence-desk/   (installed by npm run plugin:install)
       plugin/evidence-desk-plugin.ts  ── routes under /api/plugins/evidence-desk/cases/<case>
                    │                       (src/investigation/api.ts, shared with src/server.ts)
       src/investigation/desk.ts (EvidenceDesk.attach to Speck's own runtime)
        ┌───────────────────────┬────────────┼─────────────────────────┐
  EvidenceProvider          Meterless Markovian      Reasoner                 Speck runtime
  fixture │ Zetaris (live)   engine (vendored, runs      rules │ Nemotron      (the one Speck runs)
  src/evidence/            the investigation loop)   src/reasoning/          belief, memory, events

  Standalone fallback: src/server.ts serves the same page and API at :4320 (EvidenceDesk.open,
  with its own Speck runtime on data/evidence-desk.sqlite).
```

**How it fits into Speck.** Speck discovers plugins in its `plugins/` folder and hands each one
its runtime, with routes and a tab in its interface.

| What Speck required | What Evidence Desk does |
|---|---|
| Plugins load only from `speck/plugins/`, if their entry module's hash is in Speck's allowlist (`speck/plugins/.runtime/plugin-trust.json`) | `npm run plugin:install` copies the compiled plugin and its data there. It adds the entry module's hash to the allowlist, which is Speck's documented approval step. That allowlist file is the only tracked Speck file it changes. |
| Speck counts workers in `created` or `ready` as queued tasks, and pauses background cognition for all workers while any is queued | Each case worker moves `created → ready → waiting` through Speck's own transitions. In Speck's Task queue the cases show under **Waiting**. |
| Speck's background embedding job can write a stale copy of an object over a concurrent revision (demonstrated in `test/speck-compat.test.ts`) | Every change to a case takes Speck's foreground lease and waits for any background job already running. Background cognition then runs over the cases like any other worker. |
| Speck's chat could select any model in its runtime registry | Nemotron goes through a private instance of Speck's `ModelRegistry` class: the same contract validation and retries, but no model is added to Speck. |
| Speck's interface always opened on its World view, with plugin tabs after Speck's own | The one change to Speck's code, kept in this project as `patches/speck-home-view.patch` (applied by `npm run speck:patch`, part of `npm run setup`; never committed to Speck): `SPECK_HOME_VIEW` (default `world`) names the view the interface opens on and returns to (brand button, panel close). A plugin tab named there is placed first in the rail. `npm run speck` sets it to the Evidence tab; `SPECK_HOME_VIEW=world npm run speck` restores Speck's default. Speck's own tests cover the setting (`src/tests/genesis-host.test.ts`). |

| Concern | Owner | How it is used |
|---|---|---|
| Cognition | **Speck** (`speck/`, imported as `#speck`; its cognition is unmodified) | The case is a Speck worker. Hypotheses come from `proposeHypothesis`. Evidence goes into the ledger through `recordEvidence`, which caps reliability for model-judged evidence. The relations that currently take effect are applied through `reviseHypothesesFromEvidence`, which runs Speck's belief revision with decisive refutation. When invalidated evidence makes that necessary, a hypothesis is replaced and the relations are replayed (see *Revision* below). Withdrawals use `withdrawEvidence`. Ranking uses `rankHypotheses`. The released evidence stage is held with `setWorldState`, and each run's outcome is saved as episodic memory through `recordMemory`. The timeline is Speck's event log (`belief.revised`, `evidence.recorded`, …). Model calls go through Speck's model registry, which validates contracts and retries. All of this persists in one Speck SQLite database. |
| Federated evidence | **Zetaris** | `EvidenceProvider` interface with a fixture implementation and a live Zetaris adapter (`src/evidence/zetaris-provider.ts`). The adapter uses the platform's REST API (`/api/auth/login`, then `/api/proxy/query/sql/start`) with one SELECT per source table, configured in `config/zetaris-queries.json`. `EVIDENCE_MODE` selects the mode explicitly, and there is never a fallback. Every record carries its retrieval mode, table and Zetaris query token. |
| Execution | **Meterless** Markovian engine | The Apache-2.0 reference implementation, vendored unmodified at `vendor/meterless-markovian/` (pinned commit and hashes are in its `NOTICE.md`). Each run is a `Markovian.run`. The injected generator assesses one bounded batch of new evidence per chunk and ends each chunk with a `[STATE_CHECKPOINT]` carryover block, or `[TASK_COMPLETE]` on the last one. `maxChunks` caps the run. Run history goes to `data/meterless/history.json`. Progress events stream to the UI. In Nemotron mode, the reflection pass produces the model's explanation. |
| Reasoning model | **NVIDIA Nemotron** | `src/reasoning/nemotron.ts`: a model processor for any OpenAI-compatible chat endpoint, called through a private instance of Speck's `ModelRegistry` (Speck's contract validation and retries, without adding a model to Speck's own runtime). The model judges how each evidence item bears on each hypothesis, and decisive rules still take precedence. Speck records model-judged evidence as `model`-provenance and caps its reliability at 0.4. The explanation's citations are checked against the real evidence ids. The model name the endpoint reports serving is recorded with every run. |

## Sponsor integrations and the execution trace

The **Execution trace** panel on the page (and `GET /api/trace`) shows, for each run, what each
technology actually did. It is read back from saved state only, so it is the same after a
restart, and nothing in it is simulated:

1. **Evidence.** The provider's record of the fetch.
2. **Meterless.** The engine's run record, checked against the engine's own `history.json`.
3. **Assessment, per chunk.** Each chunk's assessment, saved in Speck before the chunk's
   evidence entered the ledger, with the Nemotron call behind it.
4. **Speck.** Speck's event log for the run.

Evidence Desk's own steps are labelled **EVIDENCE DESK**, never as a sponsor's: reconciliation,
recovery after an interrupted run, withdrawals and recomputations.

### Zetaris

- **Code:** `src/evidence/zetaris-provider.ts`.
- **What it does:** logs in (`/api/auth/login`), then sends one SELECT per source table through
  `/api/proxy/query/sql/start` (tables in `config/zetaris-queries.json`). Each record carries the
  table and Zetaris query token it came from.
- **Shown in the trace:** every SELECT of the run, including tables that returned no rows, with
  row count, measured latency and query token.
- **Fixture mode is unmistakable.** It is labelled FIXTURE FILE - NOT ZETARIS in the header, on
  every record and in the trace, and the trace says no Zetaris query was made. There is never a
  fallback: if Zetaris fails, the API returns 502 and nothing is recorded.
- **Verified:**
  - against a local Zetaris platform (`npm run zetaris:check`, and live runs on 2026-10-22);
  - in tests, through a stand-in HTTP layer that exercises the real adapter.

### Meterless

- **Engine:** the Markovian reference engine, `@meterless/markovian-reference@0.1.0`, vendored
  unmodified from upstream commit `1742dec` (`vendor/meterless-markovian/NOTICE.md`).
- **Invocation:** one `Markovian.run` per investigation run.
  - Each chunk is one call to Evidence Desk's injected generator, which assesses one batch of
    evidence and returns a `[STATE_CHECKPOINT]` carryover.
  - When a model is configured, the engine's reflection pass produces the explanation.
- **Shown in the trace:**
  - the engine's run id, status, and chunks used out of the maximum;
  - per chunk, the estimated tokens and whether carryover came in;
  - whether the run appears in the engine's `history.json`, matched by id and the engine's own
    timestamp. The engine numbers runs `run-1`, `run-2` and so on in each process, so the id
    alone is ambiguous after a restart.
- **Not Meterless:** Meterless does not do Evidence Desk's recovery, reconciliation or
  withdrawal, and the trace does not attribute them to it.

### NVIDIA Nemotron (local)

- **Code:** `src/reasoning/nemotron.ts`, an OpenAI-compatible chat client registered as a
  processor in Speck's model registry.
- **Verified with:** `nemotron-3-nano:4b` served by **local Ollama** (`npm run model:check`
  confirms the served model). The trace records, for every call, the model name the endpoint
  reported.
- **How judgments are constrained and validated:**
  - Speck validates each reply against a contract with enumerated evidence ids and hypothesis
    keys, covering every required (evidence, hypothesis) pair.
  - Settings: temperature 0.1, at most 2 attempts (a reply that fails the contract is retried
    once), and the configured output budget and reasoning effort.
  - Unknown ids are discarded, and a deterministic decisive rule always wins over the model.
  - A record the model says nothing about stays pending.
  - Speck caps model-judged evidence at reliability **0.4**. The evidence list shows both the
    source reliability and the 0.4 Speck applied.
  - Explanation citations are checked against real record ids, and an explanation that
    disagrees with Speck's state is flagged.
- **Shown in the trace, per call:**
  - attempts and contract rejections;
  - per-HTTP-call latency;
  - how many judgments were returned, kept, neutral, already judged, discarded, or overruled
    by a rule.
- **Not demonstrated:** the client also accepts NVIDIA's hosted API (see *Configuration*), but
  only local Ollama was used here. No hosted NVIDIA inference or other NVIDIA infrastructure is
  claimed.

### Speck

- **Repository:** `speck/`, a submodule pinned to upstream Speck `29d5bb3`. This project patches
  its working tree in three ways: the `SPECK_HOME_VIEW` interface setting
  (`patches/speck-home-view.patch`), removing Speck's other bundled plugins
  (`patches/speck-remove-plugins.patch`), and the chat component that answers from published
  case summaries (`patches/speck-chat-investigations.patch`). Belief revision, memory and the
  event log are as upstream.
- **Memory:** each case's memories are linked with Speck's association kinds, and a case summary
  is published as a shared memory after each run (see *Inside Speck*).
- **Role:** holds the case, beliefs and history.
- **Shown in the trace, per chunk:** evidence recorded, every belief revision (marked when the
  belief has since been replaced), and recomputations.

### Cursor

The team reports developing Evidence Desk with Cursor. It is a development tool, not a runtime
integration, and nothing in this repository records its use.

### What the trace flags

These appear as badges on each run's summary line:
- pending and failed assessments;
- model retries;
- invented citations;
- runs recovered after an interruption;
- recomputations.

A run that was interrupted before it finished appears as **Interrupted run**, with no Meterless
record (the engine never recorded it) and the assessments it had saved.

## How conclusions are derived

The conclusion always comes from Speck's belief state (`src/investigation/conclusion.ts`):
- **supported:** the top live hypothesis is Speck-`supported`/`confirmed` and has supporting evidence.
- **leading:** confidence ≥ 0.5, a margin of at least 0.1, and supporting evidence.
- **unresolved:** anything else, including a hypothesis held only on its prior.

Confidence is shown as Speck's belief-revision score, not as a probability.

**Direction and justification are reported separately.** Evidence can point clearly at an
explanation without yet justifying it, so every conclusion carries both:

- **What the evidence shows:**
  - which explanations are ruled out, and by which records;
  - which survive;
  - which one the evidence points to: the top live explanation, if it has support of its own
    and stands alone or leads by at least 0.1.
- **How firmly it is justified:**
  - Speck's confidence compared with its thresholds, and the gap;
  - the concrete reasons it falls short: a low prior, model-judged support capped by Speck,
    superseded records still counted against it, unanswered questions;
  - what would close the gap.

In Nemotron mode the corrected case typically ends like this:

> *Unresolved: the evidence points to "delivered to the wrong address" but does not yet justify
> it as a conclusion.*
>
> H-DELIVERED and H-NOT-SHIPPED are ruled out, and H-MISDELIVERED is the only explanation
> standing. It is held at 0.424, which is 0.176 below Speck's supported threshold of 0.6,
> because:
> - its two supporting records were judged by the model, and Speck caps those at reliability
>   0.4, so each adds at most 0.08;
> - it started from a 0.35 prior;
> - the superseded delivery scan EV-CAR-003 still counts against it.

(That sample is from Build 2. Since Build 3, a superseded record no longer counts; see below.)

**A decisive refutation is final.** In Speck only `superseded` is terminal: later support moves
a `rejected` hypothesis back to active. That happened live: a model judgment revived
H-DELIVERED after EV-CAR-005 had refuted it. Evidence Desk therefore withholds from Speck any
*support* for a hypothesis that a decisive counter-example refutes, and says so in the run's
notes. The judgment is kept, and it applies again if the refuting record is later invalidated.

### Revision: current beliefs come from evidence that still counts

Speck's belief revision is a running sum: each relation moves a hypothesis's stored confidence
one step, and Speck has no public operation to undo a step. Build 2 used that sum directly as the
current belief. So when the bank returned the payment in `correction-supersedes`, the returned
credit `EV-BNK-101` kept the 0.19 it had taken off H-UNPAID. The full analysis is in
[docs/build-3-revision.md](docs/build-3-revision.md).

Since Build 3, current beliefs are a deterministic replay of the evidence and judgments that are
still valid:

- **Recording.** Each assessed record goes into Speck's ledger *without* relations. The reasoner's
  judgments are kept with the run, as given.
- **The basis** (`src/investigation/basis.ts`). From the ledger it derives which records still
  count:
  - not withdrawn;
  - not superseded by a *valid* later record. If a correction is itself superseded or withdrawn,
    the record it replaced counts again.

  It also derives which judgments take effect: no support for a decisively refuted hypothesis.
  The result is each hypothesis's relations in observation order, not arrival order.
- **Reconciliation.** After every chunk and every withdrawal:
  - A hypothesis whose applied relations are the start of its plan is extended.
  - Any other is **replaced**. A new Speck hypothesis starts from the scenario prior, and the plan
    is replayed through Speck's own `reviseHypothesesFromEvidence`. The old hypothesis is marked
    `superseded` and keeps its revision history. A recomputation record says what stopped
    counting and why.
  - Hypotheses that did not depend on the change are left alone.
- **Withdrawal.** An investigator can withdraw a record with **Withdraw** on the evidence list,
  or with `POST /api/evidence/withdraw` (`{ "recordId", "reason" }`).
  - **An assessed record** stops counting, and beliefs that rested on it are recomputed. An
    example is a record that belongs to another case.
  - **A pending or failed record** is *withdrawn before assessment*: it is never assessed, no
    judgment is recorded or invented for it, current beliefs do not change, and it supersedes
    nothing. Without this, one record whose assessment always fails would stall every later
    record in the case.
  - Withdrawing a record again does nothing. Withdrawing one that is not in the case returns
    HTTP 400 with the reason.
- **Whole-record replacement is explained.** A superseding record replaces the whole earlier
  record. "Why this changed" lists which of the earlier record's facts no counting record
  restates, which of its judgments stopped applying, and what that changed. For example, after
  the bank return: "H-PARTIAL is no longer ruled out: EV-BNK-101 was its decisive refutation".

Every current adjustment therefore traces to a record and a judgment. The page shows each one
with its basis (deterministic rule or model interpretation) and the confidence change it made.
Records that no longer count, recomputations, and earlier beliefs are shown under "Why this
changed" and marked as history, not as current reasoning. The 0.4 cap on model-judged evidence
is unchanged. A record with any model judgment is capped as a whole, so a withheld model judgment
cannot escape the cap later.

### Recovery from interrupted runs (Build 3.1)

- **Saving judgments.** Each chunk's judgments are saved in Speck, as an
  `evidence-desk.assessment.v1` memory, *before* any of that chunk's evidence enters the ledger.
  A process that dies mid-run therefore never leaves a recorded record without its judgments.
  - A record that was judged but not yet recorded is simply assessed again.
  - A failed assessment is saved too, with its error.
- **Status of each record.** Every visible record is `pending`, `failed` (retried by the next run)
  or `completed`.
- **Reconciling.** Current beliefs are reconciled with the ledger when the desk opens, at the start
  of each run, and again at the end of a run if a chunk failed mid-reconciliation.
  - Reconciling is idempotent: a half-replayed rebuild is completed by appending, not rebuilt
    again.
  - If beliefs ever lag the ledger, the conclusion says so instead of presenting them as current.
- **What the next run reports.** It says which interrupted runs it recovered, and which of their
  records were kept or assessed again. Withdrawing a record a second time does nothing.
- **Recomputation records come first.** A recomputation record is written *before* any
  hypothesis is replaced. Every replacement therefore points at the record that explains it, and
  versions are never reused.
  - If an interruption stops a replacement after its record was written, a later recomputation
    makes it.
  - The earlier record then shows that entry as not carried out.
  - `test/interruption.test.ts` kills the process at every Speck write of a run and of a
    withdrawal. It then kills recovery again at several points, and checks that the case ends
    as if it had never been interrupted.

## Setup

Requires Node.js 22+ and git. From the repository root:

```bash
git submodule update --init --recursive   # speck/ at the pinned commit
cp .env.example .env                      # optional: defaults are fixture mode, no model
npm run setup                             # npm ci here and in speck/, build Speck, install the plugin
npm test                                  # build + all tests (no credentials needed)
npm run speck                             # Speck on http://127.0.0.1:4310, opening on the Evidence tab
```

- **Where the case lives.** Inside Speck, each case is a worker in Speck's own database. Speck
  stores that under `speck/data/` by default; set `SPECK_DB_PATH` to use another file.
- **Plugin settings.** `speck/plugins/evidence-desk/.env` holds the plugin's settings. It is
  copied from `.env` on the first install, and it is git-ignored.
- **Changing settings.** Edit that file and restart Speck.
- **Changing Evidence Desk's code.** Run `npm run plugin:install` again, then restart Speck.

The tab offers two cases:
- **Disputed delivery** follows the plugin's settings (live Zetaris and Nemotron, or fixtures).
- **Bank return** always runs on its fixture with the rule assessor.

**Standalone fallback.** `npm start` serves the same page on http://127.0.0.1:4320, outside
Speck, with its own database at `data/evidence-desk.sqlite`.

In the Evidence tab (or the standalone page), use the buttons in this order:
1. **Run investigation**
2. **Introduce prepared update**
3. **Run investigation** again

Then read the conclusion panel and the revision timeline.

**Disputed delivery** (the default scenario), with rules in fixture mode:
- Run 1 is *leading* H-DELIVERED.
- After the update, run 2 is *supported* H-MISDELIVERED (0.70).
- "Why this changed" shows that EV-CAR-003 no longer counts.

**Bank return** (the held-out `correction-supersedes` case). It's the second case in the
Evidence tab. On the standalone server, give it its own database so it doesn't share the
disputed-delivery case:

```bash
EVIDENCE_DESK_SCENARIO=eval/scenarios/correction-supersedes EVIDENCE_DESK_DB=bank-return.sqlite npm start
```

- Run 1 is *supported* H-PAID.
- After the update, run 2 is *supported* H-UNPAID (0.66).
- "Why this changed" explains that the return replaced EV-BNK-101 whole, and that H-PARTIAL is
  no longer ruled out.

To try withdrawal, press **Withdraw** on a record and give a reason. Withdrawing EV-SUP-006 in the
disputed-delivery case moves H-MISDELIVERED from supported 0.70 to leading 0.58.

**Sponsor demo (live Zetaris and local Nemotron).** These steps need the local Zetaris platform
and Ollama running.
1. Check both services:
   ```bash
   npm run zetaris:check
   npm run model:check
   ```
   `zetaris:check` should report 6 records for DISPUTE-1042. `model:check` should print the
   served model, e.g. `nemotron-3-nano:4b`.
2. Set `EVIDENCE_MODE=zetaris` and `REASONER=nemotron` in `speck/plugins/evidence-desk/.env`.
   Then run `npm run speck` and open the Evidence tab's Disputed delivery case. (Standalone:
   set them in `.env` and use `npm start`, after `npm run db:reset` for a clean case.)
3. Check the header and records:
   - the header shows **ZETARIS LIVE**, the Nemotron model and endpoint, and the Meterless
     engine and commit;
   - every record is labelled **Zetaris live**, with its table and query token.
4. Run, introduce the update, and run again. Each run takes tens of seconds on a small local
   model.
5. Open **Execution trace**. The latest run shows:
   - each SELECT with its query token;
   - the Meterless run id, confirmed in the engine's `history.json`;
   - per chunk, the Nemotron call: served model, contract, required pairs, attempts and
     retries, latency, and judgments kept or overruled by a rule;
   - per chunk, Speck's recorded evidence, belief revisions and recomputation;
   - the explanation call, with any disagreement or invented citation flagged.
6. Restart the server and reload: the trace is unchanged.

The model's judgments vary between runs. On 2026-10-22, the second run ended *leading*
H-MISDELIVERED, held back by the 0.4 cap on model-judged evidence.

In that run, Speck's contract check rejected one Nemotron reply and the retry succeeded. The trace
showed this as one retry.

| Command | What it does |
|---|---|
| `npm run setup` | Install dependencies here and in `speck/`, build Speck, and install the plugin |
| `npm run speck` | Start Speck with Evidence Desk's Evidence tab as its home view (`SPECK_HOME_VIEW`; set it to `world` for Speck's default). Other `SPECK_*` settings pass through. |
| `npm run eval:cross-domain` | The separate cross-domain suite (`eval/cross-domain/`): logistics, payment reversals, procurement; refuses to run if its locked expectations changed. Findings: `docs/cross-domain-evaluation.md` |
| `npm run plugin:install` | Build, then (re)install the plugin into `speck/plugins/evidence-desk/` and approve its entry hash in Speck's allowlist. Keeps the plugin's `.env` and case data. Restart Speck afterwards. |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start the standalone server (reads `.env` when present) |
| `npm run dev` | Build, then start with restart on changes in `dist/` (run `npx tsc -w` alongside) |
| `npm test` | Build and run every test in `dist/test/` |
| `npm run db:reset` | Delete Evidence Desk's Speck database and Meterless history. Stop the server first. |
| `npm run zetaris:seed` | Load the scenario's evidence into a local Zetaris platform (see below) |
| `npm run zetaris:check` | Exercise the live Zetaris path: login, probe query, case evidence |
| `npm run zetaris:usl` | Build and check the Zetaris Unified Semantic Layer over a warehouse and a carrier source, with a data-quality rule (separate from the live path). See `zetaris/usl/README.md` and `docs/zetaris-usl-reflection.md` |
| `npm run model:check` | One call to the Nemotron endpoint; prints the model it reports serving |
| `npm run sponsors:verify` | Runs a real two-stage investigation with the services in `.env`, on throwaway storage (`data/` is untouched). Checks each sponsor's contribution against an independent source and prints OBSERVED or NOT OBSERVED for each. Exits 1 if any configured sponsor was not observed. Saves the report and trace to `eval/results/sponsor-check.json`. |

The standalone server keeps its own database at `data/evidence-desk.sqlite`, separate from
anything in `speck/data/`. `npm run db:reset` gives it a clean case.

## Configuration

All settings are environment variables, set in a git-ignored `.env`. `.env.example` lists them
with placeholders. There are no credential defaults in code.

- `EVIDENCE_MODE=fixture|zetaris` selects the evidence source explicitly.
- `REASONER=rules|nemotron` selects the reasoner.
- In Nemotron mode an unset or non-Nemotron `NEMOTRON_MODEL` is refused before anything runs.

### Live Zetaris (local Docker Compose bundle)

1. Start the platform and confirm it with its own `./verify.sh`.
2. Set `EVIDENCE_MODE=zetaris`, `ZETARIS_BASE_URL` (the web interface, e.g.
   `http://localhost:3000`), `ZETARIS_USERNAME`, and `ZETARIS_PASSWORD`.
3. Run `npm run zetaris:seed`. It copies the scenario's records into the driver container as
   one JSON file per row and registers one Lightning file-store table per source system
   (`EVIDENCE_DESK.order_events`, `warehouse_scans`, `carrier_events`, `support_messages`),
   using the platform's documented `CREATE LIGHTNING DATABASE` / `FILESTORE TABLE` DDL.
4. Run `npm run zetaris:check`, then `npm start`.

The seeded rows originate from this repository's fixture file. Live mode really does read them
back through Zetaris, which is what the UI labels show. To investigate other data, point
`config/zetaris-queries.json` at tables with the same columns.

If Zetaris is unreachable, rejects the login, or lacks a table, the API returns HTTP 502 and
the page shows the error, the server's message and what to do. No run is recorded and no
fixture data is substituted.

### Nemotron

The client speaks the OpenAI chat API, so any compatible endpoint serving a Nemotron model can be
configured:

- **Local Ollama (the configuration used and verified here):**
  - `NEMOTRON_BASE_URL=http://127.0.0.1:11434/v1`;
  - `NEMOTRON_MODEL` set to a local Nemotron tag (verified with `nemotron-3-nano:4b`);
  - `NEMOTRON_REASONING_EFFORT=none`. With reasoning on, the model's reasoning trace uses up the
    output budget.
- **NVIDIA hosted API (supported by configuration, not exercised in this project's
  verification):** `NEMOTRON_BASE_URL=https://integrate.api.nvidia.com/v1`, a Nemotron model id
  in `NEMOTRON_MODEL`, and the key in `NEMOTRON_API_KEY`.

Run `npm run model:check` before claiming Nemotron was used. Each run also records
`servedModels`, the names the endpoint returned.

## Evaluation

```bash
npm run eval        # deterministic: no model, no credentials; same result every run
npm run eval:live   # same cases with the configured Nemotron endpoint (exits 2 if none is configured)
npm run eval:cross-domain   # the separate cross-domain suite (logistics, payments, procurement)
```

The cross-domain suite is reported apart from the two groups below. Its labels were locked
before its first run. Its findings, including two defects it exposed, are in
[docs/cross-domain-evaluation.md](docs/cross-domain-evaluation.md).

Each run prints a table per group. It writes the full per-checkpoint reports to
`eval/results/<mode>.json` (held-out cases) and `eval/results/<mode>-regression.json`
(correction-sequence regression cases). Both are git-ignored.

**Cases.** The seven held-out cases live in `eval/scenarios/`, apart from the development
fixture in `fixtures/`:

| Case | Category |
|---|---|
| `correction-supersedes` | a credible correction (bank return) supersedes an earlier claim |
| `model-misreading` | evidence that contradicts a likely model reading ("DELIVERED" to a pickup point) |
| `missing-evidence` | nothing establishes the cause, so the right answer is unresolved |
| `ghost-citation` | a record refers to ids that do not exist |
| `partial-support` | the evidence supports only half of a compound conclusion |
| `conflicting-sources` | equally reliable sources disagree, with no justified resolution |
| `provider-failure` | the real Zetaris adapter against an unreachable port |

Each case's `expected.json` labels every checkpoint with:
- the correct conclusion, or `null` to abstain;
- the hypotheses that must not be presented as current;
- the hypotheses the evidence does not support at all.

The labels were written before any system was run against them and have not been changed since.
The loader refuses fixture directories, and a test checks that no case, scenario or record id is
shared with the development fixtures.

**Systems.**

| System | What it is |
|---|---|
| `speck-desk` | Evidence Desk as built: one persistent Speck case across checkpoints |
| `speck-fresh` | the same pipeline with a new Speck database at every checkpoint, given all visible evidence at once: no persisted beliefs, history or prior state |
| `baseline-stateless` | no Speck at all. In fixture mode it sums the same rule weights and takes the top positive score. In live mode it makes one Nemotron call per checkpoint with the question, hypotheses and all visible evidence, and must answer a key or `unresolved` with citations. |

**Scoring.** A Speck system concludes only when Speck holds the hypothesis as *supported*.
*Leading* and *points to* count as abstaining, so a sole surviving hypothesis is never scored as
proven. Every metric is a count over these 9 checkpoints, measured on this run, and is not a
general accuracy figure. Latency is measured wall-clock time per HTTP call. Meterless token
counts are estimates and are not used.

**Correction-sequence regression cases** (Build 3). These live in `eval/regression/` and are
reported as a separate group. Their labels were committed (`2aa0066`) before the fix was
implemented or any system was run on them.
- They were written to exercise the defect below, so they show whether that defect is fixed, not
  general quality.
- A checkpoint may withdraw records first (`withdrawBefore`), and lists the records that no longer
  count by then (`invalidated`).
- The extra metric, *invalidated evidence kept out of support*, counts checkpoints where none of
  those records supports anything presented as current or favoured.

| Case | Sequence |
|---|---|
| `return-cancelled` | payment, then a bank return supersedes it, then the bank cancels the return: the payment counts again |
| `withdrawn-scan` | the receipt scan is withdrawn as belonging to another return, then an audit conflicts with the remaining carrier record |
| `misattributed-scan` | a delivery scan is corrected; the independent warehouse handover must still rule out "not shipped" |

**Fixture results** (`npm run eval`, deterministic). Build 2 is the baseline at `a42f067`
(tagged `build-2-baseline`). It was run unchanged in a separate worktree. On the regression
cases, its withdrawals used Speck's own `withdrawEvidence`, the only withdrawal Build 2 had.

Held-out cases (9 checkpoints, unchanged):

| | speck-desk B2 | speck-desk B3 | speck-fresh B2 | speck-fresh B3 | baseline-stateless |
|---|---|---|---|---|---|
| conclusion correct | 7/8 | **8/8** | 7/8 | **8/8** | 5/8 |
| valid citations | 16/16 | 14/14 | 16/16 | 14/14 | 11/11 |
| unsupported claims (of conclusions) | 0/3 | 0/4 | 0/3 | 0/4 | 1/7 |
| refuted claim kept out of current | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| abstained when it should | 4/4 | 4/4 | 4/4 | 4/4 | 1/4 |
| abstained when a conclusion was due | 1/4 | **0/4** | 1/4 | **0/4** | 0/4 |
| provider failure surfaced | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

Regression cases (8 checkpoints):

| | speck-desk B2 | speck-desk B3 | speck-fresh B2 | speck-fresh B3 | baseline-stateless |
|---|---|---|---|---|---|
| conclusion correct | 4/8 | **8/8** | 4/8 | **8/8** | 6/8 |
| unsupported claims (of conclusions) | 0/4 | 0/6 | 0/4 | 0/6 | 0/8 |
| refuted claim kept out of current | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| invalidated evidence kept out of support | 3/5 | **5/5** | 3/5 | **5/5** | 5/5 |
| abstained when it should | 1/2 | 2/2 | 1/2 | 2/2 | 0/2 |
| abstained when a conclusion was due | 3/6 | 0/6 | 3/6 | 0/6 | 0/6 |

How to read these:

**Held-out cases**
- **Only one checkpoint changed:** `correction-supersedes@after-return`.
  - Build 2 only *pointed to* H-UNPAID at 0.47, because the returned credit `EV-BNK-101` still
    counted against it.
  - Build 3 replays without it, so H-UNPAID reaches 0.30 + 0.19 + 0.17 = 0.66 and is supported.
  - Every other checkpoint, for every system, is identical to Build 2.
  - Valid citations fell from 16 to 14 because current beliefs no longer cite `EV-BNK-101`.
  - H-PARTIAL is no longer listed as ruled out there (see Known limits).

**Regression cases**
- **What Build 2 got wrong:**
  - It abstained after each correction (`misattributed-scan@correction`,
    `return-cancelled@return`).
  - It left every hypothesis rejected once a return was cancelled.
  - It kept concluding H-RECEIVED from a withdrawn scan.
- **The stateless baseline:**
  - It cannot cite withdrawn evidence, because the harness removes withdrawn records from what it
    sees.
  - It still over-commits where the right answer is to abstain.

**Across both groups**
- **Persistence still makes no measurable difference.** `speck-desk` and `speck-fresh` match on
  every checkpoint in both builds. The fix makes incremental and from-scratch evaluation agree by
  construction, since both are replays of the same basis. It does not show that carried state
  adds value.
- **The cases are too few.** Seven held-out cases and three regression cases support observations
  about these cases, not a claim that one system is generally better.

**Live results** (`npm run eval:live`). These are single samples, run on 2026-10-22 with
`nemotron-3-nano:4b` on local Ollama. The endpoint confirmed it served that model on every call.
Build 2 and Build 3 were run one after the other in the same session. Model judgments vary
between runs, so differences of one checkpoint are within noise.

Held-out cases:

| | speck-desk B2 | speck-desk B3 | speck-fresh B2 | speck-fresh B3 | baseline-stateless (B3 run) |
|---|---|---|---|---|---|
| conclusion correct | 5/8 | 5/8 | 5/8 | 5/8 | 3/8 |
| valid citations | 17/17 | 16/18 | 17/20 | 14/18 | 12/12 |
| unsupported claims (of conclusions) | 0/1 | 0/1 | 0/1 | 0/1 | 4/7 |
| refuted claim kept out of current | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 |
| abstained when it should | 4/4 | 4/4 | 4/4 | 4/4 | 1/4 |
| abstained when a conclusion was due | 3/4 | 3/4 | 3/4 | 3/4 | 0/4 |
| provider failure surfaced | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| explanation agrees with Speck | 5/8 | 5/8 | 4/8 | 4/7 | n/a |
| model replies valid | 16/17 | 16/17 | 17/17 | 15/17 | 8/8 |
| latency ms (mean / median / max) | 3942 / 2409 / 28969 | 3938 / 2616 / 28963 | 2650 / 2687 / 4861 | 5528 / 2970 / 28990 | 649 / 653 / 727 |

Regression cases (Build 2 via the scratch runner described above, with the same scoring):

| | speck-desk B2 | speck-desk B3 | speck-fresh B2 | speck-fresh B3 | baseline-stateless (B3 run) |
|---|---|---|---|---|---|
| conclusion correct | 3/8 | 4/8 | 3/8 | 4/8 | 3/8 |
| unsupported claims (of conclusions) | 0/1 | 0/2 | 0/1 | 0/2 | 3/8 |
| refuted claim kept out of current | 4/4 | 4/4 | 4/4 | 4/4 | 2/4 |
| invalidated evidence kept out of support | 3/5 | 5/5 | 3/5 | 5/5 | 3/5 |
| abstained when it should | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 |
| abstained when a conclusion was due | 5/6 | 4/6 | 5/6 | 4/6 | 0/6 |

What these runs show:

- **Live, the fix changes almost no conclusions.**
  - On the held-out cases, Build 2 and Build 3 agree on every checkpoint.
  - `correction-supersedes@after-return` still only points to H-UNPAID in Build 3. Its two
    supporting records are model-judged, and Speck caps those at reliability 0.4 (at most +0.08
    each). H-UNPAID can reach at most 0.30 + 0.16 = 0.46, below the 0.6 threshold, with or without
    the stale −0.19.
  - The fix removes a wrong adjustment. It does not make the system more decisive, and the cap is
    unchanged.
- **Where it shows live:**
  - After the return is cancelled (`return-cancelled@return-cancelled`), Build 3 concludes H-PAID
    and Build 2 holds nothing.
  - After the scan is withdrawn, Build 2 still counts it as support for H-RECEIVED; Build 3 does
    not.
- **Invalid citations were all in model explanations, and all were flagged.** The model wrote
  malformed ids such as `EV- BNK-103` (with a space), `EV-202` and `EV-EDSP-501`. The page hides
  such explanations behind a warning. This is the same failure as in Build 2, and the fix does
  not touch it.
- **The baseline concludes everywhere.** It made 7 unsupported conclusions in 15 across the two
  groups. It also presented a refuted hypothesis as current twice in the regression cases.
- **Persistence again made no difference** between `speck-desk` and `speck-fresh`.
- **Latency is not comparable.** The baseline makes one call per checkpoint; the Speck systems
  make one per evidence chunk plus one per explanation. The roughly 29 s maxima are single calls
  where the model ran to its token cap before a retry.

## Tests

`npm test` runs 70 tests with no network access beyond localhost and no credentials:

- **Fixture mode:** runs with an empty environment.
- **Citations:** every cited record exists and keeps its source metadata.
- **Persistence:** the corrective update survives a restart and is visible to the next run.
- **Refutation:** refuted claims are not presented as current, according to Speck's own state
  and event log.
- **Thin evidence:** stays unresolved.
- **Direction vs justification:** the live 0.424 case is reproduced and its reasons checked; close rivals point nowhere.
- **No revival:** later support cannot revive a decisively refuted hypothesis.
- **No-op reruns:** a rerun with no new evidence changes nothing.
- **Zetaris failures:** unreachable, missing credentials, a rejected login and a missing table
  all surface visibly, including a 502 from the API, with no fallback. Row mapping and query
  shape are also covered.
- **Meterless:**
  - the chunk limit gives a `max-chunks` status and leaves records pending;
  - carryover crosses chunks and progress events arrive;
  - a generator failure gives an `errored` run that keeps the work already done;
  - the vendored engine is pinned.
- **Nemotron adapter:** tested against a local stand-in endpoint:
  - judgments go through Speck and decisive rules win;
  - unknown hypotheses are discarded and invented citations flagged;
  - a non-Nemotron model is refused, and an unreachable endpoint gives an errored run.
- **Repository hygiene:** `.env` is git-ignored, `.env.example` holds placeholders only, and no
  credential-shaped strings appear in project files.
- **Evaluation:** the cases load and cover every required category; they share nothing with the
  fixtures; the fixture evaluation repeats exactly; scoring counts invented citations,
  unsupported claims, refuted claims and silent provider failures. No test asserts any system's
  score.
- **Explanation agreement:** an explanation that states a different conclusion, or a different
  firmness, from Speck's is flagged.
- **Persisted state:** the page's conclusion equals Speck's persisted belief state, before and
  after a reopen, and each record shows whether a rule or the model weighed it.
- **Reversible revision** (`test/revision.test.ts`), each asserting exact current beliefs and the
  records behind them:
  - **Bank reversal:** the superseded payment's −0.19 leaves H-UNPAID, which ends at 0.66,
    supported.
  - **Invalidated support:** withdrawing a record recomputes every belief that rested on it.
  - **Correction withdrawal:** this is tested two ways, by the source (a cancelled return) and by
    the investigator (a withdrawn reversal). In both, what the correction displaced counts again,
    including withheld support.
  - **Ordering:** five arrival orders and chunkings give identical final beliefs.
  - **Auditability:** run conclusions, replaced hypotheses (marked superseded in Speck),
    recomputation records and the original revisions all remain. Timeline entries about replaced
    hypotheses are marked historical.
  - **Persistence:** reopening gives the same current state and history, and a rerun recomputes
    nothing.
  - **Unrelated claims:** only hypotheses that depended on a withdrawn record are rebuilt. A
    refutation from an independent record survives.
  - **Failure handling:** a record the reasoner (or the model) returns no judgment for is not
    recorded and stays pending. A failed assessment leaves beliefs at their priors.
  - **API:** withdrawal validation and the history payload.
  - The basis resolves supersession chains newest first.
- **Regression evaluation:** the correction-sequence cases load apart from the held-out set and
  evaluate deterministically.
- **Cross-domain suite** (`test/cross-domain.test.ts`): the expectations match their lock and a
  later edit is refused; the suite shares nothing with the other cases and covers each claimed
  behaviour; an injected assessment failure reaches each system as documented. No score is
  asserted.
- **Recovery** (`test/recovery.test.ts`). Each test interrupts a run (Speck calls fail, and the
  run snapshot is never written), reopens the database, and compares with an uninterrupted run:
  - A crash mid-chunk loses no judgment. The rerun assesses only the unrecorded record, matches
    the uninterrupted beliefs exactly, records nothing twice, and is idempotent.
  - A crash mid-reconciliation is flagged as unreconciled and repaired on reopen, without a second
    rebuild.
  - Assessment statuses are pending, failed or completed, and failed records are retried.
- **Speck compatibility** (`test/speck-compat.test.ts`):
  - A retired hypothesis keeps its confidence, statement, provenance, evidence lists and revision
    history, before and after a reopen.
  - Its `belief.revised` events remain in Speck's log.
  - Retiring is idempotent and refuses non-hypotheses.
  - Speck keeps `superseded` terminal and ranks it below live statuses.
  - Speck's background embedding job, held open on purpose, overwrites a revision made while it
    waits (0.7 back to 0.5). With the foreground lease, a case's revisions survive a background
    slice in flight, a slice that starts during a run is deferred, and beliefs equal an isolated
    run's.
- **Speck plugin** (`test/plugin.test.ts`), against a real Speck runtime and Speck's own Express:
  - the plugin declares the Evidence tab and its manifest permissions;
  - the bank-return case runs through the plugin routes to H-UNPAID at 0.66, supported;
  - the case worker is left `waiting`, and an unrelated Speck worker is untouched;
  - bad requests give 400, an unknown case 404, and the tab's assets are served;
  - cases survive a Speck restart on the same database, as the same worker;
  - the bank-return case always runs on its fixture with the rules, whatever the settings;
  - the installer copies the plugin, points `#speck` at Speck's own build, makes the entry the
    only plugin module, approves exactly its hash, and keeps `.env` and case data on reinstall.
- **Correction chains** (`test/correction-chains.test.ts`):
  - a replacement of a replacement, read both ways;
  - withdrawal of a replacement;
  - repeated withdrawal (no event, no recomputation, the first reason stands).

  An independently refuted hypothesis is never rebuilt, and every step stays in the history.
- **Exhaustive interruption** (`test/interruption.test.ts`):
  - Every Speck write in run 2 of the disputed delivery (23 points) and in a withdrawal
    (16 points) is used as a crash point.
  - At each point, recovery is itself interrupted in five patterns, and the case is then
    restarted.
  - Final beliefs must equal an uninterrupted run, versions must be unique, every replacement
    must be explained by its record, and every announced replacement must be carried out.
- **Withdrawal before assessment** (`test/exclusion.test.ts`):
  - A record that always fails stalls the case until it is withdrawn. After that, the rest is
    assessed.
  - No judgment is invented, beliefs do not change, and the record never enters Speck's ledger.
  - A correction withdrawn before assessment supersedes nothing.
- **Current beliefs only** (`test/current-beliefs.test.ts`). With a superseded hypothesis ranked
  *first* by Speck, none of these presents it as current:
  - the conclusion;
  - `hypotheses()`;
  - the model's carryover and explanation prompt;
  - the timeline;
  - the API.
- **Whole-record replacement** (`test/revision.test.ts`): the facts and judgments a superseded
  record took with it, and their consequences, are stated.
- **Execution trace** (`test/trace.test.ts`, plus one test each in `test/nemotron.test.ts` and
  `test/zetaris.test.ts`). Each part of the trace is checked against the state it is read from:
  - **Evidence:** the fixture file, labelled not-Zetaris, with no query tokens; or every Zetaris
    SELECT through the real adapter, including an empty table.
  - **Meterless:** the engine's run, confirmed in its `history.json` by id and the engine's own
    timestamp. The engine restarts its `run-N` ids in each process, so a decoy entry with the
    same id is not accepted.
  - **Chunks:** mapped to the records Speck recorded.
  - **Speck revisions:** every one in the event log, each exactly once.
  - **Nemotron calls:** a forced contract rejection and retry, the served model, the
    constraints, and the judgment accounting.
  - **Explanation:** an invented citation in it.
  - **Actions:** withdrawals, withdrawals before assessment and recovery appear as Evidence Desk
    actions, and an interrupted run appears as interrupted.
  - **Persistence:** the trace is identical after a reopen and through the API.

## Known limits of this slice

- **Speck's chat answers are written by a local model.** The investigations component gives it
  only the published case summaries and tells it to answer from them, which removed the invented
  details seen without it, but the wording is still the model's: check it against the case page.
  The guided demo's chat step completes on any reply.
- **Live runs of a person's own investigation can stop early.** With the local model, about one
  run in three of a correction errored in testing; its records stay pending and the next run
  retries them, as the page says.

- **Project-local Speck patch.**
  - `npm run speck:patch` applies the patches in `patches/` to `speck/`'s working tree, and is
    safe to run again. The submodule therefore always shows as modified, and the patch is
    never committed there.
  - If the Speck pin moves, the patch may need updating; the command says so rather than
    applying it partly.
- **Plugin installation.**
  - Speck's allowlist hashes only the plugin's entry module. Changes elsewhere in the installed
    plugin are not detected by Speck's trust check; the installer re-approves the entry on every
    install.
  - After a code change, run `npm run plugin:install` and restart Speck. Speck does not reload
    plugins.
  - Installing modifies the Speck submodule's working tree: `plugins/.runtime/plugin-trust.json`
    gains an `evidence-desk` entry and `plugins/evidence-desk/` is untracked.
  - The installed plugin imports Speck by absolute file URL (so Speck's own tests, which copy
    `plugins/` elsewhere, still load it). Reinstall if the repository moves.
  - The tab offers two fixed cases (disputed delivery and bank return). There is no way to open
    a new case from Speck.
  - The Speck tab has no live progress stream; it refreshes when an action finishes. The
    standalone page (`npm start`) keeps its server-sent events.

- **Older runs have a partial trace.** Runs recorded before the execution trace existed show no
  per-chunk model call or fetch summary; the trace says "not recorded" rather than guessing.
- **Session counters aren't per run.** The Nemotron session counters in the page header count
  calls since the server started. Per-run figures are in the trace.
- **A failed Zetaris fetch leaves no trace entry.** It records no run at all (HTTP 502), so it
  appears in the error box, not in the trace.

- The scenario's fact rules are hand-written fixture data. The deterministic assessor needs
  them; Nemotron mode uses only the decisive ones.
- Zetaris paging beyond 1000 rows per table is not implemented. The adapter fails rather than
  truncate.
- Small local models are inconsistent. With `nemotron-3-nano:4b`, the first attempt sometimes
  loops until it hits the token cap, and Speck's retry usually recovers. A failed batch is
  recorded as an errored run and its records stay pending.
- The model's explanation is checked against Speck's state using its *declared* conclusion,
  declared firmness and citations, not by reading its prose. If it disagrees, or is out of date,
  the page hides the text behind a warning.
- **Supersession is record-level.** A superseding record replaces the whole earlier record, so
  every judgment on that record stops counting.
  - In `correction-supersedes`, the returned credit was also H-PARTIAL's only refutation (the
    amount matched). After the return, H-PARTIAL is back at its 0.20 prior and is no longer listed
    as ruled out.
  - Facts that should survive a correction must be restated by the correcting record.
  - This is now stated on the page and in the conclusion's notes (see *Whole-record replacement
    is explained*), but it is not prevented.
- **Supersession must be stated.** Supersession is never inferred. A ledger entry derived from a
  reversed payment ("marked paid") keeps counting unless its source says otherwise; here the
  decisive reversal still rules H-PAID out.
- **A correction of a correction reinstates the original.** If a correction is itself superseded,
  the record it replaced counts again. A source that amends an amendment and still means to
  replace the original must list both.
- **Retiring a hypothesis relies on Speck internals.** Speck (pinned at `29d5bb3`) has no public
  API to retire a worker's hypothesis. Its only archive method, `archiveSharedMemory`, refuses
  worker objects.
  - Evidence Desk therefore marks replaced hypotheses `superseded` through Speck's mental-object
    repository, as Speck's own `mind` component does.
  - That single write is isolated in `src/investigation/speck-compat.ts`, which lists its four
    assumptions. It reads the object back after writing and throws `SpeckCompatibilityError` if
    anything that records the old belief changed. `test/speck-compat.test.ts` checks each
    assumption.
  - The write emits no event of its own; the recomputation memory is the audit record.
  - Speck's raw `rankHypotheses` still lists superseded hypotheses, ranked by confidence, so any
    other consumer of this worker must filter on status.
- **Recomputation records describe intent.**
  - A recomputation record is written before its replacements are made and its relations
    applied.
  - If that is interrupted, the record stays. A later `recovery on open` (or `end of run`) record
    shows the repair, and the earlier one shows any replacement it did not carry out.
- **Older databases.**
  - A database written by Build 2, or by Build 3 before 3.1, is reconciled when it is opened.
  - Build 2 runs stored judgments after withholding, so support withheld then cannot be
    reinstated.
  - A Build 3.0 run interrupted before its snapshot left records without saved judgments. These
    show as `failed` ("in Speck's ledger without saved judgments") and count for nothing.
- **Withdrawal before assessment cannot be undone.** A record withdrawn before assessment is
  never assessed. There is no way to reinstate it short of starting a new case. The same holds
  for withdrawn assessed records.
- Nemotron's judgments vary between runs. On identical evidence, run 1 has come out both
  *leading* (0.572) and *supported* (0.652), depending on whether the model counts the
  customer's complaint against delivery.
- A ruled-out explanation's "refuted by" list shows every record Speck counted against it, not
  only the decisive one. The timeline marks which revision was decisive.
