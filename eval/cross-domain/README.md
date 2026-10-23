# Cross-domain evaluation suite

A separate, explicitly labelled suite. It asks whether Evidence Desk's evidence revision and
recovery behave usefully beyond the delivery and bank-return examples. It is not part of the
seven held-out cases (`eval/scenarios/`) or the correction regression cases (`eval/regression/`).
Neither of those, their labels, the baselines nor the 0.4 cap were changed for it.

Run it with `npm run eval:cross-domain`. The report is written to `eval/results/` (git-ignored).

## Cases

| Case | Domain | What it exercises |
|---|---|---|
| `logistics-misattributed-scan` | logistics | replacement, decisive refutation |
| `logistics-misattributed-scan-late-original` | logistics | arrival order: the correction arrives before the record it replaces |
| `logistics-misattributed-scan-single-batch` | logistics | arrival order: everything at once |
| `logistics-missing-proof` | logistics | missing evidence (the deciding record does not exist) |
| `payment-amount-correction-chain` | payments | replacement chain (a correction of a correction) |
| `payment-reversal-withdrawn` | payments | a correction withdrawn by the investigator |
| `payment-unreadable-record` | payments | failed assessment (harness fault injection), then withdrawal |
| `procurement-short-delivery` | procurement | replacement, decisive refutation |
| `procurement-short-delivery-late-original` | procurement | arrival order: the correction arrives before the record it replaces |
| `procurement-price-amendment` | procurement | decisive refutation, then withdrawn by its source |

Cases in the same `family` share their records and differ only in arrival order. Interrupted
runs are not a case of their own: the runner interrupts every checkpoint of every case in turn
(see below).

## How the expectations were labelled

The labels were written before any system was run on these cases. They describe what a careful
human investigator would conclude from the records visible at each checkpoint. They were not
derived from what any system computes.

- **conclusion**: the hypothesis the visible evidence establishes, or `null` (abstain) when the
  evidence conflicts or the deciding record is missing.
- **Superseded and withdrawn records do not count.** A record replaced by its source, or
  withdrawn by the investigator, no longer bears on the conclusion. A correction that lists the
  record it replaces makes that record not count, even if the replaced record arrives later.
- **Unreadable records:** when the assessor cannot read one record, the label is what the
  readable records establish. A correct system concludes from those and reports the unread
  record. It neither stalls on it nor guesses its content.
- **notCurrent**: hypotheses the evidence has refuted or replaced by this checkpoint. None may be
  presented as current or favoured.
- **unsupported**: hypotheses the evidence does not support at all. Concluding one is an
  unsupported claim.
- **invalidated**: visible records that no longer count (superseded or withdrawn). None may
  still influence any belief.

## Fixed before running

`expectations.lock.json` holds the SHA-256 of every case file, written before the suite's
first run. The runner refuses to score if any case file differs from the lock. A label changed
after seeing results would therefore show as a lock change in git, never as a silent edit.

## Fault injection

- **Failed assessment.** `failAssessment` in `expected.json` names records whose assessment
  fails. The harness gives every system an assessor that throws on any batch containing them.
  This is how a model failure reaches Evidence Desk: per batch, as in production.
- **Interruption.** The same mechanism as `test/recovery.test.ts`. Speck's `recordEvidence`
  starts failing after one call, and the run snapshot is never written. The database is then
  reopened and the investigation rerun.

No sponsor service is called by this suite. Evidence comes from these files through the
fixture provider, and assessment uses the scenario's fact rules.
