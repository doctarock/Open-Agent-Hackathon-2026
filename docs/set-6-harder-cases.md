# Set 6: harder cases, and how the gap moves as the model improves (pre-registration)

Written 2026-10-26, with the cases and labels (`eval/challenge-6/`), and committed before any
system was run on them. Results are added below this pre-registration, which is not edited after
the runs.

## 1. The question

Each model change so far made the stateless baseline better. With Nemotron 3 Nano 4B it trailed
Speck on set 5 (27/45 against 37/45); with Nemotron 3.5 Bolt E4B it led (42/45 against 36/45), and
it stopped citing the replaced delivery scan ([bolt-e4b.md](bolt-e4b.md)). The earlier cases may
simply be easy for a capable model. Set 6 asks whether there is a level of difficulty at which a
stateless call, even on the better model, still fails where explicit evidence state does not:

- **correction chains**: a correction that is itself reversed, so the original counts again;
- **restatements**: a source that changes its own facts without declaring a replacement;
- **long streams**: a decisive correction buried among routine records, beside a feed that keeps
  showing the old status, in a prompt that grows past the 4B's 4,096-token window;
- **out-of-order arrival**: a correction that arrives before the record it replaces.

It also includes two controls (one authoritative record; plain agreement) and one case aimed at
Speck (a withdrawn correction), so that the set does not only reward keeping state.

## 2. Systems, models and protocol

- **Systems**: Speck (persistent), Speck rebuilt from scratch at each checkpoint, and the stateless
  model baseline, exactly as in every earlier suite. Rule `corroborated-1` (the default) only;
  `corroborated-2` is not run on this set.
- **Models**: Nemotron 3 Nano 4B on local Ollama (`nemotron-3-nano:4b`, Q4_K_M, the 4,096-token
  window Ollama gives it) and Nemotron 3.5 Bolt E4B (`nvidia/nemotron-3.5-bolt-e4b`, through
  Meterless Nightshift). Both with reasoning off, temperature 0.1, replies capped at 4,096 tokens.
- **Runs**: 3 repeats per model, alternated 4B, Bolt, 4B, Bolt, 4B, Bolt
  (`npm run eval:challenge -- --set 6 --live --repeats 1 --out <model>/rep<n>`), and one
  deterministic run (`npm run eval:challenge -- --set 6`). 66 checkpoint-samples per system and
  model. No run is discarded; failed calls are counted as errors.
- **Not changed for this set**: no rule, prompt, prior, threshold or label. The only code added
  before the lock is measurement: each stateless checkpoint now records its prompt length and the
  prompt tokens the endpoint reported (`CheckpointOutcome.prompt`).

## 3. Measures

As for set 5: conclusion matches the label; concluded where abstaining was right; correct where a
conclusion was due; unsupported conclusions; refuted explanation kept out of current; withdrawn or
replaced evidence kept out of support; model replies valid; checkpoint errors. Added: the stateless
prompt's length and reported tokens per checkpoint. Every count is reported per model and system,
with its denominator, and per checkpoint.

## 4. Predictions (written before any run)

- **P1.** On the 4B, the stateless baseline matches the label in fewer than 60% of set 6's
  checkpoint-samples (its set 5 rate was 27/45, 60%).
- **P2.** On Bolt, the stateless baseline matches the label in fewer than 85% of set 6's
  checkpoint-samples (its set 5 rate was 42/45, 93%). This is the main prediction: the harder
  cases bring back failures the better model had removed.
- **P3.** On both models, Speck keeps withdrawn or replaced evidence out of its support at least as
  often as the stateless baseline, and more often on at least one.
- **P4 (context).** At `permit-long@review-pending` the 4B stateless prompt (about 18,750
  characters, an estimated 4,700 tokens) exceeds the 4,096-token window, and the 4B stateless call
  is wrong or errors there in at least 2 of 3 samples; on Bolt (65,536 tokens) it is not truncated.
  If the reported prompt does not exceed the window, P4 is void and the case counts as a burial
  test only.
- **P5 (controls; predicted losses for Speck).** At `refund-single-authority@paid` and
  `repair-two-sources@in-repair`, where one authoritative record settles the case, the stateless
  baseline is right on both models, and Speck abstains in most samples.
- **P6 (aimed at Speck).** At `prescription-reversal-withdrawn@reversal-withdrawn` Speck concludes
  "dispensed" once the reversal is withdrawn, in most samples on both models.
- **P7 (what is not predicted).** No prediction is made that Speck is more accurate than the
  stateless baseline overall on set 6. Speck's known weaknesses (its own threshold concluding from
  one source's records, corroboration from weak agreement, abstaining where one record settles the
  case) are present in this set too, and are scored the same way.

Per checkpoint, the expectation behind P1-P6 (✓ likely right, ✗ likely wrong, ? uncertain):

| Checkpoint | Label | Stateless, 4B | Stateless, Bolt | Speck (both) |
|---|---|---|---|---|
| baggage @ arrived | arrived | ✓ | ✓ | ✓ |
| baggage @ scan-voided | abstain | ✗ | ? | ✓ |
| baggage @ void-reversed | arrived | ? | ✓ (may cite the void) | ✓ |
| licence @ active / suspended / reinstated | active / inactive / active | ? | ✓ | ✓ |
| licence @ revoked | inactive | ? | ✓ | ? (one source supports "inactive") |
| permit @ lodged | abstain | ✗ | ? | ✓ |
| permit @ approved | approved | ✓ | ✓ | ✓ |
| permit @ approval-withdrawn | abstain | ✗ | ? | ? (the portal's records, one source) |
| permit @ refused | refused | ✓ | ✓ | ✓ |
| permit @ review-lodged, review-pending | refused | ✗ (context) | ✓ | ✓ |
| prescription @ dispensed | dispensed | ✓ | ✓ | ✓ |
| prescription @ reversed | abstain | ✗ | ? | ✓ |
| prescription @ reversal-withdrawn | dispensed | ✓ | ✓ | ✓ |
| livestock @ correction | abstain | ✗ | ? | ✓ |
| livestock @ late-original | feedlot | ? | ✓ | ✓ |
| refund @ approved | abstain | ✗ | ? | ✓ |
| refund @ paid | paid | ✓ | ✓ | ✗ |
| repair @ in-repair | not returned | ✓ | ✓ | ✗ |
| repair @ returned | returned | ✓ | ✓ | ✓ |

## 5. What would count against the idea

If on Bolt the stateless baseline matches the label as often on set 6 as on set 5 (P2 fails), the
harder cases did not find a limit of the stateless call at this model's level, and the project's
claim stays at traceability: Speck records which record stopped counting and why, without being
more accurate. That result is reported the same way.

## 6. Results

(Added after the runs, below this line.)

**Set 6 was abandoned after one of its six runs (2026-10-26).** After the first repeat on the 4B,
the owner judged that the set aimed at the wrong limit: context size tests the prompt window, not
reasoning, and the intended test is a scenario with more conflicting receipts over time. The
runs were stopped; the second (Bolt, repeat 1) was killed before it saved anything. No prediction
is scored, because the registered protocol (3 repeats per model) was not completed. The one
saved report is kept: `eval/results/experiments/challenge-6/nano-4b/rep1/r1.json`. The cases stay
locked and seen; set 7 is new, with its own lock.

What that one repeat (4B, 22 checkpoint-samples per system) showed, as observations only:
- Speck 15/22, Speck rebuilt each time 11/22, stateless 14/22 (3 errors: the model's replies for
  the prescription case failed the contract twice). Withdrawn or replaced evidence kept out of
  support: Speck 9/9, stateless 8/9.
- **The prompt did overflow, earlier than estimated.** The 4B's tokenizer gives about 2.8
  characters per token, not the 4 assumed in P4. From `permit-long@refused` (11,435 characters)
  the reported prompt tokens stop at 2,050 while the prompt keeps growing to 19,041 characters:
  Ollama truncated it. The stateless call still answered "refused" at all three truncated
  checkpoints, because the latest records survived the cut. So in this sample context size was
  not where the stateless call failed.
- **Speck rebuilt each time is not a fair system on a long case**: it assesses every visible record
  in one run, over the engine's chunk budget (8 chunks of 2 records), so records stay pending and
  it abstains at every `permit-long` checkpoint after the first. The persistent system assesses
  only each stage's new records and is not affected.
- Speck's failures were the known ones: abstaining where one record settles the case (`refund@paid`,
  `repair@in-repair`, `prescription@dispensed`), its own threshold concluding "approved" from the
  lagging portal's records (`permit@approval-withdrawn`), and abstaining where corroboration was
  weak (`baggage@void-reversed`, `licence@revoked`). The stateless call's were concluding where it
  should wait (4 of 6: `baggage@scan-voided`, `livestock@correction`, `permit@approval-withdrawn`,
  `refund@approved`).
