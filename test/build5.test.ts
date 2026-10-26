import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import type { MentalObject } from "#speck";
import { ROOT_DIR, type ConclusionRule } from "../src/config.js";
import type { EvidenceRecord } from "../src/evidence/types.js";
import type { Invalidation } from "../src/investigation/basis.js";
import { deriveConclusion } from "../src/investigation/conclusion.js";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner, RelationJudgment } from "../src/reasoning/types.js";
import { testConfig, withDesk } from "./helpers.js";

// Build 5 (docs/build-5-corroboration.md): rule corroborated-2 beside
// corroborated-1. First the rule on its own, then the Build 4 failures with
// the model's judgments as the local nemotron-3-nano:4b gave them in the
// diagnostic (eval/results/experiments/build5-diagnostic/r1.json), replayed
// without a model, then the model contract.

const BELIEF = { supportedThreshold: 0.6, supportBonus: 0.2, modelReliabilityCeiling: 0.4 };

const record = (id: string, system: string, supersedes: string[] = []): EvidenceRecord => ({
  id, caseId: "C-5", source: { system, name: `${system} source` }, observedAt: "2026-10-15T00:00:00.000Z",
  content: id, facts: {}, provenance: { systemOfRecord: system, recordRef: id, author: "test", supersedes },
  retrieval: { mode: "fixture", location: "test", retrievedAt: "2026-10-26T00:00:00.000Z" }
});

const hypothesis = (key: string, status: string, confidence: number, supporting: string[], contradicting: string[] = []) => ({
  id: `obj-${key}`, content: `${key} statement`, confidence,
  data: { key, status, supportingEvidence: supporting, contradictoryEvidence: contradicting, revisionHistory: [{ previousConfidence: 0.33 }] }
}) as unknown as MentalObject;

type Judged = Partial<Pick<RelationJudgment, "basis" | "strength" | "strengthReported" | "establishes">>;
const supports = (judged: Judged = {}): RelationJudgment => ({
  hypothesisKey: "H-A", direction: "supports", strength: 0.9, decisive: false, basis: "model", rationale: "test", establishes: true, ...judged
});

// H-A supported by the given records (id -> system and judgment); H-B, a
// rival, supported by `rival` when given; `against` recorded against H-A.
function conclude(rule: ConclusionRule, input: {
  support: Record<string, { system: string; judgment: RelationJudgment | null }>;
  rival?: { id: string; system: string; judgment: RelationJudgment };
  against?: string[];
  invalidated?: Map<string, Invalidation>;
  supersededBy?: Record<string, string>;
  status?: string;
  confidence?: number;
}) {
  const records = new Map<string, { record: EvidenceRecord; judgment: RelationJudgment | null }>();
  for (const [id, item] of Object.entries(input.support)) records.set(id, { record: record(id, item.system), judgment: item.judgment });
  if (input.rival) records.set(input.rival.id, { record: record(input.rival.id, input.rival.system), judgment: { ...input.rival.judgment, hypothesisKey: "H-B" } });
  for (const id of input.against ?? []) records.set(id, { record: record(id, "other"), judgment: { ...supports(), direction: "contradicts" } });
  for (const [id, by] of Object.entries(input.supersededBy ?? {})) records.set(by, { record: record(by, records.get(id)!.record.source.system, [id]), judgment: null });
  return deriveConclusion({
    ranked: [
      hypothesis("H-A", input.status ?? "active", input.confidence ?? 0.46, Object.keys(input.support), input.against ?? []),
      hypothesis("H-B", "active", 0.3, input.rival ? [input.rival.id] : [])
    ],
    assessed: [...records.values()].map((item) => item.record),
    evidenceFor: (id) => {
      const found = records.get(id);
      return found ? { record: found.record, reliability: 0.4, judgedBy: found.judgment?.basis === "rule" ? "rules" : "model", judgment: found.judgment ?? undefined } : undefined;
    },
    questions: [],
    belief: BELIEF,
    ...(input.invalidated ? { invalidated: input.invalidated } : {}),
    rule
  });
}

const both = (input: Parameters<typeof conclude>[1]) => ({ c1: conclude("corroborated-1", input), c2: conclude("corroborated-2", input) });

test("two strong, independent judgments that establish the explanation conclude under both rules, with Speck's own lower confidence kept", () => {
  const { c1, c2 } = both({ support: { "R-1": { system: "bank", judgment: supports() }, "R-2": { system: "ledger", judgment: supports({ strength: 1 }) } } });
  for (const c of [c1, c2]) {
    assert.equal(c.state, "supported");
    assert.equal(c.justification.route, "corroboration");
    assert.deepEqual(c.justification.corroboration?.systems, ["bank", "ledger"]);
    // A policy conclusion is not high model confidence: Speck's numbers are unchanged.
    assert.equal(c.justification.confidence, 0.46);
    assert.equal(c.justification.status, "active");
    assert.match(c.justification.reasons.join("\n"), /Speck holds H-A as active at 0\.46, 0\.14 short of its supported threshold of 0\.6; Speck itself has not established it/);
  }
  assert.equal(c2.justification.corroboration?.rule, "corroborated-2");
  assert.match(c2.justification.reasons.join("\n"), /each judged as establishing it/);
});

test("two judgments that agree but do not establish the explanation: corroborated-1 concludes, corroborated-2 abstains and says why", () => {
  const { c1, c2 } = both({ support: { "R-1": { system: "adjuster", judgment: supports({ strength: 1, establishes: false }) }, "R-2": { system: "customer", judgment: supports({ establishes: false }) } } });
  assert.equal(c1.state, "supported");
  assert.equal(c2.state, "unresolved");
  assert.deepEqual(c2.justification.corroboration?.excluded.map((item) => item.recordId), ["R-1", "R-2"]);
  assert.match(c2.justification.reasons.join("\n"), /Not corroborated \(rule corroborated-2\): no record that still counts gives it qualifying support; not counted: R-1 \(the model judged that it does not itself establish this\)/);
});

test("two weak judgments that superficially agree do not qualify, even when marked as establishing", () => {
  const { c1, c2 } = both({ support: { "R-1": { system: "a", judgment: supports({ strength: 0.3 }) }, "R-2": { system: "b", judgment: supports({ strength: 0.4 }) } } });
  assert.equal(c1.state, "supported");
  assert.equal(c2.state, "unresolved");
  assert.deepEqual(c2.justification.corroboration?.excluded.map((item) => item.reason), ["strength 0.3 is below 0.5", "strength 0.4 is below 0.5"]);
});

test("one qualifying judgment and one that does not: one system is not corroboration", () => {
  const c2 = conclude("corroborated-2", { support: { "R-1": { system: "clinic", judgment: supports() }, "R-2": { system: "gp", judgment: supports({ establishes: false }) } } });
  assert.equal(c2.state, "unresolved");
  assert.deepEqual(c2.justification.corroboration?.records, ["R-1"]);
  assert.match(c2.justification.reasons.join("\n"), /its qualifying support comes from one source system \(clinic\); corroboration needs 2 different ones; not counted: R-2/);
});

test("duplicated records from one source are one system under both rules", () => {
  const { c1, c2 } = both({ support: { "R-1": { system: "planner", judgment: supports() }, "R-2": { system: "planner", judgment: supports() } } });
  for (const c of [c1, c2]) {
    assert.equal(c.state, "unresolved");
    assert.deepEqual(c.justification.corroboration?.systems, ["planner"]);
  }
});

test("conflicting evidence blocks both rules, and a rival's support blocks corroborated-2 even when it does not qualify", () => {
  const support = { "R-1": { system: "a", judgment: supports() }, "R-2": { system: "b", judgment: supports() } };
  for (const c of Object.values(both({ support, against: ["R-9"] }))) {
    assert.equal(c.state, "unresolved");
    assert.match(c.justification.reasons.join("\n"), /R-9 is recorded against it/);
  }
  const rival = conclude("corroborated-2", { support, rival: { id: "R-8", system: "c", judgment: supports({ strength: 0.2, establishes: false }) } });
  assert.equal(rival.state, "unresolved");
  assert.match(rival.justification.reasons.join("\n"), /H-B still has support of its own/);
});

test("missing strength metadata, a missing judgment, and judgments the model was never asked about do not qualify", () => {
  const c2 = conclude("corroborated-2", { support: {
    "R-1": { system: "a", judgment: supports({ strengthReported: false, strength: 0.5 }) },
    "R-2": { system: "b", judgment: null },
    "R-3": { system: "c", judgment: supports({ establishes: undefined }) }
  } });
  assert.equal(c2.state, "unresolved");
  assert.deepEqual(c2.justification.corroboration?.excluded, [
    { recordId: "R-1", reason: "the model gave no strength" },
    { recordId: "R-2", reason: "no judgment recorded" },
    { recordId: "R-3", reason: "the model was not asked whether it establishes this" }
  ]);
});

test("deterministic rule results qualify by their authored strength", () => {
  const strong = conclude("corroborated-2", { support: { "R-1": { system: "a", judgment: supports({ basis: "rule", strength: 1, establishes: undefined }) }, "R-2": { system: "b", judgment: supports({ basis: "rule", strength: 0.5, establishes: undefined }) } } });
  assert.equal(strong.state, "supported");
  const weak = conclude("corroborated-2", { support: { "R-1": { system: "a", judgment: supports({ basis: "rule", strength: 1, establishes: undefined }) }, "R-2": { system: "b", judgment: supports({ basis: "rule", strength: 0.3, establishes: undefined }) } } });
  assert.equal(weak.state, "unresolved");
});

test("withdrawn and superseded records cannot corroborate under either rule", () => {
  const support = { "R-1": { system: "a", judgment: supports() }, "R-2": { system: "b", judgment: supports() } };
  const withdrawn = both({ support, invalidated: new Map<string, Invalidation>([["R-2", { kind: "withdrawn", reason: "another customer's", at: "" }]]) });
  const superseded = both({ support, supersededBy: { "R-2": "R-2b" } });
  for (const c of [...Object.values(withdrawn), ...Object.values(superseded)]) {
    assert.equal(c.state, "unresolved");
    assert.deepEqual(c.justification.corroboration?.records, ["R-1"]);
  }
});

test("Speck's own supported status is untouched by the rule: corroborated-2 never withdraws it", () => {
  const c2 = conclude("corroborated-2", { status: "supported", confidence: 0.66, support: { "R-1": { system: "a", judgment: supports({ establishes: false }) } } });
  assert.equal(c2.state, "supported");
  assert.equal(c2.justification.route, "speck-threshold");
});

// Replays through the desk: decisive fact rules first, then the given model
// judgments (basis "model", so Speck caps them at 0.4), with `establishes` as
// a corroborated-2 assessor would record it.
type Said = Array<[string, "supports" | "contradicts", number, boolean?]>;
function replayed(desk: () => EvidenceDesk, said: Record<string, Said>, asked: boolean): Reasoner {
  return {
    kind: "nemotron",
    describe: () => ({ kind: "nemotron", label: "replayed model judgments (test)", provider: "ollama", model: "nemotron-3-nano:4b", endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      const judgments: Record<string, RelationJudgment[]> = {};
      for (const item of input.batch) {
        const rules = ruleJudgments(item, desk().scenario.hypotheses, { decisiveOnly: true });
        const model = (said[item.id] ?? []).filter(([key]) => !rules.some((rule) => rule.hypothesisKey === key))
          .map(([hypothesisKey, direction, strength, establishes]): RelationJudgment => ({
            hypothesisKey, direction, strength, decisive: false, basis: "model", rationale: "replayed",
            ...(asked ? { establishes: direction === "supports" && establishes === true } : {})
          }));
        judgments[item.id] = [...rules, ...model];
      }
      return { judgments, notes: [], narrative: "" };
    }
  };
}

async function replay<T>(dir: string, rule: ConclusionRule, said: Record<string, Said>, stages: number, body: (desk: EvidenceDesk) => Promise<T> | T): Promise<T> {
  let current: EvidenceDesk | null = null;
  return withDesk(testConfig({ scenarioDir: path.join(ROOT_DIR, dir), conclusionRule: rule }), async (desk) => {
    current = desk;
    for (let stage = 0; stage < stages; stage++) {
      if (stage) await desk.introduceNextUpdate();
      await desk.run();
    }
    return body(desk);
  }, { reasoner: replayed(() => current!, said, rule === "corroborated-2") });
}

// Bank return, after the return: what the model said in sample b92a9bde, the
// returned payment and the reopened invoice both stating the unpaid state.
const BANK: Record<string, Said> = {
  "EV-BNK-101": [["H-PAID", "supports", 1, true], ["H-UNPAID", "contradicts", 1]],
  "EV-LDG-102": [["H-PAID", "supports", 1, true], ["H-UNPAID", "contradicts", 1], ["H-PARTIAL", "contradicts", 1]],
  "EV-BNK-103": [["H-UNPAID", "supports", 1, true], ["H-PARTIAL", "contradicts", 1]],
  "EV-LDG-104": [["H-UNPAID", "supports", 1, true], ["H-PAID", "contradicts", 1], ["H-PARTIAL", "contradicts", 1]]
};

test("the original bank-return failure stays fixed under corroborated-2 when the records state the unpaid state", async () => {
  for (const rule of ["corroborated-1", "corroborated-2"] as const) {
    await replay("eval/scenarios/correction-supersedes", rule, BANK, 2, (desk) => {
      const c = desk.conclusionFromSpeck();
      assert.equal(c.hypothesis?.key, "H-UNPAID", rule);
      assert.equal(c.justification.route, "corroboration");
      assert.equal(c.justification.corroboration?.rule, rule);
      assert.equal(c.justification.confidence, 0.46, "Speck's own belief, unchanged");
      assert.deepEqual(c.noLongerCounted.map((item) => [item.recordId, item.invalidation.kind]), [["EV-BNK-101", "superseded"], ["EV-LDG-102", "restated"]]);
    });
  }
});

test("weak corroboration, missing-evidence: a fault report and a scheduled inspection no longer conclude a manufacturing defect", async () => {
  // Diagnostic r1: both judged as supporting H-DEFECT at 0.8 and 0.9.
  const said: Record<string, Said> = {
    "EV-WCF-301": [["H-DEFECT", "supports", 0.8, false], ["H-MISUSE", "contradicts", 0.6], ["H-NO-FAULT", "contradicts", 0.7]],
    "EV-SVC-302": [["H-DEFECT", "supports", 0.9, false], ["H-NO-FAULT", "contradicts", 0.8]]
  };
  await replay("eval/scenarios/missing-evidence", "corroborated-1", said, 1, (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.hypothesis?.key, "H-DEFECT", "the Build 4 false positive, reproduced");
    assert.equal(c.justification.route, "corroboration");
  });
  await replay("eval/scenarios/missing-evidence", "corroborated-2", said, 1, (desk) => {
    const c = desk.conclusionFromSpeck();
    // Leading, from H-DEFECT's prior of 0.4: tentative, not a conclusion.
    assert.notEqual(c.state, "supported");
    assert.equal(c.justification.route, null);
    assert.equal(c.direction.pointsTo?.key, "H-DEFECT", "the direction is still reported");
    assert.match(c.justification.reasons.join("\n"), /EV-WCF-301 \(the model judged that it does not itself establish this\)/);
    assert.ok(c.openQuestions.some((question) => question.id === "Q-FINDING"));
  });
});

test("weak corroboration, claim: a recommendation and the customer's expectation no longer conclude approval; the single decline stays unresolved", async () => {
  // Diagnostic r1: H-APPROVED supported at 1.0 and 0.9, both rivals contradicted.
  const said: Record<string, Said> = {
    "CH3-01": [["H-APPROVED", "supports", 1, false], ["H-PENDING", "contradicts", 1], ["H-DECLINED", "contradicts", 1]],
    "CH3-02": [["H-APPROVED", "supports", 0.9, false], ["H-PENDING", "contradicts", 0.9], ["H-DECLINED", "contradicts", 0.9]],
    "CH3-03": [["H-DECLINED", "supports", 1, true]]
  };
  await replay("eval/challenge/claim-decision-missing", "corroborated-1", said, 1, (desk) => {
    assert.equal(desk.conclusionFromSpeck().hypothesis?.key, "H-APPROVED", "the Build 4 false positive, reproduced");
  });
  await replay("eval/challenge/claim-decision-missing", "corroborated-2", said, 1, (desk) => {
    assert.equal(desk.conclusionFromSpeck().state, "unresolved");
  });
  // A conclusion that should be reachable is not made reachable: one
  // authoritative record is still one source (a known limit of both rules).
  await replay("eval/challenge/claim-decision-missing", "corroborated-2", said, 2, (desk) => {
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.equal(c.direction.pointsTo?.key, "H-DECLINED");
  });
});

test("a failed model call under corroborated-2 withholds the conclusion until the records are assessed", async () => {
  let current: EvidenceDesk | null = null;
  let failing = true;
  const model = replayed(() => current!, BANK, true);
  const reasoner: Reasoner = {
    ...model,
    async assess(input) {
      if (failing && input.batch.some((item) => item.id === "EV-BNK-103")) throw new Error("model did not return a JSON object");
      return model.assess(input);
    }
  };
  await withDesk(testConfig({ scenarioDir: path.join(ROOT_DIR, "eval/scenarios/correction-supersedes"), conclusionRule: "corroborated-2" }), async (desk) => {
    current = desk;
    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const c = desk.conclusionFromSpeck();
    assert.equal(c.state, "unresolved");
    assert.match(c.headline, /not yet assessed \(EV-BNK-103, EV-LDG-104\)/);
    failing = false;
    await desk.run();
    assert.equal(desk.conclusionFromSpeck().hypothesis?.key, "H-UNPAID");
  }, { reasoner });
});

// The model contract, through the real adapter and Speck's registry over HTTP
// (a stand-in endpoint, as in nemotron.test.ts).
async function endpoint(reply: (prompt: string) => unknown): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      const parsed = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: "assistant", content: JSON.stringify(reply(parsed.messages.at(-1).content as string)) } }] }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies, close: () => server.close() };
}

const BANK_DIR = path.join(ROOT_DIR, "eval", "scenarios", "correction-supersedes");
const bankIds = (prompt: string) => [...(prompt.split("EVIDENCE IN THIS CHUNK:")[1] ?? "").matchAll(/^\[(EV-[A-Z]+-\d+)\]/gm)].map((match) => match[1]!);

test("the model is asked for establishes only under corroborated-2; a missing strength is marked, and only true establishes", async () => {
  const server = await endpoint((prompt) => {
    if (prompt.includes("cited_evidence")) return { explanation: "x", cited_evidence: [], stated_conclusion: "unresolved", stated_established: false };
    return {
      judgments: bankIds(prompt).flatMap((id) => [
        { evidence_id: id, hypothesis: "H-PAID", relation: "supports", strength: id === "EV-LDG-102" ? "high" : 0.9, rationale: "r", establishes: id === "EV-BNK-101" ? true : "yes" },
        { evidence_id: id, hypothesis: "H-UNPAID", relation: "neutral", strength: 0.1, rationale: "r" }
      ]),
      summary: "s"
    };
  });
  const env = { REASONER: "nemotron", NEMOTRON_BASE_URL: server.url, NEMOTRON_MODEL: "test/nemotron-stand-in", NEMOTRON_API_KEY_ENV: "EVIDENCE_DESK_TEST_KEY", EVIDENCE_DESK_TEST_KEY: "test-key-not-a-secret" };
  try {
    for (const rule of ["corroborated-1", "corroborated-2"] as const) {
      server.bodies.length = 0;
      await withDesk(testConfig({ scenarioDir: BANK_DIR }, { ...env, CONCLUSION_RULE: rule }), async (desk) => {
        const run = await desk.run();
        const relations = server.bodies.filter((body) => body.includes("EVIDENCE IN THIS CHUNK"));
        assert.ok(relations.length > 0);
        assert.equal(relations.every((body) => body.includes("establishes")), rule === "corroborated-2", `${rule}: prompt and contract`);
        const judgment = (id: string) => run.assessed.find((item) => item.record.id === id)!.judgments.find((item) => item.hypothesisKey === "H-PAID")!;
        assert.equal(judgment("EV-LDG-102").strengthReported, false);
        assert.equal(judgment("EV-LDG-102").strength, 0.5, "Speck still gets the default strength");
        assert.equal(judgment("EV-BNK-101").strengthReported, undefined);
        assert.equal(judgment("EV-BNK-101").establishes, rule === "corroborated-2" ? true : undefined);
        assert.equal(judgment("EV-LDG-102").establishes, rule === "corroborated-2" ? false : undefined, "\"yes\" is not true");
      });
    }
  } finally {
    server.close();
  }
});

test("the comparison names the rule in its policy, so samples under different rules are never counted together", async () => {
  const { evidencePolicy, EVIDENCE_POLICY } = await import("../src/compare/comparison.js");
  assert.equal(evidencePolicy({}), EVIDENCE_POLICY);
  assert.equal(evidencePolicy({ conclusionRule: "corroborated-1" }), "build-4 (restatement, corroborated-1)");
  assert.equal(evidencePolicy({ conclusionRule: "corroborated-2" }), "build-5 (restatement, corroborated-2)");
});

test("set 5 is locked and loads apart from every other suite", async () => {
  const { verifyLock } = await import("../src/eval/cross-domain.js");
  const { CHALLENGE5_DIR, loadEvalCases, leakage } = await import("../src/eval/cases.js");
  const lock = verifyLock(CHALLENGE5_DIR, path.join(CHALLENGE5_DIR, "expectations.lock.json"));
  assert.equal(lock.files, 24);
  const cases = loadEvalCases(CHALLENGE5_DIR);
  assert.deepEqual(leakage(cases), []);
  const labels = cases.flatMap((item) => item.checkpoints.map((checkpoint) => checkpoint.conclusion));
  assert.deepEqual([labels.length, labels.filter((label) => label === null).length], [15, 6]);
  const others = ["scenarios", "regression", "cross-domain", "challenge"].flatMap((dir) => fs.readdirSync(path.join(ROOT_DIR, "eval", dir)));
  assert.ok(cases.every((item) => !others.includes(item.id)));
});

test("set 6 is locked and loads apart from every other suite", async () => {
  const { verifyLock } = await import("../src/eval/cross-domain.js");
  const { CHALLENGE6_DIR, loadEvalCases, leakage } = await import("../src/eval/cases.js");
  const lock = verifyLock(CHALLENGE6_DIR, path.join(CHALLENGE6_DIR, "expectations.lock.json"));
  assert.equal(lock.files, 21);
  const cases = loadEvalCases(CHALLENGE6_DIR);
  assert.deepEqual(leakage(cases), []);
  const labels = cases.flatMap((item) => item.checkpoints.map((checkpoint) => checkpoint.conclusion));
  assert.deepEqual([labels.length, labels.filter((label) => label === null).length], [22, 6]);
  const others = ["scenarios", "regression", "cross-domain", "challenge", "challenge-5"].flatMap((dir) => fs.readdirSync(path.join(ROOT_DIR, "eval", dir)));
  assert.ok(cases.every((item) => !others.includes(item.id)));
});

test("set 7 is locked, loads apart from every other suite, and stays inside a small prompt", async () => {
  const { verifyLock } = await import("../src/eval/cross-domain.js");
  const { CHALLENGE7_DIR, loadEvalCases, leakage } = await import("../src/eval/cases.js");
  const lock = verifyLock(CHALLENGE7_DIR, path.join(CHALLENGE7_DIR, "expectations.lock.json"));
  assert.equal(lock.files, 12);
  const cases = loadEvalCases(CHALLENGE7_DIR);
  assert.deepEqual(leakage(cases), []);
  const labels = cases.flatMap((item) => item.checkpoints.map((checkpoint) => checkpoint.conclusion));
  assert.deepEqual([labels.length, labels.filter((label) => label === null).length], [25, 6]);
  const others = ["scenarios", "regression", "cross-domain", "challenge", "challenge-5", "challenge-6"].flatMap((dir) => fs.readdirSync(path.join(ROOT_DIR, "eval", dir)));
  assert.ok(cases.every((item) => !others.includes(item.id)));
  // At most 15 records per case: no context effect, and one run assesses them all.
  for (const item of cases) assert.ok(JSON.parse(fs.readFileSync(path.join(item.dir, "evidence.json"), "utf8")).records.length <= 15, item.id);
});
