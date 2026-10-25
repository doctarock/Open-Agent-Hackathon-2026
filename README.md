# Open-Agent-Hackathon-2026 — Speck Evidence Desk

> **For judges:** Evidence Desk is a **Speck plugin**. Install (`npm run setup`), start Speck (`npm run speck`) for the full experience, alternatively view the project as a standalone interface or CLI (explained below), (`npm run configure`) if you need to change settings.

> baseline**, a tab on each case: one click runs the same case, with the same
> evidence and the same correction, through both, and shows what each actually did.
> - [docs/SUBMISSION.md](docs/SUBMISSION.md): problem, approach, proof and sponsor use, in one page.
> - [docs/comparison.md](docs/comparison.md): the side-by-side comparison, how it is made fair,
>   and every saved result.
> - [DEMO.md](DEMO.md): the 3-minute walkthrough and slide outline.
> - `npm run sponsors:verify`: checks each sponsor technology in a real run, and reports what it
>   could not observe. It needs local Zetaris and a Meterless Runtime. For what it needs and how
>   to read it, see [Verifying the sponsors yourself](docs/SUBMISSION.md#verifying-the-sponsors-yourself).
>   **Receipt log:** the saved report of the 2026-10-24 run, with its trace and the model that
>   served every call, is
>   [eval/results/sponsors/2026-10-24T02-14-08-828Z.json](eval/results/sponsors/2026-10-24T02-14-08-828Z.json).
> - [Which agent uses which model](#which-agent-uses-which-model): one table.
> - **Reading the code:** each source file in `src/` and `plugin/` opens with its role and a
>   *Why it is built this way* list, and the decisions inside it are marked with `Why:` comments.
>   [src/investigation/](src/investigation/) is the core; start with `desk.ts`.
> - `npm run investigate -- examples/payment-correction-chain/input.json`: one case from
>   structured input to structured output on the command line, with its execution trace. No
>   credentials or network needed. See [Command line](#command-line) and [examples/](examples/).

**Contents**

- [Which agent uses which model](#which-agent-uses-which-model)
- [Speck beside a stateless baseline](#speck-beside-a-stateless-baseline)
- [Decisive mode (experimental)](#decisive-mode-experimental)
- [Using the interface for the first time](#using-the-interface-for-the-first-time)
- [Inside Speck: the guided demo, Speck's views, and your own investigations](#inside-speck-the-guided-demo-specks-views-and-your-own-investigations)
- [The scenario](#the-scenario)
- [Architecture](#architecture)
- [Sponsor integrations and the execution trace](#sponsor-integrations-and-the-execution-trace)
  - [Zetaris](#zetaris) · [Meterless](#meterless) · [NVIDIA Nemotron (local)](#nvidia-nemotron-local) · [Speck](#speck) · [Cursor](#cursor) · [What the trace flags](#what-the-trace-flags)
- [How conclusions are derived](#how-conclusions-are-derived)
  - [Revision: current beliefs come from evidence that still counts](#revision-current-beliefs-come-from-evidence-that-still-counts)
  - [Recovery from interrupted runs (Build 3.1)](#recovery-from-interrupted-runs-build-31)
- [Command line](#command-line)
- [Setup](#setup)
- [Configuration](#configuration)
  - [Live Zetaris (local Docker Compose bundle)](#live-zetaris-local-docker-compose-bundle) · [Model providers](#model-providers) · [Small model, small context](#small-model-small-context) · [Reasoning on or off](#reasoning-on-or-off)
- [Evaluation](#evaluation)
- [Tests](#tests)
- [Security](#security)
- [Known limits of this slice](#known-limits-of-this-slice)

**The problem.** An ordinary stateless model call answers from whatever evidence it is handed.
When a source later corrects a record (a bank returns a payment, a carrier amends a delivery
scan), nothing ties the old conclusion to the record that has just been replaced: the call may
keep the old answer, may keep citing the replaced record, and cannot say what changed or why.

**The approach.** Evidence Desk keeps the case in Speck as explicit state: the evidence ledger,
the competing explanations and Speck's belief in each, the judgment behind every adjustment, and
every revision. When a later record contradicts or replaces an earlier claim, it:
- revises what it believes, from the evidence that still counts;
- says which evidence caused the revision;
- keeps the old belief on record as history, rather than presenting both claims side by side.

**The proof.** The side-by-side comparison, a reproducible test suite, and labelled evaluation
results, kept apart by kind (deterministic fixtures, live model samples). In live samples on the
disputed delivery, the stateless model call kept "delivered" after the carrier's correction and
cited the replaced scan as support, while Speck revised and recorded why (see
[docs/comparison.md](docs/comparison.md) for every sample, including the ones that favour the
baseline). The evaluation finds no measurable accuracy difference between keeping beliefs across
runs and recomputing them from scratch, and Speck abstains more often than the baseline. What
Evidence Desk adds is traceability: an auditable record of which evidence each conclusion rests
on, and how and why it changed.

**It is compact.** The model that weighs the evidence is a 4-billion-parameter Nemotron.

> **Note on model size.** By default, Meterless serves `nvidia/nemotron-3.5-lightning-30b-a3b`
> through its Nightshift NVIDIA provider. Only the 4B model is required for the software to work
> correctly. The larger models Meterless may route to are not needed.

- The model runs on one consumer GPU: Nemotron 3 Nano 4B, 4-bit (Q4_K_M), 2.8 GB, all on the GPU.
- It works in a 4,096-token window, the window Ollama gives it inside Speck and standalone alike.
  The model could take 262,144 tokens, but nothing here needs more.
- Prompts stay small because the case's state lives in Speck, not in the prompt:
  - the Meterless engine splits each run into chunks of at most 4,000 tokens, carrying at most
    512 tokens from one chunk to the next;
  - each chunk holds two records;
  - a run assesses only records not yet assessed;
  - beliefs and history are read from Speck, never replayed to the model.

  So a prompt does not grow as the case does. See *Small model, small context* for the
  measurements.

### Which agent uses which model

| Agent (role) | Code | Model | Receipt |
|---|---|---|---|
| Evidence assessor: judges how each record bears on each explanation, one Meterless chunk at a time | `src/reasoning/nemotron.ts` | Nemotron. Local Ollama: `nemotron-3-nano:4b` (reasoning off). Through Meterless Nightshift (`meterless/auto`, the default), the runtime picks: in the receipt run, `nvidia/nemotron-3-ultra-550b-a55b` (stage 1) and `nvidia/nemotron-3.5-lightning-30b-a3b` (stage 2). | [Sponsor run, 2026-10-24](eval/results/sponsors/2026-10-24T02-14-08-828Z.json) (`servedModels` per call) |
| Explanation writer: the Meterless engine's reflection pass | `src/reasoning/nemotron.ts` | The same model as the assessor | Same report |
| Stateless baseline: the comparison's fresh call per stage, with no memory | `src/eval/systems.ts` | The same model, endpoint and temperature as the assessor | [Saved live comparisons](eval/results/comparisons/) (`nemotron-3-nano:4b`) |
| Decisive reading (experimental, off by default) | `public/decisive.js` | The same model, with reasoning on (`NEMOTRON_DECISIVE_REASONING_EFFORT`) | [docs/comparison.md](docs/comparison.md#decisive-mode-experimental) |
| Speck's chat (*Talk to Speck*) | `patches/speck-chat-investigations.patch` | Set in Speck's System view. Used here: Nemotron Nano 9B v2 on Ollama (`hf.co/bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF:Q4_K_M`), or a Meterless Runtime | One rehearsal, not saved |
| Rule assessor (sample mode, the bank return) | `src/reasoning/rules.ts` | None: deterministic rules | [eval/results/](eval/results/) |

Every live run records the model name the endpoint reported serving, so the trace, not this
table, is the record of what was used.

It runs inside Speck as a plugin:
- **A case is a Speck worker** in Speck's own database, beside Speck's other work.
- **The page is a tab** in Speck's interface, and it is the interface's home: Speck opens on it.
- **Five project-local changes to Speck**, kept in this repository as patches in `patches/`. They
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
  - `speck-meterless-provider.patch`: adds the Meterless Runtime as a Speck model provider (see
    *Model providers*):
    - the contract itself (`src/models/meterless.ts`), which Evidence Desk also uses;
    - a processor and Speck's chat path through it;
    - a Meterless panel in the System view, with the token kept in Speck's secret store.
  - `speck-response-collapse.patch`: Speck's chat reply box gets a *Minimise* / *Expand* button.
    A new reply always opens it again.

  Everything else Evidence Desk needs is Speck's existing plugin system and memory API.

A standalone server serving the same page remains, for development and as a fallback. See
[Setup](#setup) for what it adds and what it lacks.

### Speck beside a stateless baseline

The **Speck vs. baseline** tab of every case (the guided demo opens it as its last
case step) runs the whole case twice, stage by stage, and shows the two side by side. Code: `src/compare/comparison.ts` (server), `public/compare.js` (page); tests:
`test/compare.test.ts` and a route test in `test/plugin.test.ts`.

| | Stateless baseline | Speck |
|---|---|---|
| What it is | The evaluation's own stateless baseline (`src/eval/systems.ts`), called afresh at every stage with no memory of its previous answer. Live: one call to the configured Nemotron endpoint with the question, the explanations and every visible record (text, facts, and "replaces …" where the source says so). Deterministic: the scenario's fact rules summed from scratch. | Evidence Desk as built: one Speck case carried across the stages, evidence assessed incrementally, beliefs revised, replaced records dropped and the beliefs that rested on them rebuilt. |
| Evidence | Exactly the records Speck's desk lists as visible at that stage | the same |
| Question, explanations, assessor | the same model, endpoint, temperature (0.1), output budget and reasoning effort | the same |

What makes it fair, and what it does not show:
- **Same inputs.** Both see the same records at every stage (a test checks each side equals the
  evaluation's own system on the same case).
- **Same checks.** Every check is computed the same way for both: whether it commits to a
  conclusion or abstains; which records it offers as support; whether any of those was replaced by
  a later record (derived from the records alone, with the same rule for both); whether its
  conclusion changed since the previous stage; and, where the case is an evaluation case, whether
  it matches the pre-registered label and whether the conclusion is unsupported (scored exactly as
  `src/eval/metrics.ts` does).
- **Nothing is simulated.** Each value is what the two approaches returned. The live baseline is a
  real model call; a comparison that fails saves nothing and says so.
- **Not persistence alone.** The difference comes from Speck's explicit evidence and revision state
  and its conclusion policy (thresholds, decisive refutation, supersession). The evaluation's
  `speck-fresh` system, which rebuilds from scratch at each checkpoint, reaches the same
  conclusions as the persistent one.
- **Single samples.** Live model judgments vary. Each live comparison is one sample, labelled as
  such; `docs/comparison.md` lists every saved sample, including those that favour the baseline.
- **The case on the page is not touched.** A comparison runs on its own temporary Speck database.

How it is shown: the six steps (observe, assess, correct, revise, verify, explain) each
summarised from the report; short findings; then each stage with the records both saw (the
replaced one struck through), and the two columns side by side: conclusion, cited records,
the baseline's own words (live) or scores (rules), and Speck's evidence for and against with each
record's confidence change, what was ruled out, and "why it changed" as Speck recorded it. Record
ids are buttons that jump to the record. On narrow screens the columns stack.

Saved comparisons and staleness:
- Each comparison is saved as its own file, written whole (temporary file, then rename), and
  never overwritten: from the page beside the case's data, and from `npm run compare` /
  `npm run compare:live` in `eval/results/comparisons/<scenario>/` (tracked in git).
- A comparison is shown as current only if it was made with the case's current scenario,
  fixture evidence and assessor settings (a fingerprint). Others are listed with their settings
  and open only on request, with a warning. While a new comparison runs, the previous one is
  dimmed and labelled as the previous one.
- One comparison runs at a time (HTTP 409 otherwise).

API (standalone under `/api`, inside Speck under `/api/plugins/evidence-desk/cases/<case>`):
`GET comparison` (current, others, running, last failure), `POST comparison` (start),
`GET comparison/<id>`. `GET /api/evaluation` (inside Speck `/api/plugins/evidence-desk/evaluation`)
returns the evaluation reports and the saved comparisons, counted per configuration; the page
shows them under **Evaluation results** (a button beside the cases inside Speck, and in each case's
**Audit** tab).

### Decisive mode (experimental)

A switch at the top of each case's conclusion (and in the comparison panel) turns on an extra
reading that combines Speck with the stateless baseline: the stateless answer is accepted only if
every record it cites still counts and Speck holds or points to the same explanation; otherwise
Speck's own conclusion stands, or nothing is concluded. *What is decisive mode?* beside the switch
explains it, its cost, and that it is experimental. It is off by default, kept per viewer in the
browser, and never changes Speck's belief state, the evidence or the history.

- Rule: `public/decisive.js` (`decisive-1`, fixed as first written); tests: `test/decisive.test.ts`.
- On the case page, after each run it asks the same stateless baseline (`GET`/`POST opinion`;
  one model call when live) for an answer on the case as it stands, and shows the reading only
  while that answer still matches the latest run, stage and records.
- That one call is made with the model's **reasoning on** (`NEMOTRON_DECISIVE_REASONING_EFFORT`,
  default `medium` for Ollama and Meterless, the provider's default elsewhere; `none` turns it
  off), whatever the assessor uses. Reasoning made the stateless answer markedly better (see
  *Reasoning on or off*). The prompt and the reasoning fit easily in the 4,096-token window:
  measured, a 1,007-token prompt and 250-470 reply tokens.
- It was designed after looking at the saved comparisons, including a held-out case, and has not
  been evaluated on other cases. The replay and its cost are in
  [docs/comparison.md](docs/comparison.md#decisive-mode-experimental).

### Using the interface for the first time

The page explains itself; no walkthrough from a developer is needed.

- **One view at a time.** Under the case and its Run / Introduce update buttons, the page has
  five tabs: **Conclusion**, **Evidence** (with its record count, and how many are new),
  **Speck vs. baseline**, **History** (the revision timeline) and **Audit** (the execution
  trace, evaluation results and configuration). The tab last chosen is remembered per browser.
  The guided tour and the Guide's *Show me* open the tab that holds what they point at.
- **A first-run introduction** says what Evidence Desk is for and offers one action, *Start the
  guided investigation*. It can be dismissed, and is not shown again to the same browser. Inside
  Speck it is on both prepared cases (not on your own investigations), and its button starts the
  full guided demo; it is hidden while the guided demo is running, and *Reset demo case* shows it
  again.
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
  - Inside Speck, a reset made outside the guided demo also clears any demo still in progress in
    that browser.
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

Inside Speck the Evidence tab runs one **guided demo** across both cases and Speck's views. A
prepared case's introduction offers it (*Start the guided investigation* or *Explore on my own*),
and the *Start the guided demo* button at the end of the case picker starts or resumes it.

1. **Disputed delivery** (live when configured): the case tour above, without its comparison
   and last overview steps.
2. **Bank return** (deterministic, instant): the explanations, a run, the prepared update (the
   bank's return of the payment), a second run, and which record no longer counts. It ends on
   **Speck beside a stateless baseline**: the panel opens and runs the whole case both ways.
3. **Speck's world view:** the demo opens it. Each investigation is a Speck task, and its runs'
   actions (Hypothesis Proposed, Memory Recorded, Belief Revised, Association Reinforced) are laid
   out in time; right-drag travels back. The panel quotes Speck's own timeline status and each
   case's run count and current conclusion, read from the plugin's API.
4. **The memory map:** the demo switches to it. The lines are the links Evidence Desk makes
   (below); the panel quotes Speck's own count of memories and associations.
5. **Talk to Speck:** a question about the bank return is put in Speck's message bar. The step
   completes when Speck replies (Speck's `speck:reply` event); it does not judge the reply, and
   says to check it against the case page.
6. **Your own investigation:** the new-investigation form opens, with what creating, running and
   correcting one does. This part does not wait for anything: it says the guided demo is
   complete, and the viewer can go on to create one.

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

Speck's chat needs a model of its own, set in Speck's System view (or `POST /api/brains/config`)
as a processor for Speck's roles: an Ollama model or a Meterless Runtime. `npm run configure`
offers to point it at the same Meterless Runtime as the assessor. Speck saves that in
`speck/data/genesis-runtime/model-processors.json`, which is runtime data and not committed;
restart Speck after changing it.

The local alternative used here is Nemotron Nano 9B through Ollama. The 4B model used for
assessments was tried first and invented details more often.

**Your own investigations.** *+ New investigation* takes a title, the question, two to five
competing explanations (equal priors) and optionally the first evidence.
- Once the title and question are written, *Suggest explanations* has the configured model
  (through Speck's model registry, under a structured-output contract) fill the empty explanation
  fields, and *Suggest another* adds one more field with a suggestion, up to five. Suggestions
  never repeat an explanation already written, are only filled into the form to edit or replace,
  and record nothing in Speck (`POST /api/plugins/evidence-desk/explanations/suggest`). Without a
  configured model the form says so and nothing is called.
- It is written as an ordinary scenario under the installed plugin's
  `data/user-cases/my-N/` and investigated by the same pipeline, as case `MY-N`.
- *Add evidence* adds a record (source, text, optional date), or a correction of an earlier record,
  which then supersedes it. Added records are assessed on the next run.
- The evidence is free text, so only the Nemotron assessor can weigh it (capped at reliability
  0.4 like all model-judged evidence). Under the rule assessor the records are assessed but weigh
  nothing, and the page says so.
- *Delete investigation…* (top right of the case, for your own investigations only) asks
  first, then:
  - takes the case off the tab;
  - suspends its Speck worker, every copy of it, with its history, so Speck's task queue stops
    offering it;
  - archives its chat summary;
  - moves its files to `data/deleted-cases/<time>-my-N/`, from which they can be restored.

  The two prepared demo cases cannot be deleted, only reset: the button is not shown on them,
  and the server refuses them by name (HTTP 400), which a test checks for both. A later investigation may reuse the free name
  `my-N`, but each has its own scenario id, so it never attaches to a deleted case's worker.
- The code is `src/investigation/user-cases.ts` and `retireCase` in `src/investigation/desk.ts`,
  tested in `test/user-cases.test.ts` and `test/plugin.test.ts`.

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

**Inside the desk** (`src/investigation/`), one job per module:

| Module | Job |
|---|---|
| `api.ts` | The case's JSON API as one route table (`DESK_ROUTES`), registered by both hosts: under `/api` by `src/server.ts`, and per case by the plugin |
| `desk.ts` | `EvidenceDesk`: opens or attaches to Speck, the case's worker and its copies, and every change to the case (run, update, withdrawal, reset), one at a time under Speck's foreground lease |
| `records.ts` | What Evidence Desk keeps in Speck beside Speck's own objects (run snapshots, assessments, recomputations, exclusions), and the errors |
| `case-state.ts` | `CaseState`: one read of the case in Speck, with the ledger, the basis, the conclusion and the evidence listing derived from it at most once. A page request reads one snapshot, so its views agree |
| `reconcile.ts` | Brings Speck's current hypotheses in line with the evidence that still counts (see *Revision*) |
| `run.ts` | One investigation run: the Meterless generator, the assessment per chunk, the explanation and its check |
| `publish.ts` | What Speck's memory and chat see: links between the case's memories, and the shared case summary |
| `basis.ts`, `conclusion.ts`, `timeline.ts`, `trace.ts` | Pure derivations: what counts, the conclusion, the revision timeline, the execution trace |

**How it fits into Speck.** Speck discovers plugins in its `plugins/` folder and hands each one
its runtime, with routes and a tab in its interface.

| What Speck required | What Evidence Desk does |
|---|---|
| Plugins load only from `speck/plugins/`, if their entry module's hash is in Speck's allowlist (`speck/plugins/.runtime/plugin-trust.json`) | `npm run plugin:install` copies the compiled plugin and its data there. It adds the entry module's hash to the allowlist, which is Speck's documented approval step. That allowlist file is the only tracked Speck file it changes. |
| Speck counts workers in `created` or `ready` as queued tasks, and pauses background cognition for all workers while any is queued | Each case worker moves `created → ready → waiting` through Speck's own transitions. In Speck's Task queue the cases show under **Waiting**. |
| Speck's background embedding job can write a stale copy of an object over a concurrent revision (demonstrated in `test/speck-compat.test.ts`) | Every change to a case takes Speck's foreground lease and waits for any background job already running. The lease does not order foreground work, so a change (a run, an update, a withdrawal, a reset) is refused with HTTP 409 while another change to the same case is in progress. Background cognition then runs over the cases like any other worker. |
| Speck's chat could select any model in its runtime registry | Nemotron goes through a private instance of Speck's `ModelRegistry` class: the same contract validation and retries, but no model is added to Speck. |
| Speck's interface always opened on its World view, with plugin tabs after Speck's own | One of five project-local changes to Speck (see above), kept in this project as `patches/speck-home-view.patch` (applied by `npm run speck:patch`, part of `npm run setup`; never committed to Speck): `SPECK_HOME_VIEW` (default `world`) names the view the interface opens on and returns to (brand button, panel close). A plugin tab named there is placed first in the rail. `npm run speck` sets it to the Evidence tab; `SPECK_HOME_VIEW=world npm run speck` restores Speck's default. Speck's own tests cover the setting (`src/tests/genesis-host.test.ts`). |

| Concern | Owner | How it is used |
|---|---|---|
| Cognition | **Speck** (`speck/`, imported as `#speck`; its cognition is unmodified) | The case is a Speck worker. Hypotheses come from `proposeHypothesis`. Evidence goes into the ledger through `recordEvidence`, which caps reliability for model-judged evidence. The relations that currently take effect are applied through `reviseHypothesesFromEvidence`, which runs Speck's belief revision with decisive refutation. When invalidated evidence makes that necessary, a hypothesis is replaced and the relations are replayed (see *Revision* below). Withdrawals use `withdrawEvidence`. Ranking uses `rankHypotheses`. The released evidence stage is held with `setWorldState`, and each run's outcome is saved as episodic memory through `recordMemory`. The timeline is Speck's event log (`belief.revised`, `evidence.recorded`, …). Model calls go through Speck's model registry, which validates contracts and retries. All of this persists in one Speck SQLite database. |
| Federated evidence | **Zetaris** | `EvidenceProvider` interface with a fixture implementation and a live Zetaris adapter (`src/evidence/zetaris-provider.ts`). The adapter uses the platform's REST API (`/api/auth/login`, then `/api/proxy/query/sql/start`) with one SELECT per source table, configured in `config/zetaris-queries.json`. `EVIDENCE_MODE` selects the mode explicitly, and there is never a fallback. Every record carries its retrieval mode, table and Zetaris query token. |
| Execution | **Meterless** Markovian engine | The Apache-2.0 reference implementation, vendored unmodified at `vendor/meterless-markovian/` (pinned commit and hashes are in its `NOTICE.md`). Each run is a `Markovian.run`. The injected generator assesses one bounded batch of new evidence per chunk and ends each chunk with a `[STATE_CHECKPOINT]` carryover block, or `[TASK_COMPLETE]` on the last one. `maxChunks` caps the run. Run history goes to `data/meterless/history.json`. Progress events stream to the UI. In Nemotron mode, the reflection pass produces the model's explanation. |
| Reasoning model | **NVIDIA Nemotron** | `src/reasoning/nemotron.ts`: a model processor for any OpenAI-compatible chat endpoint, called through a private instance of Speck's `ModelRegistry` (Speck's contract validation and retries, without adding a model to Speck's own runtime). The model judges how each evidence item bears on each hypothesis, and decisive rules still take precedence. Speck records model-judged evidence as `model`-provenance and caps its reliability at 0.4. The explanation's citations are checked against the real evidence ids. The model name the endpoint reports serving is recorded with every run. |

## Sponsor integrations and the execution trace

The **Execution trace** in the page's **Audit** tab (and `GET /api/trace`) shows, for each run, what each
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

Two parts of Meterless are used, and the trace and `npm run sponsors:verify` report them
separately: the Markovian engine executes each run (below), and Nightshift, Meterless's HTTP
API, is the default model provider (see *Model providers*).

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

- **Repository:** `speck/`, a submodule pinned to upstream Speck `8821789`: `29d5bb3` plus
  Speck's own lockfile update, which clears its `npm audit` advisories (0 vulnerabilities). This project patches
  its working tree in four ways: the `SPECK_HOME_VIEW` interface setting
  (`patches/speck-home-view.patch`), removing Speck's other bundled plugins
  (`patches/speck-remove-plugins.patch`), the chat component that answers from published
  case summaries (`patches/speck-chat-investigations.patch`), and the Meterless Runtime as a
  model provider (`patches/speck-meterless-provider.patch`). Belief revision, memory and the
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

## Command line

`npm run investigate` runs one case end to end, without Speck's interface. It runs every stage
in order, one Evidence Desk run per stage, on throwaway storage; `data/` is not touched.

```bash
npm run investigate -- examples/payment-correction-chain/input.json             # sample mode
npm run investigate -- eval/scenarios/correction-supersedes --output result.json
npm run investigate -- fixtures/scenarios/disputed-delivery --live              # .env settings
```

- **Input:** a folder holding `scenario.json` and `evidence.json` (the format of every case in
  `fixtures/` and `eval/`), or one JSON file `{"scenario": …, "evidence": …}`.
- **Sample mode** (the default) needs no credentials, network, Zetaris or model, and reads no
  `.env`. The evidence is the case's own file and the deterministic rule assessor judges it. The
  Meterless engine, Speck's belief revision and the validation all run as usual.
- **`--live`** reads `.env` instead, so the evidence (fixtures or Zetaris) and the assessor (rules,
  or Nemotron through the configured provider) are whatever it configures.
- **Output:** the result, stage by stage: the records visible, those newly assessed, those no
  longer counted and why, and the conclusion with its state, explanation, confidence, what is
  eliminated and the records it rests on. The schema is in [examples/README.md](examples/README.md).
  `--output <file>` writes it alone.
- **Trace:** stdout is JSON Lines, and the same lines go to `logs/<time>-<case>.jsonl` (`--logs
  <dir>` to change; git-ignored):
  - `start`: the evidence source, the assessor (with the requested model, if any) and the engine;
  - `stage`: each stage as it is released;
  - `trace`, one line per step of the run, read from the persisted execution trace (see
    *Sponsor integrations and the execution trace*):
    - `run`: the evidence fetch (each Zetaris SELECT with its query token, or the fixture file),
      the Meterless run (id, status, chunks), and flags (retries, contract failures, invalid
      citations, revisions);
    - `chunk`: each engine chunk's records, its token count and carryover, its judgments, Speck's
      revisions, and its model call: requested and served model, endpoint, attempts, contract
      and transport failures, outcome and latency;
    - `explanation`: the model's explanation, checked against Speck's state and its citations;
  - `result` (or `error`), last.

  Exit status: 0 on success, 1 if the investigation failed, 2 for a usage error.

[examples/](examples/) has three cases with their expected outputs. `test/examples.test.ts`
checks that sample mode reproduces each one and that the CLI writes the same lines to stdout and
`logs/` with no settings at all.

## Setup

Requires Node.js 22+ and git. Clone the repository, then from its root:

```bash
npm run setup    # fetch speck/, install, build Speck, install the plugin, then ask two questions
npm run speck    # Speck on http://127.0.0.1:4310, opening on the Evidence tab
```

On the first run `npm run setup` asks the two questions of `npm run configure`, and checks each
answer against the real service before saving it to `.env`:

1. **Which model weighs the evidence:**
   - **Meterless Runtime** (the default). It finds a runtime on this machine (ports 8088, 8090,
     8787 and 11434), or takes a pasted address or connect link. It asks for the token if the
     runtime wants one, and offers its routing modes.
   - **Nemotron on local Ollama.** It lists your Nemotron models and offers to download
     `nemotron-3-nano:4b` if there are none.
   - **Nemotron on NVIDIA's hosted API.** It takes your key and lists the Nemotron models
     available to it.
   - **No model.** The deterministic fact rules.
2. **Where the evidence comes from:**
   - fixture files;
   - **local Zetaris** (the Docker bundle). It signs in and offers to load the scenario's evidence;
   - **another Zetaris address.** It signs in and checks the tables; this is not tested beyond
     the local bundle.

Run `npm run configure` again at any time to change these (`--model`, `--evidence` and `--yes`
skip the questions). Secrets are typed hidden and never printed. Without a `.env`, the cases run
on fixtures with the rule assessor. `npm test` builds and runs every test, with no credentials.

- **One settings file.** The repository's `.env` is read by the standalone server, the scripts
  and the Speck plugin, which finds it through the `install.json` it was installed with.
  It is git-ignored. After changing it, restart Speck. A `.env` left in
  `speck/plugins/evidence-desk/` by an earlier version is renamed `.env.old` and no longer read.
- **Where the case lives.** Inside Speck, each case is a worker in Speck's own database. Speck
  stores that under `speck/data/` by default; set `SPECK_DB_PATH` to use another file.
- **Changing Evidence Desk's code.** Run `npm run plugin:install` again, then restart Speck.

The tab offers two cases:
- **Disputed delivery** follows the plugin's settings (live Zetaris and Nemotron, or fixtures).
- **Bank return** always runs on its fixture with the rule assessor.

**Standalone fallback.** `npm start` serves the same page on http://127.0.0.1:4320, outside
Speck, with its own database at `data/evidence-desk.sqlite`. It has no login, so it answers only
its own page and local tools: requests from another site open in the browser (by `Origin`) and from
a domain name that resolves to this machine (DNS rebinding, by `Host`) are refused. Open it by
`localhost` or an IP address. It warns at startup if `EVIDENCE_DESK_HOST` exposes it to the network.
Inside Speck, Speck's admin token guards the same API.

Use the Evidence tab in Speck for the demo. The standalone page is for when Speck will not start,
or for development. It offers only these things the tab does not:
- **Live run progress.** The server streams each run's phase and chunk to the page as it
  happens. The tab instead checks for progress while a run is under way and refreshes when it
  finishes.
- **The per-case introduction and tour.** Inside Speck, the guided demo across Speck's views
  replaces them.
- **Any scenario, with no reinstall.** `EVIDENCE_DESK_SCENARIO` points the server at any
  scenario folder. Run several at once with their own `EVIDENCE_DESK_PORT` and
  `EVIDENCE_DESK_DB`. The cross-domain evaluation was run this way.
- **No Speck needed.** It opens its own Speck runtime on its own database, so it leaves Speck's
  data alone. A code change needs only `npm run build`, not `npm run plugin:install` and a Speck
  restart.

Everything else is only in the tab:
- your own investigations (*+ New investigation*);
- the guided demo;
- the case's links in Speck's memory map;
- the published case summary;
- talking to Speck about the case.

In the Evidence tab (or the standalone page), use the buttons in this order:
1. **Run investigation**
2. **Introduce prepared update**
3. **Run investigation** again

Then read the **Conclusion** tab and the revision timeline in the **History** tab.

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
2. Choose them with `npm run configure -- --model ollama --evidence zetaris-local` (or set
   `EVIDENCE_MODE=zetaris`, `REASONER=nemotron` and `MODEL_PROVIDER=ollama` in `.env`).
   Then run `npm run speck` and open the Evidence tab's Disputed delivery case. (Standalone:
   `npm start`, after `npm run db:reset` for a clean case.)
3. Check the header and records:
   - the header shows **ZETARIS LIVE**, the Nemotron model and endpoint, and the Meterless
     engine and commit;
   - every record is labelled **Zetaris live**, with its table and query token.
4. Run, introduce the update, and run again. Each run takes tens of seconds on a small local
   model.
5. Open the **Audit** tab's **Execution trace**. The latest run shows:
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
| `npm run setup` | Fetch `speck/`, install dependencies here and in it, build Speck, install the plugin, and on a first run ask the `configure` questions |
| `npm run configure` | Choose the model (Meterless Runtime, local Ollama, NVIDIA's API, or rules) and the evidence source (fixtures, local Zetaris, another Zetaris address); checks each against the real service and writes `.env`. `--model`, `--evidence`, `--yes` skip the questions. |
| `npm run speck` | Start Speck with Evidence Desk's Evidence tab as its home view (`SPECK_HOME_VIEW`; set it to `world` for Speck's default). Other `SPECK_*` settings pass through. A Speck already running on the same port is stopped first; anything else on the port is left alone and Speck does not start. |
| `npm run investigate -- <case>` | One case from structured input to structured output, every stage, with the execution trace as JSON Lines on stdout and in `logs/`. Sample mode by default (no `.env`, credentials or network); `--live` uses `.env`; `--output <file>` writes the result. See *Command line*. |
| `npm run compare` | Speck beside the stateless baseline on both prepared cases, deterministic (fixtures, rules). Saves each report as a new file in `eval/results/comparisons/<scenario>/`; the page shows them. |
| `npm run compare:live` | The same with the settings in `.env`: the configured model provider for both cases, and Zetaris for the disputed delivery. Exits 2 if no usable model is configured. |
| `npm run eval:reasoning` | The live evaluation on local Ollama with the model's reasoning off and on (three repeats each, alternated); writes each report and a `summary.md` to `eval/results/experiments/reasoning/<time>/`, never `live.json`. Needs the 16K model: `ollama create nemotron-3-nano-4b-ctx16k -f config/ollama/nemotron-3-nano-4b-ctx16k.Modelfile`. `-- --summarize <dir>` re-summarises a folder. |
| `npm run eval:cross-domain` | The separate cross-domain suite (`eval/cross-domain/`): logistics, payment reversals, procurement; refuses to run if its locked expectations changed. Findings: `docs/cross-domain-evaluation.md` |
| `npm run plugin:install` | Build, then (re)install the plugin into `speck/plugins/evidence-desk/` and approve its entry hash in Speck's allowlist. Keeps the case data; the plugin reads the repository's `.env`. Restart Speck afterwards. |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start the standalone server (reads `.env` when present) |
| `npm run dev` | Build, then start with restart on changes in `dist/` (run `npx tsc -w` alongside) |
| `npm test` | Build and run every test in `dist/test/` |
| `npm run db:reset` | Delete Evidence Desk's Speck database and Meterless history. Stop the server first. |
| `npm run zetaris:seed` | Load the scenario's evidence into a local Zetaris platform (see below) |
| `npm run zetaris:check` | Exercise the live Zetaris path: login, probe query, case evidence |
| `npm run zetaris:usl` | Build and check the Zetaris Unified Semantic Layer over a warehouse and a carrier source, with a data-quality rule (separate from the live path). See `zetaris/usl/README.md` and `docs/zetaris-usl-reflection.md` |
| `npm run model:check` | One plain-text call to the configured model provider (for a Meterless Runtime, after checking its status and routing modes); prints the model it reports serving |
| `npm run sponsors:verify` | Runs a real two-stage investigation with the services in `.env`, on throwaway storage (`data/` is untouched). Checks each sponsor's contribution against an independent source and prints OBSERVED or NOT OBSERVED for each. Exits 1 if any configured sponsor was not observed. Saves the report and trace to `eval/results/sponsor-check.json`, and keeps a copy that is never overwritten in `eval/results/sponsors/<time>.json` (tracked in git). |

The standalone server keeps its own database at `data/evidence-desk.sqlite`, separate from
anything in `speck/data/`. `npm run db:reset` gives it a clean case.

## Configuration

All settings are environment variables, set in a git-ignored `.env`, which `npm run configure`
writes. `.env.example` lists them with placeholders. There are no credential defaults in code.

- `EVIDENCE_MODE=fixture|zetaris` selects the evidence source explicitly.
- `REASONER=rules|nemotron` selects the reasoner: the fact rules, or the model assessor.
- `MODEL_PROVIDER=meterless|ollama|nvidia|openai-compatible` selects where the model assessor's
  calls go (see *Model providers*). Unset, it is `meterless`, unless an older `.env` sets
  `NEMOTRON_BASE_URL`, which keeps that endpoint.
- An unusable model is refused before anything runs: a Meterless model that is not a routing mode
  or has no token, or, for the other providers, an unset or non-Nemotron `NEMOTRON_MODEL`.

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

### Model providers

The model client (`src/reasoning/nemotron.ts`) speaks the OpenAI chat API. `MODEL_PROVIDER`
chooses the endpoint:

- **Meterless Runtime (`meterless`, the default).** Meterless Runtime 1.4, provider contract v4.
  - **What it is.** Nightshift, Meterless's HTTP API: a separate program, by default on port
    8088, that routes each call to a model. Start it before configuring.
  - **Model identity.** Every call sends the routing mode (`meterless/auto` and so on) as the
    model, and the trace records the model each response names. `npm run sponsors:verify`
    reports Nightshift as OBSERVED only when:
    - every model call of the run went to it and was answered;
    - each response named the model that served it, not just the routing mode echoed back.
  - **Code.**
    - The contract is implemented once, in Speck (`speck/src/models/meterless.ts`, from
      `speck-meterless-provider.patch`).
    - Evidence Desk uses it through `src/reasoning/meterless.ts`, under its own app id.
  - **Not the engine.** This is separate from the Meterless engine that executes each run
    (`vendor/meterless-markovian/`), which is unchanged.
  - **Where to set it:** `npm run configure`, `.env`, or Speck's System view.
    - In Speck's System view, under Brains, the provider *Meterless Runtime* shows a panel:
      - the address field also takes a connect link;
      - *Auto Detect* finds a runtime on this machine;
      - *Discover* checks the runtime and lists its routing modes;
      - a token field appears when the runtime says *unauthorized*.
    - The token is kept in Speck's encrypted secret store as `meterless_runtime_token`, and no
      route ever returns it.
    - Inside Speck, a token in the secret store wins over `.env`, so a token saved in the System
      view also reaches Evidence Desk's cases. `npm run configure` writes the token to both.
    - `npm run speck` passes `.env`'s `meterless_runtime_token` (and nothing else from `.env`) to
      Speck, so Speck's chat is authorised even when the store is empty, as after a fresh clone
      whose `npm run setup` kept an existing `.env` and so skipped configure.
  - `METERLESS_BASE_URL` (default `http://127.0.0.1:8088/v1`). A pasted address with or without
    a scheme, `/v1`, `/v1/chat/completions`, `/v1/models` or `/healthz` is normalised to
    `<host>/v1`. A connect link (`http://<host>:<port>/connect#k=<key>`) gives both the address
    and the token; `npm run configure` reads it and never prints it.
  - `meterless_runtime_token`: the token the runtime writes to `<stateDir>/proxy-token`. It is
    sent as `Authorization: Bearer` on every call; the placeholder `rt-local` counts as no token.
  - `METERLESS_MODEL` (default `meterless/auto`): a routing mode, not a model:
    - `meterless/<disposition>`: `auto`, `fast`, `deep`, `cheap`, `local` or `fusion`;
    - `meterless/<class>`, or `meterless/<class>.<disposition>`;
    - any other `meterless/*` id the runtime lists is kept.
  - Every request carries `meterless-app`: `evidence-desk` for the assessor, `speck` for Speck's
    chat. Chat requests also carry `meterless-scope: user`. Calls time out after 180 s (`NEMOTRON_TIMEOUT_MS`), because a
    model load can take minutes.
  - Status comes from `GET /v1/models`: 401 or 403 is *unauthorized*; 200 with `meterless/*` ids
    is *online*; anything else is *offline* (`/healthz` only shows the process is up).
  - Auto Detect tries ports 8088, 8090, 8787 and 11434 on 127.0.0.1, localhost and [::1], and
    keeps the first that is online or unauthorized.
  - Tested against a stand-in runtime (`test/meterless-runtime.test.ts`, and Speck's
    `src/tests/meterless-provider.test.ts`):
    - a wrong token shows *unauthorized*, not *offline*;
    - Auto Detect finds the runtime and skips an Ollama-like server;
    - a plain-text request on `meterless/auto` returns a string;
    - Speck's chat path answers through it.

    The same stand-in, driven through a running Speck, showed each of these:
    - detected *unauthorized*;
    - a connect link saved the token and showed the runtime *online*;
    - a chat turn was answered through it;
    - Evidence Desk's assessor called it with the token from Speck's secret store.

    A real runtime was then verified on 2026-10-24 (Meterless Runtime on port 8088,
    `meterless/auto`): `npm run sponsors:verify` reported every sponsor OBSERVED. All 5 model
    calls of the two-stage run went through Nightshift and were answered, each naming the model
    that served it:
    - the first stage's two chunks and its explanation went to `nvidia/nemotron-3-ultra-550b-a55b`;
    - the second stage's chunk and explanation went to `nvidia/nemotron-3.5-lightning-30b-a3b`.

    Calls took 10-52 s each, and none was rejected by the contract check. `auto` chose much
    larger models than the 4B one *It is compact* describes; that description is of local
    Ollama. Use `METERLESS_MODEL=meterless/local` to keep calls on the device.
  - **Only the 4B is required.** By default, Meterless serves
    `nvidia/nemotron-3.5-lightning-30b-a3b` through its Nightshift NVIDIA provider. Evidence
    Desk works correctly with the 4B Nemotron alone; the larger models are not required.
  - The runtime chooses the model for each call. The trace records the model it reports serving.
    `npm run sponsors:verify` still requires that model to be Nemotron before it reports Nemotron
    as used.
- **Nemotron on local Ollama (`ollama`; the configuration used and verified here):**
  - `NEMOTRON_MODEL` set to a local Nemotron tag (verified with `nemotron-3-nano:4b`); the base
    URL defaults to `http://127.0.0.1:11434/v1`;
  - `NEMOTRON_REASONING_EFFORT=none`. With reasoning on, the model's reasoning trace uses up the
    output budget.
- **Nemotron on NVIDIA's hosted API (`nvidia`; supported by configuration, not exercised in this
  project's verification):**
  - a Nemotron model id in `NEMOTRON_MODEL`, and the key in `NEMOTRON_API_KEY`;
  - the base URL defaults to `https://integrate.api.nvidia.com/v1`;
  - the key is read from the same `.env` as everything else, so it also reaches the plugin
    inside Speck.
- **`openai-compatible`:** any other endpoint serving Nemotron, at `NEMOTRON_BASE_URL`.

Run `npm run model:check` before claiming a model was used. For a Meterless Runtime it first
reports the runtime's status and routing modes. Each run also records `servedModels`, the names
the endpoint returned.

### Small model, small context

The assessor runs on **Nemotron 3 Nano 4B**, served by local Ollama:
- 4.0B parameters, quantised to 4 bits (Q4_K_M), 2.8 GB, entirely on the GPU;
- a **4,096-token context window**, which is Ollama's default when a client sends no context size
  and is what `ollama ps` reports. Evidence Desk sends none, so the window is the same inside Speck
  and standalone;
- replies are capped at 4,096 tokens (`NEMOTRON_MAX_TOKENS`).

The model accepts 262,144 tokens; the design keeps every prompt far below even 4,096.
- **Bounded chunks.** The Meterless engine caps each chunk at 4,000 tokens and carries at most
  512 from one chunk to the next.
- **Two records per chunk** (`EVIDENCE_BATCH_SIZE`).
- **Only new evidence.** A run assesses only records not yet assessed; earlier judgments are
  already in Speck.
- **State in Speck, not in the prompt.** Beliefs, the evidence ledger and the revision history are
  Speck's state. The model is never handed the case's history to re-read.

Measured on 2026-10-24: the disputed delivery's two stages, fixture evidence,
`nemotron-3-nano:4b` with reasoning off, one sample:

| Call | Prompt tokens | Reply tokens | Time |
|---|---|---|---|
| Stage 1, two assessments | 911, 955 | 566, 633 | 6.5 s, 5.0 s |
| Stage 1, explanation | 1,792 | 177 | 1.7 s |
| Stage 2, two assessments | 956, 985 | 4,096, 607 | 31.3 s, 4.8 s |
| Stage 2, explanation | 1,923 | 165 | 1.6 s |

- **No growth with history.** Stage 2's prompts are the same size as stage 1's, although the case
  had grown.
- **The largest prompt** was 1,923 tokens, under half the window.
- **One runaway reply.** One stage-2 assessment ran on to the 4,096-token output cap (31 s), the
  kind of inconsistency a small model shows (see *Known limits of this slice*). Both runs still
  completed: *leading* H-DELIVERED, then *leading* H-MISDELIVERED.

Speck's own chat uses a separate model, the 9B Nemotron Nano, with a 16,384-token window (see
*Inside Speck*).

### Reasoning on or off

The 4B model can reason before it answers. The assessor runs with reasoning off
(`NEMOTRON_REASONING_EFFORT=none`). To see what reasoning and a larger window would change,
`npm run eval:reasoning` runs the live evaluation (both groups: 8 held-out and 8 regression
checkpoints with fixed labels) under two settings, alternated, three times each:
- **reasoning off:** `nemotron-3-nano:4b`, 4,096-token window, replies capped at 4,096 tokens;
- **reasoning on:** the same weights in a 16,384-token window
  (`config/ollama/nemotron-3-nano-4b-ctx16k.Modelfile`), replies capped at 12,288.

Every system uses the same model in each setting: Speck, Speck rebuilt from scratch at each
checkpoint, and the stateless baseline.

**Results** (48 labelled checkpoints per cell, 2026-10-24). Each report is in
`eval/results/experiments/reasoning/`, with a `summary.md` per run.

| Conclusion correct | Reasoning off | Reasoning on |
|---|---|---|
| Speck (the case as the app runs it) | 26/48 | 27/48 |
| Speck, rebuilt from scratch | 27/48 | 28/48 |
| Stateless baseline | 19/48 | **35/48** |
| Time for one pass of both groups | about 5 min | about 7 min |

- **Speck does not improve.** It almost never states a wrong conclusion: 0-1 unsupported claims
  in either setting. What it misses, it misses by abstaining when a conclusion was due (22 of 30
  such checkpoints with reasoning off, 20 with it on). That comes from Speck's conclusion policy,
  not from the model's judgments: model-judged evidence is capped at reliability 0.4, and a
  conclusion must clear a threshold. Better judgments do not move it.
- **The stateless baseline improves markedly.** With reasoning on:
  - unsupported claims fall from 19 of 44 of its conclusions to 3 of 43;
  - it keeps every refuted claim out of its answer (27/27, against 19/27);
  - it never cites a replaced record as support (15/15, against 10/15).
- **Where the comparison's claim holds.** The side-by-side comparison's finding (the stateless call
  keeps "delivered" and cites the replaced scan) was measured with reasoning off. With reasoning
  on, the baseline mostly stops doing that.
- **Cost.** Reasoning takes longer: a median of about 4-6 s per Speck call against about 2 s, and
  about 1.6 s per baseline call against 0.7 s.
- **A fix the experiment found.** With reasoning on, the model sometimes splits an identifier
  after its hyphen ("H- MISDELIVERED", "EV- SUP-006"), and the contract check rejected those
  replies: 12 of 54 baseline replies in the first run
  (`eval/results/experiments/reasoning/2026-10-24-strict-ids/`).
  - The model client now joins such identifiers back together, for every call alike
    (`joinSplitIdentifiers` in `src/reasoning/nemotron.ts`). Only a quoted value made of
    uppercase letters, digits and hyphens is treated as an identifier; other text is left as
    written.
  - The reasoning-on numbers above are the rerun with the fix (`2026-10-24-ids-joined/`), in which
    every baseline reply was valid. Before the fix, reasoning on scored 26, 26 and 32 of 48.
  - The reasoning-off numbers come from the first run. That setting produced no split
    identifiers, so the fix does not touch it.

What follows from it:
- **The assessor stays at reasoning off**, which is as accurate for Speck and about twice as fast.
- **Decisive mode's stateless call uses reasoning on**, where it helps (see *Decisive mode*).
- **The lever for Speck is its conclusion policy**, not the model. Changing it is a design
  decision, and would be measured the same way against the same pre-registered labels.

These are three live samples per setting on 16 checkpoints, so differences of one or two counts
are within run-to-run variation. The 19 versus 35 difference for the baseline is not.

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
(correction-sequence regression cases). Both are git-ignored. Before a report is replaced, the
previous one is copied to `eval/results/history/` under its own timestamp, so rerunning a command
never loses an earlier result (`src/eval/results.ts`; the same for the cross-domain suite and
`sponsors:verify`). The page shows every report under **Evaluation results**, with its date,
sample size and model, and each case and checkpoint.

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

`npm test` runs 139 tests with no network access beyond localhost and no credentials:

- **Side-by-side comparison** (`test/compare.test.ts`, and a route test in `test/plugin.test.ts`): both approaches see the same records at every stage, and each side equals the evaluation's own system on the same case; a stateless answer citing a replaced record is flagged (a stand-in model endpoint); the case on the page is untouched; saved comparisons are never overwritten, partial writes are ignored, and a comparison made with other settings is never shown as current; a failed comparison saves nothing; one runs at a time (409); the page's findings are built from the report; the evaluation summary reads the reports as written; rewriting a report archives the previous one.

- **Fixture mode:** runs with an empty environment.
- **Command line and examples** (`test/examples.test.ts`): each of the three examples, run in sample mode, equals its expected output, and its trace shows the evidence fetch, the engine run and the assessor; the CLI, started with no settings at all, writes the same JSON Lines to stdout and `logs/`.
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
- **Speck launcher** (`test/speck-launcher.test.ts`): `npm run speck` reads Speck's port and host
  as Speck does; a Speck already on the port (a stand-in in its own process) is stopped and the
  port freed; a server on the port that is not Speck is left running and nothing starts.
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

## Security

Evidence Desk is a local, single-user tool. These are the decisions behind how it is protected,
from a security review of this repository's code (Speck is reviewed separately).

**Who can reach the API.**
- **Inside Speck**, everything under `/api/plugins` requires Speck's admin token. The plugin adds
  no login of its own and relies on that.
- **Standalone** (`npm start`), the server has no login. It listens on `127.0.0.1` by default and
  answers only its own page and local tools (`src/server.ts`, `foreignRequest`):
  - A request whose `Origin` is not the server itself is refused (403). Browsers send `Origin` on
    every cross-site POST, so another site open in the same browser cannot run, reset or change
    a case.
  - A request whose `Host` is not `localhost` or an IP address is refused (403). This stops DNS
    rebinding, where a page on a domain that re-resolves to 127.0.0.1 could otherwise read the
    case. An IP address cannot be rebound, so a server opened to the network on purpose still
    answers by its IP.
  - Setting `EVIDENCE_DESK_HOST` to a non-loopback address prints a warning at startup, because
    anyone who can reach the port can then use the case. It is not refused.
  - Tools such as curl send no `Origin` and are unaffected. `test/server.test.ts` covers each case.

**Input.**
- Request bodies are capped at 16 KB. A malformed path parameter is a 400, not a server error.
- Comparison, case and record ids are looked up among known ones, never used as file paths.
  Static files are confined to `public/`.
- The Zetaris case id is checked against `^[A-Za-z0-9_-]+$` before it goes into a SELECT; table
  and column names come from `config/zetaris-queries.json`, not from requests.
- The page builds dynamic content as text nodes; its only `innerHTML` is the static template.
- A person's own investigation has length limits on every field, dated records, and corrections
  that must name an earlier record of the same investigation.
- API keys and tokens are never returned by the API, written to reports or logged; only the
  endpoint and model name are shown.

**Accepted for now, deliberately.**
- **Error messages reach the page.** An unexpected error's message (which can include a local
  path) is shown on the page. It is kept because it is the most useful clue when something fails
  during a demo. Another site cannot read it (the `Host` check), and inside Speck only the admin
  sees it.
- **Evidence text is not delimited in the model prompt.** Record content is placed in the
  assessment prompt as plain text (`src/reasoning/nemotron.ts`, `assessmentPrompt`), so a record
  written to look like instructions or like another record could sway the model's judgments of
  its batch. The effect is bounded: judgments naming an unknown record or hypothesis are
  discarded, and Speck caps model-judged reliability at 0.4. It matters only when evidence comes
  from someone other than the person running the desk. Delimiting it changes the prompt the
  reasoning results in *Reasoning on or off* were measured with, so it waits until those can be
  re-measured (`npm run eval:reasoning`).
- **No limit on how many investigations can be created.** Inside Speck only the admin can create
  them.

## Known limits of this slice

- **The side-by-side comparison is two cases.** Six live samples each of a small local model show
  behaviour on these cases, in both directions; they are not rates and no significance is claimed.
  The difference between the columns reflects Speck's whole policy (thresholds, decisive rules,
  supersession, the 0.4 cap), not persistence alone. The bank return's evidence exists only as a
  fixture, so its live comparison uses the model but not Zetaris. Inside Speck the panel polls
  for progress (about once a second); it reports the stage and step, not a percentage.

- **Speck's chat answers are written by a local model.** The investigations component gives it
  only the published case summaries and tells it to answer from them, which removed the invented
  details seen without it, but the wording is still the model's: check it against the case page.
  The guided demo's chat step completes on any reply.
- **Live runs of a person's own investigation can stop early.** With the local model, about one
  run in three of a correction errored in testing; its records stay pending and the next run
  retries them, as the page says.

- **Project-local Speck patches.**
  - `npm run speck:patch` applies the patches in `patches/` to `speck/`'s working tree, and is
    safe to run again. The submodule therefore always shows as modified, and the patches are
    never committed there.
  - If the Speck pin moves, a patch may need updating; the command says so rather than
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
  - The tab offers two fixed cases (disputed delivery and bank return) and the user's own
    investigations. Other scenarios open only on the standalone page.
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
- **Retiring a hypothesis relies on Speck internals.** Speck (pinned at `8821789`) has no public
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
