import assert from "node:assert/strict";
import { test } from "node:test";
import type { MentalObject } from "#speck";
import type { EvidenceRecord } from "../src/evidence/types.js";
import { deriveConclusion } from "../src/investigation/conclusion.js";

// The live Nemotron run on 2026-10-22 ended here: H-DELIVERED refuted, and
// H-MISDELIVERED the only explanation left, at 0.424 on model-judged support.
// Direction and justification must be reported separately.

const record = (id: string, system: string, supersedes: string[] = []): EvidenceRecord => ({
  id, caseId: "DISPUTE-1042", source: { system, name: `${system} source` }, observedAt: "2026-10-15T00:00:00.000Z",
  content: id, facts: {}, provenance: { systemOfRecord: system, recordRef: id, author: "test", supersedes },
  retrieval: { mode: "zetaris", location: "EVIDENCE_DESK.t", retrievedAt: "2026-10-22T00:00:00.000Z" }
});

const hypothesis = (key: string, status: string, confidence: number, prior: number, supporting: string[], contradicting: string[]) => ({
  id: `obj-${key}`, content: `${key} statement`, confidence,
  data: { key, status, supportingEvidence: supporting, contradictoryEvidence: contradicting, revisionHistory: [{ previousConfidence: prior }] }
}) as unknown as MentalObject;

const records = [record("EV-CAR-003", "carrier"), record("EV-SUP-004", "support"), record("EV-CAR-005", "carrier", ["EV-CAR-003"]), record("EV-SUP-006", "support")];
const evidence: Record<string, { record: EvidenceRecord; reliability: number; judgedBy: "rules" | "model" }> = {
  "o-3": { record: records[0]!, reliability: 0.4, judgedBy: "model" },
  "o-4": { record: records[1]!, reliability: 0.4, judgedBy: "model" },
  "o-5": { record: records[2]!, reliability: 0.4, judgedBy: "model" },
  "o-6": { record: records[3]!, reliability: 0.4, judgedBy: "model" }
};

test("evidence that points to an explanation is kept apart from justifying it", () => {
  const conclusion = deriveConclusion({
    ranked: [
      hypothesis("H-MISDELIVERED", "active", 0.424, 0.35, ["o-5", "o-6"], ["o-3"]),
      hypothesis("H-DELIVERED", "rejected", 0.05, 0.5, ["o-3"], ["o-4", "o-5", "o-6"]),
      hypothesis("H-NOT-SHIPPED", "rejected", 0.05, 0.15, [], ["o-3", "o-4"])
    ],
    assessed: records,
    evidenceFor: (id) => evidence[id],
    questions: [{ id: "Q-RECEIVED", text: "Has the customer received it?", answeredBy: "customer.received" }],
    belief: { supportedThreshold: 0.6, supportBonus: 0.2, modelReliabilityCeiling: 0.4 }
  });

  // The conclusion stays unresolved.
  assert.equal(conclusion.state, "unresolved");
  assert.equal(conclusion.hypothesis, null);
  assert.match(conclusion.headline, /points to "H-MISDELIVERED statement" but does not yet justify it/);

  // What the evidence shows.
  assert.equal(conclusion.direction.pointsTo?.key, "H-MISDELIVERED");
  assert.deepEqual(conclusion.direction.surviving, ["H-MISDELIVERED"]);
  assert.deepEqual(conclusion.direction.eliminated.map((item) => item.key), ["H-DELIVERED", "H-NOT-SHIPPED"]);
  assert.ok(conclusion.direction.eliminated[0]!.refutedBy.includes("EV-CAR-005"));
  assert.match(conclusion.direction.summary, /H-MISDELIVERED is the only explanation still standing, supported by EV-CAR-005, EV-SUP-006/);

  // Why that is not yet a conclusion, from Speck's own numbers.
  const justification = conclusion.justification;
  assert.equal(justification.established, false);
  assert.equal(justification.confidence, 0.424);
  assert.equal(justification.gapToSupported, 0.176);
  const reasons = justification.reasons.join("\n");
  assert.match(reasons, /0\.176 short of its supported threshold of 0\.6 and below the 0\.5 needed even to call it leading/);
  assert.match(reasons, /low prior of 0\.35/);
  assert.match(reasons, /EV-CAR-005, EV-SUP-006 was judged by the model\. Speck caps model-judged evidence at reliability 0\.4, so each such record adds at most 0\.08/);
  assert.match(reasons, /EV-CAR-003 is still counted against it, although its source has superseded it with EV-CAR-005/);
  assert.ok(justification.wouldChange.some((item) => /0\.176 more is needed/.test(item)));
  assert.ok(justification.wouldChange.some((item) => /Has the customer received it\?/.test(item)));
});

test("close rivals mean the evidence points nowhere yet", () => {
  const conclusion = deriveConclusion({
    ranked: [hypothesis("H-A", "active", 0.36, 0.3, ["o-4"], []), hypothesis("H-B", "proposed", 0.3, 0.3, [], [])],
    assessed: records,
    evidenceFor: (id) => evidence[id],
    questions: [],
    belief: { supportedThreshold: 0.6, supportBonus: 0.2, modelReliabilityCeiling: 0.4 }
  });
  assert.equal(conclusion.state, "unresolved");
  assert.equal(conclusion.direction.pointsTo, null);
  assert.match(conclusion.direction.summary, /does not yet favour one explanation among H-A, H-B/);
  assert.match(conclusion.headline, /^Unresolved: the assessed evidence does not establish any explanation/);
  assert.ok(conclusion.justification.reasons.some((reason) => /too close/.test(reason)));
});
