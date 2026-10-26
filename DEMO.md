# Evidence Desk: 3-minute demo

Evidence Desk runs inside Speck as a plugin. The demo uses one Speck server and Speck's own
interface. Each case page has a **Speck vs. baseline** tab: the same case, the same evidence and
the same correction, run through both, with what each actually did. The **Evidence** tab in
Speck's rail has three cases:
- **Hotel chargeback** carries the main point, and comes first. It is set 7's case (receipts
  that conflict over time) where the approaches part most clearly: after the check-in and the
  door-lock entries are re-attributed to another guest, Speck follows the original no-show back
  and the stateless side does not, in every run measured. It follows the plugin's settings like
  the disputed delivery: its records are read live from its own five Zetaris tables when
  `EVIDENCE_MODE=zetaris`, otherwise from its fixture; the assessor is the configured model (the
  fact rules when none is set).
- **Disputed delivery** is a correction worked by hand, and the live sponsor stack: Zetaris,
  Meterless, Nemotron and Speck, each visible in the Execution trace.
- **Bank return** lets the judge make a correction by hand. It is deterministic, instant and works
  offline (fixture evidence and the rule assessor, whatever the settings).

Each case is a Speck worker. Everything shown is read from saved state. Each claim below names
the test or command that backs it.

## Before the judges arrive (5 minutes)

Start the local Zetaris platform and the Meterless Runtime (Nightshift). Then, from the repository
root:

```bash
npm run sponsors:verify    # runs a real live investigation on throwaway storage; prints OBSERVED or NOT OBSERVED per sponsor
```

Expect **OBSERVED** for all five: Zetaris, the Meterless engine, Meterless Nightshift, NVIDIA
Nemotron and Speck, and exit code 0 (receipt of 2026-10-26, Bolt E4B through Nightshift, in
`eval/results/sponsors/`). With the older local model (`MODEL_PROVIDER=ollama`) Nightshift is
reported **NOT OBSERVED**, because the calls went to Ollama, and the exit code is 1; that is
correct (receipt of 2026-10-25).
If Zetaris or Nemotron shows NOT OBSERVED, use the fallback at the end. Do not present the live
case.

The hotel chargeback and the disputed delivery read their settings from the repository's `.env`.
It must set `EVIDENCE_MODE=zetaris` and `REASONER=nemotron`, with the model provider you will show:
`npm run configure -- --model meterless --evidence zetaris-local` sets and checks them, choosing
`nvidia/nemotron-3.5-bolt-e4b`, and points Speck's chat at the same model. It also checks both
cases' records through Zetaris and offers to load any that are missing (`npm run zetaris:seed`
loads both, each into its own tables).

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

For the *Talk to Speck* step, Speck's chat needs a model. `npm run configure` with the Meterless
Runtime sets it to Bolt E4B; the chat has not been rehearsed with Bolt, so check it once before the
judges arrive. The earlier set-up, by hand in Speck's **System** view, was the
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
- On first open the Evidence tab offers *Start the guided demo*. It walks the three prepared cases with the
  real buttons (first the hotel chargeback's side-by-side comparison, then the disputed delivery and the bank return worked by hand), then opens
  **Evaluation results** at *Results across models* (both models, set 7 highlighted), then Speck's **World** view
  and **Memory map**, puts a question in Speck's message bar, and ends on the form for an
  investigation of the judge's own, which the judge can go on to create and run. It describes whatever the live runs actually
  conclude.
- A judge can follow it unaided. The **Start the guided demo** button (or **Resume the guided
  demo**) at the end of the case picker starts or resumes it at any time, and a prepared case's
  introduction (**Start the guided investigation**) starts it too, until it is taken or declined;
  resetting a prepared case for the next person shows that introduction again. Each case's **Guide** button lists every feature, marking which ones
  that case has demonstrated.

Optionally, before the judges arrive, run `npm run compare:live -- --only hotel-chargeback`:
the hotel chargeback's panel then opens on a fresh live comparison (labelled with its time)
instead of waiting about 100 s for one. Never present a comparison as live unless its badge says LIVE MODEL CALLS.

## The script (about 3 minutes)

The demo opens on the **Hotel chargeback**, the case where the two approaches part most clearly,
then shows a correction by hand on the **Disputed delivery**. Read what the page says rather than
predicting it. Outcomes quoted as "offline" use fixture evidence and fact rules, which give the
same result every time; with a live model the conclusions can vary between runs.

**0:00 The problem (15 s).** Evidence changes after the fact. A stateless model call answers from
whatever it is handed; nothing ties its old answer to the record that was just replaced.

**0:15 The hotel chargeback, side by side (70 s).** Select **Hotel chargeback** and open its
**Speck vs. baseline** tab. Offline, click **Run the side-by-side comparison** (a second). With a
model configured, open a saved live one from 2026-10-26 under **Other saved comparisons** (Bolt
E4B, badge LIVE MODEL CALLS), or run one (about 100 s). Then walk the six stages:
1. **Booked:** neither concludes.
2. **No-show:** the night audit flags a no-show and the travel agency relays it. Both conclude
   "no-show", where the label says wait: the agency's record is only the hotel's own report, and
   the stay is not over. Say: "Both fall for it. Speck counted the relay as a second source."
3. **Late check-in:** the night audit is corrected (a late arrival) and door-lock entries show the
   booking's key in use. The stateless call says "stayed"; Speck leans to it without concluding
   (live) or concludes it (offline).
4. **Dispute:** the guest says they never stayed. The stateless call keeps "stayed", rightly; Speck
   holds back, because something now counts against it. That is Speck's caution, and its cost.
5. **Re-attributed:** the check-in and the key entries turn out to be a walk-in guest's; both
   corrections replace the records that showed the stay, so the night audit's no-show counts
   again. Point at the two columns:
   - **Stateless:** offline it keeps "stayed", citing the two replaced records (badge *relies on
     replaced record N7H-04, N7H-05*); live, it loses the thread and answers "unresolved".
   - **Speck:** "no-show". *Why it changed*: `N7H-04` and `N7H-05` no longer count, and the belief
     is rebuilt from what still does.
6. **Refunded:** the agency refunds the booking as a no-show. Speck holds "no-show"; the stateless
   side still does not.

Say the counts: "At the re-attribution and after, Speck concluded no-show in every run we have:
the fact rules, the 4B three times out of three and Bolt E4B three out of three, and in all six
saved live comparisons, three of them with the evidence read from Zetaris. The stateless side never
did." (`docs/set-7-conflicting-receipts.md`,
section 6; the saved comparisons are in `eval/results/comparisons/c7-hotel-chargeback/`.)

**1:25 A correction by hand (35 s).** Select **Disputed delivery** and click **Run investigation**:
offline, *Leading, not established*: delivered (0.61), resting on the carrier's scan `EV-CAR-003`.
Click **Introduce prepared update**, then **Run investigation**: the carrier's review `EV-CAR-005`
replaces the scan, and Speck holds *supported*: delivered to the wrong address (0.70). **Why this
changed**: `EV-CAR-003` no longer counts, because its source replaced it.

**2:00 The history is kept (15 s).** The **History** tab keeps the earlier revisions, badged
*historical: belief since replaced*; the **Evidence** tab still lists `EV-CAR-003`, marked *no
longer counts: replaced by EV-CAR-005*. Nothing is erased.

**2:15 The measured results (20 s).** Open **Evaluation results** (beside the cases) at *Results
across models*. Point at the set 7 rows: on receipts that conflict over time, the better model's
stateless call still concluded the wrong explanation and leaned on replaced records; Speck never
did, on either model, but abstained so often that the stateless call matched the label more.

**2:35 The sponsors, briefly (10 s).** Open **Audit**, then **Execution trace**.
- **Meterless:** the engine's run id and chunks, "present in the engine's history.json".
- **Zetaris, Nightshift and Nemotron:** with live services, the disputed delivery's four SELECTs
  with query tokens (the hotel chargeback's five, if you show it) and, per chunk, the served model `nvidia/nemotron-3.5-bolt-e4b`, reached
  through Nightshift. Offline the trace says plainly FIXTURE FILE - NOT ZETARIS and that the rule
  assessor (no model) judged the evidence; then point at the saved sponsor receipt of 2026-10-26
  (`eval/results/sponsors/`), not at the page.

**2:45 The advantage and the limitation (15 s).** "When receipts conflict over time, Speck keeps
track of which ones still count, and when it concludes, it is never the wrong explanation and
never rests on a replaced record. But it holds back too often: on the locked cases the stateless
call still matched the label more often. What this demonstrates is evidence-aware revision and
traceability, not better accuracy."

**If asked: the disputed delivery's comparison.** With the 4B, in the 12 live comparisons of
2026-10-25, the stateless call kept "delivered" on the replaced scan 12 times; Speck in none of the
9 that completed (3 errored). With Bolt E4B the stateless call no longer did (0 of 6): a stronger
reading fixed that case on its own, and only Speck recorded why. Both kinds of sample are under
**Other saved comparisons** on that case, each labelled with its model.

**If asked: the bank return.** It shows the same mechanism with a second kind of correction (a
returned payment, and a ledger that restates its own "paid"), and it is where Speck lost: before
Build 4 it stayed unresolved after the return in all 12 live samples while the stateless call was
right in 11, because two capped model judgments could not reach Speck's threshold. Build 4 fixed it
(6/6, marked *by corroboration*, with Speck's own confidence of about 0.45 beside it), but the
change was designed on that case, so it is not a test of it (`docs/build-4-bank-return.md`).

**If asked: Build 5.** An opt-in rule, `corroborated-2`, asks the model whether each record
*establishes* the explanation. On eight new locked cases it scored 39/45, but the old rule on the
same judgments also scored 39/45, so the extra judgment showed no independent improvement. With
Bolt E4B it did worse (34/45, losing 8 correct conclusions).

### Optional: the same case with live services

With `.env` set to Zetaris and a model (about 40 s):
1. Point to the header:
   - **ZETARIS LIVE** at the platform's URL;
   - the Nemotron model and where it is served (`nvidia/nemotron-3.5-bolt-e4b` through Nightshift
     at `127.0.0.1:8088`, or a local Ollama model at `127.0.0.1:11434`);
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
   case summary Evidence Desk published, through the project's chat patch. The model writes the
   wording, so check the answer against the case page; in rehearsal it gave the right
   conclusion and records, and said why the conclusion changed. A live reply can take a minute.
4. **Your own investigation:** *+ New investigation*, a question with two explanations and one
   record, then **Run investigation**. Add a correction of that record and run again: the record
   no longer counts. With the local 4B a run sometimes stopped early and left records
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
3. **Side by side, live** (a screenshot of the hotel chargeback's comparison panel at the
   re-attribution). Same records, same model: once the check-in and key entries are found to be
   another guest's, Speck concludes "no-show" and shows which records stopped counting; the
   stateless call keeps "stayed" on the replaced records (fact rules, 4B) or cannot decide (Bolt
   E4B), in every run measured. Earlier, with the fact rules and Bolt, both fell for a relayed
   no-show, and Speck held back at the dispute where the stateless call was right.
4. **Across models** (a screenshot of *Results across models*): from the 4B to Bolt E4B the
   stateless call improves on every suite and Speck's accuracy does not move. On set 7, receipts
   that conflict over time, Bolt's stateless call falls to 60% and still concludes wrongly where a
   correction was itself corrected (3 of 57) or leans on a replaced record (9 of 48); Speck does
   neither (0, 0) but abstains in 33 of 57 where a conclusion is due.
5. **Where Speck lost, and what changed** (the bank return): before Build 4 it stayed unresolved
   after the return in all 12 live samples (the baseline: 11 of 12), because two capped model
   judgments could not reach its threshold and the ledger's stale "paid" still counted. Build 4:
   6 of 6, by corroboration. On five new locked cases, though, Build 4 scored 18/30, the same as
   before and the same as the baseline, and it concluded from weak agreement where it should wait.
6. **Proof.** Deterministic evaluation (held-out, regression, cross-domain), the tests (including
   a crash at every Speck write), saved comparisons; persistence alone shows no accuracy gain.
7. **Sponsors, as verified.** Zetaris (live SELECTs with query tokens), Meterless (engine runs
   matched in its history), Nightshift (Bolt E4B, named in every response), Nemotron (served model on every call), Speck (host, state,
   world view, memory map, chat); Cursor as a development tool.
8. **Impact.** Defensible decisions in investigations whose evidence changes: what a decision
   rested on, what was corrected, and what was believed before.

There is no recorded video in this repository; record one from this script if the submission
requires it.

## Fallback (no Zetaris or no model)

Run `npm run configure -- --model rules --evidence fixture` (or set `EVIDENCE_MODE=fixture` and
`REASONER=rules` in the repository's `.env`), delete the demo database and restart Speck. The
main script above works unchanged offline. The bank-return case is unaffected either way.

The trace labels the evidence **FIXTURE FILE - NOT ZETARIS** and says "rule assessor (no
model)". Say plainly that the live services are not running. Show the saved live report from
`npm run sponsors:verify`: the published one is
`eval/results/sponsors/2026-10-26T07-05-56-787Z.json` (every sponsor OBSERVED, Bolt E4B through
Nightshift), or `eval/results/sponsor-check.json` for the last local run. Point at its date and
model.

If Speck itself will not start, the standalone page still works: `npm start`, then
http://127.0.0.1:4320. It shows one case, chosen by `EVIDENCE_DESK_SCENARIO` (see the README).

## Likely questions, and grounded answers

| Question | Answer | Backed by |
|---|---|---|
| Did you modify Speck? | Only locally, for this project, through patches kept in this repository: a general `SPECK_HOME_VIEW` setting, so Speck opens on the Evidence tab (`patches/speck-home-view.patch`); removing Speck's other bundled plugins, so Evidence Desk is the only one (`patches/speck-remove-plugins.patch`); a chat component that answers questions about an investigation from the case summaries Evidence Desk publishes (`patches/speck-chat-investigations.patch`); the Meterless Runtime as a model provider (`patches/speck-meterless-provider.patch`); and a *Minimise* / *Expand* button on the chat reply (`patches/speck-response-collapse.patch`). Nothing is committed to Speck; the submodule is pinned to upstream. Evidence Desk itself is a plugin in `speck/plugins/evidence-desk/`, approved by hash in Speck's plugin allowlist. Speck's cognition is unmodified. | `npm run plugin:install`, `test/plugin.test.ts`, Speck's `src/tests/genesis-host.test.ts` |
| Does it interfere with Speck's other work? | Each case is a worker left *waiting*, so it never holds up Speck's queue. Changes take Speck's foreground lease, so background cognition cannot overwrite a revision; we wrote a test that shows the overwrite happening without it. | `test/plugin.test.ts`, `test/speck-compat.test.ts` |
| Is the Zetaris data real? | It is each live case's own records (the disputed delivery's four tables, the hotel chargeback's five), seeded into a local Zetaris platform and read back through its REST API. Each record carries the platform's query token. | `npm run zetaris:check`, `npm run sponsors:verify`, `test/zetaris.test.ts` |
| Which NVIDIA model, where? | Since 2026-10-26: `nvidia/nemotron-3.5-bolt-e4b`, served by NVIDIA and reached through Meterless Nightshift by name, for the assessor, the baseline and Speck's chat. Every number before that: `nemotron-3-nano:4b` (Q4_K_M) on local Ollama. The two are reported separately. In `meterless/auto` the runtime chose larger Nemotrons (30B, 550B); those runs produced no evaluation number. The client's direct path to NVIDIA's hosted API was not used. | `npm run model:check` (served model), the trace |
| How do you stop the model from inventing things? | Speck validates each reply against a contract with enumerated ids, covering every pair, and retries once. Unknown ids are discarded, and deterministic decisive rules always win. Speck caps model-judged evidence at reliability 0.4. Explanation citations are checked against real record ids. | `test/nemotron.test.ts`, the trace's per-call accounting |
| What does "by corroboration" mean? | Speck caps model-judged evidence at 0.4, so two records add at most +0.08 each and its own confidence rarely reaches 0.6 live. Since Build 4 Evidence Desk also concludes when two or more source systems support an explanation with nothing recorded against it and every rival ruled out or unsupported. Speck's own confidence is always shown beside it. Its weakness: it counts that sources agree, not how strongly. | `docs/build-4-bank-return.md` |
| What does Meterless do here? | It runs each investigation: one bounded chunk per batch of evidence, with carryover between chunks, plus the reflection pass for the explanation. Recovery and recomputation are Evidence Desk's own code, and the trace labels them that way. | `vendor/meterless-markovian/NOTICE.md`, the trace |
| What if the process crashes mid-run? | Judgments are saved per chunk before evidence enters Speck, and beliefs are reconciled on restart. A test kills the process at every write, and again during recovery, and checks the outcome is the same as an uninterrupted run. | `test/interruption.test.ts`, `test/recovery.test.ts` |
| Is it better than a plain LLM? | Not in accuracy, on our evidence. Live, on five new cases locked before any run, Speck and the stateless call both scored 18/30, with opposite errors: the stateless call never abstained (wrong at all 12 checkpoint-samples where waiting was right) and Speck abstained where one authoritative record settled the case. The 4B stateless call cited the replaced delivery scan in all 12 live comparisons of 2026-10-25; Speck in none of the 9 that completed (in the 3 that errored, its unassessed state still rested on it). With Bolt E4B the stateless call did not cite it (0/6) and is ahead on both locked sets (21/30 and 42/45, against 18/30 and 36/45). On set 7, receipts that conflict over time, it is still ahead (45/75 against 33/75) but concludes the wrong explanation 3/57 times and leans on replaced records 9/48 times; Speck 0 and 0, while abstaining in 33/57 where a conclusion was due. Few cases, small models, three repeats: not a general result. | `docs/build-4-bank-return.md`, `docs/comparison.md`, `docs/bolt-e4b.md` |
| What did Build 5 change? | An opt-in successor rule, `corroborated-2`, pre-registered and tested on eight new locked cases. It met its criteria narrowly, but the old rule scored on the same judgments did as well, so the gain came with the changed prompt. Most remaining false conclusions there are Speck's own threshold concluding from one source's two records. On those cases Speck matched the label more often than the stateless call (37-39/45 against 27/45), mostly because the stateless call never abstains; the cases are the rule author's own. | `docs/build-5-corroboration.md` |
| Did persistence help? | No measurable accuracy difference from recomputing from scratch. | README, *Evaluation* |
| Can Speck's chat be trusted about a case? | It is given only the case summaries Evidence Desk published, and told to answer from them; without that, a small model invented details. The wording is still the model's, so the case page is the record. | Speck's `src/tests/investigations-component.test.ts`, `test/memory-links.test.ts` |
| Where do the memory map's lines come from? | Evidence Desk links each case's memories with Speck's `reinforceAssociation`: derived-from, supports, contradicts, and inhibitory for a correction. | `test/memory-links.test.ts` |

## Do not claim

- That persistence improves accuracy.
- That Build 4 improved accuracy in general. Its live gains are on cases seen in development; on new locked cases it scored the same as Build 3.
- That Build 5's rule is a validated improvement. It met its pre-registered criteria narrowly, and on the new cases its own check changed no outcome.
- That a conclusion "by corroboration" is Speck's own judgment. Speck's confidence is below its threshold; Evidence Desk's rule concluded.
- That the live investigation queries the Zetaris USL. It reads Lightning tables (four for the disputed delivery, five for the hotel chargeback); the USL is a separate demonstration on sample data.
- That a routing-mode model (`meterless/auto`'s 30B or 550B) produced any evaluation number. Before
  2026-10-26 they come from the local 4B; from 2026-10-26, from Bolt E4B asked for by name.
- That the stateless call still cites the replaced scan. That was the 4B; with Bolt it did not.
- That Bolt E4B runs on the device. It is served by NVIDIA through Nightshift.
- That Speck never relied on a replaced record. In 3 errored live samples its unassessed state still did; say "none of the 9 that completed".
- That abstaining is always right. Speck also abstains where a conclusion was due.
- That Speck is generally more accurate than a model call, or eliminates invented answers. The comparison shows behaviour on three cases, in both directions.
- That live reasoning is generally better.
- That any evaluation number came from a hosted or larger Nemotron, or that the client's direct NVIDIA hosted-API path was used. Nightshift's routing to larger Nemotrons is a sponsor-check receipt only.
- That Cursor is part of the running system. It is a development tool the team reports using.
- That Speck's trust check covers the whole plugin. It hashes only the entry module.
- That Speck's chat answers are verified. They are written by a model from the published
  summaries; the guided demo only waits for a reply.
- That a judge's own investigation uses Zetaris. Its evidence is stored locally by the plugin.
