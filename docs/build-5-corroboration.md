# Build 5: a successor to rule `corroborated-1` (experiment record)

Reference: Build 4 at commit `e5efc75` (rule `corroborated-1`). Speck submodule pinned at
`8821789`, cognition unmodified. This file is written in stages; each section says when it was
written relative to the runs it describes.

## 0. Decision fixed before any strength was inspected

*Written and committed before the live strength diagnostic (section 1) was run.*

No saved receipt records the strength of each judgment behind a corroborated conclusion (the
eval reports keep outcomes; the comparison reports keep only Speck's per-record deltas). So
whether the Build 4 false positives rest on weak judgments is not yet known.

The hypothesis to test: a corroborating judgment should count only if its strength is **at least
0.5**. The value is taken from meanings the code already has, not chosen from data:
- the model is asked for "strength: a number from 0.1 (weak) to 1 (strong)"
  (`src/reasoning/nemotron.ts`); 0.5 is the middle of that scale;
- a model reply with no usable strength is set to 0.5 (`nemotron.ts`), so 0.5 is already the
  "no information" value; a strength that was defaulted, rather than reported, must therefore
  not qualify;
- scenario fact rules use 1 (the default) for a record that establishes a state, 0.5 for
  indirect support and 0.3 for weak support.

Commitment: the diagnostic on already-seen cases tests whether this hypothesis can explain the
false positives at all. The threshold is not moved after the diagnostic, whatever it shows.

## 1. Baseline and diagnosis

*Written after section 0 was committed and set 5 was locked (section 2), from the code at
`e5efc75`, the saved receipts, and a live diagnostic on already-seen cases.*

### 1a. What `corroborated-1` actually reads (`src/investigation/conclusion.ts`)

| Term | What it is in the code |
|---|---|
| Corroborating judgment | An entry in Speck's `supportingEvidence` for the top explanation whose record still counts (not superseded, withdrawn or restated). Any strength, any basis. |
| Deterministic rule result | A `RelationJudgment` with `basis: "rule"`, from the scenario's fact rules, strength as authored (default 1). **In live mode only decisive rules are applied** (`ruleJudgments(..., { decisiveOnly: true })` in `nemotron.ts`), and every decisive rule in every suite is a contradiction. So in live runs every supporting judgment is a model judgment. |
| Model judgment and its strength | `basis: "model"`; `strength` is the model's own number on "0.1 (weak) to 1 (strong)", clamped to [0.1, 1], and set to 0.5 when the reply has no finite number. Speck applies it with reliability capped at 0.4, so it moves a belief by at most 0.2 × 0.4 × strength. `EvidenceRef.judgedBy` is per record (any model judgment makes it "model"); `judgment.basis` is per judgment. |
| Independent source agreement | At least two distinct `source.system` values among those records. Nothing else: not `provenance.author`, not `systemOfRecord`, not whether one record repeats another's claim. |
| Evidence against | Any entry in the top explanation's `contradictoryEvidence`, counting or not. Blocks. |
| Unsupported rival | Any other current explanation (not rejected or superseded) with no supporting record that still counts. Every rival must be unsupported. |
| Remains unresolved | Speck has not reached its own supported status and any condition above fails; or `withholdForPending`: a record the last run could not assess is still waiting. |

### 1b. Baseline, re-run at `e5efc75` (2026-10-26)

| Command | Result | Agrees with tracked evidence |
|---|---|---|
| `npm test` | 157/157 pass | yes |
| `node dist/src/scripts/eval.js` (held-out, deterministic) | Speck 8/8, 0/4 unsupported; rule baseline 5/8 | yes (Build 4 doc, 5d) |
| same, regression group | Speck 8/8; rule baseline 6/8 | yes |
| `node dist/src/scripts/eval-cross-domain.js` | Speck 19/27, unnecessary abstentions 8/22, abstained rightly 5/5, unsupported 0/14, invalidated record still bearing 1/14, order-consistent 2/2; rule baseline 17/27 | yes |
| `node dist/src/scripts/eval-challenge.js` (deterministic) | Speck 7/10; rule baseline 5/10 | yes |
| Re-scoring the saved live receipts (`eval/results/experiments/challenge/2026-10-25-build4-after/`) | Speck 18/30, stateless 18/30; `claim@recommendation` concluded H-APPROVED by corroboration 3/3 | yes |
| Re-scoring `eval/results/experiments/reasoning/2026-10-25-build4-after/` | Speck 40/48, unsupported 3/28, all three `missing-evidence@claim` by corroboration | yes |

The deterministic reports are git-ignored (`eval/results/*`), so "agrees" means the counts equal
those written in `docs/build-4-bank-return.md`, not a byte comparison.

### 1c. Live strength diagnostic (already-seen cases only)

`eval/results/experiments/build5-diagnostic/r1-r3.json` (script beside them). Evidence Desk as the
eval's `speck-desk` runs it, local `nemotron-3-nano:4b` on Ollama (reasoning off, 4,096-token
cap, temperature 0.1), 3 repeats over the held-out, regression and Build 4 challenge cases:
78 checkpoint-samples, 0 errors; the repeats finished at 13:45, 13:49 and 13:53 UTC on 2026-10-25. It started after section 0 was
committed and ran while set 5 was being written; none of its output was read before set 5 was
locked.

- **Both documented false positives reproduced, 6/6**: `missing-evidence@claim` H-DEFECT 3/3,
  `claim-decision-missing@recommendation` H-APPROVED 3/3, all by corroboration.
- **The judgments behind them are strong by the model's own scale.** Fault report → defect
  0.8, 0.8, 0.8; "inspection scheduled" → defect 0.9, 0.9, 0.7; adjuster's recommendation →
  approved 1.0 ×3; customer's expectation → approved 0.9 ×3.
- **The model's strengths carry almost no information.** All 337 model judgments: minimum 0.6,
  209 at 1.0, 83 at 0.9; none at 0.5 (no defaulted strength occurred). The true corroborations
  (bank return 0.95/0.95, refund records 1.0/1.0, ...) are indistinguishable from the false ones.

**The section 0 hypothesis is refuted for this model.** A threshold of 0.5 (fixed before looking)
would not have removed any of the 6 false-positive samples, and any threshold that did (above 0.9)
would also remove most correct corroborations. The threshold is not moved.

One more general idea was checked on these seen cases and rejected before any new run: refusing
corroboration while one of the case's declared `questions` is unanswered. It would block the
bank-return fix itself (`payment.repaid` is never answered there).

### 1d. Root cause

A combination, in this order of weight:
1. **Invalid semantic agreement.** The model judges a record that *anticipates or reports a
   state* (an inspection scheduled, a recommendation, someone's expectation) as *supporting* the
   state, at the same strength as a record that *establishes* it. Nothing in the judgment
   distinguishes the two: `direction` is "supports" and `strength` is ~0.9 either way.
2. **Correlated evidence treated as independent.** The customer's expectation repeats what the
   adjuster said; corroboration counts only `source.system`, so a dependent copy counts as a
   second source. No structured field records that dependence (fixtures set `systemOfRecord` to
   the source's own name and `author` to its feed).
3. **Absence of rival support read as support.** In missing-information cases the rivals are
   unsupported because the deciding record does not exist yet, which `corroborated-1` reads as
   "every rival is unsupported".
4. **Weak individual judgments: not a factor for this model** (1c).

What it is not: not the cap, threshold or priors (unchanged and not used by the rule), not
stale or replaced records (none involved), not failed model calls (the one failure-driven error,
claim@decision repeat 1 in Build 4, is handled by `withholdForPending`).

## 2. The new locked set (set 5)

`eval/challenge-5/` (README there): 8 cases in 8 domains no earlier suite uses, 15 checkpoints
(9 labelled with a conclusion, 6 abstain), equal priors. Written and locked
(`expectations.lock.json`, SHA-256 per file, `lockedAt` 2026-10-25T13:45:4xZ) in commit
`2278915` (2026-10-26 00:45:46 +11:00), **before** any system was run on them, before the
diagnostic's output was read, and before the candidate in section 3 existed. The section 0
commit (`e062203`) precedes it.

Not derived from the false-positive cases' records, but written by the same author knowing that
the failure was weak agreement; the set therefore contains that kind of case (4 abstain
checkpoints with agreeing anticipation, intention, repetition or scheduling) and also genuine
agreement where a conclusion is due (so a rule that abstains on everything scores badly).

## 3. The candidate, pre-registered: rule `corroborated-2`

*Written and committed before any of it was implemented and before any system was run on set 5.*

### 3a. Definition

`corroborated-2` holds for Speck's top explanation H when Speck has not established H itself and:
1. H is Speck's top-ranked current explanation (as before);
2. **at least two qualifying supporting judgments, from records that still count, from at least
   two different source systems**;
3. no record is recorded against H (as before: every recorded contradiction blocks);
4. every other current explanation has no supporting record that still counts (as before; *any*
   support for a rival blocks, qualifying or not).

A supporting judgment **qualifies** when its strength was reported (not defaulted) and is at
least 0.5 (section 0), and:
- its basis is a deterministic fact rule (`basis: "rule"`); or
- its basis is the model, and the model marked it `establishes: true`.

Non-qualifying support neither counts nor blocks. Every other rule is unchanged: the cap, the 0.6
threshold, the priors, decisive refutation, restatement, supersession, withdrawal and
`withholdForPending`.

### 3b. Where `establishes` comes from

Only when the rule in force is `corroborated-2`, the relation-judgment contract gets one more
required field per judgment, with exactly this instruction:

> - establishes: true only when relation is "supports" and the item itself records that the
>   hypothesis is the case (a completed event, a recorded decision, an observed state). false when
>   it only reports a request, plan, schedule, intention, recommendation, expectation or
>   prediction, or repeats what another party said. false for "contradicts" and "neutral".

The value is kept only if it is the boolean `true`; anything else is `false`. It is stored on the
judgment (`RelationJudgment.establishes`) and used only by the conclusion policy: Speck's belief
revision receives the same direction and strength as before. Under `corroborated-1` the prompt
and contract are unchanged byte for byte, so Build 4 stays reproducible.

### 3c. Handling decided in advance

| Situation | Handling |
|---|---|
| Missing strength | The model reply's strength is still set to 0.5 for Speck, but marked `strengthReported: false`; it never qualifies. |
| Missing or non-boolean `establishes` | Not qualifying. |
| Judgments saved before Build 5 (no `establishes`) | Not qualifying under `corroborated-2`. |
| Failed model call | Unchanged: the records stay unassessed, `withholdForPending` withholds any conclusion; nothing from a failed call counts as support. |
| Conflicting sources | Unchanged: any recorded contradiction blocks; any rival support blocks. |
| Repeated records from one source | Unchanged: one system, however many records. |
| Sources that share one underlying claim | No structured field shows this; only the model's `establishes` ("repeats what another party said") can exclude it. A known limit. |
| Withdrawn, superseded, restated, stale | Unchanged: they do not count, so cannot qualify. |
| Deterministic runs | Rule judgments qualify by their authored strength (≥ 0.5). |

The page and reports keep showing Speck's own confidence and status beside a corroborated
conclusion; the reasons name the qualifying records and every excluded one with why.

### 3d. Isolation

`CONCLUSION_RULE` (`corroborated-1` default, or `corroborated-2`) selects the rule for the desk,
the page and the comparison; the comparison's policy string names it, so samples are never pooled
across rules. The evaluation can also score both rules on **the same** Speck state and judgments.

## 4. Evaluation, pre-registered

### 4a. Procedure

1. Implement; add unit tests; run the full suite.
2. Deterministic, each rule separately: held-out, regression, cross-domain, Build 4 challenge,
   set 5. Reported separately; **not** used for the decision (fact-rule strengths in set 5 were
   written by the rule's author).
3. **Live, set 5** (the decision), local `nemotron-3-nano:4b`, Ollama, reasoning off, 4,096-token
   cap, temperature 0.1, 3 repeats per configuration, alternated R, C, R, C, R, C:
   - **R (reference)**: Build 4 as it is (`corroborated-1`, the Build 4 prompt);
   - **C (candidate)**: `corroborated-2` with its prompt; in the same runs `corroborated-1` is
     also scored on the same judgments (paired, secondary: separates the rule from the prompt).
   The stateless model baseline runs in both, unchanged.
4. **Live, seen suites** (regression check, previously seen): held-out, regression and Build 4
   challenge under C, 3 repeats; compared with the paired `corroborated-1` in the same runs and
   with Build 4's saved receipts.
5. Nothing in the rule or prompt changes once step 3 starts. A defect found later is reported;
   fixing it would be a new rule name, and set 5 would no longer be independent for it.

### 4b. Measures (counts with denominators, per system and per checkpoint-sample)

Correct; concluded where abstention was due; concluded the wrong explanation where another was
due; unsupported conclusions (the labels' lists); abstained rightly; abstained when a conclusion
was due; refuted explanations kept out of current; invalidated records kept out of support;
model replies valid; records left unassessed by a failed call. Scoring code and labels unchanged.

### 4c. Acceptance criteria (C's `corroborated-2` against R, set 5 live)

- **A1** conclusions at abstain-labelled checkpoints (18 samples): C at least 2 fewer than R. If R
  makes fewer than 2 there, no improvement can be shown and the candidate is not adopted.
- **A2** correct conclusions at conclusion-labelled checkpoints (27 samples): C no more than 1
  below R.
- **A3** refuted kept out of current, invalidated kept out of support: C no more than 1 below R on
  each.
- **A4** seen suites under C: the bank return after the return (`correction-supersedes@after-return`)
  concluded H-UNPAID in 3/3.
- **A5** model replies valid under C no more than 5 percentage points below R.

All five hold: recommend `corroborated-2` (the default stays `corroborated-1` until the owner
switches it). Any fails: keep Build 4 as the reference and report the result as it is.

---

*Everything below was written after the implementation (commit `bf0a8e9`, 2026-10-26 01:06 +11:00)
and the runs it describes. Nothing in the rule, the prompt, the cases or the scoring changed after
the first run on set 5.*

## 5. What was implemented

As pre-registered in section 3, with no differences:

| File | Change |
|---|---|
| `src/config.ts` | `CONCLUSION_RULE` → `conclusionRule` (`corroborated-1` default) |
| `src/reasoning/types.ts` | optional `strengthReported: false` and `establishes` on a judgment |
| `src/reasoning/nemotron.ts` | the `establishes` field and instruction (3b) only when asked; a defaulted strength is marked |
| `src/investigation/conclusion.ts` | rule `corroborated-2`; `corroboration.excluded` lists each non-qualifying record and why |
| `src/investigation/case-state.ts`, `desk.ts` | the rule in force, and `conclusionFromSpeck(inFlight, rule)` to read another rule from the same state |
| `src/compare/comparison.ts` | the policy string names the rule (`build-5 (restatement, corroborated-2)`); Build 4's name is kept for `corroborated-1` |
| `src/eval/*`, `src/scripts/eval*.ts` | `--rule`; under `corroborated-2` the Speck systems also score `corroborated-1` on the same runs (`<system>~corroborated-1`); `eval:challenge -- --set 5`; live reports refuse to overwrite |
| `test/build5.test.ts` | 17 tests (section 7) |

Under `corroborated-1` the prompt and contract are unchanged (tested), and the default eval
reports have exactly Build 4's systems (an existing test checks it).

## 6. Results

**Kinds of result, never pooled.** *Deterministic*: fact rules, no model. *Live*: local
`nemotron-3-nano:4b` on Ollama at `127.0.0.1:11434` (Q4_K_M, reasoning off, temperature 0.1,
4,096-token output cap), each repeat a separate sample, 2026-10-25/26 UTC. Every live run in this
document is this local 4B model; none went through Meterless/Nightshift or a 30B model. **R** is
Build 4 as it is; **C** is the candidate (`corroborated-2` with its prompt); **C~1** is
`corroborated-1` scored on C's own runs and judgments. Counts are over these cases only.

### 6a. Set 5, live (the pre-registered decision): 3 repeats, 45 checkpoint-samples per system

`eval/results/experiments/challenge-5/2026-10-26-reference/rep1-3/` and `.../2026-10-26-candidate/rep1-3/`,
run alternately R, C, R, C, R, C.

| | Speck R | Speck C | Speck C~1 | Stateless (beside R) | Stateless (beside C) |
|---|---|---|---|---|---|
| Conclusion matches the label | 37/45 | **39/45** | 39/45 | 27/45 | 27/45 |
| Concluded where abstention was due | 8/18 | **6/18** | 6/18 | 15/18 | 15/18 |
| Correct where a conclusion was due | 27/27 | 27/27 | 27/27 | 27/27 | 27/27 |
| Concluded the wrong explanation where one was due | 0/27 | 0/27 | 0/27 | 0/27 | 0/27 |
| Unsupported conclusions (the labels' lists, of conclusions) | 2/35 | 3/33 | 3/33 | 3/42 | 3/42 |
| Abstained when it should | 10/18 | 12/18 | 12/18 | 0/18 | 0/18 |
| Refuted explanation kept out of current | 21/21 | 21/21 | 21/21 | 21/21 | 21/21 |
| Withdrawn or replaced evidence kept out of support | 9/9 | 9/9 | 9/9 | 6/9 | 6/9 |
| Model replies valid | 93/94 | 93/93 | (same calls) | 42/48 | 42/48 |
| Checkpoint errors (failed model calls surfaced) | 0 | 0 | 0 | 3 | 3 |

The stateless rows are identical in R and C (the baseline is unchanged; its errors are three
failed replies at `utility-disconnection@scheduled`).

Per checkpoint, Speck (3 samples each; (c) = by corroboration, otherwise Speck's own threshold):

| Checkpoint | Label | R | C | C~1 |
|---|---|---|---|---|
| leave-approval @ intent | abstain | **H-APPROVED (c) 3** | abstain 3 | abstain 3 |
| venue-booking @ phone | abstain | H-CONFIRMED 3 | H-CONFIRMED 3 | H-CONFIRMED 3 |
| referral-attendance @ booked | abstain | H-SEEN 2, abstain 1 | H-SEEN 3 | H-SEEN 3 |
| utility-disconnection @ scheduled | abstain | abstain 3 | abstain 3 | abstain 3 |
| enrolment @ conflict, grant @ receipt-withdrawn | abstain | abstain 3, 3 | abstain 3, 3 | abstain 3, 3 |
| leave-approval @ recorded | H-APPROVED | H-APPROVED 3 | H-APPROVED 3 (2 by (c)) | same |
| every other checkpoint (8) | a conclusion | correct 3 each | correct 3 each | correct 3 each |

**Acceptance criteria (4c):**

| | Required | Result | |
|---|---|---|---|
| A1 | C at least 2 fewer conclusions where abstention was due | 8 → 6 | met, at the minimum |
| A2 | C no more than 1 below R on correct conclusions where due | 27 → 27 | met |
| A3 | refuted kept out, invalidated kept out: C no more than 1 below R | 21/21, 9/9 both | met |
| A4 | seen suites under C: bank return after the return H-UNPAID 3/3 | 3/3 (by corroboration) | met (6b) |
| A5 | model replies valid within 5 points | 98.9% → 100% | met |

**All five pre-registered criteria are met. But the paired measure shows that on set 5 the rule
itself changed nothing:** C~1 equals C at every checkpoint-sample. The whole difference between R
and C is one checkpoint, `leave-approval@intent`, where under C's prompt the model also judged the
manager's intention as supporting "still awaiting a decision" (a rival with support blocks both
rules; section 6d). That is an effect of the changed prompt on the model's judgments (or of
sampling), not of the qualifying check. 6 of R's 8 and all 6 of C's remaining false conclusions
were reached by **Speck's own threshold**, which neither rule touches.

### 6b. Seen suites, live, under C (previously seen: held-out, regression, Build 4 challenge)

`eval/results/experiments/reasoning/2026-10-26-build5-candidate/` and
`eval/results/experiments/challenge/2026-10-26-build5-candidate/`, 3 repeats. Compared with
Build 4's saved receipts (`.../2026-10-25-build4-after/`), which are separate runs.

| | Build 4 receipts (R) | C | C~1 | Stateless, beside C |
|---|---|---|---|---|
| Held-out + regression: matches the label | 40/48 | 42/48 | 42/48 | 18/48 |
| ... concluded where abstention was due | 3/18 | **0/18** | 0/18 | 15/18 |
| ... correct where a conclusion was due | 25/30 | 24/30 | 24/30 | 15/30 |
| Build 4 challenge: matches the label | 18/30 | 19/30 | 16/30 | 17/30 |
| ... concluded where abstention was due | 3/12 | **0/12** | 3/12 | 12/12 |
| ... correct where a conclusion was due | 9/18 | 7/18 | 7/18 | 17/18 |
| Model replies valid (held-out + regression; challenge) | 93/96; 58/65 | 93/96; 60/63 | (same calls) | 48/48; 30/30 |

The 48 held-out and regression samples include the provider-failure case (3 per system), which
every system handles correctly. Refuted explanations were kept out of current and replaced or
withdrawn evidence kept out of support in every Speck sample under C, in both suites.

Per checkpoint, where C differs from the Build 4 receipts:

| Checkpoint | Label | Build 4 receipts | C | C~1 | What changed it |
|---|---|---|---|---|---|
| correction-supersedes @ after-return (the bank return) | H-UNPAID | H-UNPAID (c) 3 | **H-UNPAID (c) 3** | 3 | unchanged |
| missing-evidence @ claim | abstain | H-DEFECT (c) 3 | abstain 3 | abstain 3 | the prompt (C~1 abstains too) |
| claim-decision-missing @ recommendation | abstain | H-APPROVED (c) 3 | **abstain 3** | H-APPROVED (c) 3 | **the rule**: both records marked as not establishing |
| claim-decision-missing @ decision | H-DECLINED | H-APPROVED 1 (failed call), abstain 2 | abstain 3 | abstain 3 | still one source |
| misattributed-scan @ correction | H-IN-DEPOT | H-IN-DEPOT (c) 2, abstain 1 | abstain 3 | abstain 3 | prompt or sampling (a loss) |
| refund-settlement-withdrawn @ settled | H-RECEIVED | H-RECEIVED 3 | H-RECEIVED 1, abstain 2 | same | prompt or sampling (a loss) |
| model-misreading @ pickup-report | H-AWAITING | H-AWAITING (c) 2, abstain 1 | H-AWAITING (c) 3 | 3 | prompt or sampling |

On seen cases C removed every corroboration false positive (7 samples), of which the rule's own
check removed 3 (`claim@recommendation`); it also lost 3 correct conclusions, all of which C~1
loses too.

### 6c. Deterministic (fact rules, no model), each rule

| Suite | `corroborated-1` | `corroborated-2` |
|---|---|---|
| Held-out | 8/8, 0/4 unsupported | identical per checkpoint |
| Regression | 8/8 | identical |
| Cross-domain | 19/27, 0/14 unsupported, abstained rightly 5/5, unnecessary abstentions 8/22, invalidated still bearing 1/14 | identical |
| Build 4 challenge | 7/10 | identical |
| Set 5 | 13/15, 2/11 unsupported | identical |
| Rule baseline | held-out 5/8, regression 6/8, cross-domain 17/27, challenge 5/10, set 5 9/15 | (unchanged) |

Deterministically the two rules never differ. On set 5 both make two unsupported conclusions
(`utility-disconnection@scheduled`, `referral-attendance@booked`), through Speck's own threshold:
with a prior of 0.5, two weak fact rules from uncapped sources pass 0.6.

### 6d. Post-hoc diagnostic: how the set 5 outcomes arose

*Run after 6a and 6b, on set 5 (now seen), to explain them; not part of the decision.*
`eval/results/experiments/challenge-5/2026-10-26-posthoc-diagnostic/`, 3 repeats each of R and C
on `leave-approval`, `venue-booking` and `referral-attendance`.

- **leave @ intent.** R: manager and employee both support "approved" (0.7-0.9), nothing for
  "pending", so `corroborated-1` concludes 3/3. C: the model also gives "pending" support in 3/3
  (rival support blocks), and marks 4 of the 5 support judgments for "approved" as not
  establishing; once it marked the employee's report of what the manager said as establishing.
- **venue @ phone.** One source, two records, 0.9 each: Speck's own belief goes 0.5 → 0.644 and is
  supported by threshold, in R and C alike. The model marked all 6 support judgments as not
  establishing, correctly; the rule never applies because Speck itself concluded.
- **referral @ booked.** Booking and reminder from one clinic system, Speck's threshold again
  (0.618-0.644). Under C the model marked a booking or a reminder as *establishing* that the
  patient was seen in 5 of 6 judgments: wrong.

So the `establishes` judgment of this 4B model is right on some kinds of anticipation
(recommendations, expectations, verbal assurances) and wrong on others (bookings, reminders).

## 7. Tests

`npm test`: **174/174 pass** (157 before, 17 new in `test/build5.test.ts`), run on the committed
implementation. The new tests: two strong independent judgments (both rules conclude, Speck's
lower confidence kept); two agreeing judgments that do not establish (rule 1 concludes, rule 2
abstains and lists why); two weak judgments marked establishing (excluded below 0.5); one
qualifying and one not (one system); duplicated same-source records (one system, both rules);
contradiction and non-qualifying rival support (both block); missing strength, a missing judgment,
a judgment never asked about (excluded); deterministic rules by authored strength; withdrawn and
superseded records; Speck's own supported status untouched; the bank return replayed (both rules
conclude H-UNPAID by corroboration, Speck 0.46); `missing-evidence` and the claim replayed from the
diagnostic (rule 1 reproduces the false positive, rule 2 does not; the single decline stays
unresolved); a failed model call under rule 2 (withheld, then concluded once assessed); the model
contract through the real adapter (the field only under rule 2; a missing strength marked; only
`true` counts); the comparison's policy string; set 5's lock and separation.

## 8. Recommendation

**By the pre-registered criteria, `corroborated-2` passes, and adopting it is recommended.** The
default is not switched here: the owner decides (`CONCLUSION_RULE=corroborated-2`).

What that recommendation rests on, and what it does not:
- It removed every corroboration false positive on the previously seen suites (7 samples) and,
  on the independent set, 2 of 8 false conclusions net (3 removed at one checkpoint, one more at
  `referral@booked`, 2 → 3), without losing a correct conclusion there, while keeping the bank-return fix (3/3) and correction handling (every sample).
- **It is not shown that the qualifying check works on new cases.** On set 5 the rule's own check
  changed no outcome; the gain came with the prompt change. The check's measurable effect is on
  one seen case (`claim@recommendation`, 3/3).
- The gain on set 5 is the minimum the criteria required (2 samples, one checkpoint, one model).
- It does not touch the larger remaining source of false conclusions on set 5: Speck's own
  threshold concluding from one source's two records when the prior is 0.5 (all 6 of C's).
- On seen cases C also lost 3 correct conclusions (all in C~1 too).
- **Accuracy:** on set 5 both Speck configurations matched the label more often than the stateless
  call (37/45 and 39/45 against 27/45), almost entirely because the stateless call never abstained
  (0/18). This is one locked set written by the rule's author; on the Build 4 challenge cases the
  three were level (18/30).

## 9. Remaining limits

- **Speck's own threshold over-concludes at prior 0.5.** Two model-judged records from one source
  move a two-hypothesis case from 0.5 to 0.644. Fixing it would mean changing priors or the
  threshold (Speck's, deliberately left alone) or adding an Evidence Desk check on threshold
  conclusions; that is a new design and needs a new locked set.
- **`establishes` is a model judgment** and is wrong for some kinds of anticipation (bookings,
  reminders). Dependence between sources is detected only through it.
- **Independent set, one author.** Set 5 was written knowing the failure, and is now seen.
- **Small samples, one small local model**; no 30B/Nightshift run of either rule was made.
- **Unassessed corrections** are still only withheld (Build 4, section 6).

## 10. Documentation changed with this build

README (results, the rule, how to select it, limits), `docs/SUBMISSION.md`, `docs/comparison.md`,
`DEMO.md`, `eval/challenge-5/README.md`. The comparison panel needs no change: it shows each
conclusion's route and Speck's own confidence, and its policy string now names the rule.
