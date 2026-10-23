# Evidence Desk: 3-minute demo

Evidence Desk runs inside Speck as a plugin. The demo uses one Speck server and Speck's own
interface. Each case page opens with **Speck beside a stateless baseline**: the same case, the
same evidence and the same correction, run through both, with what each actually did. The
**Evidence** tab in Speck's rail has two cases:
- **Bank return** shows the correction story. It is deterministic, instant and works offline
  (fixture evidence and the rule assessor, whatever the settings).
- **Disputed delivery** shows the live sponsor stack: Zetaris, Meterless, local Nemotron and
  Speck, each visible in the Execution trace.

Each case is a Speck worker. Everything shown is read from saved state. Each claim below names
the test or command that backs it.

## Before the judges arrive (5 minutes)

Start the local Zetaris platform and Ollama. Then, from the repository root:

```bash
npm run sponsors:verify    # runs a real live investigation on throwaway storage; prints OBSERVED or NOT OBSERVED per sponsor
```

Expect **OBSERVED** for Zetaris, Meterless, NVIDIA Nemotron (local) and Speck, and exit code 0.
If Zetaris or Nemotron shows NOT OBSERVED, use the fallback at the end. Do not present the live
case.

The disputed-delivery case reads its settings from the plugin's own `.env`,
`speck/plugins/evidence-desk/.env`. `npm run setup` copied the repository's `.env` there on
first install. It must set `EVIDENCE_MODE=zetaris` and `REASONER=nemotron`.

Make sure the installed plugin is current, then start Speck on a fresh demo database, so the
cases start empty and your everyday Speck database is not touched. The path is relative to
`speck/`.

```bash
npm run plugin:install
SPECK_DB_PATH=data/demo-speck.sqlite npm run speck
```

The same in PowerShell:

```powershell
npm run plugin:install
$env:SPECK_DB_PATH="data/demo-speck.sqlite"; npm run speck
```

For the *Talk to Speck* step, Speck's chat needs a model. In Speck's **System** view, add the
local Nemotron Nano 9B on Ollama (`hf.co/bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF:Q4_K_M`
at `http://127.0.0.1:11434`) as a processor and assign it to Speck's roles, then restart Speck.
Speck keeps this in `speck/data/genesis-runtime/model-processors.json` (not committed). Without
it, skip that step.

To start over between judges, use **Reset demo case…** at the top right of the Evidence tab, on
each prepared case.
- It starts a fresh copy of the case at its first stage. Inside the guided demo, that part starts
  again from its first step.
- Nothing is deleted: the previous copy stays in Speck, suspended.
- To clear the demo database completely instead, stop Speck, delete
  `speck/data/demo-speck.sqlite` and start it again.

Open http://127.0.0.1:4310. Speck opens on the **Evidence** tab, first in its rail. Speck's
other views (World, Queue and the rest) stay available, and the Speck logo returns to Evidence.

**The page explains itself.**
- On first open the Evidence tab offers *Start the guided demo*. It walks both cases with the
  real buttons (the bank return, then the disputed delivery, each opening on the side-by-side comparison), then opens Speck's **World** view
  and **Memory map**, puts a question in Speck's message bar, and ends on the form for an
  investigation of the judge's own, which the judge can go on to create and run. It describes whatever the live runs actually
  conclude.
- A judge can follow it unaided. The **Guided demo** link beside the case picker starts or
  resumes it at any time. Each case's **Guide** button lists every feature, marking which ones
  that case has demonstrated.

Optionally, before the judges arrive, run `npm run compare:live` once more: the disputed
delivery's panel then opens on a fresh live comparison (labelled with its time) instead of waiting
30-60 s for one. Never present a comparison as live unless its badge says LIVE MODEL CALLS.

## The script

**0:00 The problem (15 s).** Evidence about a case changes: a payment is reversed, a delivery
scan is corrected. A stateless model call answers from whatever it is handed; nothing ties its
old answer to the record that was just replaced.

**0:15 The difference, side by side (45 s).** Select **Disputed delivery**. The first panel is
**Speck beside a stateless baseline**. If its badge says LIVE MODEL CALLS with today's time, use it;
otherwise press **Run the side-by-side comparison** and talk over the 30-60 s.
1. Point to the six steps across the top: observe, assess, correct, revise, verify, explain.
2. Stage 2, the correction: "EV-CAR-005 replaces EV-CAR-003". Read the two columns:
   - **Stateless model call:** in every live sample so far it kept "delivered" and cited
     EV-CAR-003, the scan the carrier replaced (red badge: *relies on replaced record*). Its own
     words are shown.
   - **Speck:** EV-CAR-003 no longer counts; it rebuilt the beliefs that rested on it and now
     points to "delivered to the wrong address", without concluding it (the model-judged support
     is capped). *Why it changed (recorded by Speck)* is its own state, not a summary.
   - Do not predict the live result. Read what the panel says; `docs/comparison.md` has all six
     earlier samples.
3. Say: "Same records, same model, same correction. One kept the answer and the stale record;
   the other dropped the record and can show you why. That is not a claim of better accuracy; on
   the bank return the baseline was right more often after the return, and that's on the page
   too."

**1:00 Bank return, by hand (60 s).** Select **Bank return**. Its comparison panel is
deterministic and instant, with the pre-registered labels; both approaches match them. Then do it
on Speck's case yourself:
1. Click **Run investigation**: *supported* "Invoice INV-77 has been paid in full".
2. Click **Introduce prepared update**. The bank returns the payment (EV-BNK-103 supersedes
   EV-BNK-101). Click **Run investigation**: *supported* "Invoice INV-77 remains unpaid", at 0.66.
3. Point to **Evidence currently supporting**. Each record shows its rule and the exact
   confidence change it made: EV-BNK-103 +0.19, EV-LDG-104 +0.17.
4. Point to **Why this changed**:
   - EV-BNK-101 no longer counts; its source replaced it with EV-BNK-103.
   - The page also says what went with it: payment.amount_matches=true, and so "H-PARTIAL is
     no longer ruled out".
   - The earlier beliefs are kept as **history**, not current.

Say: "Build 2 left the reversed payment's −0.19 in place and stopped at 0.47. Current beliefs
are now a replay of the evidence that still counts, through Speck's own revision rule. That
held-out checkpoint went from wrong to right, and nothing else changed."

**2:00 Disputed delivery, live sponsor run (40 s; shorten or skip if the comparison above ran
live).** Select **Disputed delivery**.
1. Point to the header:
   - **ZETARIS LIVE** at the platform's URL;
   - the Nemotron model at `127.0.0.1:11434`;
   - the Meterless engine and its commit.

   Every record is labelled **Zetaris live**, with its table and query token.
2. Click **Run investigation**. In rehearsal inside Speck it took about 15 s; it can take up to
   about 35 s when the model's reply is rejected and retried. The tab has no live progress
   stream, so talk over it.
3. Open **Execution trace**, Run 1:
   - **Zetaris:** four SELECTs, each with row count, latency and query token.
   - **Meterless:** the engine's run id and chunks, "present in the engine's history.json".
   - **Per chunk, Nemotron:** served model, contract covering all 6 evidence/hypothesis pairs,
     temperature 0.1, attempts, latency, and judgments kept, neutral or overruled by a
     deterministic rule.
   - **Per chunk, Speck:** evidence recorded and each belief revision.
4. If time allows: **Introduce prepared update**, then **Run investigation**. The trace shows
   the superseded delivery scan triggering a recomputation.
   - The conclusion depends on the model's judgments and varies between runs. In our live runs
     on 2026-10-22, it sometimes ended *leading* "delivered to the wrong address" and sometimes
     *unresolved*.
   - Do not predict it. Read what the page says. Either way, the trace shows why.
5. Optionally, open Speck's **World** view: the case's evidence and revisions are Speck events
   on the case's worker. The **Task queue** lists the cases as waiting, not queued.

Say: "Each line here is read back from what was saved: Zetaris query tokens, the engine's own
history file, the model name the endpoint reported, Speck's event log. Restart Speck and the
trace is identical."

**Extended demo: Speck's views and your own case (2 to 4 minutes, if there is time).** The guided
demo continues here by itself; the steps are:
1. **World:** each case is a Speck task with its runs' actions laid out in time (Hypothesis
   Proposed, Memory Recorded, Belief Revised, Association Reinforced). Right-drag to travel back.
2. **Memory map:** the lines are the case's reasoning as Speck associations. An assessment is
   derived from the records it judged, a record supports or contradicts its run's conclusion,
   and a correction inhibits the record it replaced. Select a memory to inspect it.
3. **Talk to Speck:** send the prepared question about the bank return. Speck answers from the
   case summary Evidence Desk published, through the project's chat patch. The local model
   writes the wording, so check the answer against the case page; in rehearsal it gave the right
   conclusion and records, and said why the conclusion changed. A live reply can take a minute.
4. **Your own investigation:** *+ New investigation*, a question with two explanations and one
   record, then **Run investigation**. Add a correction of that record and run again: the record
   no longer counts. With the local model a run sometimes stops early and leaves records
   pending; the page says so, and the next run retries them.

**2:40 Proof and honesty (20 s).** Open **Evaluation results** (beside the cases): every report
with its date, sample size and model, each case and checkpoint, and the saved side-by-side
comparisons counted per configuration. In the terminal, `npm run sponsors:verify`:
- It reports **OBSERVED** for each sponsor, checked against an independent source.
- It reports **NOT OBSERVED** rather than simulating, when a service is off.

Close with: "We don't claim that persistence improves accuracy; our evaluation shows it
doesn't, and Speck abstains more often than a plain model call. What we do claim is that every
conclusion can be traced, and every correction explained, and you've just seen the difference
that makes on the same evidence."

## Slide outline (if slides are wanted)

1. **The problem.** Evidence changes after the fact: a bank returns a payment, a carrier corrects
   a scan. A stateless model call has no link between its answer and the record that was replaced.
2. **The approach.** Speck holds the case as state: evidence ledger, competing explanations,
   each judgment and its confidence change, every revision. Corrections rebuild the beliefs that
   rested on the replaced record; the old ones stay as history.
3. **Side by side, live** (a screenshot of the disputed delivery's comparison panel). Same records,
   same model: the stateless call kept "delivered" and cited the replaced scan in 6 of 6 samples;
   Speck dropped it and recorded why in 6 of 6.
4. **Where Speck loses** (the bank return): it stays unresolved after the return live (0 of 6
   matched the label, against 5 of 6 for the baseline), because model-judged evidence is capped at
   0.4. It never made an unsupported claim; the baseline did in 3 of 6 samples before the return.
5. **Proof.** Deterministic evaluation (held-out, regression, cross-domain), the tests (including
   a crash at every Speck write), saved comparisons; persistence alone shows no accuracy gain.
6. **Sponsors, as verified.** Zetaris (live SELECTs with query tokens), Meterless (engine runs
   matched in its history), local Nemotron (served model on every call), Speck (host, state,
   world view, memory map, chat); Cursor as a development tool.
7. **Impact.** Defensible decisions in investigations whose evidence changes: what a decision
   rested on, what was corrected, and what was believed before.

There is no recorded video in this repository; record one from this script if the submission
requires it.

## Fallback (no Zetaris or no Ollama)

Set `EVIDENCE_MODE=fixture` and `REASONER=rules` in `speck/plugins/evidence-desk/.env`, delete
the demo database and restart Speck. The bank-return case is unaffected either way.

The trace labels the evidence **FIXTURE FILE - NOT ZETARIS** and says "rule assessor (no
model)". Say plainly that the live services are not running. Show the saved live report
`eval/results/sponsor-check.json` from the last `npm run sponsors:verify`, with its date and
model.

If Speck itself will not start, the standalone page still works: `npm start`, then
http://127.0.0.1:4320. It shows one case, chosen by `EVIDENCE_DESK_SCENARIO` (see the README).

## Likely questions, and grounded answers

| Question | Answer | Backed by |
|---|---|---|
| Did you modify Speck? | Only locally, for this project, through patches kept in this repository: a general `SPECK_HOME_VIEW` setting, so Speck opens on the Evidence tab (`patches/speck-home-view.patch`); removing Speck's other bundled plugins, so Evidence Desk is the only one (`patches/speck-remove-plugins.patch`); and a chat component that answers questions about an investigation from the case summaries Evidence Desk publishes (`patches/speck-chat-investigations.patch`). Nothing is committed to Speck; the submodule is pinned to upstream. Evidence Desk itself is a plugin in `speck/plugins/evidence-desk/`, approved by hash in Speck's plugin allowlist. Speck's cognition is unmodified. | `npm run plugin:install`, `test/plugin.test.ts`, Speck's `src/tests/genesis-host.test.ts` |
| Does it interfere with Speck's other work? | Each case is a worker left *waiting*, so it never holds up Speck's queue. Changes take Speck's foreground lease, so background cognition cannot overwrite a revision; we wrote a test that shows the overwrite happening without it. | `test/plugin.test.ts`, `test/speck-compat.test.ts` |
| Is the Zetaris data real? | It is the scenario's records, seeded into a local Zetaris platform and read back through its REST API. Each record carries the platform's query token. | `npm run zetaris:check`, `npm run sponsors:verify`, `test/zetaris.test.ts` |
| Which NVIDIA model, where? | `nemotron-3-nano:4b` on local Ollama. No hosted NVIDIA inference was used. | `npm run model:check` (served model), the trace |
| How do you stop the model from inventing things? | Speck validates each reply against a contract with enumerated ids, covering every pair, and retries once. Unknown ids are discarded, and deterministic decisive rules always win. Speck caps model-judged evidence at reliability 0.4. Explanation citations are checked against real record ids. | `test/nemotron.test.ts`, the trace's per-call accounting |
| Why is the live conclusion only "leading"? | The 0.4 cap: two model-judged records add at most +0.08 each, so live conclusions stay tentative. We left the cap unchanged rather than tune for a better demo. | README, *Evaluation* |
| What does Meterless do here? | It runs each investigation: one bounded chunk per batch of evidence, with carryover between chunks, plus the reflection pass for the explanation. Recovery and recomputation are Evidence Desk's own code, and the trace labels them that way. | `vendor/meterless-markovian/NOTICE.md`, the trace |
| What if the process crashes mid-run? | Judgments are saved per chunk before evidence enters Speck, and beliefs are reconciled on restart. A test kills the process at every write, and again during recovery, and checks the outcome is the same as an uninterrupted run. | `test/interruption.test.ts`, `test/recovery.test.ts` |
| Is it better than a plain LLM? | On the 7 held-out cases, in two live samples, the stateless model baseline made 4 unsupported conclusions each time (4 of 7, then 4 of 6). Evidence Desk made none, but abstained more often. These are few cases and single samples of a small model, not a general result. On the side-by-side comparison (6 live samples per case), the plain model call kept "delivered" and cited the replaced scan after the carrier's correction every time, while Speck dropped it every time; on the bank return the plain call matched the label after the return 5 of 6 times and Speck 0 of 6. | README, *Evaluation*; `docs/build-3-revision.md`; `docs/comparison.md` |
| Did persistence help? | No measurable accuracy difference from recomputing from scratch. | README, *Evaluation* |
| Can Speck's chat be trusted about a case? | It is given only the case summaries Evidence Desk published, and told to answer from them; without that, a small model invented details. The wording is still the model's, so the case page is the record. | Speck's `src/tests/investigations-component.test.ts`, `test/memory-links.test.ts` |
| Where do the memory map's lines come from? | Evidence Desk links each case's memories with Speck's `reinforceAssociation`: derived-from, supports, contradicts, and inhibitory for a correction. | `test/memory-links.test.ts` |

## Do not claim

- That persistence improves accuracy.
- That Speck is generally more accurate than a model call, or eliminates invented answers. The comparison shows behaviour on two cases, in both directions.
- That live reasoning is generally better.
- Hosted NVIDIA inference or any other NVIDIA infrastructure.
- That Cursor is part of the running system. It is a development tool the team reports using.
- That Speck's trust check covers the whole plugin. It hashes only the entry module.
- That Speck's chat answers are verified. They are written by a local model from the published
  summaries; the guided demo only waits for a reply.
- That a judge's own investigation uses Zetaris. Its evidence is stored locally by the plugin.
