# Evidence Desk: 3-minute demo

Evidence Desk runs inside Speck as a plugin. The demo uses one Speck server and Speck's own
interface. The **Evidence** tab in Speck's rail has two cases:
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

To start over between judges, use **Reset demo case…** at the top right of the Evidence tab.
- It starts a fresh copy of the case at its first stage, and shows the introduction again.
- Nothing is deleted: the previous copy stays in Speck, suspended.
- To clear the demo database completely instead, stop Speck, delete
  `speck/data/demo-speck.sqlite` and start it again.

Open http://127.0.0.1:4310. Speck opens on the **Evidence** tab, first in its rail. Speck's
other views (World, Queue and the rest) stay available, and the Speck logo returns to Evidence.

**The page explains itself.**
- On first open it shows a short introduction with *Start the guided investigation*. The tour
  walks the Disputed delivery case with the real buttons, and describes whatever the live run
  actually concludes.
- A judge can follow it unaided. The **Guide** button reopens it and lists every feature, marking
  which ones this case has demonstrated.
- To show the introduction again on a browser that has dismissed it, use **Guide → Show the
  introduction**.

## The script

**0:00 The problem (20 s).** Evidence about a case changes: a payment is reversed, a delivery
scan is corrected. A system that only accumulates scores keeps the old evidence's effect after
the source has retracted it. Ours did, in Build 2. Then explain how it was fixed and how the
fix was verified.

**0:20 Bank return (70 s).** Select **Bank return** at the top of the Evidence tab.
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

**1:30 Disputed delivery, live sponsor run (70 s).** Select **Disputed delivery**.
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

**2:40 Honesty (20 s).** In the terminal, show `npm run sponsors:verify`:
- It reports **OBSERVED** for each sponsor, checked against an independent source.
- It reports **NOT OBSERVED** rather than simulating, when a service is off.

Close with: "We don't claim that persistence improves accuracy; our evaluation shows it
doesn't. What we do claim is that every conclusion can be traced, and every correction
explained."

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
| Did you modify Speck? | Only locally, for this project: a patch kept in this repository (`patches/speck-home-view.patch`) adds a general `SPECK_HOME_VIEW` setting, so Speck opens on the Evidence tab. Nothing is committed to Speck; the submodule is pinned to upstream. Evidence Desk itself is a plugin in `speck/plugins/evidence-desk/`, approved by hash in Speck's plugin allowlist. Speck's cognition is unmodified. | `npm run plugin:install`, `test/plugin.test.ts`, Speck's `src/tests/genesis-host.test.ts` |
| Does it interfere with Speck's other work? | Each case is a worker left *waiting*, so it never holds up Speck's queue. Changes take Speck's foreground lease, so background cognition cannot overwrite a revision; we wrote a test that shows the overwrite happening without it. | `test/plugin.test.ts`, `test/speck-compat.test.ts` |
| Is the Zetaris data real? | It is the scenario's records, seeded into a local Zetaris platform and read back through its REST API. Each record carries the platform's query token. | `npm run zetaris:check`, `npm run sponsors:verify`, `test/zetaris.test.ts` |
| Which NVIDIA model, where? | `nemotron-3-nano:4b` on local Ollama. No hosted NVIDIA inference was used. | `npm run model:check` (served model), the trace |
| How do you stop the model from inventing things? | Speck validates each reply against a contract with enumerated ids, covering every pair, and retries once. Unknown ids are discarded, and deterministic decisive rules always win. Speck caps model-judged evidence at reliability 0.4. Explanation citations are checked against real record ids. | `test/nemotron.test.ts`, the trace's per-call accounting |
| Why is the live conclusion only "leading"? | The 0.4 cap: two model-judged records add at most +0.08 each, so live conclusions stay tentative. We left the cap unchanged rather than tune for a better demo. | README, *Evaluation* |
| What does Meterless do here? | It runs each investigation: one bounded chunk per batch of evidence, with carryover between chunks, plus the reflection pass for the explanation. Recovery and recomputation are Evidence Desk's own code, and the trace labels them that way. | `vendor/meterless-markovian/NOTICE.md`, the trace |
| What if the process crashes mid-run? | Judgments are saved per chunk before evidence enters Speck, and beliefs are reconciled on restart. A test kills the process at every write, and again during recovery, and checks the outcome is the same as an uninterrupted run. | `test/interruption.test.ts`, `test/recovery.test.ts` |
| Is it better than a plain LLM? | On the 7 held-out cases, in two live samples, the stateless model baseline made 4 unsupported conclusions each time (4 of 7, then 4 of 6). Evidence Desk made none, but abstained more often. These are few cases and single samples of a small model, not a general result. | README, *Evaluation*; `docs/build-3-revision.md` |
| Did persistence help? | No measurable accuracy difference from recomputing from scratch. | README, *Evaluation* |

## Do not claim

- That persistence improves accuracy.
- That live reasoning is generally better.
- Hosted NVIDIA inference or any other NVIDIA infrastructure.
- That Cursor is part of the running system. It is a development tool the team reports using.
- That Speck's trust check covers the whole plugin. It hashes only the entry module.
