# Bolt E4B comparisons made before the JSON-mode fix (2026-10-26)

Four live comparisons (two per case) made while switching the assessor to
`nvidia/nemotron-3.5-bolt-e4b` through Meterless Nightshift, before the fix in
`src/reasoning/nemotron.ts` (`jsonMode`). They are kept as they were saved, and
are not counted with the Bolt E4B results.

In every one, Speck's first assessment failed: Nightshift's JSON mode rejected
Bolt's answer (HTTP 502, `invalid_json_output`) because it opened with the
`>> action` line that the Meterless engine's chunk prompt asks for, before
valid JSON. Evidence Desk no longer asks Nightshift for JSON mode; Speck's
contract check takes the JSON object that follows and validates it. The
diagnosis is in `docs/bolt-e4b.md`.
