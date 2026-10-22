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
