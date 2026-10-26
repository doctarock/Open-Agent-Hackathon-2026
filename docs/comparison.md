# Speck beside a stateless baseline

The same case, the same evidence, the same correction, processed two ways, with what each
actually did. This is what the **Speck vs. baseline** tab of every case page runs, and what
`npm run compare` / `npm run compare:live` save. Every report behind the numbers below is in
`eval/results/comparisons/<scenario>/` (tracked in git; each run is its own file and none is
ever overwritten).

## The question it answers

An ordinary stateless model call answers from whatever evidence it is handed. When a source later
corrects a record, does it drop the record that was replaced, change its answer, and say why? And
does keeping the case as explicit state (Speck) do any better on the same inputs?

## How it is made fair

| | Stateless baseline | Speck |
|---|---|---|
| Implementation | The evaluation's own baseline, unchanged (`src/eval/systems.ts`: `statelessModelAnswer`, `statelessRulesAnswer`), called afresh at every stage | Evidence Desk as built: one Speck case carried across the stages (`src/compare/comparison.ts`) |
| Evidence at each stage | exactly the records Speck's desk lists as visible | the same records |
| Live assessor | one call to the configured Nemotron endpoint with the question, the explanations and every visible record (text, facts, and "replaces …" where the source says so); must answer an explanation or "unresolved", with citations | the same endpoint, model, temperature (0.1), output budget and reasoning effort; one call per evidence chunk plus one for the explanation; Speck's decisive fact rules and its 0.4 reliability cap on model-judged evidence apply |
| Deterministic assessor | the scenario's fact rules summed from scratch; the top positive score wins. It does not read a record's `supersedes` list. | the same fact rules through Speck's belief revision |
| Memory between stages | none | the case's evidence, beliefs, judgments and revisions |

Every check is computed the same way for both sides:
- **Concludes or abstains.** Speck concludes when it holds an explanation as *supported*, or
  (since Build 4) when Evidence Desk's rule `corroborated-1` holds: two or more source systems
  support it with records that still count, nothing is recorded against it, and every rival is
  ruled out or unsupported. Each Speck conclusion says which route it took, with Speck's own
  confidence beside it. *Leading* or *points to* count as abstaining, as in the evaluation.
  Whether abstaining was right is scored against the label (abstained rightly, or where a
  conclusion was due).
- **Support offered.** The records each side cites for what it presents.
- **Relies on a replaced record.** Any of those records replaced by a later visible record,
  derived from the records alone with the same rule for both.
- **Relies on an out-of-date record** (Build 4). Any of those records whose own source later
  reported a new value for every fact in it (a ledger that said "paid", then "reopened"),
  derived the same way for both.
- **Why they differ.** At each stage where the two disagree, a sentence built from what each
  returned: Speck's blocking reason or route, and what the stateless call cited.
- **Model identity and failures.** For both sides: calls, retries, failures, and the model name
  the endpoint reported serving.
- **Changed since the previous stage**, and **recorded why** (only something the approach itself
  kept counts).
- **Pre-registered label** (evaluation cases only): matches, and unsupported conclusion, scored
  exactly as `src/eval/metrics.ts` scores a checkpoint. The labels were written before any system
  was run on the case.

What it cannot separate: the difference between the columns comes from Speck's explicit evidence
and revision state *and* its conclusion policy (thresholds, decisive refutation, supersession,
the 0.4 cap), not from persistence alone. The evaluation's `speck-fresh` system, which rebuilds
from scratch at every checkpoint, reaches the same conclusions as the persistent one.

## Results, Nemotron 3.5 Bolt E4B (2026-10-26)

Live: `nvidia/nemotron-3.5-bolt-e4b`, served by NVIDIA through Meterless Nightshift and asked
for by name, reasoning off, temperature 0.1, both sides; every response named that model. Six
samples per case, run back to back with Evidence Desk as of Build 5 (rule `corroborated-1`).
None was discarded. Four earlier comparisons, made before Evidence Desk stopped asking Nightshift
for JSON mode, are kept apart and uncounted
(`eval/results/experiments/bolt-e4b/2026-10-26-before-json-mode-fix/`; why in
[bolt-e4b.md](bolt-e4b.md)). The disputed delivery's evidence was read live from Zetaris.

| Live, 6 samples each | Stateless | Speck |
|---|---|---|
| Delivery, initial evidence: concluded | nothing 6/6 | nothing 6/6 (leading "delivered", 0.54) |
| Delivery, after the correction: concluded | "misdelivered" 6/6 | "misdelivered" 6/6, by corroboration |
| ... cites the replaced scan `EV-CAR-003` | **0/6** | 0/6 |
| ... recorded why its conclusion changed | 0/6 | 6/6 |
| Bank return, before the return (label: paid): matches | 6/6 | 6/6 |
| Bank return, after the return (label: unpaid): matches | 6/6 | 6/6, by corroboration |
| Errors | 0/12 | 0/12 |

**What these support.** With Bolt the correction is no longer where the answers part: the
stateless call dropped the replaced scan and the replaced bank credit on its own, every time, and
no longer called the invoice unpaid before the return. Both reached the labelled answers. What
the stateless call still does not have is a record of what changed: Speck said which record
stopped counting and which beliefs were rebuilt (6/6), the stateless call cannot (0/6). The 4B
results below stand as recorded; they show the same comparison on a weaker reading.

## Hotel chargeback (set 7)

The guided demo opens on this comparison. Set 7's `hotel-chargeback` (labels locked before any
run; [set-7-conflicting-receipts.md](set-7-conflicting-receipts.md)): a no-show is reported and
relayed, corrected by a late check-in and door-lock entries, disputed, then reinstated when both
the check-in and the key entries turn out to be a walk-in guest's (`N7H-10` and `N7H-09` replace
`N7H-04` and `N7H-05`, so the night audit `N7H-02` counts again). Saved on 2026-10-26 with
Evidence Desk as of Build 5 (rule `corroborated-1`): 1 deterministic comparison, and 6 live with
`nvidia/nemotron-3.5-bolt-e4b` through Nightshift, 3 on the case's fixture and 3 with its
evidence read live from its own five Zetaris tables. The six live samples came out the same at
every stage; none was discarded and none errored.

| Stage (label) | Stateless, fact rules | Speck, fact rules | Stateless, Bolt (6) | Speck, Bolt (6) |
|---|---|---|---|---|
| Booked (abstain) | abstains | abstains | abstains 6/6 | abstains 6/6 |
| No-show (abstain) | "no-show" | "no-show", supported | "no-show" 6/6 | "no-show" 6/6, supported 0.648 |
| Late check-in (stayed) | "stayed" | "stayed", supported | "stayed" 6/6 | abstains 6/6, leading "stayed" 0.58 |
| Dispute (stayed) | "stayed" | abstains, leading "stayed" | "stayed" 6/6 | abstains 6/6, unresolved 0.444 |
| Re-attributed (no-show) | "stayed", **on the replaced `N7H-04`, `N7H-05`** | **"no-show"**, supported | abstains ("unresolved") 6/6 | **"no-show" 6/6**, supported 0.92-0.93 |
| Refunded (no-show) | "stayed", on the replaced records | "no-show" | abstains 6/6 | "no-show" 6/6 |

**What these support.** Where a correction is itself undone, the approaches part: Speck stops
counting the two replaced records, the night audit counts again, and it concludes "no-show" and
says why; the stateless call either keeps the stay on the replaced records (fact rules) or cannot
decide (Bolt). The same holds in the evaluation's runs (fact rules, and 3 repeats on each of the
4B and Bolt). The table also shows Speck's costs on this case: it counts the agency's relay of the
hotel's report as a second source at the no-show, and it holds back at the late check-in (live)
and the dispute where the stateless call is right. One case, written by the project's author.

## Results, Build 4 (2026-10-25)

Every saved comparison, counted per case, Evidence Desk policy, evidence source and model, is in
[eval/results/comparisons/SUMMARY.md](../eval/results/comparisons/SUMMARY.md)
(`npm run compare:summary`), with every sample listed. Build 4's changes and their full
evaluation are in [build-4-bank-return.md](build-4-bank-return.md).

Live: `nemotron-3-nano:4b` (Q4_K_M) on local Ollama, reasoning off, temperature 0.1, both sides;
the endpoint reported that model on every call. Six samples per case and build, run back to back
on the same machine: Build 3 (commit `fbed6e7`), then Build 4. None was discarded. The disputed
delivery's evidence was read live from the local Zetaris platform; the bank return's from its
fixture file.

### Bank return (held-out case `correction-supersedes`; the Build 4 change was designed on it)

| Live, 6 samples each | Stateless, beside Build 3 | Speck, Build 3 | Stateless, beside Build 4 | Speck, Build 4 |
|---|---|---|---|---|
| Before the return (label: paid): matches | 0/6 (6 unsupported "unpaid") | 6/6 | 0/6 (6 unsupported "unpaid") | 6/6 |
| After the return (label: unpaid): matches | 6/6 | **0/6** (unresolved 0.364-0.38) | 5/6 (1 unresolved) | **6/6** by corroboration (Speck's own confidence 0.444-0.46) |
| After: counts the ledger's old "paid" against "unpaid" | n/a | 6/6 | n/a | 0/6 |
| After: recorded why its conclusion changed | 0/6 | 6/6 | 0/6 | 6/6 |

**Why Build 3 failed and the baseline did not.** In every live sample the model judged the two
new records correctly. Speck caps model-judged evidence at reliability 0.4, so each record moved
"unpaid" by at most 0.08 from its prior of 0.30, and the ledger's own superseded "paid" status
still counted 0.08 against it: 0.38 at best, against a threshold of 0.6 that two records could
never reach. The abstention was arithmetic, not a judgment about the evidence. The stateless call
read the four records and answered. Build 4 stops counting a record whose source has since
reported a new value for every fact in it, and concludes when independent sources agree with
nothing against and every rival ruled out or unsupported.

### Disputed delivery (development fixture, no labels)

| Live, 6 samples each | Stateless, beside Build 3 | Speck, Build 3 | Stateless, beside Build 4 | Speck, Build 4 |
|---|---|---|---|---|
| After the correction: concluded | "delivered" 6/6 | nothing 4, error 2 | "delivered" 6/6 | "misdelivered" 2 (by corroboration), nothing 3, error 1 |
| ... cites the replaced scan `EV-CAR-003` | 6/6 | 0/4, plus the 2 errored samples | 6/6 | 0/5, plus the errored sample |
| ... recorded why its conclusion changed | 0/6 | 4/6 | 0/6 | 5/6 |

**The errored samples.** In three of the twelve samples (two under Build 3, one under Build 4)
the model's reply for the correction failed Speck's contract twice, the correction stayed
unassessed, and Speck's state still held "delivered" on the replaced scan. All three are counted
as errors. Since Build 4 such a conclusion is withheld until
the waiting records are assessed (build-4-bank-return.md, section 6).

**What these support.** The correction is still where the approaches part: the stateless call
kept citing the replaced scan in every delivery sample (12/12); Speck cited it in none of the 9
that completed, and in the 3 errored samples its unassessed state still rested on it. On the bank return Build 4 now reaches the
labelled answer, but the case it was designed on is not a test of it. On five new cases written
and locked beforehand, Build 4 scored the same as Build 3 live (18/30, the baseline also 18/30),
and its corroboration rule concluded twice from agreement a careful investigator would not accept
(build-4-bank-return.md, sections 5b and 5c). No accuracy claim is made.

Build 5 (build-5-corroboration.md) tested a successor rule, `corroborated-2`, on eight more locked
cases through the evaluation, not this panel; no new side-by-side comparisons were recorded for it.
Samples made under it carry the policy `build-5 (restatement, corroborated-2)`, so they are never
counted with Build 4's.

## Results, Build 3 (2026-10-23)

Run on 2026-10-23. Live: `nemotron-3-nano:4b` on local Ollama (the endpoint reported that model on
every call); the disputed delivery's evidence read live from the local Zetaris platform, the bank
return's from its fixture file (it has no Zetaris tables). Six live samples per case, all saved;
none was discarded. Four of the twelve live samples overlapped in time with another run (a
second `npm run compare:live` was started by mistake while the first was sampling) and took
longer; they are genuine runs of the same configuration and are counted like the rest.

### Disputed delivery (no pre-registered labels: a development fixture)

Stage 1: order, warehouse handover, carrier scan "delivered", customer says nothing arrived.
Stage 2: the carrier's proof-of-delivery review (`EV-CAR-005`) replaces the scan (`EV-CAR-003`):
GPS 380 m away, at No. 41 *North*; the resident there is holding the parcel.

| | Stateless model call | Speck |
|---|---|---|
| Stage 1, concluded | delivered, 6/6 | delivered (supported 0.652) 2/6; leaning to delivered without concluding (leading 0.572-0.644) 4/6 |
| Stage 2, concluded | **delivered, 6/6** | concluded nothing 6/6: pointing to misdelivered 5/6 (leading 0.502-0.504 three times, unresolved 0.42 twice), no explanation ahead 1/6 |
| Stage 2, cites the replaced scan `EV-CAR-003` as support | **6/6** | 0/6 |
| Stage 2, recorded why its conclusion changed | 0/6 | 6/6 (`EV-CAR-003` no longer counts; the beliefs that rested on it rebuilt) |

Deterministic (2 identical runs): the rule baseline concludes delivered at stage 1, where Speck
holds it only as leading (0.61) because the customer's complaint counts against it; both conclude
misdelivered at stage 2; only Speck records why.

### Bank return (held-out evaluation case `correction-supersedes`, with labels)

Stage 1: a bank credit for the invoice and the ledger marking it paid. Label: paid.
Stage 2: the bank returns the payment (`EV-BNK-103` replaces the credit `EV-BNK-101`) and the
ledger reopens the invoice. Label: unpaid.

| | Stateless model call | Speck |
|---|---|---|
| Stage 1, matches label (paid) | 3/6; **3/6 concluded unpaid, an unsupported conclusion** | 6/6 (supported 0.66) |
| Stage 2, matches label (unpaid) | **5/6**; 1/6 answered unresolved | **0/6**: pointed to unpaid each time but stayed unresolved (0.36-0.38) |
| Stage 2, cites the replaced credit as support | 0/6 | 0/6 |
| Stage 2, recorded why its conclusion changed | 0/6 | 6/6 |

Deterministic (2 identical runs): both match the labels at both stages (Speck supported 0.86, then
0.66); the rule baseline still counts the replaced credit in its scores; only Speck records why.

### What these results support, and what they do not

- **The correction is where the approaches part.** On the disputed delivery the stateless call
  kept its answer after the source corrected the record it rested on, and kept citing that
  record, in every sample. Speck stopped counting it every time and recorded the revision.
- **Speck is more cautious, and that costs it.** On the bank return Speck never reached the
  labelled conclusion live after the return: its two supporting records were judged by the model,
  and Speck caps model-judged evidence at reliability 0.4 (the cap was not tuned for this). The
  stateless call got it right 5 times in 6. It also made an unsupported "unpaid" claim at stage 1
  in half the samples, where Speck concluded the labelled answer every time.
- **No accuracy claim.** Two cases and six samples each are illustrations of behaviour, not rates.
  No significance is claimed, and the evaluation (below) still finds no measurable accuracy
  difference from persistence alone.
- **Traceability is the consistent difference**: in every sample, Speck's state said which
  records count, which stopped counting and why, and what was believed before.
- **These samples are with reasoning off.** Every live comparison here was made with the model's
  reasoning off, as the assessor runs.
  - With reasoning on, the stateless baseline did much better on the evaluation's labelled
    checkpoints: 35/48 correct against 19/48, with unsupported claims falling from 19 to 3 and
    every refuted claim kept out. Speck stayed at 27/48 against 26/48.
  - So the stateless call's habit of keeping "delivered" and citing the replaced scan is a property
    of the small model with reasoning off, not of stateless calls in general.
  - See the README, *Reasoning on or off*; the reports are in `eval/results/experiments/reasoning/`.

## Decisive mode (experimental)

The two approaches fail in different places: the stateless call keeps leaning on corrected
records and sometimes over-commits; Speck stays unresolved when its model-judged support is
capped. Decisive mode is an opt-in reading that combines them (`public/decisive.js`, rule
`decisive-1`, fixed as first written):

1. The stateless answer is rejected if it cites a record a later record replaced, or a record
   that does not exist, or no record at all.
2. If it survives and names the explanation Speck holds or points to, decisive mode concludes it.
3. Otherwise Speck's own firm conclusion stands, or nothing is concluded.

Switch it on at the top of a case's conclusion (or in the comparison panel; both set the same
per-viewer preference). On the case it asks the same stateless baseline for an answer on the case
as it stands after each run (one model call when live) and shows the reading beside Speck's
conclusion; in the comparison it adds "Decisive mode would…" under each stage. Speck's belief
state, the evidence and the history are never changed by it.

**Replayed on the saved comparisons above. Exploratory, not a result:** the rule was written
after looking at these samples, and the bank return is a held-out evaluation case, so this replay
is tuned on what it is scored on.

| Live, 6 samples each | Stateless | Speck | Decisive mode |
|---|---|---|---|
| Bank return, before the return (label: paid) | 3/6 right | 6/6 | 6/6 |
| Bank return, after the return (label: unpaid) | 5/6 | 0/6 | 5/6 (1 concluded nothing) |
| Delivery, after the correction | "delivered" on the replaced scan, 6/6 | nothing, 6/6 | nothing, 6/6 |
| Delivery, initial evidence | "delivered", 6/6 | firm 2/6, leaning 4/6 | "delivered", 6/6 |

The last row is its cost: where both lean the same way it concludes where Speck alone would wait
(here, despite the customer's complaint counting against delivery). Both opinions come from the
same model, so their agreement is not independent evidence. Before it is presented as more than
an option it needs evaluating, frozen, on cases it was not designed on: the regression and
cross-domain suites, live with several samples, and new labelled cases written first.

## Reproduce

```bash
npm run compare        # deterministic: the three prepared cases, fixtures and fact rules, no model
npm run compare:live   # with .env: the Nemotron endpoint, and Zetaris for the hotel chargeback and the disputed delivery
npm run compare:live -- --only hotel-chargeback   # one case
```

Or press **Run the side-by-side comparison** on a case page. The page shows the newest comparison
made with the case's current settings; earlier ones, and ones made with other settings, are
listed beneath it with their date and configuration. **Evaluation results** counts every saved
comparison per case and configuration.
