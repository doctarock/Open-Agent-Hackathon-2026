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
the evidence that still counts, and the old beliefs stay on record as history. A record also
stops counting when its own source later reports a new value for every fact in it (a ledger that
said "paid", then "reopened"). A conclusion is drawn when Speck's belief clears its threshold, or
when independent sources agree with nothing against and every rival ruled out or unsupported
(rule `corroborated-1`, Build 4; each conclusion says which route it took, with Speck's own
confidence beside it). Build 5 tested a successor, `corroborated-2` (opt-in), that counts only
records the model judges as establishing the explanation. Otherwise the page says what the evidence points to and why that is not
yet enough.

## Four layers, and what each one solves

| Layer | Solves | Does not solve |
|---|---|---|
| **Language model** (Nemotron, `src/reasoning/nemotron.ts`) | Interpreting each record: does it support or contradict each explanation | Whether that reading is sound. Speck caps model-judged evidence at 0.4; deterministic decisive rules override it |
| **Speck** (persistent state, `speck/`, cognition unmodified) | Keeping the evidence, the beliefs, every revision and the earlier beliefs as history, and revising beliefs by its own rule | What a record means |
| **Evidence Desk** (validity and conclusion policy, `src/investigation/`) | Which records still count after a replacement, restatement or withdrawal; rebuilding the beliefs that rested on them; concluding by Speck's threshold or `corroborated-1`, or abstaining and saying why | Turning a weak model judgment into a strong one |
| **Stateless baseline** (`src/eval/systems.ts`) | A fresh answer from the same model on the same records, with no memory | Saying what changed since its last answer, or why |

Persistent state preserves corrections and exposes stale evidence; it cannot guarantee that the
model's interpretation is sound, and persistence alone shows no measurable accuracy benefit.
`corroborated-2` is an experimental alternative to `corroborated-1`, off by default
(`CONCLUSION_RULE=corroborated-2`), and not validated: on new cases its own check changed no
outcome.

## Demonstration: a correction to evidence

The disputed delivery, in the case's **Speck vs. baseline** tab:
1. The carrier's scan `EV-CAR-003` says "delivered", supporting *delivered*.
2. The carrier's proof-of-delivery review `EV-CAR-005` replaces it: the parcel went to No. 41
   *North*, where the resident is holding it.
3. The stateless baseline keeps "delivered" and cites `EV-CAR-003`: 12/12 live comparisons on
   2026-10-25.
4. Speck stops counting `EV-CAR-003`, rebuilds the beliefs that rested on it and keeps the old
   belief as history: in all 9 of those 12 samples that completed (3 errored; see Proof).
5. The panel shows each stage's records with the replaced one struck through, both answers and
   citations, a *relies on replaced record* badge, and Speck's *no longer counts* and rebuilt
   beliefs with what they were before.

The panel runs the case twice, stage by stage, on the same records with the same assessor: once
as the evaluation's stateless baseline (a fresh model call per stage, or the fact rules summed from
scratch), once through Speck. Saved live comparisons open from the panel without a model or
Zetaris. Then the judge does it by hand on the bank return: run, introduce the correction, run
again, and read "why this changed".

## Proof

Real outputs, clearly labelled. [comparison.md](comparison.md) and
[eval/results/comparisons/SUMMARY.md](../eval/results/comparisons/SUMMARY.md) list every sample;
[build-4-bank-return.md](build-4-bank-return.md) has the diagnosis, the change and its full
before-and-after evaluation.

| Live, local `nemotron-3-nano:4b`, 6 samples per row, 2026-10-25 | Stateless model call | Speck, Build 3 | Speck, Build 4 |
|---|---|---|---|
| Disputed delivery, after the carrier's correction: cites the replaced scan | 12/12 | 0/4 (2 errors) | 0/5 (1 error) |
| ... recorded why its conclusion changed | 0/12 | 4/6 | 5/6 |
| Bank return, before the return: matches the label | 0/12 (12 unsupported "unpaid") | 6/6 | 6/6 |
| Bank return, after the return: matches the label | 11/12 | **0/6** | **6/6** (by corroboration) |

| Live, 3 repeats per suite | Stateless | Speck, Build 3 | Speck, Build 4 |
|---|---|---|---|
| Held-out + regression cases: matches the label | 20/48, 18/48 | 27/48 | 40/48 |
| ... unsupported conclusions | 19/45, 21/45 | 0/9 | **3/28** |
| New challenge cases, locked before any run: matches the label | 18/30, 18/30 | 18/30 | **18/30** |
| ... abstained where abstaining was right | 0/12 | 12/12 | 9/12 |

| Live, Build 5 set (8 new cases locked before any run), 3 repeats, 2026-10-26 | Stateless | Speck, `corroborated-1` | Speck, `corroborated-2` |
|---|---|---|---|
| Matches the label | 27/45, 27/45 | 37/45 | 39/45 |
| ... concluded where abstaining was right | 15/18, 15/18 | 8/18 | 6/18 |
| ... correct where a conclusion was due | 27/27, 27/27 | 27/27 | 27/27 |

In the first table, "0/4 (2 errors)" and "0/5 (1 error)" count the samples that completed. In
the 3 errored samples the model's reply for the correction failed Speck's contract twice, the
correction stayed unassessed, and Speck's state still presented "delivered" on the replaced scan;
a guard added after these runs now withholds the conclusion while a record waits
([build-4-bank-return.md](build-4-bank-return.md), section 6).

What this shows, and does not, as three separate claims:

**A. Correction and revision behaviour.** The stateless call kept citing the replaced delivery
scan in 12/12 live comparisons on 2026-10-25 (and 6/6 on 2026-10-23); Speck cited it in none of
the 9 of those 12 that completed, and recorded why in all 9. Speck mostly did this by withdrawing
its conclusion (7 concluded nothing, 2 concluded "misdelivered"), not by reaching a new one. Two
prepared cases and six samples per build: an illustration, not a rate. The bank-return failure
is fixed as diagnosed (arithmetic: two capped records could never reach the threshold, plus an
obsolete ledger status still counting), but the change was designed on that case, so it is not a
test of it.

**B. General conclusion accuracy: no advantage is claimed.** On five challenge cases locked before
any run, Speck and the stateless call both scored 18/30. On set 5, `corroborated-2` scored 39/45,
but `corroborated-1` applied to the candidate's own judgments also scored 39/45, so the gain over
Build 4's runs (37/45) cannot be attributed to the successor rule alone: it came with the changed
prompt, or sampling ([build-5-corroboration.md](build-5-corroboration.md)). The stateless call's
27/45 there is mostly because it never abstained, and the set was written by the rule's author.
Persistence alone shows no measurable accuracy benefit.

**C. Abstention and unsupported conclusions.** Where waiting was right, the stateless call
concluded anyway (12/12 on the Build 4 challenge cases, 15/18 on set 5) and Speck less often (3/12;
8/18 and 6/18). But abstaining is not inherently correct: Speck also abstained in 8/18
checkpoint-samples where a conclusion was due (the stateless call 0/18), and the stateless call is
better where one authoritative record settles the case. Speck also over-concludes from weak or
correlated evidence: `corroborated-1` concluded from weak agreement in 6 checkpoint-samples
(`missing-evidence`, the claim case), and on set 5 Speck's own threshold concluded from one
source's two records in all 6 of `corroborated-2`'s remaining false conclusions.

## Impact

Investigations whose evidence changes, such as disputed deliveries, payment reversals and
procurement amendments, need decisions that can be defended later: which records the decision
rested on, which were corrected, and what was believed before. Evidence Desk makes that the
system's state rather than something reconstructed afterwards. It says "not established" more
often than a stateless call, which is right in some cases and wrong in others (claim C above).

## What it is

Evidence Desk investigates a case whose evidence conflicts and changes over time: a disputed
delivery, or a payment the bank later reverses. When a source corrects or retracts a record, the
current conclusion is recomputed from the evidence that still counts. The page says which
record changed the conclusion, which of its facts and judgments went with it, and what the
system believed before.

It runs inside Speck as a plugin and is Speck's main interface here: Speck opens on its
**Evidence** tab, with Speck's other views beside it. Each case is a Speck worker, and its
evidence, beliefs and revisions live in Speck's database. The plugin is approved by hash in
Speck's plugin allowlist. Speck is changed in five small ways, all kept in this repository as
patches that setup applies, never committed to Speck:
- a general `SPECK_HOME_VIEW` setting for the view its interface opens on;
- removing Speck's other bundled plugins, so Evidence Desk is the only one;
- a chat component that answers questions about an investigation from the case summaries
  Evidence Desk publishes to Speck's memory;
- the Meterless Runtime as a Speck model provider;
- a *Minimise* / *Expand* button on Speck's chat reply box.

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
   - Model-judged evidence is capped at reliability 0.4 (Speck's cap, unchanged). Since Build 4 a
     conclusion reached by corroboration is marked as such, with Speck's own lower confidence
     beside it, and the evaluation reports where that rule was wrong.
   - The deterministic baseline over-commits, and so does the live stateless-model baseline;
     Evidence Desk abstains more often, which is sometimes wrong, and still over-concludes from
     weak or same-source agreement (claim C above).
   - Persistence shows no measurable accuracy benefit, and we say so.
4. **It survives failure.**
   - An exhaustive test kills the process at each of the 39 Speck write points of a run and a
     withdrawal, and again during recovery. Every sequence ends exactly as an uninterrupted run
     would.
   - A record whose assessment keeps failing can be withdrawn before assessment, without
     inventing a judgment.
5. **It uses Speck's own views, and anyone can bring a case.**
   - One guided demo walks both cases, then Speck's World view (the runs' actions in time), its
     Memory map (the case's records and assessments linked with Speck's association kinds:
     derived-from, supports, contradicts, inhibitory for a correction) and its chat, which
     answers from the published case summary.
   - It ends on the form for an investigation of the judge's own: a question, competing
     explanations and free-text evidence, weighed by the local model, with corrections.

## Sponsor technologies, as verified in a real run

`npm run sponsors:verify` runs a real two-stage investigation on throwaway storage. It checks
each contribution against an independent source, and reports NOT OBSERVED rather than simulating
one. It was re-run on 2026-10-25 in both configurations, local Nemotron 4B
(`eval/results/sponsors/2026-10-25T13-04-35-404Z.json`) and through Nightshift
(`...2026-10-25T13-04-05-519Z.json`); [sponsor-audit.md](sponsor-audit.md) checks every claim
below against those receipts, and states what is not verified. Two points a judge should know:
- **The live investigation reads four Zetaris Lightning tables, not the USL.** The Unified
  Semantic Layer and its data-quality rule are real and re-run on 2026-10-25, but as a separate
  demonstration. All Zetaris data is this repository's sample data.
- **Nightshift chose 30B and 550B Nemotrons**; every evaluation and comparison number comes from
  the local 4B model instead.

Its runs on 2026-10-22 (model on local Ollama) and 2026-10-24 (model through Nightshift) reported:

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

- **Exit status:** 0 when every sponsor it checks is OBSERVED; 1 otherwise. Nightshift is always
  checked, so a run on local Ollama exits 1 with Nightshift NOT OBSERVED ("model calls went to
  http://127.0.0.1:11434/v1, not through Nightshift"), as on 2026-10-25.
- **Without the services:** it still runs. Each sponsor that was not set up is reported NOT
  OBSERVED, with the reason (for example "EVIDENCE_MODE is not zetaris"), and it exits 1. That
  is the check working, not failing: nothing is simulated in place of a missing service.
- **The model:** `meterless/auto` lets the runtime choose. In the saved run it chose 30B and 550B
  Nemotrons, but only the 4B is required. Set `METERLESS_MODEL=meterless/local` to keep calls
  on the device.

## Results

These are counts over these cases only, not general accuracy.

| Deterministic (fact rules, no model) | Build 2 | Build 3 | Build 4 |
|---|---|---|---|
| Held-out cases (8 labelled checkpoints) | 7/8 correct | 8/8, 0 unsupported | 8/8, 0 unsupported |
| Correction regression cases (8) | 4/8 | 8/8; replaced or withdrawn evidence never used as support (5/5) | 8/8 (5/5) |
| Cross-domain suite (27) | | 15/27; same records in another order, identical: 0/2 | 19/27, 0 unsupported; 2/2 |
| Challenge cases, locked before any run (10) | | 6/10 | 7/10 (stateless rule baseline 5/10) |
| Tests | 29 | 147 | 157 (174 with Build 5) |

The live results (3 repeats per suite) are in the proof tables above and, per checkpoint, in
[build-4-bank-return.md](build-4-bank-return.md).

## Try it

```bash
git submodule update --init --recursive && npm run setup   # builds Speck and installs the plugin
npm run speck            # Speck at http://127.0.0.1:4310, opening on the Evidence tab
npm test                 # 174 tests, no credentials or network needed
npm run investigate -- examples/payment-correction-chain/input.json   # one case, JSON in, JSON + trace out, offline
npm run compare          # Speck beside the stateless baseline, deterministic (compare:live with .env)
npm run eval             # deterministic evaluation, both groups
npm run eval:challenge   # the locked challenge cases (add -- --live for the model)
npm run compare:summary  # every saved comparison counted, to eval/results/comparisons/SUMMARY.md
npm run sponsors:verify  # with Zetaris and a Meterless Runtime configured; see Verifying the sponsors yourself
```

The 3-minute walkthrough is in [DEMO.md](../DEMO.md). The design, defect analysis and audit
history are in [build-3-revision.md](build-3-revision.md).

## Known limits

- **One investigation scenario.** The fact rules are hand-written.
- **Few cases.** Seven held-out cases, three regression cases, ten cross-domain cases, five Build 4
  challenge cases and eight Build 5 cases; live results are three repeats of one small local model.
- **Corroboration over-concludes.** `corroborated-1` counts that two sources agree, not whether the
  records establish anything; it concluded from weak agreement in 6 live checkpoint-samples. The
  model's strengths cannot separate weak from strong (0.6-1.0 for everything). The Build 5
  candidate asks the model directly; on new cases its own check changed no outcome.
- **Speck's own threshold can conclude from one source** when the prior is 0.5 (two model-judged
  records reach 0.644): most remaining false conclusions on the Build 5 cases.
- **A failed model call leaves a correction unassessed.** The earlier conclusion is now withheld
  until the next run, but the correction itself does not take effect until it is assessed.
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
- **A local, single-user tool.** Inside Speck the API needs Speck's admin token; the standalone
  server has no login and refuses requests from other sites and rebound domains. Error messages
  are shown on the page, and evidence text is not yet delimited in the model prompt; both are
  deliberate for now (README, *Security*).
- **Speck's chat is a small local model.** It answers from the published summary, but its
  wording is the model's; the case page is the record. A person's own investigation can only be
  weighed by the model, and a live run of it sometimes stops early, leaving records pending to
  retry.
