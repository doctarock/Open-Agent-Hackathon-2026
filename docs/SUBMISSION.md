# Speck Evidence Desk: submission summary

## What it is

Evidence Desk investigates a case whose evidence conflicts and changes over time: a disputed
delivery, or a payment the bank later reverses. When a source corrects or retracts a record, the
current conclusion is recomputed from the evidence that still counts. The page says which
record changed the conclusion, which of its facts and judgments went with it, and what the
system believed before.

It runs inside Speck as a plugin and is Speck's main interface here: Speck opens on its
**Evidence** tab, with Speck's other views beside it. Each case is a Speck worker, and its
evidence, beliefs and revisions live in Speck's database. The plugin is approved by hash in
Speck's plugin allowlist. The one change to Speck is a general `SPECK_HOME_VIEW` setting for the
view its interface opens on. It is kept in this repository as a patch that setup applies, and is
not committed to Speck; the submodule is pinned to upstream Speck.

## What is worth a judge's time

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

## Sponsor technologies, as verified in a real run

`npm run sponsors:verify` runs a real two-stage investigation on throwaway storage. It checks
each contribution against an independent source, and reports NOT OBSERVED rather than simulating
one. Its last run, on 2026-10-22, reported:

| Sponsor | What it does in Evidence Desk | Observed in the live run |
|---|---|---|
| **Zetaris** | Federated evidence: login, then one SELECT per source table through the platform's REST API (`src/evidence/zetaris-provider.ts`). | 4 SELECTs per run against the local platform. Every assessed record carried one of that run's query tokens. |
| **Meterless** | Execution engine: the Markovian reference engine (`@meterless/markovian-reference@0.1.0`, commit `1742dec`, vendored unmodified) runs each investigation as bounded chunks with carryover, plus a reflection pass for the explanation. | Run ids, status and chunk counts matched the engine's own `history.json`. Runs are matched by id and the engine's timestamp, because the engine restarts its ids in each process. |
| **NVIDIA Nemotron** (local) | Judges how each record bears on each hypothesis, and writes the explanation (`src/reasoning/nemotron.ts`). Every reply is validated by Speck's contract and retried once; decisive rules override it; Speck caps its evidence at 0.4. | `nemotron-3-nano:4b` on local Ollama, reported by the endpoint on every call. All model-judged evidence was at reliability ≤ 0.4. Retries were visible: in one run a contract rejection, in another an empty reply. |
| **Speck** | Hosts Evidence Desk as a plugin (a tab, routes and its runtime), and holds each case as a worker with its beliefs, revisions and history (submodule pinned to upstream `29d5bb3`; cognition unmodified; a project-local patch adds the `SPECK_HOME_VIEW` interface setting). | Every belief revision in Speck's event log appears in the trace, exactly once. Inside Speck, the case's events appear in Speck's World view, and the case waits in Speck's task queue without blocking it. |
| **Cursor** | The team reports using it to develop Evidence Desk. | Not a runtime component; nothing in a run can observe it. |

**Not demonstrated:**
- NVIDIA's hosted API: the client accepts it, but it was not used.
- Any other NVIDIA infrastructure.

## Results

These are counts over these cases only, not general accuracy.

| | Build 2 | Build 3 onward |
|---|---|---|
| Held-out cases, deterministic (9 checkpoints) | 7/8 correct | 8/8 correct, 0 unsupported conclusions |
| Correction regression cases, deterministic (8 checkpoints) | 4/8 | 8/8; withdrawn or superseded evidence never used as support (5/5) |
| Held-out cases, live `nemotron-3-nano:4b` (single samples) | 5/8 | 5/8, identical per checkpoint |
| Tests | 29 | 67 |

Across two live samples on the held-out cases, the stateless model baseline made 4 unsupported
conclusions each time (4 of 7, then 4 of 6). Evidence Desk made none, but it abstained when a
conclusion was due 3 times in 4, because of the 0.4 cap.

## Try it

```bash
git submodule update --init --recursive && npm run setup   # builds Speck and installs the plugin
npm run speck            # Speck at http://127.0.0.1:4310, opening on the Evidence tab
npm test                 # 67 tests, no credentials or network needed
npm run eval             # deterministic evaluation, both groups
npm run sponsors:verify  # with Zetaris and Ollama running and configured in .env
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
  restarted. The tab offers two fixed cases and has no live progress stream.
