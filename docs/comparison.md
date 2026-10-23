# Speck beside a stateless baseline

The same case, the same evidence, the same correction, processed two ways, with what each
actually did. This is what the first panel of every case page runs, and what
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
- **Concludes or abstains.** Speck concludes only when it holds an explanation as *supported*;
  *leading* or *points to* count as abstaining, as in the evaluation.
- **Support offered.** The records each side cites for what it presents.
- **Relies on a replaced record.** Any of those records replaced by a later visible record,
  derived from the records alone with the same rule for both.
- **Changed since the previous stage**, and **recorded why** (only something the approach itself
  kept counts).
- **Pre-registered label** (evaluation cases only): matches, and unsupported conclusion, scored
  exactly as `src/eval/metrics.ts` scores a checkpoint. The labels were written before any system
  was run on the case.

What it cannot separate: the difference between the columns comes from Speck's explicit evidence
and revision state *and* its conclusion policy (thresholds, decisive refutation, supersession,
the 0.4 cap), not from persistence alone. The evaluation's `speck-fresh` system, which rebuilds
from scratch at every checkpoint, reaches the same conclusions as the persistent one.

## Results

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
npm run compare        # deterministic: both prepared cases, fixtures and fact rules, no model
npm run compare:live   # with .env: the Nemotron endpoint, and Zetaris for the disputed delivery
```

Or press **Run the side-by-side comparison** on a case page. The page shows the newest comparison
made with the case's current settings; earlier ones, and ones made with other settings, are
listed beneath it with their date and configuration. **Evaluation results** counts every saved
comparison per case and configuration.
