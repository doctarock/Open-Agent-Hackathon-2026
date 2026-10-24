# Input/output examples

Three reference cases for `npm run investigate`. Each folder holds:

- `input.json`: the whole case as structured input, `{"scenario": …, "evidence": …}`. These are
  the question, the competing explanations with their fact rules, the stages, and every record
  with its source, time, facts and what it replaces.
- `expected-output.json`: what `npm run investigate -- examples/<name>/input.json` returns in
  sample mode, stage by stage.

The expected outputs are reference examples only. Nothing reads them to produce a result:
`test/examples.test.ts` runs each input and checks that the result equals the file. Where the
output falls short of the case's pre-registered label, it is recorded as it is, not edited to
match.

```bash
npm run investigate -- examples/payment-correction-chain/input.json --output result.json
```

| Example | Domain | What it exercises | Per stage: conclusion (pre-registered label) |
|---|---|---|---|
| [payment-correction-chain](payment-correction-chain/) | Payments | A correction that is itself corrected. Speck revises twice and stops counting all three replaced records. | `credit`: leading H-PAID-FULL (H-PAID-FULL) · `first-correction`: leading H-PARTIAL; XP1-01 no longer counts (H-PARTIAL) · `second-correction`: supported H-PAID-FULL; XP1-01, XP1-02, XP1-03 no longer count (H-PAID-FULL) |
| [procurement-short-delivery](procurement-short-delivery/) | Procurement | A receipt amended by a recount, then confirmed by the manifest. Speck abstains between the two. | `receipt`: supported H-FULL (H-FULL) · `recount`: **unresolved**, points to H-SHORT; XR1-02 no longer counts (H-SHORT: Speck abstains where the label commits) · `manifest`: supported H-SHORT (H-SHORT) |
| [logistics-missing-proof](logistics-missing-proof/) | Logistics | Conflicting claims, and the proof that would settle them does not exist. Speck correctly declines to conclude. | `dispute`: unresolved (no conclusion) · `proof-requested`: unresolved (no conclusion) |

The labels come from the held-out cross-domain evaluation (`eval/cross-domain/<case>/expected.json`),
which these inputs copy. They are therefore not new evidence of accuracy. The evaluation's
results are in [docs/cross-domain-evaluation.md](../docs/cross-domain-evaluation.md).

## The output

```jsonc
{
  "schema": "evidence-desk.investigation-result.v1",
  "case":  { "scenarioId", "caseId", "title", "question" },
  "mode":  { "evidence": "fixture" | "zetaris", "reasoner": "rules" | "nemotron", "model": null | "<id>" },
  "stages": [{
    "stage": "<stage id>",
    "visibleRecords": ["…"],       // every record the stage makes visible
    "newlyAssessed":  ["…"],       // assessed by this stage's run (earlier ones are not re-assessed)
    "noLongerCounted": [{ "recordId", "reason" }],  // replaced or withdrawn
    "conclusion": {
      "state": "supported" | "leading" | "unresolved",
      "hypothesis", "statement", "confidence",       // null when unresolved
      "pointsTo",                                    // what the evidence favours, even unresolved
      "eliminated", "supportedBy", "contradictedBy", "headline"
    },
    "changedFromPreviousStage": true | false
  }],
  "final": { /* the last stage's conclusion */ }
}
```

`confidence` is Speck's belief-revision score, not a calibrated probability. Stdout also carries
the execution trace as JSON Lines before the result (see the README, *Command line*).
