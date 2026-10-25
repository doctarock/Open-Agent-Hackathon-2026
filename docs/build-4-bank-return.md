# Build 4: why Speck failed the bank return live, and what changed

Baseline: Build 3.x at commit `fbed6e7`. Speck submodule pinned at `8821789`, cognition unmodified.

Sections 1 to 3 were written and committed **before** the change was implemented or any system
was run on the new challenge cases. Section 4 onwards was written after.

## 1. The failure

Side-by-side comparison, bank return (`eval/scenarios/correction-supersedes`), local
`nemotron-3-nano:4b` (Q4_K_M, Ollama, reasoning off, temperature 0.1), six live samples on
2026-10-23 (`eval/results/comparisons/eval-correction-supersedes/`):

| After the bank return (label: H-UNPAID) | Stateless model call | Speck |
|---|---|---|
| matches the label | 5/6 | 0/6 |
| outcome | H-UNPAID 5, unresolved 1 | unresolved 6 (pointing to H-UNPAID at 0.364-0.38) |

Deterministic runs (fact rules, no model) reach H-UNPAID supported at 0.66 every time.

## 2. Trace of one live sample

`2026-10-23T08-49-41-771Z-b92a9bde.json`, after the return. All six live samples have the same
structure; only the strengths differ (0.9-1.0).

| Step | What happens | Effect on H-UNPAID |
|---|---|---|
| Source records | Fixture file (this case has no Zetaris tables). `EV-BNK-103` (bank: payment returned, `supersedes: [EV-BNK-101]`), `EV-LDG-104` (ledger: invoice reopened, `ledger.status=reopened`). `EV-LDG-102` (ledger: marked paid, `ledger.status=paid`) is still visible and declares nothing. | |
| Intake / validity | `EV-BNK-101` stops counting (declared supersession). `EV-LDG-102` keeps counting: supersession must be declared, and the ledger did not declare it. | |
| Assessment | Decisive rule: `payment.reversed=true` refutes H-PAID. The model judges every other pair. In 6/6 samples it judged `EV-BNK-103` and `EV-LDG-104` as supporting H-UNPAID, and `EV-LDG-102` as contradicting it. **The model's reading was right every time.** | |
| Recording | Each record carries model judgments, so it enters Speck as the model's. Speck caps its reliability at 0.4 (`beliefRevision.modelReliabilityCeiling`). | |
| Hypothesis rebuild | H-UNPAID is rebuilt from its prior 0.30 with the relations that still count. | 0.30 |
| Belief revision | `EV-BNK-103` supports: 0.2 × 0.4 × 1.0 | +0.08 |
| | `EV-LDG-104` supports | +0.08 |
| | `EV-LDG-102` contradicts | -0.08 |
| Result | H-UNPAID **0.38, active**. H-PAID rejected (decisive). H-PARTIAL rejected (0.05). | 0.38 |
| Judgment | "Supported" needs Speck's supported status, i.e. confidence ≥ 0.6. | unresolved |

### Root cause

Two defects, both in Evidence Desk, neither in Speck and neither in the model:

1. **The conclusion was unreachable by construction.** With every non-decisive judgment made by
   the model and capped at 0.4, each record moves a belief by at most 0.08. From a prior of 0.30,
   reaching 0.6 needs four unanimous, full-strength supporting records and nothing against.
   This case has two. *No model output could have produced a conclusion*: the abstention was
   not a judgment about the evidence. The same arithmetic is why stage 1 succeeded: H-PAID
   started at 0.5 and needed only two records. In live mode the author's prior, not the evidence,
   decided whether Speck could conclude. At that point Speck had already ruled out every other
   explanation and held H-UNPAID as the only one standing, supported by two different sources.
2. **Speck relied on an obsolete record.** `EV-LDG-102` ("marked paid") still counted against
   H-UNPAID after the same ledger reported the invoice `reopened` (`EV-LDG-104`). The ledger's
   current status is "reopened"; its earlier status no longer describes anything. Because the
   ledger did not declare a replacement, the Build 3 policy (only declared supersession counts)
   kept it. This is the failure Speck is meant to avoid: relying on evidence its own source has
   since changed.

**Why the baseline succeeds:** it reads all four records in one call and answers from their
text. It has no cap, no prior and no threshold, so two clear records are enough. It treated the
earlier "marked paid" as history, as a person would.

**What it is not:** not the threshold (0.6 is Speck's), not the cap (Speck's, deliberately kept),
not the model's interpretation (correct in 6/6), not a stale hypothesis (Build 3 rebuilds them),
and not the evidence caps on the comparison's side.

A third defect was found while checking the second fix against other suites, and is fixed
because the second fix would otherwise make it worse:

3. **A declared replacement was ignored when the replaced record has a later timestamp.**
   `basis.ts` evaluated records newest first and ignored "a claim about a later record". In the
   cross-domain `*-late-original` cases, a backfilled record is stamped later than the
   correction that names it, so the correction was ignored and the replaced record kept counting
   (cross-domain "same records, different orders: identical and correct": 0/2). An id named in
   `supersedes` is unambiguous whatever the timestamps. Fixing this after seeing that result
   means the cross-domain suite is **no longer independent** for this behaviour.

## 3. The change (pre-registered)

No threshold, prior, cap or Speck code changes. The stateless baseline and the comparison rules
are unchanged.

### 3a. Validity: a source's newer value replaces its older one (`src/investigation/basis.ts`)

A record stops counting, as **restated**, when:
- every fact it reports is reported again by a later-observed record from the **same source
  system** that still counts, and
- at least one of those values differs.

Rules that keep it narrow:
- Facts are the source's own structured fields, never inferred from text or by the model.
- Different systems never restate each other (a cycle count does not replace a warehouse figure).
- Same value restated: the older record keeps counting (nothing changed).
- A record with some facts restated and others not keeps counting (record-level, as supersession is).
- Strictly later observation time; equal timestamps restate nothing.
- Declared supersession and withdrawals are resolved first. A record that a valid record
  declares replaced cannot restate anything, and a record cannot be restated by a record that it
  itself declares replaced.
- Records without facts (most user cases) are never restated.

Declared supersession is resolved independently of timestamps: a record is replaced when any
record that still counts names it in `supersedes`. Chains resolve as before (a withdrawn or
replaced correction replaces nothing, so the record it named counts again). In a cycle of
declarations, claims made by an older record against a newer one are ignored, as before.

This is an **evidence-policy change**: Build 3 said "supersession must be stated, never
inferred". It now says: replacement is stated by the source, either by naming the record, or by
the same system reporting a newer value for every fact the old record reported.

### 3b. Conclusion: corroborated by independent sources (`src/investigation/conclusion.ts`)

Rule `corroborated-1`. When Speck holds no explanation as supported, Evidence Desk concludes the
top explanation H when **all** hold:
1. H is Speck's top-ranked current explanation (not rejected or superseded);
2. at least two records that still count support H, from at least two different source systems;
3. no record that still counts is recorded against H;
4. every other current explanation that Speck has not ruled out has no supporting record that
   still counts.

The conclusion is reported as reached by corroboration, with Speck's own confidence and status
shown unchanged beside it ("Speck's confidence 0.46 is below its 0.6 threshold; ..."). Speck's
belief state is not written to.

Why this is not a lowered threshold: it uses no confidence value. It asks whether the evidence
is independent, unanimous and unopposed, and whether every rival is either ruled out by Speck or
unsupported. A single record, however strong, never satisfies it; any counting record against
the explanation, or any support for a rival, blocks it. It applies to rule-judged and
model-judged evidence alike.

### Predictions, stated before running

- Bank return, deterministic: unchanged (H-PAID supported 0.86, then H-UNPAID supported 0.66).
  `EV-LDG-102` is listed as no longer counting after the return.
- Bank return, live: if the model judges as it did in the six saved samples, H-UNPAID is
  concluded by corroboration after the return. The model can still prevent it, for example by
  judging a record as supporting H-PARTIAL.
- Cross-domain `*-late-original`: the replaced record no longer counts.
- Abstentions that are labelled correct must stay abstentions. If any becomes a conclusion,
  that is reported as an unsupported conclusion and is not tuned away.

---

*Everything below was written after the change was implemented and the runs below were made.*

## 4. What was implemented, including what differs from section 3

| File | Change |
|---|---|
| `src/investigation/basis.ts` | `deriveValidity`: declared replacement resolved whatever the timestamps (in a cycle, the older record's claim is ignored); restatement as in 3a; new invalidation kind `restated` |
| `src/investigation/conclusion.ts` | rule `corroborated-1`; `justification.route` (`speck-threshold` or `corroboration`) and `justification.corroboration` (records, systems, what is missing); `withholdForPending` (section 6) |
| `src/investigation/case-state.ts`, `run.ts` | apply `withholdForPending` to the page's conclusion and to each run's saved conclusion |
| `src/compare/comparison.ts`, `evaluation.ts`, `src/scripts/compare-summary.ts` | see section 7 |
| `src/eval/*`, `src/scripts/eval-challenge.ts` | the challenge suite runner; the route recorded per checkpoint; `(c)` marks a corroborated conclusion in printed reports |
| `public/app.js`, `public/compare.js`, `public/style.css` | the route, Speck's reasons, out-of-date records and "why they differ" shown on the page |
| `src/investigation/publish.ts`, `src/scripts/investigate.ts` | `restated` described in the published summary; `route` in the CLI output |
| tests | 10 new (`test/build4.test.ts`, and assertions in the comparison test); 7 existing tests updated where they encoded the old policy, each with a comment saying why |

Two clarifications were made while implementing, before any evaluation suite was run on the
new code. Both narrow the rules; neither was chosen from evaluation results:
- **A correction is never restated.** A record that itself names records it replaces is replaced
  only by being named or withdrawn. Restating it would silently undo the replacement it
  declared. (Found while reading the cross-domain records for restatement candidates.)
- **Corroboration is blocked by every contradiction Speck has recorded**, not only those from
  records that still count. Once beliefs are reconciled this is the same rule; before that, a
  contradiction Speck still applies must not be argued away. (Found when an existing unit test,
  which models an un-reconciled state, started concluding.)

Not changed: Speck's code and its pinned commit, the 0.4 cap, the 0.6 threshold, any prior, the
stateless baseline, the comparison's scoring rules, any case file or label.

## 5. Results

**Kinds of result.** *Deterministic*: fixture evidence and fact rules, no model, identical on
every run. *Live*: the local `nemotron-3-nano:4b` (Q4_K_M, Ollama 0.40.6, reasoning off,
temperature 0.1, 4,096-token output cap), each repeat a separate sample. Before and after were
run on 2026-10-25 with the same command, settings and machine, back to back: Build 3 at
`fbed6e7`, then Build 4. Counts are over these cases only and are not general accuracy rates.

### 5a. The bank return, side by side (6 live samples per build)

`eval/results/comparisons/eval-correction-supersedes/`, summarised in
`eval/results/comparisons/SUMMARY.md`. The six Build 3 samples of 2026-10-23 are also listed.

| | Build 3, 2026-10-23 | Build 3, 2026-10-25 | Build 4, 2026-10-25 |
|---|---|---|---|
| Before the return (label H-PAID): Speck matches | 6/6 | 6/6 | 6/6 |
| ... stateless matches | 3/6 (3 unsupported "unpaid") | 0/6 (6 unsupported "unpaid") | 0/6 (6 unsupported "unpaid") |
| After the return (label H-UNPAID): Speck matches | **0/6** | **0/6** | **6/6**, all by corroboration (Speck's own confidence 0.44-0.46) |
| ... stateless matches | 5/6 (1 unresolved) | 6/6 | 5/6 (1 unresolved) |
| ... Speck counts the ledger's old "paid" against "unpaid" | 6/6 | 6/6 | 0/6 |
| ... either side cites a replaced or out-of-date record | 0/6 | 0/6 | 0/6 |

This case is no longer an independent test: the change was designed on it.

### 5b. Live evaluation, held-out and regression cases (3 repeats; 48 labelled checkpoint-samples per system)

`eval/results/experiments/reasoning/2026-10-25-build3-before/` and `.../2026-10-25-build4-after/`.

| | Speck, Build 3 | Speck, Build 4 | Stateless, run beside Build 3 | Stateless, run beside Build 4 |
|---|---|---|---|---|
| Conclusion matches the label | 27/48 (56%) | 40/48 (83%) | 20/48 (42%) | 18/48 (38%) |
| Abstained when a conclusion was due | 21/30 (70%) | 5/30 (17%) | 0/30 | 0/30 |
| Abstained when it should | 18/18 | 15/18 | 3/18 | 3/18 |
| Unsupported conclusions | 0/9 | **3/28** | 19/45 | 21/45 |
| Refuted explanation kept out of current | 27/27 | 27/27 | 20/27 | 18/27 |
| Withdrawn or replaced evidence kept out of support | 15/15 | 15/15 | 10/15 | 9/15 |
| Model replies valid (Speck's registry, after retries) | 93/94 | 93/96 | 48/48 | 48/48 |

The baseline's code is the same in both columns; its difference is sampling variation. The 48
include the provider-failure case (3 per system), which every system handles correctly.

Per checkpoint (Speck, 3 samples each, Build 3 → Build 4):

| Checkpoint | Label | Build 3 | Build 4 |
|---|---|---|---|
| correction-supersedes @ after-return | H-UNPAID | abstain 3 | H-UNPAID (c) 3 |
| ghost-citation @ records | H-REFUNDED | abstain 3 | H-REFUNDED (c) 3 |
| model-misreading @ pickup-report | H-AWAITING | abstain 3 | H-AWAITING (c) 2, abstain 1 |
| return-cancelled @ return | H-UNPAID | abstain 3 | H-UNPAID (c) 3 |
| withdrawn-scan @ scans | H-RECEIVED | abstain 3 | H-RECEIVED (c) 3 |
| misattributed-scan @ correction | H-IN-DEPOT | abstain 3 | H-IN-DEPOT (c) 2, abstain 1 |
| **missing-evidence @ claim** | **abstain** | **abstain 3** | **H-DEFECT (c) 3: unsupported** |
| misattributed-scan @ scan | H-DELIVERED | abstain 3 | abstain 3 |
| every other checkpoint | | unchanged | unchanged |

(c) = concluded by corroboration.

**The new failure.** `missing-evidence` has two records: the customer's fault report and "unit
received at the service centre, inspection scheduled". The model judged both as supporting
"manufacturing defect", from two source systems, with nothing against and both rivals
unsupported, so `corroborated-1` concluded it three times in three. A careful investigator
would not: neither record establishes a cause. The rule counts *that* two sources agree, not
*how strongly*; a weak model judgment counts as much as a strong one. The rule was not changed
after this was seen (the case is held out), and the failure is reported as it is.

The other held-out cases were not used to design the change, but their files had been read
during earlier builds: they are evidence of behaviour, not a clean test.

### 5c. Challenge cases, written and locked before any system ran on them (`eval/challenge/`)

Live, 3 repeats, 30 checkpoint-samples per system
(`eval/results/experiments/challenge/2026-10-25-build3-before/` and `.../2026-10-25-build4-after/`):

| | Speck, Build 3 | Speck, Build 4 | Stateless (run beside each) |
|---|---|---|---|
| Conclusion matches the label | 18/30 | **18/30** | 18/30, 18/30 |
| Abstained when a conclusion was due | 12/18 | 8/18 | 0/18 |
| Abstained when it should | 12/12 | 9/12 | 0/12 |
| Unsupported conclusions (the labels' lists) | 0/6 | 1/13 | 0/30 |

Per checkpoint (3 samples each):

| Checkpoint | Label | Speck, Build 3 | Speck, Build 4 | Stateless |
|---|---|---|---|---|
| payroll @ paid | H-PAID | abstain 3 | H-PAID (c) 3 | H-PAID 3 |
| payroll @ returned | H-NOT-PAID | abstain 3 | abstain 3 | H-NOT-PAID 3 |
| customs @ conflict | abstain | abstain 3 | abstain 3 | H-HELD 3 |
| customs @ inspection-done | H-RELEASED | abstain 3 | abstain 3 | H-RELEASED 3 |
| claim @ recommendation | abstain | abstain 3 | **H-APPROVED (c) 3** | H-APPROVED 3 |
| claim @ decision | H-DECLINED | abstain 3 | abstain 2, **H-APPROVED (c) 1** (section 6) | H-DECLINED 3 |
| refund @ settled | H-RECEIVED | H-RECEIVED 3 | H-RECEIVED 3 | H-RECEIVED 3 |
| refund @ settlement-withdrawn | abstain | abstain 3 | abstain 3 | H-NOT-RECEIVED 3 |
| stock @ first-count | abstain | abstain 3 | abstain 3 | H-ENOUGH 3 |
| stock @ recount | H-ENOUGH | H-ENOUGH 3 | H-ENOUGH 3 | H-ENOUGH 3 |

**On cases it was not designed on, Build 4 is no better than Build 3: 18/30 both.** It gained
the payroll "paid" stage (equal priors of 0.33 made Speck's threshold unreachable for model
evidence) and lost the claim "recommendation" stage, the same weakness as `missing-evidence`: a
recommendation and the customer's expectation, two sources agreeing on something neither
establishes. The baseline also scored 18/30, with the opposite error profile: it never abstained,
so it was wrong at every checkpoint where abstaining was right (12/12), and right at three where
Speck abstained (the payroll return, the hold lifted by the agency that requested it, the single
authoritative claim decision).

Deterministic (fact rules, no model), Build 3 → Build 4: 6/10 → 7/10 (the payroll return is now
concluded: payroll's "paid" status no longer counts once payroll reports "unpaid"); the stateless
rule baseline 5/10 in both. Speck's deterministic misses: it concludes H-HELD on the customs
conflict and H-NOT-RECEIVED after the withdrawal (both through Speck's own threshold, both before
Build 4 too), and abstains on the single claim decision.

### 5d. Deterministic suites (`npm run eval`, `npm run eval:cross-domain`)

| | Build 3 | Build 4 |
|---|---|---|
| Held-out, Speck | 8/8, 0 unsupported | 8/8, 0 unsupported (unchanged per checkpoint) |
| Regression, Speck | 8/8 | 8/8 (unchanged per checkpoint) |
| Cross-domain, Speck: correct | 15/27 | 19/27 |
| ... abstained when a conclusion was due | 11/22 | 8/22 |
| ... abstained when it should | 5/5 | 5/5 |
| ... unsupported conclusions | 1/11 | 0/14 |
| ... invalidated record still bearing on a current belief | 4/14 | 1/14 |
| ... same records in a different order: correct and identical | 0/2 | 2/2 |
| Cross-domain, stateless rule baseline | 17/27 | 17/27 |

Cross-domain changes: both `*-late-original` cases (the named replacement now holds), two
checkpoints concluded by corroboration (`payment-amount-correction-chain @ first-correction`,
`procurement-price-amendment @ contract-check`), both matching their labels, and the
`payment-unreadable-record` change described in section 6. The late-original fix was made after
seeing the earlier result, so the cross-domain suite is no longer independent for arrival order.

## 6. A failure mode found in the live runs, and the guard added for it

In 4 live samples (3 delivery comparisons, two under Build 3 and one under Build 4, and 1
challenge checkpoint under Build 4) the model's reply for newly arrived records failed Speck's contract twice, so those
records stayed unassessed. Speck's state still held the conclusion it had before them, and the
page and the reports presented it as current: "delivered" resting on the scan the carrier had
replaced, and "approved" after the claims system had declined.

`withholdForPending` (in `conclusion.ts`, applied by the desk and to each run's saved conclusion):
while records the last run could not assess are still waiting (neither assessed nor withdrawn), no
conclusion is presented as firm. The headline says which records are waiting and what the
evidence pointed to before them. Speck's belief state is not changed; the next run assesses the
records. Test: `test/build4.test.ts`, "failure: while the correction cannot be assessed ...".

This guard was added **after** the live runs in section 5. By hand, it changes exactly one
reported checkpoint-sample (claim @ decision, Build 4, repeat 1: "approved" becomes an
abstention, still not the labelled "declined", and no longer an unsupported conclusion) and the
three delivery comparisons, which the summaries already count as errors. In the deterministic
cross-domain suite it turns three unsupported "paid" conclusions, made while the bank's return
was unreadable (`payment-unreadable-record`), into abstentions (the 0/14 above).

A deeper fix is not made here: a source's declared replacement could take effect as soon as the
replacing record is visible, without waiting for the model. That changes how unassessed records
enter the evidence ledger and needs its own design.

## 7. The comparison, made more explanatory (rules unchanged)

Its definitions and scoring are as before; the new fields add information for both sides alike:
- each record: `outdatedBy`, when its source later reported a new value for every fact in it;
- each side: `supportFromOutdated` beside the existing `supportFromReplaced`;
- Speck: `route`, Speck's own `reasons`, and its model calls, failures and served models;
- labels: `abstention`, appropriate or inappropriate;
- each stage: `disagreement`, why the two differ, derived from what each returned;
- `configuration.policy`, included in the fingerprint, so samples from different builds are never
  counted together. Reports saved before Build 4 have no policy and are counted as Build 3.

`npm run compare:summary` writes `eval/results/comparisons/SUMMARY.md`: every saved comparison,
grouped by case, policy, evidence and model, with count/samples and percentage per stage (matches
label, unsupported, abstained when due or rightly, followed a labelled change, relied on a
replaced or out-of-date record, recorded why, by corroboration, errors), and every sample listed
with the models the endpoint reported serving.

## 8. What this supports, and what it does not

- **The defect is fixed as diagnosed.** After the return Speck no longer counts the ledger's old
  status, and it reaches the labelled answer 6/6 live (0/12 before), visibly by corroboration,
  with Speck's own confidence shown beside it.
- **The policy is not yet a reliable improvement.** On cases it was not designed on it scored the
  same as before (18/30), trading correct abstentions for conclusions. It concludes from agreement
  a careful person would not accept (`missing-evidence`, the claim recommendation): 6
  checkpoint-samples across the two live suites.
- **Speck still loses to the baseline in places**, live and deterministic: a single authoritative
  decision (one source is never corroboration), a hold lifted by the agency that requested it (the
  terminal's hold notice still counts against release), and the payroll return live.
- **Where Speck is consistently better:** it did not rely on a replaced or out-of-date record in
  any live sample in this report; the stateless call cited the replaced delivery scan in 6/6 live
  comparisons, and kept replaced or withdrawn evidence in support at 6/15 and 5/15
  regression checkpoint-samples. It also abstained on conflicting or withdrawn evidence where the
  baseline committed (9 of 12 such challenge checkpoint-samples under Build 4, 12 of 12 under
  Build 3).

## 9. Remaining risks

- **Corroboration has no strength requirement.** Two weak model judgments from two sources count.
  A refinement (for example, each corroborating judgment must be a fact rule or a model judgment
  of at least moderate strength) must be written before it is run, and tested on new locked
  cases; tuning it on `missing-evidence` or the claim case would contaminate them.
- **Restatement assumes one entity per fact key.** Facts carry no entity id: a source reporting
  the same fact for two different parcels would wrongly restate one with the other. No current
  case does this.
- **Record-level replacement and restatement.** A record with only some facts restated keeps
  counting whole.
- **Unassessed corrections** (section 6) are only withheld, not applied.
- **Small samples, one small model.** Three repeats per suite; the model's judgments vary.
