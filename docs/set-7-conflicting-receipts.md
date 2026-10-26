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

Run 2026-10-26 08:27-10:19 UTC as registered: 3 repeats per model, alternated, no errors, none
discarded. Reports: `eval/results/experiments/challenge-7/{nano-4b,bolt-e4b}/rep1-3/`; deterministic:
`eval/results/challenge-7-fixture.json`. 75 checkpoint-samples per system and model.

### 6a. Totals

| | Speck, 4B | Speck rebuilt, 4B | Stateless, 4B | Speck, Bolt | Speck rebuilt, Bolt | Stateless, Bolt |
|---|---|---|---|---|---|---|
| Matches the label | 32/75 | 26/75 | 35/75 | 33/75 | 31/75 | **45/75** |
| Concluded where abstaining was right | 9/18 | 9/18 | **18/18** | 9/18 | 9/18 | 12/18 |
| Correct where a conclusion was due | 23/57 | 17/57 | 35/57 | 24/57 | 22/57 | 39/57 |
| Concluded the wrong explanation where one was due | **0/57** | 0/57 | 20/57 | **0/57** | 0/57 | 3/57 |
| Unsupported conclusions | 0/32 | 0/26 | 18/73 | 0/33 | 0/31 | 0/54 |
| Replaced evidence kept out of support | **48/48** | 48/48 | 10/48 | **48/48** | 48/48 | 39/48 |
| Model replies valid | 174/179 | 345/378 | 75/75 | 174/174 | 381/381 | 75/75 |

Deterministic (fact rules, no model): Speck 17/25, Speck rebuilt 17/25, the rule baseline 18/25.

### 6b. The predictions

| | Prediction | Result | |
|---|---|---|---|
| P1 | Bolt stateless below 85% | 45/75 (60%; 93% on set 5) | **met** |
| P2 | 4B stateless below 60% | 35/75 (47%) | met |
| P3 | Speck abstains rightly in at least 12/18, the stateless call in fewer | Speck 9/18 on both models; stateless 0/18 (4B), 6/18 (Bolt) | **not met** (Speck fewer than 12) |
| P4 | Speck keeps replaced evidence out at least as often | 48/48 against 10/48 (4B) and 39/48 (Bolt) | met |
| P5 | Speck concludes "no-show" at `hotel@no-show` (predicted loss) | 3/3 on both models | met (a loss) |
| P6 | Speck's correct-where-due below the stateless call's on Bolt (predicted cost) | 24/57 against 39/57 | met (a cost) |
| P7 | No overall accuracy claim | the stateless call matches the label more often on both models | |

### 6c. Where each approach failed

- **The stateless call's errors are errors of commission, and they are the ones state is for.**
  - On the 4B: it concluded at all 18 checkpoint-samples where waiting was right, concluded the
    wrong explanation in 20 of 57 where one was due, and leaned on a replaced record in 38 of 48.
  - On Bolt these fall but do not vanish. Its wrong conclusions are at the corrected corrections:
    `cold-chain@notice-corrected` ("excursion" while the loggers conflict again, 3/3),
    `aircraft@notice-retracted` ("released" because the part was cleared, though the release was
    still withdrawn, 3/3), and both loggers' first readings (`arrival`, `second-logger`, 3/3 each).
    It abstained at `hotel@reattributed` and `@refunded` (6/6) rather than following the chain back
    to the night audit's no-show, and leaned on a replaced record in 9 of 48.
- **Speck's errors are errors of omission, plus its own threshold.**
  - It never concluded the wrong explanation (0/57, both models), never leaned on a replaced record
    (48/48) and made no unsupported conclusion.
  - But it abstained in 33-34 of 57 checkpoint-samples where a conclusion was due: every
    `aircraft` checkpoint after the withdrawal, `cold-chain@probe-and-power`, `property@booked`,
    `@reversed`, `@resettled`, `@registered`, and `hotel@late-checkin`, `@dispute`. These are the conflicts P6 predicted:
    `corroborated-1` needs nothing recorded against the conclusion, and Speck's own threshold is
    hard to reach with judgments capped at 0.4.
  - Its false conclusions were `hotel@no-show` (the predicted dependent-source corroboration, P5)
    and "intact" at `cold-chain@second-logger` and `@notice-corrected` (3/3 each, both models), by
    **Speck's own threshold** (route `speck-threshold`): at prior 0.5, two supporting records from two
    sources clear 0.6 even with the pallet-face logger counting against. This is the threshold
    weakness found in Build 5.
- **The model hardly changes Speck** (32/75 and 33/75): its outcomes are set by its policy. It
  changes the stateless call a great deal (35/75 to 45/75, wrong conclusions 20 to 3, replaced
  evidence leaned on 38 to 9).

### 6d. What this shows, and does not

- These cases found a limit of the stateless call on the better model (P1): with conflicting
  receipts over time, Bolt's stateless call fell from 93% on set 5 to 60%, and its failures are at
  the checkpoints where a correction was itself corrected or a cleared fact did not undo a
  withdrawal.
- Speck did not turn that into accuracy. It avoided every one of those errors of commission, but by
  abstaining far too often; on both models the stateless call matched the label more often. What
  Speck offers on these cases is that when it concludes, it is never the wrong explanation and never
  rests on replaced evidence (0/57, 48/48), and its abstentions say what is missing.
- The rebuilt-each-time system was within the engine's budget on every checkpoint here (15 records
  or fewer), so its differences from the persistent one come from separate model calls, not from
  pending records.
- One locked set, written by the project's author, four cases, three repeats per model.
