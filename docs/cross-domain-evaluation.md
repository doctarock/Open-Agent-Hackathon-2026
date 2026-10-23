# Cross-domain evidence revision: findings

**Question.** Is Evidence Desk's evidence revision and recovery useful beyond the delivery and
bank-return examples?

**Method.**
- A separate suite of 10 cases with 27 labelled checkpoints, in `eval/cross-domain/`, covers
  three domains: logistics, payment reversals and procurement disputes.
- It exercises arrival order, replacement chains, withdrawn corrections, decisive refutations,
  missing evidence and failed assessments. Every checkpoint is also interrupted in turn.
- The labels were written from the records, before any system ran. They were locked by hash
  (`eval/cross-domain/expectations.lock.json`, 2026-10-23T00:04:51Z) and have not changed.
- The held-out cases, the regression cases, the baselines and the 0.4 cap are unchanged. The
  held-out and regression results are identical before and after this work.

Reproduce with `npm run eval:cross-domain`. The full per-case report, with every evidence
sequence and each system's conclusion at each checkpoint, is written to
`eval/results/cross-domain.md`.

## Systems compared

All three are deterministic: the same records from the same files, the same fact rules, and no
model.

- **speck-desk:** Evidence Desk as built.
- **speck-fresh:** the same pipeline on a new database at each checkpoint.
- **baseline-stateless/rules:** the existing stateless baseline, unchanged.

Differences to keep in mind:
- **The baseline ignores corrections.** It does not read a record's `supersedes` list, so a
  record replaced by its source still counts for it.
- **The systems commit on different terms.** Speck systems conclude only at Speck's *supported*
  status (confidence ≥ 0.6). The baseline commits to its top positive score.
- **A failed assessment fails more for the baseline.** It assesses everything in one pass, so
  one failed record fails the whole checkpoint. Evidence Desk fails the batch holding it.
- **Withdrawal timing differs for speck-fresh.** It applies withdrawals after its run, as the
  existing harness does.

## Results (counts over these 27 checkpoints only)

| Measure | speck-desk | speck-fresh | baseline |
|---|---|---|---|
| Conclusion correct | 15/27 | 15/27 | 17/27 |
| Correct revisions (label changed from the previous checkpoint) | 6/11 | 6/11 | 7/11 |
| Stale or refuted hypothesis concluded or presented as current | 1/17 | 2/17 | 4/17 |
| Invalidated record still bearing on a current belief | 4/14 | 5/14 | 12/14 |
| Unnecessary abstentions (conclusion due, abstained) | 11/22 | 10/22 | 0/22 |
| Abstained when it should | 5/5 | 5/5 | 0/5 |
| Unsupported claims (of conclusions made) | 1/11 | 2/12 | 4/26 |
| Valid citations | 53/53 | 54/54 | 45/45 |
| Same records in another order: final answer correct and identical | 0/2 | 0/2 | 2/2 |

**Recovery after interruption** (speck-desk only; the baseline keeps no state to damage):
- Interruptions: 27, one per checkpoint, and 27/27 reached the interruption point.
- After reopening, 27/27 matched the uninterrupted run exactly from that point on: the
  conclusion, what was presented, and the records behind current beliefs.
- 9/27 were also correct against the labels from that point on. The shortfall is the
  uninterrupted run's own errors, which recovery reproduces faithfully.

## What this shows

1. **Revision generalises; commitment does not.**
   - Across all three domains, Evidence Desk kept invalidated records out of its beliefs more
     often than the baseline (4/14 against 12/14). It also presented a refuted or replaced
     hypothesis as current less often (1/17 against 4/17).
   - It never committed where the labels say to abstain (5/5), where the baseline always
     committed (0/5).
   - The price is abstention. On 11 of the 22 checkpoints where a conclusion was due, it only
     leaned. Seven of those are a single reliable record pointing one way, which Speck holds at
     about 0.58, below its 0.6 *supported* threshold.
   - Overall correctness is therefore similar (15/27 against 17/27). The two systems are wrong
     in different ways: the baseline over-commits, Evidence Desk under-commits.
2. **A correction that arrives before the record it replaces is ignored.**
   - Supersession is honoured only for records observed *before* the correction
     (`src/investigation/basis.ts:54-66`). A record has a single timestamp, `observedAt`, so a
     late-synced or backfilled original counts again.
   - This happened in both late-arrival variants. It accounts for 3 of Evidence Desk's 4
     invalidated-influence checkpoints, and for both of its order-consistency failures.
   - The same records delivered in natural order were handled correctly.
   - This is a real limit of the design, not of the harness.
3. **One unreadable record stalls the case.**
   - When assessment fails on a record that arrives with a decisive bank return, the whole batch
     fails. Evidence Desk then keeps presenting the refuted *paid* conclusion until the
     investigator withdraws the record. This is the known stall, now measured outside the
     original scenario.
   - After the withdrawal it only leans towards *unpaid*.
   - The baseline fails the whole checkpoint instead.
4. **Recovery holds across domains.** All 27 interruptions recovered to exactly the
   uninterrupted state.
5. **A display defect, found during the demonstration.**
   - After a correction is withdrawn, the record it had replaced counts again. The conclusion
     and its rules say so ("in effect").
   - But the evidence list still badges that record "superseded by X" and strikes it through.
     `listEvidence` derives that badge from every visible record's `supersedes` list,
     ignoring whether the correction itself still counts (`src/investigation/desk.ts:343-344`).
   - The same badge appears on a late original that, per finding 2, still counts.
   - The beliefs are correct; only the label is wrong.

## Demonstrated in the existing UI

Both were run with the standalone page (`npm start` with `EVIDENCE_DESK_SCENARIO`), on fixture
evidence and the rule assessor. The page labels these "FIXTURE FILE - NOT ZETARIS" and "rules";
no sponsor service was called.

```bash
EVIDENCE_MODE=fixture REASONER=rules EVIDENCE_DESK_DATA_DIR=data/xd-logistics \
  EVIDENCE_DESK_SCENARIO=eval/cross-domain/logistics-misattributed-scan EVIDENCE_DESK_PORT=4331 npm start
EVIDENCE_MODE=fixture REASONER=rules EVIDENCE_DESK_DATA_DIR=data/xd-payment \
  EVIDENCE_DESK_SCENARIO=eval/cross-domain/payment-reversal-withdrawn EVIDENCE_DESK_PORT=4332 npm start
```

- **Logistics** (`logistics-misattributed-scan`):
  1. Run: leaning *delivered* (0.58).
  2. Update and run: unresolved.
  3. Update and run: *supported*, held at the depot (0.66). "Why this changed" names the
     reassigned scan and what went with it.
- **Payment correction** (`payment-reversal-withdrawn`):
  1. Run: *supported*, paid (0.86).
  2. Update and run: unresolved after the bank return.
  3. Update, then **Withdraw** XP2-03 ("The bank confirmed the return belongs to INV-525, a
     different invoice."), then run: *supported*, paid (0.86) again. The withdrawal and both
     recomputations show in the history.

## Limits of this experiment

- **Small and synthetic.** There are 10 cases, written for this purpose by the same team that
  built the system. Domain realism is limited to what the records say.
- **One labeller.** The labels encode one reading of what a careful investigator would
  conclude. Some cases, notably the single-record checkpoints, could reasonably be labelled
  "abstain"; they were left as locked.
- **Deterministic only.** No live model run was made on this suite, so nothing here speaks to
  Nemotron's judgments.
- **The baseline ignores corrections by design.** A stateless system that honoured
  `supersedes` was not built; it might match Evidence Desk on invalidated influence without any
  persistence.
- **Interruption at one point.** It is applied at one point per checkpoint (after the first
  ledger write, with the snapshot lost), not at every write as `test/interruption.test.ts` does
  for the delivery case.

## Possible next steps (not done)

- Give records an event time separate from arrival time, so corrections can apply to
  late-arriving originals (finding 2).
- Derive the "superseded by" badge from the belief basis (finding 5).
- Add a stateless baseline that honours `supersedes`, to isolate what persistence adds.
- A live-model run of this suite.
