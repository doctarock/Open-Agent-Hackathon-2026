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
| Cognition | **Speck** (`speck/`, unmodified, imported as `#speck`) | The case is a Speck worker. Hypotheses come from `proposeHypothesis`, and evidence plus relations go in through `recordEvidence`, which runs Speck's belief revision with decisive refutation and caps reliability for model-judged evidence. Ranking uses `rankHypotheses`. The released evidence stage is held with `setWorldState`, and each run's outcome is saved as episodic memory through `recordMemory`. The timeline is Speck's event log (`belief.revised`, `evidence.recorded`, …). Model calls go through Speck's model registry, which validates contracts and retries. All of this persists in one Speck SQLite database. |
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

**A decisive refutation is final.** In Speck only `superseded` is terminal: later support moves
a `rejected` hypothesis back to active. That happened live: a model judgment revived
H-DELIVERED after EV-CAR-005 had refuted it. Evidence Desk therefore withholds from Speck any
*support* for a hypothesis that a decisive counter-example has refuted, and says so in the
run's notes. Further contradictions are still recorded.

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

Each run prints a table and writes the full per-checkpoint report to `eval/results/<mode>.json`
(git-ignored).

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

**Fixture results** (`npm run eval`, deterministic):

| | speck-desk | speck-fresh | baseline-stateless |
|---|---|---|---|
| conclusion correct | 7/8 | 7/8 | 5/8 |
| valid citations | 16/16 | 16/16 | 11/11 |
| unsupported claims (of conclusions) | 0/3 | 0/3 | 1/7 |
| refuted claim kept out of current | 5/5 | 5/5 | 5/5 |
| abstained when it should | 4/4 | 4/4 | 1/4 |
| abstained when a conclusion was due | 1/4 | 1/4 | 0/4 |
| provider failure surfaced | 1/1 | 1/1 | 1/1 |

How to read these:

- **Persistence made no measurable difference.** `speck-desk` and `speck-fresh` match on every
  checkpoint. Here, replaying the same evidence in the same order gives the same beliefs. What
  separates Speck from the baseline is Speck's revision policy (thresholds, decisive refutation),
  not carried state.
- **The baseline over-commits.** It concludes on weak or partial support (missing-evidence,
  partial-support, and the first model-misreading checkpoint). The Speck systems abstain there.
- **The Speck systems over-abstain once.** After the bank return in `correction-supersedes` they
  only *point to* H-UNPAID (0.47), and the baseline concludes it correctly. Speck's own revision
  log shows the cause: the superseded record EV-BNK-101 had already taken 0.19 off H-UNPAID, and
  Speck does not undo a revision when its source is superseded. This is a real limitation of
  correction handling, not something to tune around.
- **Seven cases are too few.** They support observations about these cases, not a claim that one
  system is generally better.

**Live results** (`npm run eval:live`): one run on 2026-10-22, `nemotron-3-nano:4b` on local
Ollama (served model confirmed by the endpoint). Model judgments vary between runs, so treat this
as a single sample.

| | speck-desk | speck-fresh | baseline-stateless |
|---|---|---|---|
| conclusion correct | 5/8 | 5/8 | 3/8 |
| valid citations | 17/19 | 17/18 | 12/12 |
| unsupported claims (of conclusions) | 0/1 | 0/1 | 4/7 |
| refuted claim kept out of current | 5/5 | 5/5 | 4/5 |
| abstained when it should | 4/4 | 4/4 | 1/4 |
| abstained when a conclusion was due | 3/4 | 3/4 | 0/4 |
| provider failure surfaced | 1/1 | 1/1 | 1/1 |
| explanation agrees with Speck | 5/8 | 5/8 | n/a |
| model calls answered | 16/16 | 18/18 | 8/8 |
| model replies valid | 16/16 | 17/18 | 8/8 |
| latency ms (mean / median / max) | 2514 / 1571 / 5561 | 4076 / 2266 / 29319 | 640 / 639 / 725 |

What this run shows:

- **The Speck systems almost never over-claim but rarely conclude.** They made one conclusion
  in 8 checkpoints, and it was correct. They abstained when a conclusion was due 3 times in 4,
  because Speck caps model-judged support at reliability 0.4, so beliefs climb slowly.
- **The baseline concludes everywhere.** 4 of its 7 conclusions were unsupported, including H-LOST
  presented as current after the pickup point reported the parcel on its shelf. It was right
  about the bank return, where the Speck systems are held back by the superseded-record penalty
  described above.
- **The invalid citations were all in Speck's model explanations** (`EV- BNK-101` with a space,
  and `EV-PIP-202`). They were caught and flagged. 3 of 8 explanations disagreed with Speck's
  state and would be hidden behind a warning on the page.
- **Persistence again made no difference** between `speck-desk` and `speck-fresh`.
- **Latency is not comparable.** The baseline makes one call per checkpoint; the Speck systems
  make one per evidence chunk plus one per explanation.

## Tests

`npm test` runs 29 tests with no network access beyond localhost and no credentials:

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
- A correction does not retract the earlier record's effect. Speck keeps revisions made by
  evidence its source later superseded (see the evaluation's `correction-supersedes` case).
- Nemotron's judgments vary between runs. On identical evidence, run 1 has come out both
  *leading* (0.572) and *supported* (0.652), depending on whether the model counts the
  customer's complaint against delivery.
- A ruled-out explanation's "refuted by" list shows every record Speck counted against it, not
  only the decisive one. The timeline marks which revision was decisive.
