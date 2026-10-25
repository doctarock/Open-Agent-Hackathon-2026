# Build 4: why Speck failed the bank return live, and what changed

Baseline: Build 3.x at commit `fbed6e7`. Speck submodule pinned at `8821789`, cognition unmodified.

Sections 1 to 3 were written and committed **before** the change was implemented or any system
was run on the new challenge cases. Section 4 onwards was written after.

## 1. The failure

Side-by-side comparison, bank return (`eval/scenarios/correction-supersedes`), local
`nemotron-3-nano:4b` (Q4_K_M, Ollama, reasoning off, temperature 0.1), six live samples on
2026-10-23 (`eval/results/comparisons/eval-correction-supersedes/`):

| After the bank return (label: H-UNPAID) | Stateless model call | Speck |
|---|---|---|
| matches the label | 5/6 | 0/6 |
| outcome | H-UNPAID 5, unresolved 1 | unresolved 6 (pointing to H-UNPAID at 0.364-0.38) |

Deterministic runs (fact rules, no model) reach H-UNPAID supported at 0.66 every time.

## 2. Trace of one live sample

`2026-10-23T08-49-41-771Z-b92a9bde.json`, after the return. All six live samples have the same
structure; only the strengths differ (0.9-1.0).

| Step | What happens | Effect on H-UNPAID |
|---|---|---|
| Source records | Fixture file (this case has no Zetaris tables). `EV-BNK-103` (bank: payment returned, `supersedes: [EV-BNK-101]`), `EV-LDG-104` (ledger: invoice reopened, `ledger.status=reopened`). `EV-LDG-102` (ledger: marked paid, `ledger.status=paid`) is still visible and declares nothing. | |
| Intake / validity | `EV-BNK-101` stops counting (declared supersession). `EV-LDG-102` keeps counting: supersession must be declared, and the ledger did not declare it. | |
| Assessment | Decisive rule: `payment.reversed=true` refutes H-PAID. The model judges every other pair. In 6/6 samples it judged `EV-BNK-103` and `EV-LDG-104` as supporting H-UNPAID, and `EV-LDG-102` as contradicting it. **The model's reading was right every time.** | |
| Recording | Each record carries model judgments, so it enters Speck as the model's. Speck caps its reliability at 0.4 (`beliefRevision.modelReliabilityCeiling`). | |
| Hypothesis rebuild | H-UNPAID is rebuilt from its prior 0.30 with the relations that still count. | 0.30 |
| Belief revision | `EV-BNK-103` supports: 0.2 × 0.4 × 1.0 | +0.08 |
| | `EV-LDG-104` supports | +0.08 |
| | `EV-LDG-102` contradicts | -0.08 |
| Result | H-UNPAID **0.38, active**. H-PAID rejected (decisive). H-PARTIAL rejected (0.05). | 0.38 |
| Judgment | "Supported" needs Speck's supported status, i.e. confidence ≥ 0.6. | unresolved |

### Root cause

Two defects, both in Evidence Desk, neither in Speck and neither in the model:

1. **The conclusion was unreachable by construction.** With every non-decisive judgment made by
   the model and capped at 0.4, each record moves a belief by at most 0.08. From a prior of 0.30,
   reaching 0.6 needs four unanimous, full-strength supporting records and nothing against.
   This case has two. *No model output could have produced a conclusion*: the abstention was
   not a judgment about the evidence. The same arithmetic is why stage 1 succeeded: H-PAID
   started at 0.5 and needed only two records. In live mode the author's prior, not the evidence,
   decided whether Speck could conclude. At that point Speck had already ruled out every other
   explanation and held H-UNPAID as the only one standing, supported by two different sources.
2. **Speck relied on an obsolete record.** `EV-LDG-102` ("marked paid") still counted against
   H-UNPAID after the same ledger reported the invoice `reopened` (`EV-LDG-104`). The ledger's
   current status is "reopened"; its earlier status no longer describes anything. Because the
   ledger did not declare a replacement, the Build 3 policy (only declared supersession counts)
   kept it. This is the failure Speck is meant to avoid: relying on evidence its own source has
   since changed.

**Why the baseline succeeds:** it reads all four records in one call and answers from their
text. It has no cap, no prior and no threshold, so two clear records are enough. It treated the
earlier "marked paid" as history, as a person would.

**What it is not:** not the threshold (0.6 is Speck's), not the cap (Speck's, deliberately kept),
not the model's interpretation (correct in 6/6), not a stale hypothesis (Build 3 rebuilds them),
and not the evidence caps on the comparison's side.

A third defect was found while checking the second fix against other suites, and is fixed
because the second fix would otherwise make it worse:

3. **A declared replacement was ignored when the replaced record has a later timestamp.**
   `basis.ts` evaluated records newest first and ignored "a claim about a later record". In the
   cross-domain `*-late-original` cases, a backfilled record is stamped later than the
   correction that names it, so the correction was ignored and the replaced record kept counting
   (cross-domain "same records, different orders: identical and correct": 0/2). An id named in
   `supersedes` is unambiguous whatever the timestamps. Fixing this after seeing that result
   means the cross-domain suite is **no longer independent** for this behaviour.

## 3. The change (pre-registered)

No threshold, prior, cap or Speck code changes. The stateless baseline and the comparison rules
are unchanged.

### 3a. Validity: a source's newer value replaces its older one (`src/investigation/basis.ts`)

A record stops counting, as **restated**, when:
- every fact it reports is reported again by a later-observed record from the **same source
  system** that still counts, and
- at least one of those values differs.

Rules that keep it narrow:
- Facts are the source's own structured fields, never inferred from text or by the model.
- Different systems never restate each other (a cycle count does not replace a warehouse figure).
- Same value restated: the older record keeps counting (nothing changed).
- A record with some facts restated and others not keeps counting (record-level, as supersession is).
- Strictly later observation time; equal timestamps restate nothing.
- Declared supersession and withdrawals are resolved first. A record that a valid record
  declares replaced cannot restate anything, and a record cannot be restated by a record that it
  itself declares replaced.
- Records without facts (most user cases) are never restated.

Declared supersession is resolved independently of timestamps: a record is replaced when any
record that still counts names it in `supersedes`. Chains resolve as before (a withdrawn or
replaced correction replaces nothing, so the record it named counts again). In a cycle of
declarations, claims made by an older record against a newer one are ignored, as before.

This is an **evidence-policy change**: Build 3 said "supersession must be stated, never
inferred". It now says: replacement is stated by the source, either by naming the record, or by
the same system reporting a newer value for every fact the old record reported.

### 3b. Conclusion: corroborated by independent sources (`src/investigation/conclusion.ts`)

Rule `corroborated-1`. When Speck holds no explanation as supported, Evidence Desk concludes the
top explanation H when **all** hold:
1. H is Speck's top-ranked current explanation (not rejected or superseded);
2. at least two records that still count support H, from at least two different source systems;
3. no record that still counts is recorded against H;
4. every other current explanation that Speck has not ruled out has no supporting record that
   still counts.

The conclusion is reported as reached by corroboration, with Speck's own confidence and status
shown unchanged beside it ("Speck's confidence 0.46 is below its 0.6 threshold; ..."). Speck's
belief state is not written to.

Why this is not a lowered threshold: it uses no confidence value. It asks whether the evidence
is independent, unanimous and unopposed, and whether every rival is either ruled out by Speck or
unsupported. A single record, however strong, never satisfies it; any counting record against
the explanation, or any support for a rival, blocks it. It applies to rule-judged and
model-judged evidence alike.

### Predictions, stated before running

- Bank return, deterministic: unchanged (H-PAID supported 0.86, then H-UNPAID supported 0.66).
  `EV-LDG-102` is listed as no longer counting after the return.
- Bank return, live: if the model judges as it did in the six saved samples, H-UNPAID is
  concluded by corroboration after the return. The model can still prevent it, for example by
  judging a record as supporting H-PARTIAL.
- Cross-domain `*-late-original`: the replaced record no longer counts.
- Abstentions that are labelled correct must stay abstentions. If any becomes a conclusion,
  that is reported as an unsupported conclusion and is not tuned away.
