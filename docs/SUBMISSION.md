# Speck Evidence Desk: submission summary

Track: **Reasoning Architecture**.

## Problem

An ordinary stateless model call answers from whatever evidence it is handed, from scratch each
time. When a source later corrects a record (a bank returns a payment, a carrier amends a delivery
scan), nothing connects the earlier conclusion to the record that has just been replaced. The call
may keep its old answer, may keep citing the replaced record, and cannot say what changed or why.

## Approach

Evidence Desk keeps each case in Speck as explicit, inspectable state: the evidence ledger, the
competing explanations and Speck's belief in each, the judgment behind every adjustment (a
deterministic rule or a model interpretation, with the confidence change it made), and every
revision. When a record is corrected or withdrawn, the beliefs that rested on it are rebuilt from
the evidence that still counts, and the old beliefs stay on record as history. A conclusion is
only drawn when Speck's belief clears its threshold; otherwise the page says what the evidence
points to and why that is not yet enough.

## Demonstration

A panel on each case (below the case itself, opened on request and at the end of the guided
demo) runs the case twice, stage by stage, on the same records with the same assessor: once as the evaluation's stateless baseline (a fresh model call per stage, or the
fact rules summed from scratch), once through Speck. It shows what each concluded, what it cited,
what the correction replaced, whether either still leans on the replaced record, and the revision
Speck recorded. Then the judge does it by hand on the case: run, introduce the correction, run
again, and read "why this changed".

## Proof

Real outputs, clearly labelled ([comparison.md](comparison.md) has every sample):

| Live, `nemotron-3-nano:4b`, 6 samples per case | Stateless model call | Speck |
|---|---|---|
| Disputed delivery, after the carrier's correction: concluded | "delivered" 6/6 | nothing 6/6 (pointing to "misdelivered" 5/6) |
| ... cited the replaced delivery scan as support | 6/6 | 0/6 |
| ... recorded why its conclusion changed | 0/6 | 6/6 |
| Bank return, before the return: matches the pre-registered label | 3/6 (3 unsupported "unpaid" claims) | 6/6 |
| Bank return, after the return: matches the label | 5/6 | **0/6** (unresolved: the 0.4 cap on model-judged evidence) |

Deterministic fixtures, the test suite and the evaluation are below. Persistence alone shows no
measurable accuracy benefit, and Speck abstains more often than the baseline; the consistent
difference is traceability.

## Impact

Investigations whose evidence changes, such as disputed deliveries, payment reversals and
procurement amendments, need decisions that can be defended later: which records the decision
rested on, which were corrected, and what was believed before. Evidence Desk makes that the
system's state rather than something reconstructed afterwards, and it says "not established"
instead of over-committing.

## What it is

Evidence Desk investigates a case whose evidence conflicts and changes over time: a disputed
delivery, or a payment the bank later reverses. When a source corrects or retracts a record, the
current conclusion is recomputed from the evidence that still counts. The page says which
record changed the conclusion, which of its facts and judgments went with it, and what the
system believed before.

It runs inside Speck as a plugin and is Speck's main interface here: Speck opens on its
**Evidence** tab, with Speck's other views beside it. Each case is a Speck worker, and its
evidence, beliefs and revisions live in Speck's database. The plugin is approved by hash in
Speck's plugin allowlist. Speck is changed in three small ways, all kept in this repository as
patches that setup applies, never committed to Speck:
- a general `SPECK_HOME_VIEW` setting for the view its interface opens on;
- removing Speck's other bundled plugins, so Evidence Desk is the only one;
- a chat component that answers questions about an investigation from the case summaries
  Evidence Desk publishes to Speck's memory.

The submodule is pinned to upstream Speck.

## What is worth a judge's time

0. **Speck beside a stateless baseline, on the same evidence.** One click on a case page; the
   bank return is deterministic and instant, the disputed delivery makes real Nemotron and Zetaris
   calls. Saved comparisons are listed with their date and configuration, and counted under
   **Evaluation results**, beside every evaluation report and each case's checkpoints.
1. **Corrections actually retract their effect.**
   - Build 2 kept a reversed payment's −0.19 in its belief state, and stalled at 0.47 on the
     held-out bank-return case.
   - Current beliefs are now a replay, through Speck's own revision rule, of the evidence and
     judgments that still count. That checkpoint is now correct (0.66, supported), and no other
     outcome changed.
   - Three correction-sequence regression cases were labelled and committed before the fix: 4/8
     → 8/8.
2. **Every conclusion is traceable.**
   - The page shows, for each current belief, the record, the judgment (a deterministic rule or
     a model interpretation) and the confidence change.
   - The **Execution trace** shows what Zetaris, Meterless, Nemotron and Speck did in each run.
   - Both are read back from saved state, and are identical after a restart.
3. **It does not overclaim.**
   - Model-judged evidence is capped at reliability 0.4, so live conclusions stay tentative; we
     did not tune the cap for the demo.
   - The deterministic baseline over-commits, and so does the live stateless-model baseline;
     Evidence Desk abstains instead.
   - Persistence shows no measurable accuracy benefit, and we say so.
4. **It survives failure.**
   - An exhaustive test kills the process at each of the 39 Speck write points of a run and a
     withdrawal, and again during recovery. Every sequence ends exactly as an uninterrupted run
     would.
   - A record whose assessment keeps failing can be withdrawn before assessment, without
     inventing a judgment.
5. **It uses Speck's own views, and anyone can bring a case.**
   - One guided demo opens on a one-minute TL;DR (the stateless baseline and Speck through one
     correction), walks both cases, then Speck's World view (the runs' actions in time), its
     Memory map (the case's records and assessments linked with Speck's association kinds:
     derived-from, supports, contradicts, inhibitory for a correction) and its chat, which
     answers from the published case summary.
   - It ends on the form for an investigation of the judge's own: a question, competing
     explanations and free-text evidence, weighed by the local model, with corrections.

## Sponsor technologies, as verified in a real run

`npm run sponsors:verify` runs a real two-stage investigation on throwaway storage. It checks
each contribution against an independent source, and reports NOT OBSERVED rather than simulating
one. Its runs on 2026-10-22 (model on local Ollama) and 2026-10-24 (model through Nightshift) reported:

| Sponsor | What it does in Evidence Desk | Observed in the live run |
|---|---|---|
| **Zetaris** | Federated evidence: login, then one SELECT per source table through the platform's REST API (`src/evidence/zetaris-provider.ts`). | 4 SELECTs per run against the local platform. Every assessed record carried one of that run's query tokens. |
| **Meterless Markovian** | Execution engine: the Markovian reference engine (`@meterless/markovian-reference@0.1.0`, commit `1742dec`, vendored unmodified) runs each investigation as bounded chunks with carryover, plus a reflection pass for the explanation. | Run ids, status and chunk counts matched the engine's own `history.json`. Runs are matched by id and the engine's timestamp, because the engine restarts its ids in each process. |
| **Meterless Nightshift** | Model provider, the default: Meterless's HTTP API (OpenAI-compatible, provider contract v4) routes each assessor call to a model (`src/reasoning/meterless.ts`, contract in `speck/src/models/meterless.ts`). | Observed 2026-10-24 (`npm run sponsors:verify`, routing mode `meterless/auto`): all 5 model calls of the two-stage run went to Nightshift's `/v1/chat/completions` and were answered. Each response named the model that served it: `nvidia/nemotron-3-ultra-550b-a55b` for stage 1, `nvidia/nemotron-3.5-lightning-30b-a3b` for stage 2. That is larger than the local 4B model the Nemotron row below describes. In the same run, Zetaris, the Markovian engine, Nemotron and Speck were all OBSERVED. |
| **NVIDIA Nemotron** (local) | Judges how each record bears on each hypothesis, and writes the explanation (`src/reasoning/nemotron.ts`). Every reply is validated by Speck's contract and retried once; decisive rules override it; Speck caps its evidence at 0.4. | `nemotron-3-nano:4b` on local Ollama (4B, 4-bit, 2.8 GB, on one GPU, in a 4,096-token window), reported by the endpoint on every call. Prompts stay at about 900-1,900 tokens, the same in a case's second stage as its first, because the case's state is in Speck rather than the prompt (measured 2026-10-24; README, *Small model, small context*). All model-judged evidence was at reliability ≤ 0.4. Retries were visible: in one run a contract rejection, in another an empty reply. |
| **Speck** | Hosts Evidence Desk as a plugin (a tab, routes and its runtime), and holds each case as a worker with its beliefs, revisions and history (submodule pinned to upstream `8821789`, Speck's dependency-audit fix on top of `29d5bb3`; cognition unmodified; project-local patches add the `SPECK_HOME_VIEW` interface setting, the chat component and the Meterless Runtime provider, and remove Speck's demonstration plugins). Each case's memories are linked with Speck's `reinforceAssociation`, and a case summary is published as a shared memory after each run. | Every belief revision in Speck's event log appears in the trace, exactly once. Inside Speck, the case's events appear in Speck's World view, its linked memories in the Memory map, and the case waits in Speck's task queue without blocking it. Speck's chat, given the published summary, answered a question about the bank return with its conclusion, records and why it changed (one rehearsal, local Nemotron Nano 9B). |
| **Cursor** | The team reports using it to develop Evidence Desk. | Not a runtime component; nothing in a run can observe it. |

**Not demonstrated:**
- NVIDIA's hosted API: the client accepts it, but it was not used.
- Any other NVIDIA infrastructure.

### Verifying the sponsors yourself

The saved report of the 2026-10-24 run, with its full trace, is
[eval/results/sponsors/2026-10-24T02-14-08-828Z.json](../eval/results/sponsors/2026-10-24T02-14-08-828Z.json).
To make your own:

1. **Zetaris:** start the local Zetaris Docker Compose bundle, then run `npm run zetaris:seed`
   (README, *Live Zetaris*).
2. **Nightshift:** start a Meterless Runtime (port 8088 by default). Its token is in the
   runtime's state folder, in `proxy-token`.
3. **Configure:** run `npm run configure` and choose **Meterless Runtime** and **local Zetaris**.
   It checks both against the running services, takes the token hidden, and writes `.env`.
4. **Run:** `npm run sponsors:verify`. It takes a few minutes and uses throwaway storage; `data/`
   is not touched.

It prints one verdict per sponsor and saves the report to `eval/results/sponsor-check.json`. A
copy is kept in `eval/results/sponsors/<time>.json` and never overwritten.

| Verdict | OBSERVED only if | Checked against |
|---|---|---|
| Zetaris | Every assessed record came from a SELECT of that run. | Each record's Zetaris query token, compared with the tokens of the run's SELECTs. |
| Meterless Markovian | Each run's id, status and chunk count match. | The engine's own `history.json`, matched by run id and the engine's timestamp. |
| Meterless Nightshift | Every model call went to the Nightshift endpoint and was answered, and each response named the model that served it. | The endpoint and the `model` field of each response. A routing mode echoed back (`meterless/auto`) does not count as an identity. |
| NVIDIA Nemotron | Model calls were made, the served model is a Nemotron, and Speck holds model-judged evidence at reliability 0.4 or below. | The served model names, and Speck's evidence objects. |
| Speck | Every belief revision in Speck's event log appears in the trace, exactly once. | Speck's raw event log. |

- **Exit status:** 0 when every configured sponsor is OBSERVED; 1 otherwise.
- **Without the services:** it still runs. Each sponsor that was not set up is reported NOT
  OBSERVED, with the reason (for example "EVIDENCE_MODE is not zetaris"), and it exits 1. That
  is the check working, not failing: nothing is simulated in place of a missing service.
- **The model:** `meterless/auto` lets the runtime choose. In the saved run it chose 30B and 550B
  Nemotrons, but only the 4B is required. Set `METERLESS_MODEL=meterless/local` to keep calls
  on the device.

## Results

These are counts over these cases only, not general accuracy.

| | Build 2 | Build 3 onward |
|---|---|---|
| Held-out cases, deterministic (9 checkpoints) | 7/8 correct | 8/8 correct, 0 unsupported conclusions |
| Correction regression cases, deterministic (8 checkpoints) | 4/8 | 8/8; withdrawn or superseded evidence never used as support (5/5) |
| Held-out cases, live `nemotron-3-nano:4b` (single samples) | 5/8 | 5/8, identical per checkpoint |
| Tests | 29 | 139 |

Across two live samples on the held-out cases, the stateless model baseline made 4 unsupported
conclusions each time (4 of 7, then 4 of 6). Evidence Desk made none, but it abstained when a
conclusion was due 3 times in 4, because of the 0.4 cap.

## Try it

```bash
git submodule update --init --recursive && npm run setup   # builds Speck and installs the plugin
npm run speck            # Speck at http://127.0.0.1:4310, opening on the Evidence tab
npm test                 # 139 tests, no credentials or network needed
npm run investigate -- examples/payment-correction-chain/input.json   # one case, JSON in, JSON + trace out, offline
npm run compare          # Speck beside the stateless baseline, deterministic (compare:live with .env)
npm run eval             # deterministic evaluation, both groups
npm run sponsors:verify  # with Zetaris and a Meterless Runtime configured; see Verifying the sponsors yourself
```

The 3-minute walkthrough is in [DEMO.md](../DEMO.md). The design, defect analysis and audit
history are in [build-3-revision.md](build-3-revision.md).

## Known limits

- **One investigation scenario.** The fact rules are hand-written.
- **Few cases.** Seven held-out cases and three regression cases.
- **Supersession is record-level.** A correction replaces a whole record. Facts it doesn't
  restate stop counting, and the page says which.
- **Small model.** The local model is small and inconsistent: live conclusions vary between runs,
  and its explanations often disagree with Speck's state. When they do, they are flagged and
  hidden behind a warning.
- **One write outside Speck's public API.** Retiring a replaced hypothesis uses Speck's
  repository directly, because Speck has no public API for it. The write is isolated and
  verified by reading it back (`src/investigation/speck-compat.ts`).
- **Plugin trust covers the entry module only.** Speck's allowlist hashes the plugin's entry
  file. After a code change, `npm run plugin:install` re-approves it and Speck must be
  restarted. Inside Speck, run progress is polled, not streamed.
- **Speck's chat is a small local model.** It answers from the published summary, but its
  wording is the model's; the case page is the record. A person's own investigation can only be
  weighed by the model, and a live run of it sometimes stops early, leaving records pending to
  retry.
