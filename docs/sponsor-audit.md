# Sponsor evidence audit (2026-10-25, with the 2026-10-26 model change)

Each sponsor claim in the README and `docs/SUBMISSION.md` checked against the code and against an
execution record made on 2026-10-25, and, for the switch to Nemotron 3.5 Bolt E4B, on 2026-10-26
(section *2026-10-26: Bolt E4B through Nightshift*). Every receipt named here is tracked in git. Where something
could not be verified, it says so.

Three kinds of run are kept apart:
- **Deterministic tests** (`npm test`, `npm run eval`, `npm run compare`): fixture evidence and
  fact rules. No model and no sponsor service.
- **Live model experiments**: until 2026-10-25, `nemotron-3-nano:4b` on this laptop's GPU
  (below); on 2026-10-26, `nvidia/nemotron-3.5-bolt-e4b`, served by NVIDIA through Meterless
  Nightshift and asked for by name. Every evaluation and comparison number comes from one of
  these, labelled with its model, or from deterministic runs. The two models are never pooled.
- **Sponsor-integration verification** (`npm run sponsors:verify`): one two-stage live
  investigation per configuration, checked against each sponsor's own records. When it routes
  through Meterless Nightshift in a routing mode (`meterless/auto`), the runtime chooses the
  model; those runs are never used for evaluation numbers.

## Summary

| Sponsor | Verified on 2026-10-25 | Receipt | Not verified, or limits |
|---|---|---|---|
| Zetaris | The live investigation reads its evidence through Zetaris; the USL and its data-quality rule exist and run | `eval/results/sponsors/2026-10-25T13-04-05-519Z.json`, `...13-04-35-404Z.json`, `2026-10-25-zetaris-usl.md` | **The live investigation does not read the USL.** All Zetaris data is sample data |
| Meterless engine | Real runs, chunks, carryover and the reflection pass, matched in the engine's own history | the two sponsor receipts | Recovery and recomputation are Evidence Desk's code, not the engine's |
| Meterless Nightshift | Model calls routed and answered through the runtime; served model named. Since 2026-10-26 the provider of every live number, with the pinned Bolt E4B | `2026-10-25T13-04-05-519Z.json` (`meterless/auto`), `2026-10-26T07-05-56-787Z.json` (pinned) | The `meterless/auto` runs produced no evaluation number |
| NVIDIA Nemotron | The local 4B model, its quantisation, runtime and request settings, for every live number until 2026-10-25; Bolt E4B through Nightshift from 2026-10-26 | `2026-10-25T13-04-35-404Z.json`, `2026-10-26T07-05-56-787Z.json`, every live report under `eval/results/experiments/` and `eval/results/comparisons/` | The client's direct path to NVIDIA's hosted API was not used; Bolt E4B's size and weights are the provider's, not measured here |
| Speck | Host, belief state, every revision traced | both sponsor receipts, the test suite | |
| Cursor | Nothing | none | The repository contains no Cursor configuration and no commit attributes work to it. "The team reports using it" is the team's statement, not verified |

## Zetaris

**What the live investigation reads.** `src/evidence/zetaris-provider.ts` logs in, then runs one
SELECT per source table through the platform's REST API. Both sponsor runs on 2026-10-25 made 4
SELECTs per stage against `http://localhost:3000`:

| Table | Rows for the case |
|---|---|
| `EVIDENCE_DESK.order_events` | 1 |
| `EVIDENCE_DESK.warehouse_scans` | 1 |
| `EVIDENCE_DESK.carrier_events` | 2 |
| `EVIDENCE_DESK.support_messages` | 2 |

Every assessed record carried one of that run's query tokens (checked by the verifier, and
visible per record in the trace and on the case page). `npm run zetaris:check` also returned the
same 6 records on 2026-10-25.

**The hotel chargeback's own tables** (added 2026-10-26, after these sponsor runs).
The demo's first case reads five tables of its own, never shared with the delivery's
(`config/zetaris-queries-hotel.json`): `EVIDENCE_DESK.hotel_pms_events` (4 rows),
`hotel_ota_bookings` (3), `hotel_door_locks` (2), `hotel_card_disputes` (1) and
`hotel_guest_messages` (1), 11 records for case `N7-HTL-01`, 5 SELECTs per run. Read back through
the adapter they equal the case's fixture in content, facts, sources and replacements (only the
timestamp format differs, the same instant). Receipts: the 3 live comparisons with evidence mode
`zetaris` in `eval/results/comparisons/c7-hotel-chargeback/` (2026-10-26T14:56, 14:58, 15:00
UTC). `npm run sponsors:verify` still runs the disputed delivery, so its verdicts do not cover
this case.

**Which returned records contribute.** All six of the delivery's are assessed. The record that decides the case is
the carrier's proof-of-delivery review `EV-CAR-005` (`carrier_events`), which replaces the
"delivered" scan `EV-CAR-003` from the same table. The trace lists, per run, each record's table,
query token, the judgments made on it and the belief revisions it caused.

**The Unified Semantic Layer is real, and separate.** `npm run zetaris:usl` (2026-10-25, exit 0,
report `eval/results/sponsors/2026-10-25-zetaris-usl.md`) onboards a warehouse CSV and a carrier
JSON source, compiles and activates `lightning.metastore.evidence_desk.delivery_usl`, and queries
it: 3 rows, equal to the two source queries, all 3 scenario records found, the correction link
preserved. Evidence Desk's own Zetaris adapter read the same 3 rows from the USL with a query
token. **The live investigation does not use the USL**: it reads the `EVIDENCE_DESK` tables
above. The USL is a reproducible demonstration beside the live path, not part of it.

**The data-quality rule is configured and exercised.** `evidence_id_present`
(`evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0`) is registered on the USL and run:
3 checked, 3 passed. On an isolated sample USL with one deliberately bad row: 4 checked, 3
passed, 1 failed, and the failing record is listed.

**Sample data, not business data.** Every Zetaris table holds this repository's scenario
records, seeded by `npm run zetaris:seed` (live tables) or reshaped from them (USL sources). No
production or external business data is involved. The platform is the local Docker bundle,
version `2.4.3-v2.4.3.1-hackathon`.

## Meterless Markovian engine

Vendored unmodified (`vendor/meterless-markovian/`, `@meterless/markovian-reference@0.1.0`,
upstream commit `1742dec`). In both sponsor runs on 2026-10-25:
- run 1: engine run `run-1`, completed, 2 chunks; run 2: `run-2`, completed, 1 chunk. Each matched
  by id and the engine's own timestamp in the engine's `history.json` (`inHistory: true`).
- `reflection: true` on both runs, and the trace holds the reflection pass's model call
  (`purpose: explanation`, contract `investigation_explanation`, the served model, attempts and
  latency).
- Chunk limits as documented: at most 8 chunks per run, two records per chunk, carryover between
  chunks.

The documented workflow matches the captured run: fetch evidence, assess it chunk by chunk inside
the engine, record evidence and revise beliefs in Speck after each chunk, then the reflection pass
writes the explanation. Recovery after an interrupted run and recomputation after a correction are
Evidence Desk's code; the trace labels them that way.

## Meterless Nightshift

Run 2026-10-25T13:04:05Z (`npm run sponsors:verify` with `.env`: `MODEL_PROVIDER=meterless`,
`METERLESS_MODEL=meterless/auto`): 5 HTTP requests in 5 model calls to
`http://127.0.0.1:8088/v1/chat/completions`, sent as Meterless app `evidence-desk`, 5 answered, 0
contract rejections, 0 transport failures, 0 retries. Every response named the model that served
it: **`nvidia/nemotron-3.5-lightning-30b-a3b`** (all 5). The earlier receipt
(`2026-10-24T02-14-08-828Z.json`) shows the runtime choosing `nvidia/nemotron-3-ultra-550b-a55b`
for stage 1 and the 30B for stage 2.

These larger models are what Nightshift chose in `meterless/auto` mode. They are **not** the local
4B model, and no evaluation or comparison number came from a routing mode. Until 2026-10-25 no
number was produced through Nightshift at all; since 2026-10-26 every live number is, with the
pinned Bolt E4B (section *2026-10-26: Bolt E4B through Nightshift*). With `MODEL_PROVIDER=ollama` the verifier correctly reports Nightshift NOT OBSERVED
(run 13:04:35Z, exit 1: "model calls went to http://127.0.0.1:11434/v1, not through Nightshift").

## NVIDIA Nemotron

**The local model behind every live number until 2026-10-25**, as reported by the Ollama runtime
on 2026-10-25:

| | |
|---|---|
| Model | `nemotron-3-nano:4b` (family `nemotron_h`, 3,973,556,832 parameters) |
| Quantisation | Q4_K_M, GGUF, 2.8 GB |
| Runtime | Ollama 0.40.6, local, one consumer GPU |
| Request settings | temperature 0.1, `max_tokens` 4096, `reasoning_effort: none`, JSON output, at most 2 attempts per structured reply (Speck's registry) |
| Context | Ollama's default window inside Speck and standalone; prompts measured at about 900-1,900 tokens |
| Served-model check | the endpoint reported `nemotron-3-nano:4b` on every call in every live report |

Sponsor run 13:04:35Z with that model: 5 calls, 5 valid, 0 retries; 6 evidence objects in Speck
with model provenance, all at reliability ≤ 0.4.

**Where the model contributes, and where it does not.**
- The model judges how each record bears on each explanation (non-decisive judgments) and writes
  the explanation in the reflection pass. In live mode every non-decisive judgment is the model's.
- Independent of the model: decisive fact rules (applied first; a contradicting model judgment is
  dropped), validity (declared replacement, restatement, withdrawal), the rebuild of beliefs from
  evidence that still counts, Speck's belief revision and its 0.4 cap on model-judged evidence,
  and the conclusion policy (Speck's threshold, `corroborated-1`, withholding while records wait).
- Evidence for the split: the deterministic runs reach the same supersession and revision
  behaviour with no model at all; live, the model's judgments on the bank return were right in
  every sample under both builds, and the outcome changed only when Evidence Desk's policy changed.
  Equally, the model is the source of Build 4's new errors: its weak "supports" judgments are what
  `corroborated-1` concluded from in `missing-evidence` and the claim case.

Not used: NVIDIA's hosted API (the client supports it), any other NVIDIA infrastructure.

## 2026-10-26: Bolt E4B through Nightshift

Run 2026-10-26T07:05:56Z (`npm run sponsors:verify` with `.env`: `MODEL_PROVIDER=meterless`,
`METERLESS_MODEL=nvidia/nemotron-3.5-bolt-e4b`, Zetaris live), receipt
`eval/results/sponsors/2026-10-26T07-05-56-787Z.json`: every sponsor OBSERVED, exit 0.
- **Nightshift:** 5 HTTP requests in 5 model calls to `http://127.0.0.1:8088/v1/chat/completions`,
  sent as `meterless-app` `evidence-desk`, all answered; every response named
  `nvidia/nemotron-3.5-bolt-e4b`. A pinned model is asked for by name, so the runtime does not
  choose; the response still names what served it.
- **Nemotron:** 5 attempts, 0 contract rejections, 0 transport failures; 5 evidence objects in
  Speck with model provenance, all at reliability 0.4 or below.
- **Zetaris, the Meterless engine and Speck:** as before (engine runs `run-1` with 2 chunks and
  `run-2` with 1, found in the engine's history; 7 and 8 belief revisions, all in the trace).
- **Where the model runs:** Bolt E4B is served by NVIDIA, reached through the local Nightshift
  runtime 1.2.7. The calls leave this machine; only this repository's sample data is sent. The
  on-device Bolt E4B that Nightshift also lists was not run (its local lane was not ready).
- **What changed in Evidence Desk to allow it:** a model the runtime lists by name is accepted as
  a pinned model (Speck's Meterless contract, `patches/speck-meterless-provider.patch`; Speck's
  cognition unchanged), and structured requests through Nightshift are sent without JSON mode
  (`docs/bolt-e4b.md`, section 1).

## Speck

Submodule pinned to upstream `8821789`, cognition unmodified (Build 4 changes no Speck code and
does not move the pin). In both sponsor runs every belief revision in Speck's event log appears in
the trace exactly once (run 1: 6 or 9 revisions, run 2: 8 or 10, by configuration), and the
current conclusion is read from Speck's state. The project-local patches (`patches/`) are unchanged.

## Cursor

A development tool. Nothing in a run can observe it, and nothing in the repository records it: no
Cursor configuration files, and every commit is authored by the developer with no tool
attribution. The README states the team's report that it was used; that is unverified here and
must not be presented as runtime integration.
