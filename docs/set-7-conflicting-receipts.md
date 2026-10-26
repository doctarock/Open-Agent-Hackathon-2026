# Set 7: conflicting receipts over time (pre-registration)

Written 2026-10-26 with the cases and labels (`eval/challenge-7/`) and committed before any system
was run on them. Results are added in section 6; sections 1-5 are not edited after the runs.

## 1. The question

Each model change made the stateless baseline better: on set 5 the 4B baseline trailed Speck (27/45
against 37/45) and Bolt E4B's led it (42/45 against 36/45) ([bolt-e4b.md](bolt-e4b.md)). Set 6
aimed at context size, and was abandoned as aiming at the wrong limit
([set-6-harder-cases.md](set-6-harder-cases.md)). Set 7 tests what persistent evidence state is
for: a case whose receipts conflict over time, where the answer must be rebuilt at each stage from
the records that still count. Its cases combine, over six or seven stages:

- a correction that is itself corrected, so the original counts again (the cold-chain logger, the
  hotel's night audit);
- a source restating its own facts without a declared replacement (the carrier's setpoint, the
  settlement platform's second settlement, the maintenance system's defect status);
- a stale or dependent source that keeps repeating an old answer (the selling agent, operations
  control, the travel agency relaying the hotel);
- a record that sounds like the opposite of what it says ("released for use" that confirms the
  excursion; a cleared part that does not reinstate a withdrawn release);
- conflicts that stay unresolved, where abstaining is right.

Context plays no part: the largest stateless prompt is about 1,340 tokens.

## 2. Systems, models and protocol

- **Systems**: Speck (persistent), Speck rebuilt from scratch at each checkpoint, and the stateless
  model baseline, unchanged. Rule `corroborated-1` (the default) only.
- **Models**: Nemotron 3 Nano 4B on local Ollama (`nemotron-3-nano:4b`) and Nemotron 3.5 Bolt E4B
  (`nvidia/nemotron-3.5-bolt-e4b`, through Meterless Nightshift), both with reasoning off,
  temperature 0.1, replies capped at 4,096 tokens.
- **Runs**: 3 repeats per model, alternated 4B, Bolt, 4B, Bolt, 4B, Bolt
  (`npm run eval:challenge -- --set 7 --live --repeats 1 --out <model>/rep<n>`), then one
  deterministic run (`npm run eval:challenge -- --set 7`). 75 checkpoint-samples per system and
  model. No run is discarded; failed calls count as errors. If a run cannot complete (a service
  outage), it is rerun and the failed attempt kept and reported.
- **Not changed**: no rule, prompt, prior, threshold, engine budget or label.

## 3. Measures

As for set 5: matches the label; concluded where abstaining was right; correct where a conclusion
was due; unsupported conclusions; refuted explanation kept out of current; withdrawn or replaced
evidence kept out of support; model replies valid; checkpoint errors. Per model, system and
checkpoint, with denominators.

## 4. Predictions (written before any run)

- **P1 (the main one).** On Bolt, the stateless baseline matches the label in fewer than 85% of
  set 7's checkpoint-samples (its set 5 rate was 93%).
- **P2.** On the 4B, the stateless baseline matches the label in fewer than 60% (its set 5 rate).
- **P3.** On both models, Speck abstains rightly in at least 12 of the 18 checkpoint-samples where
  abstaining is right, and the stateless baseline in fewer.
- **P4.** On both models, Speck keeps replaced evidence out of its support at least as often as the
  stateless baseline.
- **P5 (a predicted Speck loss).** At `hotel-chargeback@no-show`, Speck concludes "no-show" by
  corroboration in most samples: it counts the agency's relay of the hotel's report as a second
  source.
- **P6 (a predicted Speck cost).** Where a conclusion is due while a weak record still counts
  against it (`cold-chain@probe-and-power`, `cold-chain@qa-ruling`, `property@settled`,
  `property@resettled`, `hotel@late-checkin`, `hotel@dispute`), Speck abstains in a substantial
  share of samples, because `corroborated-1` needs nothing recorded against and its own threshold
  is hard to reach with capped model judgments. So on Bolt, Speck's "correct where a conclusion was
  due" is predicted to be lower than the stateless baseline's.
- **P7.** No prediction is made that Speck matches the label more often than the stateless
  baseline overall. The test is whether, on these cases, the stateless call's errors reappear on
  the better model (P1), and in which kind of checkpoint.

Per checkpoint (✓ likely right, ✗ likely wrong, ? uncertain):

| Checkpoint | Label | Stateless, 4B | Stateless, Bolt | Speck |
|---|---|---|---|---|
| cold-chain @ arrival | abstain | ✗ | ? | ✓ |
| cold-chain @ second-logger | abstain | ✗ | ? | ✓ |
| cold-chain @ logger-voided | intact | ? | ✓ | ✓ |
| cold-chain @ notice-corrected | abstain | ✗ | ✗ | ✓ |
| cold-chain @ probe-and-power | excursion | ? | ✓ | ? |
| cold-chain @ qa-ruling | excursion | ? | ✓ | ? |
| property @ booked | not settled | ✓ | ✓ | ✓ |
| property @ settled | settled | ✓ | ✓ | ? |
| property @ reversed | not settled | ? | ✓ | ✓ |
| property @ agent-update | not settled | ✗ | ? | ✓ |
| property @ resettled | settled | ? | ✓ | ? |
| property @ registered | settled | ✓ | ✓ | ✓ |
| aircraft @ defect | grounded | ✓ | ✓ | ✓ |
| aircraft @ repaired | released | ✓ | ✓ | ✓ |
| aircraft @ part-notice | abstain | ✗ | ? | ✓ |
| aircraft @ release-withdrawn | grounded | ? | ✓ | ✓ |
| aircraft @ notice-retracted | grounded | ✗ | ? | ✓ |
| aircraft @ new-release, directive | released | ✓ | ✓ | ✓ |
| hotel @ booked | abstain | ? | ✓ | ✓ |
| hotel @ no-show | abstain | ✗ | ✗ | ✗ |
| hotel @ late-checkin | stayed | ✓ | ✓ | ? |
| hotel @ dispute | stayed | ? | ? | ? |
| hotel @ reattributed | no-show | ? | ? | ✓ |
| hotel @ refunded | no-show | ✓ | ✓ | ✓ |

## 5. What would count against the idea

If on Bolt the stateless baseline matches the label in 85% or more (P1 fails), these cases did not
find a limit of the stateless call at this model's level, and the project's claim stays at
traceability. If Speck does no better than the stateless call at the abstain checkpoints (P3
fails), its caution is not what separates them here. Either result is reported the same way.

## 6. Results

(Added after the runs, below this line.)
