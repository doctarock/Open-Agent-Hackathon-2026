// Decisive mode: an experimental reading that combines Speck with a stateless
// model call. Pure; the case page and the comparison panel both use it, and
// test/decisive.test.ts checks it. It never changes Speck's belief state.
//
// The rule, fixed as first written (2026-10-23):
//  1. The stateless answer is rejected if it cites a record that a later
//     record replaced, or a record that does not exist.
//  2. If it survives and names the explanation Speck holds or points to,
//     decisive mode concludes it.
//  3. Otherwise Speck's own firm conclusion stands, if it has one.
//  4. Otherwise decisive mode concludes nothing.
//
// It was written after looking at six live comparisons per prepared case,
// one of which is a held-out evaluation case, and has not yet been evaluated
// on cases it was not designed on. The page says so wherever it is shown.

export const DECISIVE_RULE_VERSION = "decisive-1 (2026-10-23)";

export const DECISIVE_EXPLANATION = [
  "Decisive mode adds a second reading beside Speck's conclusion. It asks a stateless model call (or, without a model, the fact rules) for an answer over the same records, then checks that answer against Speck's state.",
  "The stateless answer is accepted only if every record it cites still counts (none replaced by a later record, none that does not exist) and it names the explanation Speck holds or points to. Otherwise Speck's own conclusion stands, or nothing is concluded.",
  "Why: Speck caps model-judged evidence, so it can stay unresolved when the evidence clearly points one way; a stateless call is more decisive but keeps relying on records that have been corrected. Decisive mode keeps Speck's check on corrections and lets agreement settle the rest.",
  "The stateless call is made with the model's reasoning on (NEMOTRON_DECISIVE_REASONING_EFFORT; on by default for Ollama and Meterless): in a measured comparison, reasoning made stateless answers markedly more accurate. It takes a few seconds longer.",
  "The cost: when both lean the same way it concludes where Speck alone would wait, and both opinions come from the same model, so their agreement is not independent evidence.",
  "Experimental: the rule was written after looking at six live comparisons per prepared case, including a held-out evaluation case, and has not been evaluated on other cases. Speck's belief state, the evidence and the history are unchanged; switching it off removes the reading."
];

// speck: { concluded, tentative } (Speck's firm conclusion, or the
// explanation it leans towards). stateless: { concluded, cited, error }.
// replaced: Map or object, record id -> the record that replaced it.
// visible: the ids of every record both saw.
export function decisiveReading({ speck, stateless, replaced, visible }) {
  const replacedBy = replaced instanceof Map ? replaced : new Map(Object.entries(replaced ?? {}));
  const seen = new Set(visible);
  const held = speck.concluded ?? speck.tentative ?? null;
  const fallback = (reason) => speck.concluded
    ? { conclusion: speck.concluded, basis: "speck", reason: `${reason} Speck's own conclusion, ${speck.concluded}, stands.` }
    : { conclusion: null, basis: "none", reason: `${reason} Speck concludes nothing, so decisive mode concludes nothing.` };

  if (!stateless || stateless.error) return { ...fallback(`The stateless answer is unavailable${stateless?.error ? ` (${stateless.error})` : ""}.`), rejected: [] };
  if (!stateless.concluded) return { ...fallback("The stateless answer is \"unresolved\"."), rejected: [] };
  const cited = [...new Set(stateless.cited ?? [])];
  const stale = cited.filter((id) => replacedBy.has(id));
  const unknown = cited.filter((id) => !seen.has(id));
  if (stale.length || unknown.length) {
    const why = [
      stale.length ? `it cites ${stale.map((id) => `${id} (replaced by ${replacedBy.get(id)})`).join(", ")}` : null,
      unknown.length ? `it cites ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in the evidence` : null
    ].filter(Boolean).join(" and ");
    return { ...fallback(`The stateless answer, ${stateless.concluded}, is rejected: ${why}.`), rejected: [...stale, ...unknown] };
  }
  if (!cited.length) return { ...fallback(`The stateless answer, ${stateless.concluded}, cites no record.`), rejected: [] };
  if (stateless.concluded === held) {
    return {
      conclusion: held, basis: "agreement", rejected: [],
      reason: `The stateless answer, ${held}, cites only records that still count (${cited.join(", ")}), and Speck ${speck.concluded ? "concludes" : "points to"} the same explanation.`
    };
  }
  return { ...fallback(`The stateless answer, ${stateless.concluded}, disagrees with Speck${held ? `, which ${speck.concluded ? "concludes" : "points to"} ${held}` : ", which points to nothing"}.`), rejected: [] };
}

// The reading for one stage of a saved comparison report.
export function decisiveForStage(stage) {
  return decisiveReading({
    speck: { concluded: stage.speck.error ? null : stage.speck.concluded, tentative: stage.speck.error ? null : stage.speck.tentative },
    stateless: stage.stateless,
    replaced: new Map(stage.replaced.map((item) => [item.recordId, item.by])),
    visible: stage.visible.map((record) => record.id)
  });
}

// Whether a second opinion fetched for the case still describes it: the same
// latest run, stage and visible records, and nothing waiting to be assessed.
export function opinionCurrent(opinion, view) {
  if (!opinion || !view?.investigation?.latestRun || !view?.listing) return false;
  const visible = view.listing.records.filter((record) => record.status !== "withdrawn" && record.invalidation?.kind !== "withdrawn").map((record) => record.id);
  return opinion.runNumber === view.investigation.latestRun.runNumber
    && opinion.stage === view.status?.stage?.id
    && view.listing.pending.length === 0
    && opinion.visible.length === visible.length && opinion.visible.every((id, index) => id === visible[index]);
}

// Per-viewer preference, kept in browser storage (off when unavailable).
export function decisivePreference(storage) {
  return {
    on: () => { try { return storage?.getItem("edk:decisive-mode") === "on"; } catch { return false; } },
    set: (value) => { try { storage?.setItem("edk:decisive-mode", value ? "on" : "off"); } catch { /* not kept */ } }
  };
}
