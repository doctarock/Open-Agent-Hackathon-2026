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

Expect **OBSERVED** for Zetaris, the Meterless engine, NVIDIA Nemotron and Speck. With the local
model (`MODEL_PROVIDER=ollama`) Meterless Nightshift is reported **NOT OBSERVED**, because the
calls went to Ollama, and the exit code is 1; that is correct. With a Meterless Runtime configured,
all five are OBSERVED and it exits 0 (receipts of both, 2026-10-25, in `eval/results/sponsors/`).
If Zetaris or Nemotron shows NOT OBSERVED, use the fallback at the end. Do not present the live
case.

The disputed-delivery case reads its settings from the repository's `.env`. It must set
`EVIDENCE_MODE=zetaris` and `REASONER=nemotron`, with the model provider you will show:
`npm run configure -- --model ollama --evidence zetaris-local` sets and checks all three.

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
  real buttons (the disputed delivery, then the bank return, which ends on the side-by-side comparison), then opens Speck's **World** view
  and **Memory map**, puts a question in Speck's message bar, and ends on the form for an
  investigation of the judge's own, which the judge can go on to create and run. It describes whatever the live runs actually
  conclude.
- A judge can follow it unaided. The **Start the guided demo** button (or **Resume the guided
  demo**) at the end of the case picker starts or resumes it at any time, and a prepared case's
  introduction (**Start the guided investigation**) starts it too, until it is taken or declined;
  resetting a prepared case for the next person shows that introduction again. Each case's **Guide** button lists every feature, marking which ones
  that case has demonstrated.

Optionally, before the judges arrive, run `npm run compare:live` once more: the disputed
delivery's panel then opens on a fresh live comparison (labelled with its time) instead of waiting
30-60 s for one. Never present a comparison as live unless its badge says LIVE MODEL CALLS.

## The script (about 3 minutes, one correction)

The whole demo follows one correction: a bank returns a payment the ledger had marked paid.
Everything you point at is on the page; read what it says rather than predicting it.

**0:00 The problem (15 s).** Evidence changes after the fact. A stateless model call answers from
whatever it is handed; nothing ties its old answer to the record that was just replaced.

**0:15 The original evidence and the first conclusion (30 s).** Select **Bank return**.
1. Click **Run investigation**: *supported* "Invoice INV-77 has been paid in full".
2. Point to **Evidence currently supporting**: the bank credit EV-BNK-101 (+0.19) and the ledger's
   "marked paid" EV-LDG-102 (+0.17), each with the rule that judged it.

**0:45 The correction (40 s).** Click **Introduce prepared update**, then **Run investigation**.
1. The bank returns the payment: EV-BNK-103 says it replaces EV-BNK-101. The ledger reopens the
   invoice (EV-LDG-104), without saying it replaces anything.
2. Speck now holds *supported* "Invoice INV-77 remains unpaid" at 0.66.
3. Point to **Why this changed**:
   - EV-BNK-101 no longer counts: its source replaced it.
   - EV-LDG-102 no longer counts: the same ledger now reports the invoice *reopened*, so its
     earlier "paid" is out of date. (This is the Build 4 fix; before it, that stale "paid" kept
     counting against "unpaid".)
   - What went with the replaced credit: "H-PARTIAL is no longer ruled out".
   - The earlier beliefs stay as **history**, not current.

**1:25 What each approach did with the same correction (45 s).** Open the case's **Speck vs.
baseline** tab.
1. The deterministic panel (fact rules, no model): both approaches reach the labels.
2. Under **Other saved comparisons**, open a **live** one from 2026-10-25 (Nemotron 3 Nano 4B,
   badge LIVE MODEL CALLS):
   - **Before the return**, the stateless call answered "unpaid" citing the ledger's "paid":
     an unsupported conclusion, in all 6 Build 4 samples. Speck concluded "paid".
   - **After the return**, both conclude "unpaid". Speck's badge says **by corroboration**, with
     its own confidence (about 0.45) beside it: two sources agree, nothing counts against,
     every rival ruled out. *Why Speck concludes this* lists the reasons.
   - Say: "Before Build 4, Speck failed this in all 12 live samples. The model read the records
     correctly every time; two capped model judgments simply could not reach Speck's threshold,
     and the stale ledger status still counted. That is in docs/build-4-bank-return.md."

**2:10 What it still gets wrong (25 s).** Open **Evaluation results**, or
`docs/build-4-bank-return.md` section 5c.
- On five new cases written and locked before any run, Build 4 scored 18/30 live: the same as
  Build 3, and the same as the stateless call.
- Corroboration concluded from weak agreement where a careful person would wait (a fault report
  plus "inspection scheduled"; a recommendation plus the customer's hope).
- The stateless call is better when one authoritative record settles the case. Speck never
  relied on a replaced or out-of-date record; the stateless call did.
- Build 5 (`docs/build-5-corroboration.md`): the model's strengths could not separate weak from
  strong support, so a successor rule asks it whether a record *establishes* the explanation. On
  eight new locked cases it met its pre-registered criteria narrowly (8 → 6 wrong where abstaining
  was right), but the old rule on the same judgments did as well. It stays opt-in.

**2:35 The sponsors, briefly (25 s).** Select **Disputed delivery**, open **Audit**, then
**Execution trace** for a run:
- **Zetaris:** four SELECTs on the local platform, each with rows, latency and query token.
  (The Unified Semantic Layer is a separate, reproducible demonstration; the live path reads
  these four tables.)
- **Meterless:** the engine's run id and chunks, "present in the engine's history.json", and its
  reflection pass.
- **Nemotron:** per chunk, the served model `nemotron-3-nano:4b`, the contract, attempts and
  latency. Nightshift's receipt is separate and names the larger models it chose.

Close with: "We don't claim better accuracy. We show what each conclusion rests on, what stopped
counting when the evidence changed, and where our own rule still gets it wrong."

If there is time, the live disputed delivery and the extended demo below show the same behaviour
with real Zetaris and model calls.

### Optional: the disputed delivery, live

Select **Disputed delivery** (about 40 s).
1. Point to the header:
   - **ZETARIS LIVE** at the platform's URL;
   - the Nemotron model at `127.0.0.1:11434`;
   - the Meterless engine and its commit.

   Every record is labelled **Zetaris live**, with its table and query token.
2. Click **Run investigation**. In rehearsal inside Speck it took about 15 s; it can take up to
   about 35 s when the model's reply is rejected and retried. The tab has no live progress
   stream, so talk over it.
3. Open the **Audit** tab's **Execution trace**, Run 1:
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

**Proof, if asked.** **Evaluation results** (beside the cases) lists every report with its date,
sample size and model, each case and checkpoint, and the saved side-by-side comparisons counted
per configuration. In the terminal, `npm run sponsors:verify` reports **OBSERVED** for each
sponsor, checked against an independent source, and **NOT OBSERVED** rather than simulating when
a service is off.

## Slide outline (if slides are wanted)

1. **The problem.** Evidence changes after the fact: a bank returns a payment, a carrier corrects
   a scan. A stateless model call has no link between its answer and the record that was replaced.
2. **The approach.** Speck holds the case as state: evidence ledger, competing explanations,
   each judgment and its confidence change, every revision. Corrections rebuild the beliefs that
   rested on the replaced record; the old ones stay as history.
3. **Side by side, live** (a screenshot of the disputed delivery's comparison panel). Same records,
   same model: the stateless call kept "delivered" and cited the replaced scan in 6 of 6 samples;
   Speck dropped it and recorded why in 6 of 6.
4. **Where Speck lost, and what changed** (the bank return): before Build 4 it stayed unresolved
   after the return in all 12 live samples (the baseline: 11 of 12), because two capped model
   judgments could not reach its threshold and the ledger's stale "paid" still counted. Build 4:
   6 of 6, by corroboration. On five new locked cases, though, Build 4 scored 18/30, the same as
   before and the same as the baseline, and it concluded from weak agreement where it should wait.
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

Set `EVIDENCE_MODE=fixture` and `REASONER=rules` in the repository's `.env`, delete
the demo database and restart Speck. The bank-return case is unaffected either way.

The trace labels the evidence **FIXTURE FILE - NOT ZETARIS** and says "rule assessor (no
model)". Say plainly that the live services are not running. Show the saved live report from
`npm run sponsors:verify`: the published one is
`eval/results/sponsors/2026-10-24T02-14-08-828Z.json` (every sponsor OBSERVED, models through
Nightshift), or `eval/results/sponsor-check.json` for the last local run. Point at its date and
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
| What does "by corroboration" mean? | Speck caps model-judged evidence at 0.4, so two records add at most +0.08 each and its own confidence rarely reaches 0.6 live. Since Build 4 Evidence Desk also concludes when two or more source systems support an explanation with nothing recorded against it and every rival ruled out or unsupported. Speck's own confidence is always shown beside it. Its weakness: it counts that sources agree, not how strongly. | `docs/build-4-bank-return.md` |
| What does Meterless do here? | It runs each investigation: one bounded chunk per batch of evidence, with carryover between chunks, plus the reflection pass for the explanation. Recovery and recomputation are Evidence Desk's own code, and the trace labels them that way. | `vendor/meterless-markovian/NOTICE.md`, the trace |
| What if the process crashes mid-run? | Judgments are saved per chunk before evidence enters Speck, and beliefs are reconciled on restart. A test kills the process at every write, and again during recovery, and checks the outcome is the same as an uninterrupted run. | `test/interruption.test.ts`, `test/recovery.test.ts` |
| Is it better than a plain LLM? | Not in accuracy, on our evidence. Live, on five new cases locked before any run, Speck and the stateless call both scored 18/30, with opposite errors: the stateless call never abstained (wrong at all 12 checkpoint-samples where waiting was right) and Speck abstained where one authoritative record settled the case. Speck never relied on a replaced or out-of-date record; the stateless call cited the replaced delivery scan in all 12 live comparisons. Few cases, one small model, three repeats: not a general result. | `docs/build-4-bank-return.md`, `docs/comparison.md` |
| What did Build 5 change? | An opt-in successor rule, `corroborated-2`, pre-registered and tested on eight new locked cases. It met its criteria narrowly, but the old rule scored on the same judgments did as well, so the gain came with the changed prompt. Most remaining false conclusions there are Speck's own threshold concluding from one source's two records. On those cases Speck matched the label more often than the stateless call (37-39/45 against 27/45), mostly because the stateless call never abstains; the cases are the rule author's own. | `docs/build-5-corroboration.md` |
| Did persistence help? | No measurable accuracy difference from recomputing from scratch. | README, *Evaluation* |
| Can Speck's chat be trusted about a case? | It is given only the case summaries Evidence Desk published, and told to answer from them; without that, a small model invented details. The wording is still the model's, so the case page is the record. | Speck's `src/tests/investigations-component.test.ts`, `test/memory-links.test.ts` |
| Where do the memory map's lines come from? | Evidence Desk links each case's memories with Speck's `reinforceAssociation`: derived-from, supports, contradicts, and inhibitory for a correction. | `test/memory-links.test.ts` |

## Do not claim

- That persistence improves accuracy.
- That Build 4 improved accuracy in general. Its live gains are on cases seen in development; on new locked cases it scored the same as Build 3.
- That Build 5's rule is a validated improvement. It met its pre-registered criteria narrowly, and on the new cases its own check changed no outcome.
- That a conclusion "by corroboration" is Speck's own judgment. Speck's confidence is below its threshold; Evidence Desk's rule concluded.
- That the live investigation queries the Zetaris USL. It reads four Lightning tables; the USL is a separate demonstration on sample data.
- That Nightshift's models produced any evaluation number. All of them come from the local 4B model.
- That Speck is generally more accurate than a model call, or eliminates invented answers. The comparison shows behaviour on two cases, in both directions.
- That live reasoning is generally better.
- Hosted NVIDIA inference or any other NVIDIA infrastructure.
- That Cursor is part of the running system. It is a development tool the team reports using.
- That Speck's trust check covers the whole plugin. It hashes only the entry module.
- That Speck's chat answers are verified. They are written by a local model from the published
  summaries; the guided demo only waits for a reply.
- That a judge's own investigation uses Zetaris. Its evidence is stored locally by the plugin.
