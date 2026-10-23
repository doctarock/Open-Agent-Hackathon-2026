// The guided demo inside Speck: one journey across both prepared cases (the
// bank return first: deterministic, instant, with pre-registered labels; each
// opens on Speck beside a stateless model call), then
// Speck's own views of the same work (the world timeline, the memory map and
// the chat), then an investigation of the person's own. Pure definitions;
// the Evidence tab (plugin/ui/evidence-desk-ui.js) drives Speck's interface
// and renders them.
//
// A "case" part runs the case page's own guided steps (tour.js), filtered.
// The other parts are described from facts the tab gathers from real state:
// facts = { cases: [{ id, label, runs, headline }], timeline, memory, replied }.

const casesLine = (facts) => (facts.cases ?? []).map((item) => item.runs
  ? `${item.label}: ${item.runs} run(s); now ${item.headline}`
  : `${item.label}: not run yet.`);

export const SUGGESTED_QUESTION = "What did the bank return investigation conclude, and why did it change?";

export const JOURNEY = [
  {
    id: "bank",
    kind: "case",
    caseId: "bank-return",
    label: "Part 1 of 6 · Bank return",
    steps: ["case", "compare", "run", "update", "rerun", "changed"],
    finishLabel: "Next: the disputed delivery, live"
  },
  {
    id: "delivery",
    kind: "case",
    caseId: "disputed-delivery",
    label: "Part 2 of 6 · Disputed delivery",
    steps: ["case", "compare", "run", "conclusion", "record", "update", "rerun", "changed", "history"],
    finishLabel: "Next: Speck's world view"
  },
  {
    id: "world",
    kind: "speck",
    view: "world",
    label: "Part 3 of 6 · Speck's world view",
    title: "The timeline of the work",
    body: (facts) => [
      "Each investigation is held by Speck as a task. What it did is laid out in time around it: Hypothesis Proposed, Memory Recorded, Belief Revised and Association Reinforced are the actions of the runs you just made.",
      "Drag to orbit, right-drag to travel back in time, scroll to zoom, and select an object to see its result. The pulse on the right lists the latest actions.",
      facts.timeline ? `Speck reports: ${facts.timeline}.` : null,
      ["The investigations as Speck holds them now:", casesLine(facts)]
    ]
  },
  {
    id: "memory",
    kind: "speck",
    view: "memory",
    label: "Part 4 of 6 · The memory map",
    title: "How the facts are linked",
    body: (facts) => [
      "Every evidence record and every run's assessment is a memory in Speck. Evidence Desk links them with Speck's own association kinds, so the lines here are the case's reasoning:",
      [
        "an assessment is derived from each record it judged;",
        "a record supports, or contradicts, the conclusion of the run that weighed it;",
        "a correction inhibits the record it replaced, which is why the old record stops counting."
      ],
      "Select a memory to inspect it in the panel on the right: its kind, confidence and connections.",
      facts.memory ? `Speck reports: ${facts.memory}.` : null
    ]
  },
  {
    id: "chat",
    kind: "speck",
    view: "world",
    action: "chat",
    label: "Part 5 of 6 · Talk to Speck",
    title: "Ask Speck about an investigation",
    goal: (facts) => Boolean(facts.replied),
    body: () => [
      "After each run, Evidence Desk publishes the case's state to Speck as a summary memory. Speck's chat reads those summaries when a question names an investigation, and answers only from them.",
      `A question is ready in the message bar: "${SUGGESTED_QUESTION}" Press Send, or ask your own.`,
      "A local model writes the answer, so check it against the case pages: it should match the conclusion, the records and the correction."
    ],
    after: () => [
      "Speck answered. Compare it with the bank return's conclusion and its \"why it changed\" section.",
      "Ask a follow-up if you like, then continue."
    ]
  },
  {
    id: "create",
    kind: "yours",
    label: "Part 6 of 6 · Your own investigation",
    title: "Start an investigation of your own",
    body: () => [
      "This form starts an investigation of your own: a question, two to five explanations that compete to answer it, and any evidence you already have. It is investigated like the prepared cases.",
      "Once it is created, Run investigation has the local model weigh each record against each explanation (Speck caps model-judged evidence at reliability 0.4). Add evidence takes a new record, or a correction of an earlier one; run again and the conclusion is revised from the evidence that still counts.",
      "That completes the guided demo. The Guide button on any case lists every feature, and Reset demo case starts a prepared case afresh for the next person."
    ]
  }
];

export function partDone(part, facts) {
  return part.goal ? Boolean(part.goal(facts)) : true;
}

// Where the journey is, kept per viewer in browser storage; null when it is
// not running. Storage may be unavailable; then nothing is kept.
export function journeyStore(storage) {
  const read = (name, fallback) => {
    try { const value = storage?.getItem(`edk:journey:${name}`); return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
  };
  const write = (name, value) => { try { storage?.setItem(`edk:journey:${name}`, JSON.stringify(value)); } catch { /* not kept */ } };
  return {
    part: () => { const part = read("part", null); return Number.isInteger(part) && part >= 0 && part < JOURNEY.length ? part : null; },
    setPart: (part) => write("part", part),
    offerDismissed: () => read("offer-dismissed", false) === true,
    dismissOffer: () => write("offer-dismissed", true)
  };
}
