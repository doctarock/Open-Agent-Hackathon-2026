# Build 3: reversible belief revision

Baseline: Build 2 at commit `a42f067` (tagged `build-2-baseline`). Speck submodule pinned at
`29d5bb3`, unmodified.

## The defect

Build 2's held-out case `correction-supersedes` ends with Speck only *pointing to* H-UNPAID
(0.47) after the bank returns the payment. The stateless baseline concludes it correctly.

### How the bank return flows through Build 2

1. Evidence Desk assesses each record and immediately calls `runtime.recordEvidence` with the
   record's relations (`src/investigation/desk.ts`, inside the Meterless generator).
2. Speck's `reviseHypothesis` (`speck/src/belief/revision.ts`) is incremental. Each relation moves
   the stored confidence by `±0.2 × reliability × strength`, or to the 0.05 floor for a decisive
   contradiction. It then sets a status from thresholds and saves the result on the hypothesis
   object.
3. Run 1 (before the return):
   - `EV-BNK-101` (bank credit, reliability 0.95) contradicts H-UNPAID: 0.30 → 0.11. That is at or
     below the 0.15 demotion threshold, so H-UNPAID becomes **rejected**, non-decisively.
   - `EV-BNK-101` also refutes H-PARTIAL decisively (the amount matches).
   - H-PAID reaches 0.86 (confirmed).
4. Run 2: `EV-BNK-103` (reversal) declares `supersedes: ["EV-BNK-101"]`.
   - It refutes H-PAID decisively and supports H-UNPAID: 0.11 → 0.30.
   - `EV-LDG-104` (invoice reopened) adds 0.17, so H-UNPAID ends at 0.47.
   - The 0.19 that `EV-BNK-101` removed is never restored.
5. The supersession is only *displayed*. `deriveConclusion` notes "still counted against it …
   Speck does not undo a revision already made". Nothing feeds it back into belief.

### Why the effect persists

- Speck stores the **result** of revision, not a derivation. A hypothesis's confidence is a
  running sum over every relation ever applied.
- Speck's public API has no operation that removes a relation's effect:
  - `withdrawEvidence` archives the evidence but says "belief revisions it already caused are not
    undone".
  - Nothing retires a hypothesis.
- So the defect is in how Evidence Desk uses Speck, not in Speck. Evidence Desk treated Speck's
  running sum as the current belief, even though the inputs to that sum could later become
  invalid.

The same mechanism affects:
- the development fixture (superseded `EV-CAR-003` keeps its support for H-DELIVERED in Speck's
  ledger);
- the Build 2 "no revival" guard. That guard filtered judgments *at record time* and stored only
  the filtered list. If the refuting record were later invalidated, the withheld support was
  lost for good.

The incremental rule is also order-dependent. Confidence is clamped at 1 and at the floor, and a
decisive refutation resets the value, so the same evidence arriving in a different order can
give different final beliefs.

## The fix

Current beliefs are recomputed deterministically from the evidence and judgments that are still
valid, using Speck's own revision rule. History is kept, not rewritten.

1. **Judgments are recorded as given.** Each assessed record keeps the reasoner's judgments,
   unfiltered, in the run snapshot. The evidence object goes into Speck's ledger *without*
   relations.
   - Model-judged records are still recorded with model provenance, so Speck still caps them at
     0.4. A record that has any model judgment is capped as a whole, even when some of its
     judgments are withheld for now. This prevents a withheld model judgment from ever escaping
     the cap later.
2. **Derived basis** (`src/investigation/basis.ts`, pure). From the ledger it derives:
   - **Which records are valid.** A record is invalid when it has been withdrawn, or when a
     *valid*, later-observed record says it supersedes it.
     - Records are evaluated newest first, so chains resolve deterministically: if a correction is
       itself superseded or withdrawn, the record it replaced counts again.
     - A source that amends an amendment and still means to replace the original must list both.
   - **Which judgments take effect:**
     - a valid record's judgments;
     - minus any support for a hypothesis that a valid decisive contradiction refutes. This is
       Build 2's no-revival rule, now derived rather than stored.
   - **The plan.** For each hypothesis: the effective relations in canonical order (time
     observed, then record id), not in arrival order.
3. **Reconciliation** (`EvidenceDesk.reconcile`). It runs after each assessed chunk and after a
   withdrawal. For each hypothesis key:
   - If the relations Speck has applied to the current hypothesis are a prefix of the plan, the
     remainder is appended with Speck's `reviseHypothesesFromEvidence`.
   - Otherwise the hypothesis is **replaced**:
     1. A new Speck hypothesis is proposed with the scenario prior (`data.replaces` points at the
        old one).
     2. The whole plan is replayed through `reviseHypothesesFromEvidence`.
     3. The old hypothesis is marked `superseded` in Speck. It keeps its revision history for
        audit.
     4. A recomputation record (a Speck memory) states which records stopped or started counting,
        and why.
   - Hypotheses whose plan is unchanged are left alone.
4. **Reading current state.**
   - The current hypothesis for a key is the one no other hypothesis replaces.
   - Conclusions, explanations, the "no revival" check and the state block read only current
     hypotheses.
   - Replaced hypotheses and recomputations appear in the history, labelled as no longer current.

Each step is a Speck call that writes its own event (`hypothesis.proposed`, `belief.revised`,
`memory.recorded`), so every current adjustment traces to an evidence object and a judgment.

Marking the replaced hypothesis `superseded` uses `runtime.mentalObjects.update`. Speck's own
`mind` component retires a contradicted fact the same way. No Speck code is changed. The 0.4 cap
is unchanged.

### What this deliberately does not do

- It does not subtract or compensate scores. Current values come only from a replay of valid
  inputs.
- It does not add a general truth-maintenance system. The only dependencies are the two the data
  states:
  - record → superseding record (from the source);
  - support → decisive refutation (from Build 2's policy).
- It does not infer supersession the source did not state. `EV-LDG-102` ("marked paid") stays
  valid after the bank return, because nothing says it was replaced. H-PAID stays refuted by the
  decisive reversal regardless.

### Expected consequence, stated before running

In `correction-supersedes` after the return:
- H-UNPAID should be 0.30 + 0.19 + 0.17 = 0.66, which is supported.
- H-PARTIAL loses its only refutation, because `EV-BNK-101` (amount matches) is the record the
  bank superseded. It returns to its 0.20 prior with no evidence either way. This is correct under
  record-level supersession, but it is a visible change: H-PARTIAL is no longer "ruled out".

The consequence was confirmed after implementation: H-UNPAID 0.66 supported, H-PARTIAL 0.20
proposed.

## Changes

| File | Change |
|---|---|
| `src/investigation/basis.ts` | new, pure: validity, withholding, canonical plan |
| `src/investigation/desk.ts` | evidence recorded without relations; `reconcile`, `withdrawRecord`, `currentHypotheses`, `replacedHypotheses`, `recomputations`; current views read only current hypotheses; the explanation prompt marks records that no longer count |
| `src/investigation/conclusion.ts` | each evidence reference carries its judgment and the delta it contributed; `noLongerCounted`; only counting records answer questions |
| `src/investigation/timeline.ts` | recomputation and withdrawal entries; entries about replaced hypotheses marked `historical`; judgments looked up across runs |
| `src/reasoning/nemotron.ts` | a record the model returns nothing for is left unjudged (pending), not treated as no bearing |
| `src/server.ts`, `public/` | `POST /api/evidence/withdraw`; history in `/api/investigation`; judgment effect, deltas, "Why this changed", historical timeline entries |
| `src/eval/*`, `src/scripts/eval.ts` | regression group, `withdrawBefore`, `invalidated` labels, the "invalidated evidence kept out of support" metric |

Two existing tests read Build 2 internals and were updated to keep their intent:
- "claims Speck has refuted": the raw Speck list now also holds the replaced H-DELIVERED, marked
  `superseded`.
- "no revival": withheld support is now kept as a judgment and withheld by derivation, instead of
  being discarded when recorded.

## Results

Baseline: `a42f067`, 29/29 tests. Build 3: 41/41 tests (12 new).

| Deterministic | Build 2 speck-desk | Build 3 speck-desk |
|---|---|---|
| held-out, conclusion correct | 7/8 | 8/8 |
| held-out, other checkpoints | — | identical to Build 2, all systems |
| regression, conclusion correct | 4/8 | 8/8 |
| regression, invalidated evidence kept out of support | 3/5 | 5/5 |
| unsupported conclusions, both groups | 0 | 0 |

`speck-fresh` matches `speck-desk` on every checkpoint in both builds.

Live, single samples, `nemotron-3-nano:4b` on local Ollama, both builds in the same session:
- **Held-out cases:** 5/8 for both builds, identical per checkpoint. The bank-return checkpoint
  cannot reach "supported" under the 0.4 cap: at most 0.46.
- **Regression cases:** Build 2 3/8, Build 3 4/8. Build 2 used withdrawn evidence as support at 2
  checkpoints; Build 3 at none.

Full tables are in the README.

## Remaining risks

- **Record-level supersession.** A correcting record that replaces only one fact of an earlier
  record removes all of that record's judgments (H-PARTIAL in `correction-supersedes`). The data
  model has no per-fact supersession.
- **Retiring a hypothesis outside Speck's service layer.** Speck has no public API for this, so
  the change goes through `runtime.mentalObjects.update` (Speck's `mind` component does the same).
  That write has no event of its own. If Speck later adds validation or caching around hypothesis
  status, this may need to change.
- **Lost judgments on a crash** (addressed in Build 3.1, below). Judgments live in the run snapshot written at the end of a run. A
  process crash mid-run leaves records in Speck's ledger with no judgments. They then count for
  nothing and are not reassessed.
- **Cost of a long history.** Replay cost grows with a hypothesis's history. If a history reaches
  Speck's revision-history capacity (100), it is replayed on every reconcile.
- **Replacements are permanent.** Every replacement adds a hypothesis object to the Speck worker.
  This is fine at case scale, but it is never compacted.
- **Build 2 databases are only partly corrected.** Withheld support that Build 2 discarded at
  record time cannot be recovered when a Build 2 database is reconciled.
- **The regression cases target this defect.** They were labelled before the fix and before any
  run, but they were designed around this defect. They show the defect is fixed, not that
  Evidence Desk is better in general. Persistence still shows no measurable benefit over
  from-scratch evaluation.

## Build 3.1: validation and recovery

### Browser verification

- **Setup.**
  - Headless Chrome 155, driven over the Chrome DevTools Protocol.
  - The page was the real `createServer` output on scratch storage, using fixture evidence and
    the rule reasoner.
  - No browser extension or built-in browser pane was available in this session.
- **Checked:**
  - two runs and the pending banner between them;
  - withdrawing `EV-SUP-006` with the Withdraw button and prompt (supported 0.70 → leading 0.58);
  - "Why this changed";
  - historical timeline entries;
  - a reload after a full server restart, compared with `/api/investigation` and with the Speck
    database read by a bare `SpeckRuntime`;
  - the pending, failed and completed states after an interrupted run and a failed assessment.
- **Found and fixed:**
  - The conclusion panel passed `null` and arrays to `replaceChildren`. It printed a literal
    "null" under the status line and "[object HTMLHeadingElement],[object HTMLUListElement]" in
    place of answered questions. This had been present since Build 2.
  - Long banner badges did not wrap and ran past the panel edge. This had been present since
    Build 2.
  - After an interrupted first run, the panel said "No investigation has been run yet", although
    Speck held reconciled beliefs.
  - Records judged in an interrupted run were labelled "Weighed in run null".
- **Seen, not changed:** a withdrawal adds withdrawal and recomputation entries to the timeline,
  but no conclusion-change entry. The current conclusion is in the panel; the last
  *conclusion* entry in the timeline is still the last run's.

### Crash recovery

A probe interrupted run 1 mid-chunk, after some evidence was recorded but before the snapshot was
saved. Build 3.0 lost the judgments of every record already in the ledger. The rerun then rebuilt
H-NOT-SHIPPED **without its decisive refutation by EV-WMS-002** (back to 0.15, proposed), and
H-DELIVERED without EV-CAR-003. Nothing flagged it.

The fix:
- Judgments are saved per chunk, as an `evidence-desk.assessment.v1` memory, before that chunk's
  evidence is recorded. Failed attempts are saved with their error.
- The ledger is read from Speck's evidence objects joined with those saved judgments.
- Reconciliation also runs on open, at the start of each run, and at the end of a run whose chunk
  failed.
- Appends of records already in the ledger are written into the recomputation record as
  `extended` entries, with a cause: "counts again", or "applied after an interrupted run".
  Before this, a reinstated relation that only needed appending left no record of why.
- `beliefsReconciled()` marks a conclusion that lags the ledger.
- The probe now ends identical to an uninterrupted run.

### Speck compatibility

The write is isolated in `src/investigation/speck-compat.ts` and verified by reading it back.
There is no public alternative:
- `archiveSharedMemory` refuses worker objects;
- the belief service changes hypothesis status only through revision.

### Remaining risks after 3.1

- **Recomputation records describe intent, not completion.** If applying a recomputation is
  interrupted, a later repair record follows it.
- **Attempt ordering uses timestamps.** The order of assessment attempts for one record depends on
  their millisecond timestamps. Two attempts for the same record cannot share a run, so a tie
  would need two runs within one millisecond.
- **The rest is unchanged from Build 3:**
  - record-level supersession;
  - reliance on Speck's repository write, now guarded;
  - replacements that are never compacted;
  - targeted regression cases.

### Build 3.1 results

- **Tests:** 50/50, run three times in a row. Build 3 had 41.
  - 9 tests are new: 4 for recovery, 3 for Speck compatibility, 2 for correction chains.
  - One flaky ordering was found and fixed. Replaced hypotheses created in the same millisecond
    tie-broke on random ids, so `replacedHypotheses()` now sorts by recomputation, then key.
- **Deterministic evaluation:** identical to Build 3 in both groups (held-out 8/8, regression
  8/8).
- **Live evaluation:** one sample, `nemotron-3-nano:4b` on local Ollama, 2026-10-22; the endpoint
  confirmed the served model.
  - **Held-out cases:** speck-desk and speck-fresh 5/8 each, the same per checkpoint as the
    Build 3 sample.
  - **Regression cases:** speck-desk 4/8, speck-fresh 3/8. speck-fresh abstained at
    `return-cancelled@credit`, which is model variance in one sample, not an effect of
    persistence.
  - **Invalidated evidence kept out of support:** 5/5 for both Speck systems.
  - **Unsupported conclusions:** 0 for both Speck systems.
  - **Invalid citations:** two (`EV-EDSP-501`, `EV-RECV-502`), both in a model explanation, both
    flagged.

## Release-candidate audit

### Findings

1. **Recomputation interrupted between recording and applying.**
   - **What failed:** An exhaustive fault-injection test, killing the process at every Speck write
     and again during recovery, found one real defect. Replacements were proposed *before* their
     recomputation record was written. A crash in between left a replacement pointing at a
     version that was never recorded, and the next recomputation then reused that number.
   - **The fix:** The record is written first. Whether each replacement was carried out is
     derived when reading.
   - **Verified:** Run 2 has 23 crash points and the withdrawal has 16. For each, with recovery
     itself interrupted in 5 patterns, the final beliefs equal the uninterrupted ones and the
     history is consistent.
2. **Withdrawal after a failed assessment.**
   - **What failed:** A probe showed that one record whose assessment always fails stalls the
     case for good. Every run fails on the same chunk, so later records are never assessed.
   - **The fix:** Records not in Speck's ledger can now be withdrawn before assessment. Nothing is
     judged for them, beliefs are unchanged, and they supersede nothing (an
     `evidence-desk.exclusion.v1` memory).
3. **Whole-record replacement.**
   - **The gap:** Replacing a record removed facts the correction never addressed, and the only
     explanation shown was "superseded by".
   - **The fix:** Each record that no longer counts now lists:
     - the facts no counting record restates;
     - the judgments that stopped applying;
     - consequences such as "H-PARTIAL is no longer ruled out".

     These also appear in the conclusion notes and under "Why this changed".
4. **Superseded beliefs in rankings.**
   - **Audit:** Every read of hypothesis objects goes through `currentHypotheses`,
     `rankedCurrent` or `allHypotheses`, or through the timeline, which marks replaced
     hypotheses as history. Nothing reads Speck's `worker.beliefs`.
   - **Test:** A test covers each presenting path with a superseded hypothesis ranked first by
     Speck.
   - **Outcome:** No defect was found.

### Tested guarantees and assumptions

**Tested guarantees.** These hold on the fixture scenarios and the fault model in the tests:
- **Interruption:** an interrupted run or withdrawal, including interrupted recovery, ends with
  the uninterrupted beliefs.
- **Retries:** no record enters the ledger twice, and retries are idempotent.
- **Explained history:** every replacement is explained by its recomputation record.
- **Current beliefs:** only current hypotheses are presented as current.
- **No invented judgments:** no judgment is ever invented for a failed or withdrawn record.
- **The cap:** the 0.4 cap applies to every record with any model judgment.

**Assumptions** (not tested here):
- **The fault model is approximate.** It models a crash as every later Speck write failing. Real
  power loss could also interrupt SQLite itself; Speck's transactions are relied on for that.
- **The Speck repository write is pinned to `29d5bb3`.** The write is guarded by a
  read-back check, but a different Speck version could break it.
- **Timestamps order assessment attempts.** Ordering of attempts for one record relies on their
  timestamps. Two attempts for the same record cannot share a run, so a tie would need two runs
  within one millisecond.
- **Live behaviour was sampled, not established.** It rests on single samples of a small local
  model.

## Sponsor verification and demo readiness

- **`npm run sponsors:verify`** (`src/scripts/sponsor-check.ts`) runs a real two-stage
  investigation with the services in `.env`, on throwaway storage. It checks each sponsor's
  contribution against an independent source:
  - **Zetaris:** each record's own query token.
  - **Meterless:** the engine's `history.json`.
  - **Nemotron:** the model name the endpoint reported, and Speck's model-provenance evidence
    under the 0.4 cap.
  - **Speck:** its raw event log.

  On 2026-10-22, with the local Zetaris platform and Ollama (`nemotron-3-nano:4b`), all four
  were OBSERVED. With fixture evidence and the rule assessor, Zetaris and Nemotron are reported
  NOT OBSERVED and the command exits 1.
- **Found while verifying:** the Meterless engine numbers runs with a per-process counter
  (`run-${++runSeq}`), so `run-1` recurs after every restart. "Present in the engine's
  history.json", matched by id alone, could match another process's run.
  - The fix: the run snapshot now keeps the engine's own timestamp, and runs are matched by id
    and timestamp.
  - Runs saved before that fall back to id plus identical chunk contents.
  - A test plants a decoy entry with the same id and checks it is not accepted.
- **Demo:**
  - `DEMO.md` was rehearsed end to end with its exact commands (separate data directories per
    server, so the two servers never share a database or Meterless history file) in headless
    Chrome.
  - The bank-return tab matched the script; the live tab took about 12 s and 8 s per run.
  - The live conclusion after the update varied between samples, so the script does not
    predict it.

## Migration into Speck as a plugin

Evidence Desk had its own server and page beside Speck. It now runs inside Speck as a Genesis
plugin. At first Speck's code was not changed; the next section describes the one later change.
The standalone server remains as a fallback.

- **Packaging.**
  - `plugin/evidence-desk-plugin.ts` is the plugin entry. It declares an **Evidence** tab and
    routes under `/api/plugins/evidence-desk/cases/:caseId/...`, and uses the Speck runtime
    that Speck hands to plugins (`runtimeContext: ["speck"]`).
  - `npm run plugin:install` copies the compiled plugin and the cases' data into
    `speck/plugins/evidence-desk/`, the only place Speck loads plugins from. It points each
    `#speck` import at Speck's own `dist/index.js`, so the plugin shares Speck's module
    instances. It then adds the entry module's hash to Speck's allowlist
    (`plugins/.runtime/plugin-trust.json`).
  - The page (`public/app.js`) became a mountable component, `mountEvidenceDesk(root, options)`,
    used by both the standalone page and the tab. Its styles are scoped under `.edk` and use
    Speck's palette inside Speck.
  - The HTTP handlers moved into `src/investigation/api.ts`, shared by both servers.
- **Two cases, fixed.** Disputed delivery (settings from the plugin's `.env`) and bank return
  (always fixture evidence and the rule assessor). Each keeps its own Meterless history.
- **Hazards found by running inside Speck, and how they are handled.**
  - *The case worker blocked Speck.* Speck's background cognition runs only when no worker is
    `created`, `ready` or in progress. A new case worker stayed `created`, so background
    cognition stopped for every worker. Cases now move their worker to `waiting`, which Speck's
    state machine allows.
  - *Background embeddings could overwrite a revision.* Speck's embedding job reads a worker's
    objects, waits for the embeddings, then writes the objects back whole.
    `test/speck-compat.test.ts` holds that job open and shows a revision made meanwhile going
    from 0.7 back to 0.5. Every change to a case now takes Speck's foreground lease and waits
    for any background job already running. The same test then shows a slice in flight losing
    nothing, a slice started during a run being deferred, and beliefs equal to an isolated run's.
  - *The model would have joined Speck's registry.* Registering the Nemotron processor in
    Speck's shared `ModelRegistry` would have exposed it to Speck's own work, and a second case
    would have failed on the duplicate id. The adapter now uses a private registry, still
    validated by Speck's contract.
  - *Trust.* Speck loads only allowlisted plugins. The installer adds the entry's hash; this was
    the user's choice over asking Speck's operator to approve it by hand.
- **Verified inside Speck** (headless Chrome, scratch Speck database):
  - the Evidence tab appears in Speck's rail;
  - bank return: H-PAID supported, then after the update H-UNPAID supported at 0.66, with
    "Why this changed";
  - disputed delivery, live: Zetaris, then Meterless, then `nemotron-3-nano:4b`, then Speck, in
    about 15 s;
  - Speck's World view shows the case events, and its Task queue shows the cases waiting
    (Queued 0, Waiting 2);
  - Speck's background embeddings then ran over both case workers, and the beliefs stayed
    identical over 65 s.
- **Tests:** 67 (`test/plugin.test.ts` added; two race tests added to
  `test/speck-compat.test.ts`). The evaluation is unchanged.
- **Limits.** Speck's allowlist hashes only the entry module. Code changes need a reinstall and
  a Speck restart. Installing leaves the Speck submodule with a modified trust file and an
  untracked plugin folder. The tab has two fixed cases and no live progress stream.

### Evidence Desk as Speck's main interface

The "do not modify Speck" rule was loosened so that Evidence Desk could be the interface Speck
opens on. The change to Speck is general, not specific to Evidence Desk:

- `SPECK_HOME_VIEW` (`src/config.ts`, default `world`) names the view the interface opens on and
  returns to: `world`, a panel, or a plugin tab as `plugin:<pluginId>:<tabId>`.
- `GET /api/ui/settings` returns it (`src/genesis-host.ts`).
- The page opens it once the plugin list is loaded. The brand button and panel close return to
  it. A plugin tab named there is placed first in the rail, above World. If that plugin is not
  loaded, the page stays on World.
- Speck's `src/tests/genesis-host.test.ts` checks the default and the override. Speck's README
  documents the setting.

`npm run speck` now starts Speck through `src/scripts/speck.ts`, which sets
`SPECK_HOME_VIEW=plugin:evidence-desk:evidence` unless the environment sets it.

- **Found while doing this:** two of Speck's own tests copy its `plugins/` folder elsewhere and
  load every plugin there. The installed plugin imported Speck by relative path, so it failed to
  load in the copy. The installer now writes an absolute file URL instead.
- **Verified:**
  - Speck's suite: 231/231. Evidence Desk's: 67/67.
  - In headless Chrome, Speck opened on Evidence, first in the rail, with the case picker.
    World and Queue still opened, and the brand button and panel close returned to Evidence.
  - With `SPECK_HOME_VIEW=world`, Speck opened on World with its original rail order.

#### Kept out of Speck's repository

The Speck change is for this project only, so it is not committed to Speck.
- It is kept here as `patches/speck-home-view.patch`.
- `npm run speck:patch` applies it to the submodule's working tree (`scripts/speck-patches.mjs`).
  It is safe to run again, and refuses with a clear message if the patch no longer applies.
- `npm run setup` runs it before building Speck. The submodule stays pinned to upstream
  `29d5bb3`.
- The patch applies cleanly to a fresh `29d5bb3` checkout. `test/speck-patch.test.ts` checks
  that it is in the working tree and touches only the files of this change.

#### Speck's other plugins removed

Speck's bundled demonstration plugins (Social Media Manager, AirChat, Information Agent) were
removed for the Evidence Desk demonstration, together with the two Speck tests dedicated to them
(`ported-plugins.test.ts`, `social-media-manager.test.ts`).
- Kept as `patches/speck-remove-plugins.patch`, applied by `npm run speck:patch` and by setup.
- Nothing else in Speck imports them; Speck's benchmark prompts name their tools only as text.
- Speck's suite then passes 226/226, which is 231 less the 5 removed tests.
- Both patches apply cleanly to a fresh `29d5bb3` checkout.
