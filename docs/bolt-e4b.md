# Model change: Nemotron 3.5 Bolt E4B through Meterless Nightshift (2026-10-26)

Every live result before this date came from Nemotron 3 Nano 4B on local Ollama (the assessor
and the stateless baseline) and Nemotron Nano 9B v2 (Speck's chat). From 2026-10-26 both roles
use **`nvidia/nemotron-3.5-bolt-e4b`**, served by NVIDIA through Meterless Nightshift 1.2.7. The
suites, repeats, rules and labels below are exactly those of Builds 4 and 5; nothing was tuned.
The 4B results stay as recorded; the two models' results are never pooled.

## 1. What changed, and why

- **The model.** The owner chose Bolt E4B to replace the 4B and the 9B. Nightshift 1.2.7 lists
  it both on the device (`local-runtime/nemotron-3.5-bolt-e4b`) and in the cloud
  (`nvidia/nemotron-3.5-bolt-e4b`). The on-device one was not usable: the runtime's local lane
  reported `no_ready_lane` and the model was not downloaded. The owner chose the cloud one.
  **Calls now leave the machine** (only this repository's sample data is sent). "Runs on one
  consumer GPU" describes the 4B results, not the current default.
- **Pinned models.** Nightshift's model ids had been routing modes only (`meterless/auto`, ...),
  which let the runtime choose: in the 2026-10-24/25 receipts it chose 30B and 550B Nemotrons.
  A model the runtime lists by name (`<provider>/<model>`) is now accepted as a *pinned model*,
  so every assessor and baseline call goes to one named model, and the response names it.
  - Speck's Meterless contract (`patches/speck-meterless-provider.patch`, regenerated):
    `isMeterlessPinnedModel`, `isMeterlessTarget`; the probe lists pinned models apart from
    routing modes; a Speck processor accepts either; the System view keeps a pinned model. A
    server that lists named models but no routing mode is still not a Meterless Runtime. Speck
    test: "a model the runtime lists by name is a pinned model". Speck's cognition is untouched.
  - Evidence Desk: the default `METERLESS_MODEL` is `nvidia/nemotron-3.5-bolt-e4b`
    (`EVIDENCE_DESK_METERLESS_MODEL`); a pinned assessor model must name a Nemotron; `npm run
    configure` picks it without asking when the runtime serves it (otherwise offers the runtime's
    routing modes and Nemotron models), and points Speck's
    chat at the same model; `npm run eval:reasoning -- --only bolt-e4b` runs the held-out and
    regression groups on it.
- **A failure found and fixed before any counted run.** In the first live comparisons, Speck's
  first assessment of every case failed twice. Recorded traffic showed why: a case's first chunk
  has no prior conclusion, so its prompt opens with the vendored Meterless engine's instructions
  ("Log every action as '>> action'", "End every non-final chunk with [STATE_CHECKPOINT]"). Bolt
  follows them and writes `>> action` before valid JSON (3 of 3 tries, identical). Nightshift's
  JSON mode then rejects the whole answer (HTTP 502, `invalid_json_output`). The 4B ignored the
  instruction. The prompt was **not** changed (`corroborated-1`'s prompt is frozen): Evidence
  Desk no longer asks Nightshift for JSON mode, and Speck's contract check, which already takes
  the first JSON object in a reply, validates every field and retries
  (`src/reasoning/nemotron.ts`, `jsonMode`; test "Nightshift is not asked for JSON mode"). Other
  endpoints keep JSON mode. The four comparisons made before the fix are kept apart, uncounted,
  in `eval/results/experiments/bolt-e4b/2026-10-26-before-json-mode-fix/`.

Settings for every Bolt run: temperature 0.1, reasoning off (`reasoning_effort: none`), replies
capped at 4,096 tokens, the same prompts and contracts as the 4B runs. Every response named
`nvidia/nemotron-3.5-bolt-e4b` as the model that served it.

## 2. Results

Counts are over these cases only. **Every suite below had been seen before** (the held-out and
regression cases during development, the Build 4 challenge cases in Build 4, set 5 in Build 5),
so this is a re-evaluation of the same system on a different model, not a test of a new rule.

### 2a. Side by side on the two prepared cases (6 live samples per case)

`eval/results/comparisons/{disputed-delivery,eval-correction-supersedes}/2026-10-26T05-3*`,
counted in `eval/results/comparisons/SUMMARY.md`.

| Bolt E4B, 6 samples each | Stateless | Speck |
|---|---|---|
| Delivery, initial evidence: concluded | nothing 6/6 | nothing 6/6 (leading "delivered", 0.54) |
| Delivery, after the correction: concluded | "misdelivered" 6/6 | "misdelivered" 6/6, all by corroboration |
| ... cites the replaced scan `EV-CAR-003` | **0/6** | 0/6 |
| ... recorded why its conclusion changed | 0/6 | 6/6 |
| Bank return, before the return: matches the label (paid) | 6/6 | 6/6 |
| Bank return, after the return: matches the label (unpaid) | 6/6 | 6/6, all by corroboration |
| Errors | 0/12 | 0/12 |

With the 4B on 2026-10-25 the stateless call cited the replaced scan in 12/12 delivery samples
and answered "unpaid" before the return in 12/12. **With Bolt neither happens.** Both approaches
reach the right answer on both cases; the difference left is that only Speck records why its
conclusion changed and which record stopped counting.

### 2b. Held-out and regression cases (3 repeats, 48 labelled checkpoint-samples per system)

`eval/results/experiments/reasoning/2026-10-26-bolt-e4b/` (summary.md). Rule `corroborated-1`.

| | Speck | Speck, rebuilt each time | Stateless | Speck, 4B (Build 4) | Stateless, 4B |
|---|---|---|---|---|---|
| Matches the label | 42/48 | 42/48 | 42/48 | 40/48 | 18/48 |
| Abstained when a conclusion was due | 6/30 | 6/30 | 0/30 | 5/30 | 0/30 |
| Unsupported conclusions | 0/24 | 0/24 | 0/36 | 3/28 | 21/45 |
| Refuted explanation kept out of current | 27/27 | 27/27 | 27/27 | 27/27 | 18/27 |
| Withdrawn or replaced evidence kept out of support | 15/15 | 15/15 | **12/15** | 15/15 | 9/15 |
| Model replies valid | 93/93 | 114/114 | 48/48 | 93/96 | 48/48 |

The baseline's three lapses are one checkpoint, `return-cancelled@return-cancelled`, in every
repeat: it reached the labelled "paid" but cited the two records that the source had withdrawn or
replaced. Speck's six abstentions are both checkpoints of `misattributed-scan`, in every repeat.

### 2c. Build 4 challenge cases (5 locked cases, 3 repeats, 30 checkpoint-samples per system)

`eval/results/experiments/challenge/2026-10-26-bolt-e4b/`. Rule `corroborated-1`.

| | Speck | Stateless | Speck, 4B | Stateless, 4B |
|---|---|---|---|---|
| Matches the label | 18/30 | **21/30** | 18/30 | 18/30 |
| Concluded where abstaining was right | 3/12 | 9/12 | 3/12 | 12/12 |
| Correct where a conclusion was due | 9/18 | 18/18 | 9/18 | 18/18 |
| Withdrawn or replaced evidence kept out of support | 6/6 | 6/6 | 6/6 | 5/6 |

Speck's one false conclusion is the one Build 4 found: `claim@recommendation`, "approved" by
corroboration, 3/3. The rebuilt-each-time system matched the persistent one at every
checkpoint-sample.

### 2d. Set 5 (8 locked cases, 3 repeats, 45 checkpoint-samples per system)

`eval/results/experiments/challenge-5/2026-10-26-bolt-e4b-reference/rep1-3/` (R, `corroborated-1`)
and `.../2026-10-26-bolt-e4b-candidate/rep1-3/` (C, `corroborated-2`, which also scores C~1:
`corroborated-1` on C's own runs and judgments), run alternately R, C, R, C, R, C.

| Bolt E4B | Speck R | Speck C | Speck C~1 | Stateless | Speck R, 4B | Speck C, 4B | Stateless, 4B |
|---|---|---|---|---|---|---|---|
| Matches the label | 36/45 | 34/45 | 37/45 | **42/45** | 37/45 | 39/45 | 27/45 |
| Concluded where abstaining was right | 9/18 | 3/18 | 3/18 | 3/18 | 8/18 | 6/18 | 15/18 |
| Correct where a conclusion was due | 27/27 | **19/27** | 22/27 | 27/27 | 27/27 | 27/27 | 27/27 |
| Withdrawn or replaced evidence kept out of support | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 6/9 |
| Model replies valid | 93/93 | 93/93 | (same calls) | 45/45 | 93/94 | 93/93 | 42/48 |

- **R's 9 false conclusions** are `venue-booking@phone`, `utility-disconnection@scheduled` and
  `referral-attendance@booked` ("not seen"), 3 each, all by Speck's own threshold. The
  stateless call made only the last of these.
- **C loses 8 correct conclusions** that R keeps: "approved" after the leave was recorded (3),
  "confirmed" from the venue's own record (3) and "seen" from the clinic letter (2). On the 4B, C
  lost none. Only the leave losses come from the rule's own check (C~1 concludes there by
  corroboration); the other 5 occur under C~1 too, so they came with the changed prompt. C also
  removes R's false conclusions at `venue-booking@phone` and `utility-disconnection@scheduled`,
  and so does C~1: again the prompt, not the check.
- **Under C, the persistent and rebuilt systems differ** (34/45 and 39/45, at `leave-approval@recorded`
  and `referral-attendance@letter`). They make separate model calls, so this can be sampling; it
  is reported, not attributed. Under R they agree at every checkpoint-sample, as on the 4B.

### 2e. Sponsor verification

`eval/results/sponsors/2026-10-26T07-05-56-787Z.json` (`npm run sponsors:verify`, Zetaris live,
Nightshift with the pinned Bolt E4B): every sponsor OBSERVED, exit 0. 5 of 5 model calls went
through Nightshift and were answered, each response naming `nvidia/nemotron-3.5-bolt-e4b`; 0
contract rejections; 5 model-judged evidence objects in Speck, all at reliability 0.4 or below.

## 3. What this shows, and does not

- **The stateless baseline's errors were largely the 4B's.** With Bolt it handles the prepared
  corrections correctly, almost never concludes without support (0/36, 0/27, 3/30), and is the
  most accurate system on both locked sets (21/30, 42/45). This agrees with the 4B's reasoning-on
  experiment, where a better reading also closed most of the gap.
- **Speck's accuracy is unchanged by the stronger model** on the locked sets (18/30, 36/45 against
  18/30, 37/45). Its errors are its own policy's: abstaining where one record settles the case,
  corroboration from weak agreement (`claim@recommendation`), and its own threshold concluding from
  one source's two records at prior 0.5.
- **What still separates them is evidence handling and the record of revision.** Speck kept
  withdrawn or replaced evidence out of its support in every sample (15/15, 6/6, 9/9); the
  baseline did not in 3 of 15 held-out checkpoint-samples. Only Speck records which record stopped
  counting and why the conclusion changed (6/6 against 0/6 in the comparisons).
- **`corroborated-2` is worse on Bolt** (19/27 correct where due). It stays an experimental option;
  the default stays `corroborated-1`. Neither rule was changed.
- **No accuracy advantage is claimed for Speck**, and with Bolt the stateless call is ahead on both
  locked sets.

## 4. Limits

- One model, one temperature, reasoning off, three repeats per suite and six samples per case.
- All the suites had been seen; there is no new locked set for Bolt.
- The model is served by NVIDIA through Nightshift: availability and the exact weights are the
  provider's. "E4B" is the provider's name; its size was not measured here.
- The on-device Bolt was not run.
- The prompt-size measurements in the README (*Small model, small context*) were taken on the 4B;
  the prompts are the same, but Bolt's own token counts were not measured.
