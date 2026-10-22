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
- **Lost judgments on a crash.** Judgments live in the run snapshot written at the end of a run. A
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
