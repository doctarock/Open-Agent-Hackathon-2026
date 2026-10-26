# Challenge cases, set 6: harder cases for the stateless baseline

**Abandoned after one of its six runs (2026-10-26):** the set aimed at context size, which tests
the prompt window rather than reasoning. Its one saved report and what it showed are in
[docs/set-6-harder-cases.md](../../docs/set-6-harder-cases.md), section 6. The cases stay locked
and seen; set 7 replaces it.

Seven cases written to find the limits of a stateless model call, with two controls where keeping
state should not help. In domains no earlier suite uses: airline baggage, software licensing,
building permits, pharmacy, livestock traceability, tax refunds, warranty repairs. Reported apart
from every other suite. The pre-registration, with the predictions, is
[docs/set-6-harder-cases.md](../../docs/set-6-harder-cases.md).

## How they were written, and what that does and does not guarantee

- **Labels first.** Every case file, including its labels, was written and locked
  (`expectations.lock.json`, SHA-256 per file) before any system, model or deterministic, was run
  on them. The runner refuses to score files that differ from the lock. The files were generated
  by `scripts/challenge-6-cases.mjs`, kept as the record of how they were made.
- **Same labelling rules** as `eval/challenge-5/README.md`: a label is what a careful human
  investigator would conclude from the records visible at that checkpoint, or `null` (abstain)
  when the evidence conflicts or the deciding record is missing. `invalidated` lists only records
  replaced by a declared `supersedes` or withdrawn by the investigator. `unsupported` lists
  hypotheses the visible evidence does not support at all. Equal priors (0.5).
- **What the stateless baseline sees** (unchanged): every visible record, with "replaces …" where
  the source declares it; records the investigator has withdrawn are removed from its prompt. So a
  withdrawal costs it nothing, and the difficulty has to come from what it must work out itself.
- **Not independent of the author.** Written by the project's author, knowing where each approach
  has failed before (a correction of a correction, a restating source, a long prompt), and
  deliberately aimed at the stateless call. Two controls and one case aimed at Speck are included
  so that the set does not only reward keeping state. The lock proves only that the labels did not
  move after results were seen.
- **22 checkpoints**: 16 labelled with a conclusion, 6 labelled abstain.

## Cases

| Case | Aimed at | What a careful investigator concludes |
|---|---|---|
| `baggage-scan-restored` | the stateless call: a correction chain | arrived (loaded, arrival scan); abstain (the scan is voided as another bag's; one search did not find it); arrived (the void is reversed, so the original scan stands; the bag is located) |
| `licence-status-flips` | the stateless call: restatements with no declared replacement | active; inactive (suspended for non-payment); active (reinstated); inactive (revoked; a paid invoice does not make it active) |
| `permit-long` | the stateless call: a buried correction, a lagging feed, and a prompt that outgrows a 4,096-token window (72 records by the last checkpoint) | abstain (under assessment); approved; abstain (the consent is withdrawn as issued in error, while the portal, whose resync is suspended, still shows it); refused; refused (a review is lodged; the determination stands); refused |
| `prescription-reversal-withdrawn` | Speck: a withdrawn correction restores the original | dispensed; abstain (the pharmacy's reversal conflicts with the patient app's collection); dispensed (the investigator withdraws the reversal as another patient's) |
| `livestock-late-original` | the stateless call: a correction that arrives before the record it replaces | abstain (the register corrects the destination to the feedlot; no intake yet); feedlot (the late original still names the saleyards; the feedlot records the intake) |
| `refund-single-authority` | control: one authoritative record | abstain (approved is not paid); paid |
| `repair-two-sources` | control: independent agreement | not returned (in repair); returned (dispatched, delivery signed) |

In `permit-long` the consent is `N6P-13` and its withdrawal `N6P-31`, one record among 72.
