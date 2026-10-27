// The guided demo inside Speck: first the hotel chargeback, worked through
// its stages and then set beside a stateless baseline (the case where they
// part most clearly), then Speck's own views of that work (the world
// timeline, the memory map and the chat), then what the evaluation measured
// across models, then an investigation of the person's own. The other
// prepared cases stay in the tab, outside the demo: the hotel chargeback
// alone is long enough. Pure definitions;
// the Evidence tab (plugin/ui/evidence-desk-ui.js) drives Speck's interface
// and renders them.
//
// A "case" part runs the case page's own guided steps (tour.js), filtered.
// The other parts are described from facts the tab gathers from real state:
// facts = { cases: [{ id, label, runs, headline }], timeline, memory, replied }.

const casesLine = (facts) => (facts.cases ?? []).map((item) => item.runs
  ? `${item.label}: ${item.runs} run(s); now ${item.headline}`
  : `${item.label}: not run yet.`);

export const SUGGESTED_QUESTION = "What did the hotel chargeback investigation conclude, and why did it change?";

export const JOURNEY = [
  {
    // Why first: it is set 7's case where the approaches part most clearly in
    // every mode measured, at its last corrections. It is worked by hand
    // through all six stages, then compared with the stateless baseline.
    id: "hotel",
    kind: "case",
    caseId: "hotel-chargeback",
    label: "Part 1 of 6 · Hotel chargeback",
    steps: ["case", "run", "conclusion", "walk", "changed", "compare"],
    finishLabel: "Next: Speck's world view"
  },
  {
    id: "world",
    kind: "speck",
    view: "world",
    label: "Part 2 of 6 · Speck's world view",
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
    label: "Part 3 of 6 · The memory map",
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
    label: "Part 4 of 6 · Talk to Speck",
    title: "Ask Speck about an investigation",
    goal: (facts) => Boolean(facts.replied),
    body: () => [
      "After each run, Evidence Desk publishes the case's state to Speck as a summary memory. Speck's chat reads those summaries when a question names an investigation, and answers only from them.",
      `A question is ready in the message bar: "${SUGGESTED_QUESTION}" Press Send, or ask your own.`,
      "A model writes the answer, so check it against the case pages: it should match the conclusion, the records and the correction."
    ],
    after: () => [
      "Speck answered. Compare it with the hotel chargeback's conclusion and its \"why it changed\" section.",
      "Ask a follow-up if you like, then continue."
    ]
  },

  {
    // Why here: the case is an illustration; this is the measurement, read
    // from the registered experiment reports (src/compare/evaluation.ts).
    id: "results",
    kind: "results",
    label: "Part 5 of 6 · What the evaluation found",
    title: "What the measured results show",
    body: () => [
      "The case you just worked is an illustration. This page is the measurement: the same cases, rules and labels run on two models, three times each, read from the experiment reports in the repository.",
      "The table at the top, Results across models, reads in three steps:",
      [
        "The stateless call improves with the model. On the earlier suites the better model's stateless call matches the label as often as Speck, or more often.",
        "Set 7, highlighted, was written to test receipts that conflict over time. There the better model's stateless call still concludes where it should wait, concludes the wrong explanation, and leans on replaced records.",
        "Speck does neither of the last two on either model, but it abstains so often where a conclusion is due that the stateless call matches the label more."
      ],
      "So what persistent evidence state adds here is that what it concludes holds up, with a record of why; not more correct answers. Every figure has its denominator."
    ]
  },
  {
    id: "create",
    kind: "yours",
    label: "Part 6 of 6 · Your own investigation",
    title: "Start an investigation of your own",
    body: () => [
      "This form starts an investigation of your own: a question, two to five explanations that compete to answer it, and any evidence you already have. It is investigated like the prepared cases. Once the title and question are written, Suggest explanations has the model fill in the explanations for you to edit.",
      "Once it is created, Run investigation has the configured model weigh each record against each explanation (Speck caps model-judged evidence at reliability 0.4). Add evidence takes a new record, or a correction of an earlier one; run again and the conclusion is revised from the evidence that still counts.",
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
    dismissOffer: () => write("offer-dismissed", true),
    // For the next person: no part is in progress.
    restoreOffer: () => { write("offer-dismissed", false); write("part", null); }
  };
}
