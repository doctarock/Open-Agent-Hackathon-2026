# Challenge cases, set 5 (Build 5)

Eight cases written for the Build 5 experiment (`docs/build-5-corroboration.md`), in domains no
earlier suite uses (utilities, human resources, vehicle registration, education, research grants,
healthcare, telecommunications, events). They are the independent test of rule `corroborated-2`
against `corroborated-1`, and are reported apart from every other suite.

## How they were written, and what that does and does not guarantee

- **Labels first.** Every case file, including its labels, was written and locked
  (`expectations.lock.json`, SHA-256 per file) before any system was run on them, before the
  Build 5 live strength diagnostic was read, and before rule `corroborated-2` was written down or
  implemented. The runner refuses to score files that differ from the lock.
- **Same labelling rules** as `eval/cross-domain/README.md` and `eval/challenge/README.md`: a
  label is what a careful human investigator would conclude from the records visible at that
  checkpoint, or `null` (abstain) when the evidence conflicts or the deciding record is missing.
  `invalidated` lists only records replaced by a declared `supersedes` or withdrawn by the
  investigator. `unsupported` lists hypotheses the visible evidence does not support at all.
- **Equal priors** in every case (0.5 for two hypotheses, 0.33 for three).
- **Fact-rule strengths** follow the existing convention: omitted (1) when the record states the
  outcome, 0.5 for indirect support, 0.3 for weak support. They matter only to deterministic
  runs; live runs use only the decisive rules and the model judges the rest.
- **Balanced:** 9 checkpoints labelled with a conclusion, 6 labelled abstain.
- **Not independent of the author.** The cases were written by the same author as the rule being
  tested, after the Build 4 false positives were known, so the set deliberately includes the kind
  of weak agreement the rule targets, and also cases where agreement is genuine and a conclusion
  is due, so that a rule which only abstains scores badly. The lock proves only that the labels
  did not move after results were seen.
- **No injected failure.** None of these cases injects a failed model call; failed calls are
  covered by unit tests and counted where they occur in live runs.

## Cases

| Case | Category | What a careful investigator concludes |
|---|---|---|
| `utility-disconnection` | missing information, then completion | abstain (requested and scheduled, the date has passed, no completion record); then disconnected (the network completes the job, billing closes on a final read) |
| `leave-approval` | intention and hearsay, then recorded decision | abstain (a manager's intention, and the employee repeating it); then approved (HR system and payroll) |
| `vehicle-transfer-cancelled` | corrected evidence | registered to the buyer; then still the seller's (the registry cancels the transfer, declared; the dealer's status changes from lodged to cancelled) |
| `enrolment-conflict-corrected` | conflict, then declared correction | abstain (student system says withdrawn, learning system shows the student active); then enrolled (the student system reverses its withdrawal, declared) |
| `grant-receipt-withdrawn` | withdrawn evidence, then conflict | paid (funder and university agree); then abstain (the receipt is withdrawn as another grant's and the university finds none, while the funder says released) |
| `referral-attendance` | anticipation, then authoritative record with a dependent copy | abstain (referral, booking and reminder; the date has passed, no attendance record); then seen (the clinic records the attendance; the GP only files the clinic's letter) |
| `number-port` | independent agreement | ported (the losing carrier records the port-out; the customer sees the number working on the new SIM) |
| `venue-booking` | repeated same-source evidence, then authoritative record | abstain (one planner's verbal assurance, recorded twice); then confirmed (the venue's own system) |

## Results (2026-10-26)

Live, local `nemotron-3-nano:4b`, 3 repeats (45 checkpoint-samples per system): Speck 37/45 under
`corroborated-1`, 39/45 under `corroborated-2` (and 39/45 for `corroborated-1` scored on the same
judgments); the stateless call 27/45. Deterministic: Speck 13/15 under both rules; the rule
baseline 9/15. Per checkpoint, with what each got wrong:
[docs/build-5-corroboration.md](../../docs/build-5-corroboration.md), section 6. Reports:
`eval/results/experiments/challenge-5/`. These cases have now been seen; a further rule needs a
new locked set.
