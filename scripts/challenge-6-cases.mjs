// Writes the set 6 challenge cases (eval/challenge-6/): harder cases for the
// stateless baseline, with controls. Run once, before the lock; the files it
// writes are what is locked, so this script is kept only as the record of how
// they were made (the long case's noise records are generated, not hand-typed).
//
//   node scripts/challenge-6-cases.mjs
//
// Labelling follows eval/challenge-5/README.md: what a careful investigator
// would conclude from the records visible at the checkpoint, or null.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "eval", "challenge-6");

const rule = (fact, equals, direction, extra = {}) => ({ fact, equals, direction, ...extra });
function record(caseId, id, system, name, observedAt, content, facts, supersedes = []) {
  return { id, caseId, source: { system, name }, observedAt, content, facts,
    provenance: { systemOfRecord: name, recordRef: id.toLowerCase(), author: `${system}-feed`, supersedes } };
}
function write(name, scenario, records, expected) {
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "evidence.json"), `${JSON.stringify({ caseId: scenario.caseId, records }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "expected.json"), `${JSON.stringify({ id: name, family: null, order: "as recorded", ...expected }, null, 2)}\n`);
}
const cp = (afterStage, conclusion, { notCurrent = [], unsupported = [], invalidated = [], withdrawBefore } = {}) =>
  ({ afterStage, conclusion, notCurrent, unsupported, invalidated, ...(withdrawBefore ? { withdrawBefore } : {}) });

// 1. A correction chain that restores the original record.
{
  const c = "N6-BAG-01";
  const tracking = ["tracking", "Airline baggage tracking"], handler = ["handler", "Ground handler log"];
  const r = (id, src, at, text, facts, sup) => record(c, id, src[0], src[1], at, text, facts, sup);
  write("baggage-scan-restored", {
    id: "c6-baggage-scan-restored", caseId: c, title: "Has bag 0081 457 3 arrived in Sydney?",
    question: "Passenger Okafor's checked bag (tag 0081 457 3) flew Melbourne to Sydney on 3 Nov. Has it arrived in Sydney?",
    sources: { tracking: { name: tracking[1], reliability: 0.9 }, handler: { name: handler[1], reliability: 0.75 } },
    hypotheses: [
      { key: "H-ARRIVED", statement: "Bag 0081 457 3 has arrived in Sydney.", prior: 0.5, rules: [
        rule("tracking.arrival", "scanned", "supports"), rule("tracking.loaded", "true", "supports", { strength: 0.5 }),
        rule("handler.bag_found", "true", "supports"), rule("handler.bag_found", "false", "contradicts", { strength: 0.5 })] },
      { key: "H-NOT-ARRIVED", statement: "Bag 0081 457 3 has not arrived in Sydney.", prior: 0.5, rules: [
        rule("handler.bag_found", "false", "supports", { strength: 0.5 }),
        rule("tracking.arrival", "scanned", "contradicts", { decisive: true }), rule("handler.bag_found", "true", "contradicts", { decisive: true })] }
    ],
    questions: [{ id: "Q-FOUND", text: "Has the ground handler found the bag?", answeredBy: "handler.bag_found" }],
    stages: [
      { id: "arrived", label: "Loaded and scanned on arrival (3 Nov)", asOf: "2026-11-03T12:00:00Z", description: "" },
      { id: "scan-voided", label: "The arrival scan is voided; the handler's search finds nothing (4 Nov)", asOf: "2026-11-04T12:00:00Z", description: "" },
      { id: "void-reversed", label: "The void is reversed; the bag is located (5 Nov)", asOf: "2026-11-05T12:00:00Z", description: "" }
    ]
  }, [
    r("N6B-01", tracking, "2026-11-03T01:10:00Z", "Bag tag 0081 457 3 (passenger Okafor, PNR K7TQ2B): loaded on QF412 MEL-SYD, container AKE 1123.", { "tracking.loaded": "true" }),
    r("N6B-02", tracking, "2026-11-03T03:05:00Z", "Bag tag 0081 457 3: arrival scan at SYD domestic, belt 4, 14:05 AEDT.", { "tracking.arrival": "scanned" }),
    r("N6B-03", tracking, "2026-11-04T00:30:00Z", "The arrival scan of 3 Nov 14:05 for tag 0081 457 3 is voided: the reader logged tag 0081 457 2, another passenger's bag. Replaces that scan.", { "tracking.scan_void": "true" }, ["N6B-02"]),
    r("N6B-04", handler, "2026-11-04T02:00:00Z", "SYD arrivals hall and belt 4 searched for tag 0081 457 3: not found. Passenger's missing-bag report lodged.", { "handler.bag_found": "false" }),
    r("N6B-05", tracking, "2026-11-05T00:40:00Z", "The void of 4 Nov is reversed: a manual tag read confirmed that the 3 Nov 14:05 arrival scan was tag 0081 457 3. The original arrival scan stands. Replaces the void.", { "tracking.void_reversed": "true" }, ["N6B-03"]),
    r("N6B-06", handler, "2026-11-05T01:30:00Z", "Tag 0081 457 3 located in the SYD oversize baggage area, held for collection.", { "handler.bag_found": "true" })
  ], {
    domain: "airline baggage", category: "a correction chain that restores the original",
    description: "The arrival scan is voided as another bag's, then the void is reversed, so the original scan counts again. A careful investigator does not conclude while the scan is voided and the only other record is one search that did not find the bag.",
    checkpoints: [
      cp("arrived", "H-ARRIVED", { notCurrent: ["H-NOT-ARRIVED"], unsupported: ["H-NOT-ARRIVED"] }),
      cp("scan-voided", null, { invalidated: ["N6B-02"] }),
      cp("void-reversed", "H-ARRIVED", { notCurrent: ["H-NOT-ARRIVED"], unsupported: ["H-NOT-ARRIVED"], invalidated: ["N6B-03"] })
    ]
  });
}

// 2. Repeated restatements by the system of record, with no declared replacement.
{
  const c = "N6-LIC-01";
  const lic = ["licensing", "Licence server"], bill = ["billing", "Billing system"];
  const r = (id, src, at, text, facts) => record(c, id, src[0], src[1], at, text, facts);
  write("licence-status-flips", {
    id: "c6-licence-status-flips", caseId: c, title: "Is licence L-7781 active?",
    question: "Is Hartley Design's software licence L-7781 currently active?",
    sources: { licensing: { name: lic[1], reliability: 0.95 }, billing: { name: bill[1], reliability: 0.9 } },
    hypotheses: [
      { key: "H-ACTIVE", statement: "Licence L-7781 is currently active.", prior: 0.5, rules: [
        rule("licence.status", "active", "supports"), rule("billing.invoice", "paid", "supports", { strength: 0.3 }),
        rule("licence.status", "suspended", "contradicts", { decisive: true }), rule("licence.status", "revoked", "contradicts", { decisive: true })] },
      { key: "H-INACTIVE", statement: "Licence L-7781 is not currently active (suspended or revoked).", prior: 0.5, rules: [
        rule("licence.status", "suspended", "supports"), rule("licence.status", "revoked", "supports"),
        rule("billing.invoice", "overdue", "supports", { strength: 0.5 }), rule("licence.status", "active", "contradicts", { decisive: true })] }
    ],
    questions: [{ id: "Q-STATUS", text: "What status does the licence server report?", answeredBy: "licence.status" }],
    stages: [
      { id: "active", label: "Licence active, invoice paid (2 Nov)", asOf: "2026-11-02T12:00:00Z", description: "" },
      { id: "suspended", label: "Invoice overdue; licence suspended (9 Nov)", asOf: "2026-11-09T12:00:00Z", description: "" },
      { id: "reinstated", label: "Invoice paid; licence reinstated (12 Nov)", asOf: "2026-11-12T12:00:00Z", description: "" },
      { id: "revoked", label: "Licence revoked under the security policy (20 Nov)", asOf: "2026-11-20T12:00:00Z", description: "" }
    ]
  }, [
    r("N6L-01", lic, "2026-11-02T01:00:00Z", "Licence L-7781 (Hartley Design, 25 seats): status ACTIVE, term to 30 Jun 2027.", { "licence.status": "active" }),
    r("N6L-02", bill, "2026-11-02T02:00:00Z", "Invoice INV-L7781-11 for licence L-7781: paid in full.", { "billing.invoice": "paid" }),
    r("N6L-03", bill, "2026-11-08T23:00:00Z", "Invoice INV-L7781-12 for licence L-7781: overdue by 14 days; second reminder sent.", { "billing.invoice": "overdue" }),
    r("N6L-04", lic, "2026-11-09T01:00:00Z", "Licence L-7781: status SUSPENDED for non-payment (automatic suspension after 14 days overdue).", { "licence.status": "suspended" }),
    r("N6L-05", bill, "2026-11-11T22:00:00Z", "Invoice INV-L7781-12 for licence L-7781: paid in full; account in good standing.", { "billing.invoice": "paid" }),
    r("N6L-06", lic, "2026-11-12T01:00:00Z", "Licence L-7781: status ACTIVE (suspension lifted after payment).", { "licence.status": "active" }),
    r("N6L-07", lic, "2026-11-20T03:00:00Z", "Licence L-7781: status REVOKED. The licence key was published in a public code repository and is revoked under the security policy; a new licence must be issued.", { "licence.status": "revoked" })
  ], {
    domain: "software licensing", category: "repeated restatements by the system of record",
    description: "The licence server reports four statuses in turn without saying any record replaces another; the billing system restates its invoice status twice. The latest status from the licence server decides; a paid invoice does not make a revoked licence active.",
    checkpoints: [
      cp("active", "H-ACTIVE", { notCurrent: ["H-INACTIVE"], unsupported: ["H-INACTIVE"] }),
      cp("suspended", "H-INACTIVE", { notCurrent: ["H-ACTIVE"], unsupported: ["H-ACTIVE"] }),
      cp("reinstated", "H-ACTIVE", { notCurrent: ["H-INACTIVE"], unsupported: ["H-INACTIVE"] }),
      cp("revoked", "H-INACTIVE", { notCurrent: ["H-ACTIVE"] })
    ]
  });
}

// 3. A long record stream with a buried correction and a lagging status feed.
{
  const c = "N6-PMT-01";
  const council = ["council", "Council planning register"], portal = ["portal", "Permit portal status feed"], applicant = ["applicant", "Applicant correspondence"];
  const records = [];
  let n = 0;
  const add = (src, at, text, facts, sup = []) => { n += 1; const id = `N6P-${String(n).padStart(2, "0")}`; records.push(record(c, id, src[0], src[1], at, text, facts, sup)); return id; };
  const day = (d, h) => `2026-${d}T${String(h).padStart(2, "0")}:00:00Z`;
  const ping = (at, status, label, extra) => add(portal, at, `Status check for BA-5521 (14 Wren St, two-storey dwelling): ${label}. ${extra}`, { "portal.status": status });
  // Stage 1: lodged (to 15 Sep).
  add(council, day("09-01", 1), "BA-5521 lodged: two-storey dwelling at 14 Wren St, applicant Marsh Building Pty Ltd. Assessment fee AUD 3,412 received.", { "council.step": "lodged" });
  add(applicant, day("09-01", 4), "Applicant: confirming lodgement of BA-5521 and asking for the expected assessment time.", { "applicant.message": "query" });
  add(council, day("09-03", 2), "BA-5521: referred to the heritage officer (the street is in a character area); response due in ten working days.", { "council.step": "referral" });
  for (const [d, q] of [["09-04", 21], ["09-07", 19], ["09-09", 17], ["09-11", 16], ["09-14", 14]]) ping(day(d, 22), "under_assessment", "Under assessment", `Assessment officer J. Pham. Queue position ${q} of 61. The next review is weekly.`);
  add(council, day("09-08", 3), "BA-5521: neighbour notification period closed; three submissions received (overshadowing, height, parking).", { "council.step": "notification_closed" });
  add(applicant, day("09-10", 5), "Applicant: asking whether the three neighbour submissions need a formal response before determination.", { "applicant.message": "query" });
  add(council, day("09-12", 2), "BA-5521: heritage officer's response received; no objection to the facade, comments on roof form.", { "council.step": "referral_returned" });
  add(applicant, day("09-14", 6), "Applicant: supplying revised roof-form drawings in response to the heritage officer's comments.", { "applicant.message": "documents" });
  // Stage 2: approved (to 29 Sep).
  const approval = add(council, day("09-22", 3), "Development consent granted: determination D-1180 for BA-5521 (14 Wren St), with 41 conditions.", { "council.determination": "approved" });
  for (const d of ["09-22", "09-24", "09-26", "09-28"]) ping(day(d, 22), "approved", "Approved (determination D-1180)", "Conditions of consent are available to download. Construction certificate not yet issued.");
  add(applicant, day("09-23", 4), "Applicant: thanking the council for determination D-1180 and asking when a construction certificate can be lodged.", { "applicant.message": "query" });
  add(council, day("09-24", 2), "BA-5521: conditions schedule sent to the applicant with determination D-1180.", { "council.step": "conditions_sent" });
  add(applicant, day("09-25", 5), "Applicant: booking the surveyor for set-out on 13 Oct, subject to the construction certificate.", { "applicant.message": "planning" });
  add(council, day("09-26", 3), "BA-5521: file transferred from J. Pham to the duty planner while the officer is on leave.", { "council.step": "reassigned" });
  add(applicant, day("09-28", 6), "Applicant: asking whether the 41 conditions can be met by a staged construction certificate.", { "applicant.message": "query" });
  add(council, day("09-29", 1), "Planning register maintenance: weekly batch of determinations exported to the state planning portal.", { "council.step": "export" });
  // Stage 3: the approval is withdrawn (to 6 Oct); the portal keeps showing it.
  add(council, day("09-30", 2), "Register note: the weekly portal resynchronisation is suspended until the system upgrade on 12 Oct; until then the permit portal keeps showing statuses as at 29 Sep.", { "council.step": "portal_note" });
  for (const d of ["09-30", "10-02", "10-04", "10-05"]) ping(day(d, 22), "approved", "Approved (determination D-1180)", "Conditions of consent are available to download. Construction certificate not yet issued.");
  add(applicant, day("10-01", 4), "Applicant: the portal still shows approval; asking the council to confirm the construction certificate pathway.", { "applicant.message": "query" });
  add(council, day("10-02", 1), "BA-5521: duty planner reviewing the file at the applicant's request.", { "council.step": "review" });
  const voided = add(council, day("10-03", 3), "Determination D-1180 was issued in error against BA-5521: it belongs to BA-5512 (14 Wren Lane). It is withdrawn for BA-5521, which remains under assessment. Replaces the consent record of 22 Sep for BA-5521.", { "council.determination": "under_assessment" }, [approval]);
  add(applicant, day("10-04", 5), "Applicant: asking for written confirmation of the correction and the new timeframe for BA-5521.", { "applicant.message": "query" });
  add(council, day("10-05", 2), "BA-5521: returned to J. Pham; assessment report in preparation.", { "council.step": "reassigned" });
  add(applicant, day("10-06", 3), "Applicant: cancelling the surveyor booking of 13 Oct.", { "applicant.message": "planning" });
  // Stage 4: refused (to 20 Oct).
  add(council, day("10-12", 4), "Register note: system upgrade complete; the permit portal has been resynchronised with the planning register.", { "council.step": "portal_note" });
  add(council, day("10-15", 3), "BA-5521 refused: determination D-1204. The dwelling exceeds the 9.5 m height limit by 1.1 m; the overshadowing submission is upheld.", { "council.determination": "refused" });
  for (const d of ["10-15", "10-17", "10-19"]) ping(day(d, 22), "refused", "Refused (determination D-1204)", "Reasons for refusal are available to download. Review or appeal periods apply.");
  add(applicant, day("10-16", 4), "Applicant: acknowledging the refusal of BA-5521 and asking about the review process.", { "applicant.message": "query" });
  add(council, day("10-17", 2), "BA-5521: notice of determination D-1204 sent to the three submitters.", { "council.step": "submitters_notified" });
  add(applicant, day("10-18", 5), "Applicant: instructing an architect to redesign the roof to meet the height limit.", { "applicant.message": "planning" });
  add(applicant, day("10-19", 6), "Applicant: requesting a pre-lodgement meeting for a revised application.", { "applicant.message": "query" });
  add(council, day("10-20", 1), "Planning register maintenance: weekly batch of determinations exported to the state planning portal.", { "council.step": "export" });
  // Stages 5 and 6: a review is lodged and the routine stream keeps growing;
  // the determination does not change. Why: these push the stateless prompt
  // past the 4B's 4,096-token window while the answer stays the same.
  const review = [
    [council, "Review application R-77 lodged against determination D-1204 (BA-5521); review fee AUD 1,706 received. The determination stands unless the review panel decides otherwise.", { "council.step": "review_lodged" }],
    [applicant, "Applicant: lodging review R-77 with an architect's statement on the roof redesign and a shadow diagram for 9 am, noon and 3 pm on 21 June.", { "applicant.message": "documents" }],
    [council, "R-77: acknowledgement sent to the applicant; review panel to be convened within 28 days. The three original submitters are notified of the review.", { "council.step": "review_acknowledged" }],
    [applicant, "Applicant: asking whether amended plans can be considered in the review or need a fresh application.", { "applicant.message": "query" }],
    [council, "R-77: duty planner's advice to the applicant: minor amendments may be considered in the review; a change of building envelope needs a fresh application.", { "council.step": "review_advice" }],
    [applicant, "Applicant: confirming the roof redesign keeps the building envelope and asking for it to be considered within review R-77.", { "applicant.message": "query" }],
    [council, "R-77: one further submission received from a submitter, maintaining the overshadowing objection.", { "council.step": "review_submission" }],
    [applicant, "Applicant: requesting a copy of the further submission received for review R-77.", { "applicant.message": "query" }],
    [council, "Planning register maintenance: weekly batch of determinations exported to the state planning portal; no change to BA-5521.", { "council.step": "export" }],
    [applicant, "Applicant: asking the council to confirm the date of the review panel meeting for R-77.", { "applicant.message": "query" }]
  ];
  let k = 0;
  for (const [from, to, label] of [["10-21", "11-03", "Review R-77 lodged"], ["11-04", "11-17", "Review R-77 awaiting the panel"]]) {
    const days = [];
    for (let d = Date.parse(`2026-${from}T00:00:00Z`); d <= Date.parse(`2026-${to}T00:00:00Z`); d += 86_400_000) days.push(new Date(d).toISOString().slice(5, 10));
    for (const d of days.filter((_, i) => i % 3 === 0)) ping(day(d, 22), "refused", `Refused (determination D-1204). ${label}`, "Reasons for refusal are available to download. The determination stands while the review is pending.");
    for (let i = 0; i < 14 - days.filter((_, j) => j % 3 === 0).length; i += 1) {
      const [src, text, facts] = review[k % review.length];
      k += 1;
      add(src, day(days[(i * 2 + 1) % days.length], 3 + (i % 5)), text, facts);
    }
  }
  write("permit-long", {
    id: "c6-permit-long", caseId: c, title: "Has building application BA-5521 been approved?",
    question: "Has building application BA-5521 (a two-storey dwelling at 14 Wren St) been approved or refused?",
    sources: { council: { name: council[1], reliability: 0.95 }, portal: { name: portal[1], reliability: 0.6 }, applicant: { name: applicant[1], reliability: 0.5 } },
    hypotheses: [
      { key: "H-APPROVED", statement: "Building application BA-5521 has been approved.", prior: 0.5, rules: [
        rule("council.determination", "approved", "supports"), rule("portal.status", "approved", "supports", { strength: 0.5 }),
        rule("council.determination", "refused", "contradicts", { decisive: true }), rule("portal.status", "refused", "contradicts", { strength: 0.5 })] },
      { key: "H-REFUSED", statement: "Building application BA-5521 has been refused.", prior: 0.5, rules: [
        rule("council.determination", "refused", "supports"), rule("portal.status", "refused", "supports", { strength: 0.5 }),
        rule("council.determination", "approved", "contradicts", { decisive: true }), rule("portal.status", "approved", "contradicts", { strength: 0.5 })] }
    ],
    questions: [{ id: "Q-DETERMINATION", text: "What has the council determined?", answeredBy: "council.determination" }],
    stages: [
      { id: "lodged", label: "Lodged and under assessment (to 15 Sep)", asOf: "2026-09-15T12:00:00Z", description: "" },
      { id: "approved", label: "Consent granted (to 29 Sep)", asOf: "2026-09-29T12:00:00Z", description: "" },
      { id: "approval-withdrawn", label: "The consent is withdrawn as issued in error; the portal still shows it (to 6 Oct)", asOf: "2026-10-06T12:00:00Z", description: "" },
      { id: "refused", label: "Refused (to 20 Oct)", asOf: "2026-10-20T12:00:00Z", description: "" },
      { id: "review-lodged", label: "A review of the refusal is lodged (to 3 Nov)", asOf: "2026-11-03T12:00:00Z", description: "" },
      { id: "review-pending", label: "The review awaits the panel (to 17 Nov)", asOf: "2026-11-17T12:00:00Z", description: "" }
    ]
  }, records, {
    domain: "building permits", category: "a long record stream with a buried correction and a lagging feed",
    description: `${records.length} records over six stages, most of them routine. The consent is withdrawn as issued in error in one record among many, while the permit portal, whose resynchronisation the council has suspended, keeps reporting it as approved; the application is later refused, and a review of the refusal is lodged while the determination stands.`,
    checkpoints: [
      cp("lodged", null, { unsupported: ["H-APPROVED", "H-REFUSED"] }),
      cp("approved", "H-APPROVED", { notCurrent: ["H-REFUSED"], unsupported: ["H-REFUSED"] }),
      cp("approval-withdrawn", null, { unsupported: ["H-REFUSED"], invalidated: [approval] }),
      cp("refused", "H-REFUSED", { notCurrent: ["H-APPROVED"], unsupported: ["H-APPROVED"], invalidated: [approval] }),
      cp("review-lodged", "H-REFUSED", { notCurrent: ["H-APPROVED"], unsupported: ["H-APPROVED"], invalidated: [approval] }),
      cp("review-pending", "H-REFUSED", { notCurrent: ["H-APPROVED"], unsupported: ["H-APPROVED"], invalidated: [approval] })
    ]
  });
  console.log(`permit-long: ${records.length} records; consent ${approval}, withdrawn by ${voided}`);
}

// 4. The investigator withdraws a correction, so the original counts again.
{
  const c = "N6-RX-01";
  const ph = ["pharmacy", "Pharmacy dispensing system"], pt = ["patient", "Patient app"];
  const r = (id, src, at, text, facts, sup) => record(c, id, src[0], src[1], at, text, facts, sup);
  write("prescription-reversal-withdrawn", {
    id: "c6-prescription-reversal-withdrawn", caseId: c, title: "Was prescription RX-3390 dispensed?",
    question: "Was prescription RX-3390 (atorvastatin 40 mg) dispensed to patient P-2214?",
    sources: { pharmacy: { name: ph[1], reliability: 0.9 }, patient: { name: pt[1], reliability: 0.6 } },
    hypotheses: [
      { key: "H-DISPENSED", statement: "Prescription RX-3390 was dispensed to the patient.", prior: 0.5, rules: [
        rule("pharmacy.dispensed", "true", "supports"), rule("patient.collected", "true", "supports", { strength: 0.5 }),
        rule("pharmacy.dispensed", "false", "contradicts", { decisive: true })] },
      { key: "H-NOT-DISPENSED", statement: "Prescription RX-3390 was not dispensed to the patient.", prior: 0.5, rules: [
        rule("pharmacy.dispensed", "false", "supports"), rule("pharmacy.dispensed", "true", "contradicts", { decisive: true }),
        rule("patient.collected", "true", "contradicts", { strength: 0.5 })] }
    ],
    questions: [{ id: "Q-DISPENSED", text: "What does the dispensing system record?", answeredBy: "pharmacy.dispensed" }],
    stages: [
      { id: "dispensed", label: "Dispensed and marked collected (6 Nov)", asOf: "2026-11-06T12:00:00Z", description: "" },
      { id: "reversed", label: "The dispense is reversed (7 Nov)", asOf: "2026-11-07T12:00:00Z", description: "" },
      { id: "reversal-withdrawn", label: "The reversal is found to be another patient's (10 Nov)", asOf: "2026-11-10T12:00:00Z", description: "" }
    ]
  }, [
    r("N6R-01", ph, "2026-11-06T02:00:00Z", "Script RX-3390 (atorvastatin 40 mg, 30 tablets) dispensed to patient P-2214; label printed and bagged.", { "pharmacy.dispensed": "true" }),
    r("N6R-02", pt, "2026-11-06T05:00:00Z", "Patient app: order RX-3390 marked collected at Northside Pharmacy.", { "patient.collected": "true" }),
    r("N6R-03", ph, "2026-11-07T01:00:00Z", "Dispense of RX-3390 reversed: medication returned to stock as not collected. Replaces the dispense record of 6 Nov.", { "pharmacy.dispensed": "false" }, ["N6R-01"]),
    r("N6R-04", ph, "2026-11-10T01:00:00Z", "Stock reconciliation for 6-7 Nov complete: no discrepancy for atorvastatin 40 mg.", { "pharmacy.stock_check": "ok" })
  ], {
    domain: "pharmacy", category: "a withdrawn correction restores the original",
    description: "The pharmacy reverses the dispense, conflicting with the patient app's collection; the investigator then withdraws the reversal (it was keyed against the wrong script), so the dispense record counts again.",
    checkpoints: [
      cp("dispensed", "H-DISPENSED", { notCurrent: ["H-NOT-DISPENSED"], unsupported: ["H-NOT-DISPENSED"] }),
      cp("reversed", null, { invalidated: ["N6R-01"] }),
      cp("reversal-withdrawn", "H-DISPENSED", { notCurrent: ["H-NOT-DISPENSED"], unsupported: ["H-NOT-DISPENSED"], invalidated: ["N6R-03"],
        withdrawBefore: [{ recordId: "N6R-03", reason: "The reversal was keyed against RX-3390 in error; it belonged to RX-3309, another patient's script." }] })
    ]
  });
}

// 5. A correction that arrives before the record it replaces.
{
  const c = "N6-LVS-01";
  const reg = ["registry", "Livestock traceability register"], fl = ["feedlot", "Feedlot intake system"], sy = ["saleyard", "Saleyard receivals"];
  const r = (id, src, at, text, facts, sup) => record(c, id, src[0], src[1], at, text, facts, sup);
  write("livestock-late-original", {
    id: "c6-livestock-late-original", caseId: c, title: "Where are the 40 cattle of movement MV-882?",
    question: "Movement MV-882 sent 40 cattle from property PIC 3NBKT118 on 12 Nov. Are they at the Dubbo saleyards or the Dubbo feedlot?",
    sources: { registry: { name: reg[1], reliability: 0.95 }, feedlot: { name: fl[1], reliability: 0.85 }, saleyard: { name: sy[1], reliability: 0.85 } },
    hypotheses: [
      { key: "H-SALEYARD", statement: "The 40 cattle of movement MV-882 are at the Dubbo saleyards.", prior: 0.5, rules: [
        rule("registry.destination", "saleyard", "supports"), rule("saleyard.received", "true", "supports"),
        rule("saleyard.received", "false", "contradicts", { strength: 0.5 }), rule("registry.destination", "feedlot", "contradicts"),
        rule("feedlot.received", "true", "contradicts", { decisive: true })] },
      { key: "H-FEEDLOT", statement: "The 40 cattle of movement MV-882 are at the Dubbo feedlot.", prior: 0.5, rules: [
        rule("registry.destination", "feedlot", "supports", { strength: 0.5 }), rule("feedlot.received", "true", "supports"),
        rule("registry.destination", "saleyard", "contradicts"), rule("saleyard.received", "true", "contradicts", { decisive: true })] }
    ],
    questions: [{ id: "Q-INTAKE", text: "Has the feedlot recorded the intake?", answeredBy: "feedlot.received" }],
    stages: [
      { id: "correction", label: "The register corrects the destination; the saleyards report nothing received (14 Nov)", asOf: "2026-11-14T12:00:00Z", description: "" },
      { id: "late-original", label: "The original movement record syncs late; the feedlot reports the intake (15 Nov)", asOf: "2026-11-15T12:00:00Z", description: "" }
    ]
  }, [
    r("N6V-01", reg, "2026-11-14T03:00:00Z", "Correction to movement MV-882 (40 head from PIC 3NBKT118, 12 Nov): the destination is the Dubbo feedlot (PIC 3NDFL002), not the Dubbo saleyards. Replaces the movement record MV-882.", { "registry.destination": "feedlot" }, ["N6V-03"]),
    r("N6V-02", sy, "2026-11-14T05:00:00Z", "Dubbo saleyards receivals, 12-14 Nov: no consignment from PIC 3NBKT118.", { "saleyard.received": "false" }),
    r("N6V-03", reg, "2026-11-15T02:00:00Z", "Movement MV-882, recorded by the vendor on 12 Nov and synchronised late: 40 head from PIC 3NBKT118 to the Dubbo saleyards (PIC 3NDSY001).", { "registry.destination": "saleyard" }),
    r("N6V-04", fl, "2026-11-15T04:00:00Z", "Intake of 40 head from PIC 3NBKT118 on 12 Nov, pen 14; NLIS tags read 40 of 40.", { "feedlot.received": "true" })
  ], {
    domain: "livestock traceability", category: "a correction that arrives before the record it replaces",
    description: "The register's correction of movement MV-882 arrives before the original movement record, which syncs a day later still naming the saleyards. A careful investigator applies the correction to the late record, and concludes only once the feedlot records the intake.",
    checkpoints: [
      cp("correction", null, { unsupported: ["H-SALEYARD"] }),
      cp("late-original", "H-FEEDLOT", { notCurrent: ["H-SALEYARD"], unsupported: ["H-SALEYARD"], invalidated: ["N6V-03"] })
    ]
  });
}

// 6. Control: one authoritative record settles the case.
{
  const c = "N6-TAX-01";
  const tax = ["taxoffice", "Tax office account"], tp = ["taxpayer", "Taxpayer correspondence"];
  const r = (id, src, at, text, facts) => record(c, id, src[0], src[1], at, text, facts);
  write("refund-single-authority", {
    id: "c6-refund-single-authority", caseId: c, title: "Has the 2025-26 tax refund been paid?",
    question: "Has taxpayer T-44817's 2025-26 income tax refund of AUD 2,140 been paid?",
    sources: { taxoffice: { name: tax[1], reliability: 0.95 }, taxpayer: { name: tp[1], reliability: 0.5 } },
    hypotheses: [
      { key: "H-PAID", statement: "The 2025-26 refund has been paid to the taxpayer.", prior: 0.5, rules: [
        rule("taxoffice.refund", "paid", "supports"), rule("taxoffice.refund", "approved", "supports", { strength: 0.3 })] },
      { key: "H-NOT-PAID", statement: "The 2025-26 refund has not been paid to the taxpayer.", prior: 0.5, rules: [
        rule("taxoffice.refund", "paid", "contradicts", { decisive: true })] }
    ],
    questions: [{ id: "Q-REFUND", text: "What does the tax office record for the refund?", answeredBy: "taxoffice.refund" }],
    stages: [
      { id: "approved", label: "Return processed, refund approved (20 Jul)", asOf: "2026-07-20T12:00:00Z", description: "" },
      { id: "paid", label: "Refund paid (4 Aug)", asOf: "2026-08-04T12:00:00Z", description: "" }
    ]
  }, [
    r("N6T-01", tp, "2026-07-18T03:00:00Z", "Taxpayer T-44817: return lodged; asking when the refund will arrive.", { "taxpayer.query": "true" }),
    r("N6T-02", tax, "2026-07-20T02:00:00Z", "2025-26 return processed: refund of AUD 2,140 approved for payment.", { "taxoffice.refund": "approved" }),
    r("N6T-03", tax, "2026-08-04T01:00:00Z", "Refund of AUD 2,140 paid by EFT on 3 Aug to the nominated account (BSB 062-000, account ending 4471), payment reference R-55190.", { "taxoffice.refund": "paid" })
  ], {
    domain: "tax refunds", category: "control: one authoritative record settles the case",
    description: "The tax office approves the refund, then records the payment with its reference. An approval is not a payment; the payment record alone settles the case.",
    checkpoints: [
      cp("approved", null, { unsupported: ["H-NOT-PAID"] }),
      cp("paid", "H-PAID", { notCurrent: ["H-NOT-PAID"], unsupported: ["H-NOT-PAID"] })
    ]
  });
}

// 7. Control: independent agreement, no corrections.
{
  const c = "N6-WAR-01";
  const ws = ["workshop", "Service workshop"], cr = ["courier", "Return courier"];
  const r = (id, src, at, text, facts) => record(c, id, src[0], src[1], at, text, facts);
  write("repair-two-sources", {
    id: "c6-repair-two-sources", caseId: c, title: "Has the repaired laptop been returned?",
    question: "Has customer A. Ruiz's laptop, under warranty repair job W-4410, been returned to the customer?",
    sources: { workshop: { name: ws[1], reliability: 0.9 }, courier: { name: cr[1], reliability: 0.85 } },
    hypotheses: [
      { key: "H-RETURNED", statement: "The repaired laptop has been returned to the customer.", prior: 0.5, rules: [
        rule("courier.delivered", "true", "supports"), rule("workshop.job", "closed_dispatched", "supports", { strength: 0.5 }),
        rule("workshop.job", "in_progress", "contradicts", { strength: 0.5 })] },
      { key: "H-NOT-RETURNED", statement: "The laptop has not yet been returned to the customer.", prior: 0.5, rules: [
        rule("workshop.job", "in_progress", "supports", { strength: 0.5 }), rule("courier.delivered", "true", "contradicts", { decisive: true })] }
    ],
    questions: [{ id: "Q-DELIVERED", text: "Has the courier delivered it?", answeredBy: "courier.delivered" }],
    stages: [
      { id: "in-repair", label: "Received and in repair (10 Oct)", asOf: "2026-10-10T12:00:00Z", description: "" },
      { id: "returned", label: "Dispatched and delivered (17 Oct)", asOf: "2026-10-17T12:00:00Z", description: "" }
    ]
  }, [
    r("N6W-01", ws, "2026-10-08T02:00:00Z", "Job W-4410: laptop received from A. Ruiz, keyboard fault confirmed, repair in progress.", { "workshop.job": "in_progress" }),
    r("N6W-02", ws, "2026-10-15T03:00:00Z", "Job W-4410: repair complete; closed and dispatched by courier, consignment C-88120.", { "workshop.job": "closed_dispatched" }),
    r("N6W-03", cr, "2026-10-16T05:00:00Z", "Consignment C-88120 delivered to the customer's address; signed for by A. Ruiz.", { "courier.delivered": "true" })
  ], {
    domain: "warranty repairs", category: "control: independent agreement, no corrections",
    description: "The workshop has the laptop in repair; then it closes the job and dispatches it, and the courier records delivery signed by the customer.",
    checkpoints: [
      cp("in-repair", "H-NOT-RETURNED", { notCurrent: ["H-RETURNED"], unsupported: ["H-RETURNED"] }),
      cp("returned", "H-RETURNED", { notCurrent: ["H-NOT-RETURNED"], unsupported: ["H-NOT-RETURNED"] })
    ]
  });
}

console.log(`set 6 written to ${path.relative(root, out)}`);
