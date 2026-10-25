# Challenge cases (Build 4)

Five cases written for Build 4, in domains no earlier suite uses (payroll, shipping, insurance,
refunds, inventory). They test the Build 4 changes on cases they were not designed on, and
include cases where Evidence Desk is expected to struggle.

Run with `npm run eval:challenge` (deterministic) and `npm run eval:challenge -- --live`
(the configured Nemotron endpoint). Live reports are kept under
`eval/results/experiments/challenge/`.

## How they were written, and what that does and does not guarantee

- **Labels first.** Every case file, including its labels, was written and locked
  (`expectations.lock.json`, SHA-256 per file) before any system was run on it and before the
  Build 4 policy was implemented. The runner refuses to score files that differ from the lock,
  so a label changed after seeing results shows in git as a lock change.
- **Same labelling rules as the cross-domain suite** (`eval/cross-domain/README.md`): a label is
  what a careful human investigator would conclude from the records visible at that checkpoint,
  or `null` (abstain) when the evidence conflicts or the deciding record is missing. `invalidated`
  lists only records replaced by a declared `supersedes` or withdrawn by the investigator.
- **Equal priors.** Every hypothesis in a case starts at the same prior (0.5 for two, 0.33 for
  three), so the priors could not be chosen to suit the policy.
- **Not independent of the author.** The same person wrote these cases and the Build 4 change.
  They knew the policy when writing them. The lock proves only that the labels did not move
  after the results were seen.

## Cases

| Case | Category | What a careful investigator concludes |
|---|---|---|
| `payroll-final-pay-returned` | corrected evidence | paid; then not paid (the bank returns the settlement, declared; payroll changes its own status to unpaid, undeclared) |
| `customs-hold-lifted` | contradictory evidence | abstain (broker and terminal disagree); then released (the agency behind the hold completes its inspection; the terminal's hold notice is never replaced by its source) |
| `claim-decision-missing` | missing information | abstain (a recommendation and the customer's expectation agree, but no decision exists); then declined (one authoritative record) |
| `refund-settlement-withdrawn` | withdrawn evidence | received; then abstain (the only settlement is withdrawn as another customer's) |
| `stock-recount` | conflict, then same-source recount | abstain (system and count disagree); then enough (the count app recounts; different systems never replace each other) |

Written expecting Evidence Desk to have difficulty: `customs-hold-lifted` (the hold notice keeps
counting against release) and `claim-decision-missing` at the decision (a single record, however
authoritative, is not corroboration). These are recorded as they come out.
