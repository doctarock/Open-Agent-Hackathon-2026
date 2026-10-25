# Build 5: a successor to rule `corroborated-1` (experiment record)

Reference: Build 4 at commit `e5efc75` (rule `corroborated-1`). Speck submodule pinned at
`8821789`, cognition unmodified. This file is written in stages; each section says when it was
written relative to the runs it describes.

## 0. Decision fixed before any strength was inspected

*Written and committed before the live strength diagnostic (section 1) was run.*

No saved receipt records the strength of each judgment behind a corroborated conclusion (the
eval reports keep outcomes; the comparison reports keep only Speck's per-record deltas). So
whether the Build 4 false positives rest on weak judgments is not yet known.

The hypothesis to test: a corroborating judgment should count only if its strength is **at least
0.5**. The value is taken from meanings the code already has, not chosen from data:
- the model is asked for "strength: a number from 0.1 (weak) to 1 (strong)"
  (`src/reasoning/nemotron.ts`); 0.5 is the middle of that scale;
- a model reply with no usable strength is set to 0.5 (`nemotron.ts`), so 0.5 is already the
  "no information" value; a strength that was defaulted, rather than reported, must therefore
  not qualify;
- scenario fact rules use 1 (the default) for a record that establishes a state, 0.5 for
  indirect support and 0.3 for weak support.

Commitment: the diagnostic on already-seen cases tests whether this hypothesis can explain the
false positives at all. The threshold is not moved after the diagnostic, whatever it shows.
