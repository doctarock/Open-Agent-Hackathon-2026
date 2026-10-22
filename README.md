# Open-Agent-Hackathon-2026 — Speck Evidence Desk

Evidence Desk investigates a disputed delivery whose evidence conflicts and changes over time.
It shows why persistent cognition helps: when a later record contradicts an earlier claim, the
system revises what it believes, says which evidence caused the revision, and keeps the old
belief on record as refuted rather than presenting both claims side by side.

This is the first vertical slice: one scenario, one plain web page, one investigation loop.

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
            UI (public/, plain JS)  ──HTTP──  src/server.ts
                                                  │
                                    src/investigation/desk.ts (EvidenceDesk)
             ┌───────────────────────┬────────────┼─────────────────────────┐
     EvidenceProvider          Meterless Markovian      Reasoner                 Speck runtime
  fixture │ Zetaris (live)   engine (vendored, runs      rules │ Nemotron      (submodule speck/)
  src/evidence/            the investigation loop)   src/reasoning/          belief, memory, events
```

| Concern | Owner | How it is used |
|---|---|---|
| Cognition | **Speck** (`speck/`, unmodified, imported as `#speck`) | The case is a Speck worker. Hypotheses come from `proposeHypothesis`. Evidence goes into the ledger through `recordEvidence`, which caps reliability for model-judged evidence. The relations that currently take effect are applied through `reviseHypothesesFromEvidence`, which runs Speck's belief revision with decisive refutation. When invalidated evidence makes that necessary, a hypothesis is replaced and the relations are replayed (see *Revision* below). Withdrawals use `withdrawEvidence`. Ranking uses `rankHypotheses`. The released evidence stage is held with `setWorldState`, and each run's outcome is saved as episodic memory through `recordMemory`. The timeline is Speck's event log (`belief.revised`, `evidence.recorded`, …). Model calls go through Speck's model registry, which validates contracts and retries. All of this persists in one Speck SQLite database. |
| Federated evidence | **Zetaris** | `EvidenceProvider` interface with a fixture implementation and a live Zetaris adapter (`src/evidence/zetaris-provider.ts`). The adapter uses the platform's REST API (`/api/auth/login`, then `/api/proxy/query/sql/start`) with one SELECT per source table, configured in `config/zetaris-queries.json`. `EVIDENCE_MODE` selects the mode explicitly, and there is never a fallback. Every record carries its retrieval mode, table and Zetaris query token. |
| Execution | **Meterless** Markovian engine | The Apache-2.0 reference implementation, vendored unmodified at `vendor/meterless-markovian/` (pinned commit and hashes are in its `NOTICE.md`). Each run is a `Markovian.run`. The injected generator assesses one bounded batch of new evidence per chunk and ends each chunk with a `[STATE_CHECKPOINT]` carryover block, or `[TASK_COMPLETE]` on the last one. `maxChunks` caps the run. Run history goes to `data/meterless/history.json`. Progress events stream to the UI. In Nemotron mode, the reflection pass produces the model's explanation. |
| Reasoning model | **NVIDIA Nemotron** | `src/reasoning/nemotron.ts`: a model processor for any OpenAI-compatible chat endpoint, registered into Speck's model registry. The model judges how each evidence item bears on each hypothesis, and decisive rules still take precedence. Speck records model-judged evidence as `model`-provenance and caps its reliability at 0.4. The explanation's citations are checked against the real evidence ids. The model name the endpoint reports serving is recorded with every run. |

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
- **Withdrawal.** An investigator can withdraw an assessed record (for example, it belongs to
  another case) with **Withdraw** on the evidence list, or `POST /api/evidence/withdraw`.

Every current adjustment therefore traces to a record and a judgment. The page shows each one
with its basis (deterministic rule or model interpretation) and the confidence change it made.
Records that no longer count, recomputations, and earlier beliefs are shown under "Why this
changed" and marked as history, not as current reasoning. The 0.4 cap on model-judged evidence
is unchanged. A record with any model judgment is capped as a whole, so a withheld model judgment
cannot escape the cap later.

## Setup

Requires Node.js 22+ and git. From the repository root:

```bash
git submodule update --init --recursive   # speck/ at the pinned commit
npm run setup                             # npm ci here, npm ci + build in speck/
cp .env.example .env                      # optional: defaults are fixture mode, no model
npm test                                  # build + all tests (no credentials needed)
npm start                                 # http://127.0.0.1:4320
```

In the browser, use the buttons in this order:
1. **Run investigation**
2. **Introduce prepared update**
3. **Run investigation** again

Then read the conclusion panel and the revision timeline.

| Command | What it does |
|---|---|
| `npm run setup` | Install dependencies here and in `speck/`, then build Speck |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start the server (reads `.env` when present) |
| `npm run dev` | Build, then start with restart on changes in `dist/` (run `npx tsc -w` alongside) |
| `npm test` | Build and run every test in `dist/test/` |
| `npm run db:reset` | Delete Evidence Desk's Speck database and Meterless history. Stop the server first. |
| `npm run zetaris:seed` | Load the scenario's evidence into a local Zetaris platform (see below) |
| `npm run zetaris:check` | Exercise the live Zetaris path: login, probe query, case evidence |
| `npm run model:check` | One call to the Nemotron endpoint; prints the model it reports serving |

The app keeps its own database at `data/evidence-desk.sqlite`, separate from anything in
`speck/data/`. `npm run db:reset` gives a clean case.

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

Any OpenAI-compatible endpoint serving a Nemotron model works:

- **NVIDIA hosted API:** `NEMOTRON_BASE_URL=https://integrate.api.nvidia.com/v1`, a Nemotron
  model id in `NEMOTRON_MODEL`, and the key in `NEMOTRON_API_KEY`.
- **Local Ollama:** `NEMOTRON_BASE_URL=http://127.0.0.1:11434/v1`, `NEMOTRON_MODEL` set to a
  local Nemotron tag, and `NEMOTRON_REASONING_EFFORT=none`. With reasoning on, the trace uses
  up the output budget.

Run `npm run model:check` before claiming Nemotron was used. Each run also records
`servedModels`, the names the endpoint returned.

## Evaluation

```bash
npm run eval        # deterministic: no model, no credentials; same result every run
npm run eval:live   # same cases with the configured Nemotron endpoint (exits 2 if none is configured)
```

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

`npm test` runs 41 tests with no network access beyond localhost and no credentials:

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

## Known limits of this slice

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
  every judgment on that record stops counting. In `correction-supersedes`, the returned credit
  was also H-PARTIAL's only refutation (the amount matched). After the return, H-PARTIAL is back
  at its 0.20 prior and is no longer listed as ruled out. Facts that should survive a correction
  must be restated by the correcting record.
- **Supersession must be stated.** Supersession is never inferred. A ledger entry derived from a
  reversed payment ("marked paid") keeps counting unless its source says otherwise; here the
  decisive reversal still rules H-PAID out.
- **A correction of a correction reinstates the original.** If a correction is itself superseded,
  the record it replaced counts again. A source that amends an amendment and still means to
  replace the original must list both.
- **Replaced hypotheses stay in Speck's worker.** Speck has no public API to retire a hypothesis,
  so Evidence Desk marks replaced ones `superseded` through Speck's mental-object repository, as
  Speck's own `mind` component does. This change is not an event of its own; the recomputation
  memory recorded alongside it is. Any other Speck consumer reading this worker must ignore
  superseded hypotheses.
- **An interrupted run can lose judgments.** The reasoner's judgments are saved with the run
  snapshot at the end of a run. If the process dies mid-run, records already in Speck's ledger
  have no judgments and count for nothing.
- **Build 2 databases are corrected on the next run.** A database written by Build 2 is
  reconciled on the next run or withdrawal, not when it is opened. Its runs stored judgments
  after withholding, so support withheld then cannot be reinstated.
- Nemotron's judgments vary between runs. On identical evidence, run 1 has come out both
  *leading* (0.572) and *supported* (0.652), depending on whether the model counts the
  customer's complaint against delivery.
- A ruled-out explanation's "refuted by" list shows every record Speck counted against it, not
  only the decisive one. The timeline marks which revision was decisive.
