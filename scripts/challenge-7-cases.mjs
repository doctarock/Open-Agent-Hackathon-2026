// Writes the set 7 challenge cases (eval/challenge-7/): few, rich cases with
// many receipts from several sources that conflict over time, some conflicts
// resolving and some not. Run once, before the lock; the files it writes are
// what is locked, so this script is kept as the record of how they were made.
//
//   node scripts/challenge-7-cases.mjs
//
// Labelling follows eval/challenge-5/README.md: what a careful investigator
// would conclude from the records visible at the checkpoint, or null. Every
// case stays at 15 records or fewer, so no stateless prompt comes near the
// 4B's 4,096-token window and the rebuilt-each-time system can assess every
// visible record in one run (the engine's budget is 8 chunks of 2 records).
// notCurrent lists only explanations a decisive rule refutes at that point.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "eval", "challenge-7");

const rule = (fact, equals, direction, extra = {}) => ({ fact, equals, direction, ...extra });
const supports = (fact, equals, strength) => rule(fact, equals, "supports", strength === undefined ? {} : { strength });
const against = (fact, equals, strength) => rule(fact, equals, "contradicts", strength === undefined ? {} : { strength });
const refutes = (fact, equals) => rule(fact, equals, "contradicts", { decisive: true });
const cp = (afterStage, conclusion, { notCurrent = [], unsupported = [], invalidated = [] } = {}) =>
  ({ afterStage, conclusion, notCurrent, unsupported, invalidated });

function build(name, scenario, rows, expected) {
  const sources = scenario.sources;
  const records = rows.map(([id, system, observedAt, content, facts, supersedes = []]) => ({
    id, caseId: scenario.caseId, source: { system, name: sources[system].name }, observedAt, content, facts,
    provenance: { systemOfRecord: sources[system].name, recordRef: id.toLowerCase(), author: `${system}-feed`, supersedes }
  }));
  if (records.length > 15) throw new Error(`${name}: ${records.length} records; set 7 keeps every case at 15 or fewer`);
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "evidence.json"), `${JSON.stringify({ caseId: scenario.caseId, records }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "expected.json"), `${JSON.stringify({ id: name, family: null, order: "as recorded", ...expected }, null, 2)}\n`);
  console.log(`${name}: ${records.length} records, ${scenario.stages.length} stages`);
}
const stage = (id, label, asOf) => ({ id, label, asOf, description: "" });

// 1. Two loggers disagree; a voiding notice is itself corrected; later
// records confirm the excursion, and the manufacturer's release confirms it too.
build("cold-chain-excursion", {
  id: "c7-cold-chain-excursion", caseId: "N7-CCV-01", title: "Did vaccine shipment SH-7781 have a temperature excursion?",
  question: "Vaccine shipment SH-7781 (1,200 doses, to be kept at 2-8 °C) arrived at Riverbend Clinic on 2 Nov. Did it go above 8 °C in transit?",
  sources: {
    logger1: { name: "Data logger DL-4402 (pallet face)", reliability: 0.85 },
    logger2: { name: "Data logger DL-4419 (centre tote)", reliability: 0.85 },
    carrier: { name: "Carrier reefer telemetry", reliability: 0.7 },
    vendor: { name: "Logger vendor service notices", reliability: 0.8 },
    clinic: { name: "Receiving clinic", reliability: 0.75 },
    maker: { name: "Manufacturer quality assurance", reliability: 0.95 }
  },
  hypotheses: [
    { key: "H-INTACT", statement: "Shipment SH-7781 stayed within 2-8 °C throughout transit.", prior: 0.5, rules: [
      supports("dl4419.excursion", "false"), supports("dl4402.excursion", "false"), supports("carrier.setpoint_held", "true", 0.5),
      against("dl4402.excursion", "true", 0.5), against("dl4419.excursion", "true", 0.5), against("clinic.probe_high", "true", 0.5),
      against("carrier.setpoint_held", "false", 0.5), refutes("maker.excursion_confirmed", "true")] },
    { key: "H-EXCURSION", statement: "Shipment SH-7781 went above 8 °C in transit.", prior: 0.5, rules: [
      supports("dl4402.excursion", "true", 0.5), supports("dl4419.excursion", "true", 0.5), supports("clinic.probe_high", "true", 0.5),
      supports("carrier.setpoint_held", "false", 0.5), supports("maker.excursion_confirmed", "true"),
      against("dl4419.excursion", "false", 0.5), against("carrier.setpoint_held", "true", 0.3)] }
  ],
  questions: [{ id: "Q-QA", text: "What has the manufacturer's quality assurance found?", answeredBy: "maker.excursion_confirmed" }],
  stages: [
    stage("arrival", "Arrival: the pallet-face logger shows an excursion; the carrier reports the setpoint held (2 Nov)", "2026-11-02T12:00:00Z"),
    stage("second-logger", "The centre logger shows no excursion (3 Nov)", "2026-11-03T12:00:00Z"),
    stage("logger-voided", "The logger vendor voids the pallet-face logger's readings (5 Nov)", "2026-11-05T12:00:00Z"),
    stage("notice-corrected", "The vendor corrects its notice: the pallet-face logger is not affected (7 Nov)", "2026-11-07T12:00:00Z"),
    stage("probe-and-power", "The clinic's arrival probe check and the carrier's power-loss report (9 Nov)", "2026-11-09T12:00:00Z"),
    stage("qa-ruling", "The manufacturer's quality assurance ruling (12 Nov)", "2026-11-12T12:00:00Z")
  ]
}, [
  ["N7C-01", "carrier", "2026-11-02T01:00:00Z", "Reefer unit RF-12, consignment SH-7781: setpoint 5 °C held for the whole trip, no alarms raised.", { "carrier.setpoint_held": "true" }],
  ["N7C-02", "logger1", "2026-11-02T04:30:00Z", "DL-4402 trip summary for SH-7781: maximum 12.4 °C, above 8 °C for 95 minutes (2 Nov 03:10-04:45).", { "dl4402.excursion": "true" }],
  ["N7C-03", "clinic", "2026-11-02T06:00:00Z", "SH-7781 received and placed in quarantine at 2-8 °C pending a quality decision.", { "clinic.quarantine": "true" }],
  ["N7C-04", "logger2", "2026-11-03T02:00:00Z", "DL-4419 trip summary for SH-7781: maximum 7.6 °C, no reading above 8 °C.", { "dl4419.excursion": "false" }],
  ["N7C-05", "clinic", "2026-11-03T05:00:00Z", "Clinic: both logger files for SH-7781 sent to the manufacturer; the stock stays in quarantine.", { "clinic.quarantine": "true" }],
  ["N7C-06", "vendor", "2026-11-05T01:00:00Z", "Service notice SN-22: loggers DL-4400 to DL-4410 have a sensor fault that reads up to 6 °C high after a shock. Their readings for October and November shipments are void. Replaces the DL-4402 trip summary for SH-7781.", { "vendor.notice": "void" }, ["N7C-02"]],
  ["N7C-07", "vendor", "2026-11-07T01:00:00Z", "Correction to service notice SN-22: the fault affects DL-4400 and DL-4401 only; DL-4402 is not affected and its readings stand. Replaces SN-22.", { "vendor.notice": "corrected" }, ["N7C-06"]],
  ["N7C-08", "clinic", "2026-11-09T01:00:00Z", "Clinic's arrival log, now filed: probe check of three cartons on unpacking at 06:00 on 2 Nov read 9.8, 10.1 and 9.6 °C.", { "clinic.probe_high": "true" }],
  ["N7C-09", "carrier", "2026-11-09T03:00:00Z", "Telemetry review for RF-12: the unit lost power from 03:05 to 04:50 on 2 Nov; the setpoint data for that window was interpolated, not measured. The setpoint was not held during the outage.", { "carrier.setpoint_held": "false" }],
  ["N7C-10", "logger2", "2026-11-09T04:00:00Z", "DL-4419 placement note: the backup logger was inside the insulated centre tote, not at the pallet face.", { "dl4419.placement": "centre_tote" }],
  ["N7C-11", "maker", "2026-11-12T02:00:00Z", "Quality ruling on SH-7781: excursion confirmed (maximum 12.4 °C for 95 minutes). It is within the product's stability budget (up to 25 °C for 6 hours), so the stock is released for use with the excursion recorded.", { "maker.excursion_confirmed": "true", "maker.disposition": "release" }],
  ["N7C-12", "clinic", "2026-11-12T05:00:00Z", "Clinic: SH-7781 released from quarantine and added to stock, with the excursion noted on the batch record.", { "clinic.quarantine": "false" }]
], {
  domain: "vaccine cold chain", category: "conflicting loggers; a voiding notice that is itself corrected; later confirmation",
  description: "The pallet-face logger shows an excursion, the centre logger and the carrier do not. The vendor voids the pallet-face logger, then corrects its notice so the readings stand again. The clinic's probe check and the carrier's power loss then confirm the excursion, and the manufacturer confirms it while releasing the stock as within its stability budget: release for use is not the same as no excursion.",
  checkpoints: [
    cp("arrival", null),
    cp("second-logger", null),
    cp("logger-voided", "H-INTACT", { unsupported: ["H-EXCURSION"], invalidated: ["N7C-02"] }),
    cp("notice-corrected", null, { invalidated: ["N7C-06"] }),
    cp("probe-and-power", "H-EXCURSION", { invalidated: ["N7C-06"] }),
    cp("qa-ruling", "H-EXCURSION", { notCurrent: ["H-INTACT"], invalidated: ["N7C-06"] })
  ]
});

// 2. A settlement that is reversed, a stale agent, then a second settlement
// that restates the platform's status, and registration.
build("property-settlement", {
  id: "c7-property-settlement", caseId: "N7-SET-01", title: "Has the sale of 22 Ibis Court settled?",
  question: "Has the sale of 22 Ibis Court settled, with the purchase price paid and the transfer lodged for the buyers, L. and K. Moreau?",
  sources: {
    platform: { name: "Electronic settlement platform", reliability: 0.9 },
    registry: { name: "Land titles registry", reliability: 0.95 },
    bank: { name: "Buyer's lender", reliability: 0.85 },
    solicitor: { name: "Seller's solicitor", reliability: 0.7 },
    agent: { name: "Selling agent", reliability: 0.5 }
  },
  hypotheses: [
    { key: "H-SETTLED", statement: "The sale of 22 Ibis Court has settled.", prior: 0.5, rules: [
      supports("platform.status", "settled"), supports("registry.owner", "buyer"), supports("bank.funds", "released", 0.5),
      supports("solicitor.reports", "settled", 0.5), supports("agent.reports", "settled", 0.3),
      against("bank.funds", "held", 0.5), against("registry.owner", "seller", 0.3), refutes("platform.status", "reversed")] },
    { key: "H-NOT-SETTLED", statement: "The sale of 22 Ibis Court has not settled.", prior: 0.5, rules: [
      supports("platform.status", "reversed"), supports("platform.status", "booked", 0.5), supports("bank.funds", "held", 0.5),
      supports("solicitor.reports", "pending", 0.5), supports("registry.owner", "seller", 0.3),
      refutes("platform.status", "settled"), refutes("registry.owner", "buyer")] }
  ],
  questions: [{ id: "Q-REGISTERED", text: "Has the registry recorded the buyers as owners?", answeredBy: "registry.owner" }],
  stages: [
    stage("booked", "Settlement booked for 4 Sep (1 Sep)", "2026-09-01T12:00:00Z"),
    stage("settled", "The platform records settlement (4 Sep)", "2026-09-04T12:00:00Z"),
    stage("reversed", "The lender's funds were held; the platform reverses the settlement (5 Sep)", "2026-09-05T12:00:00Z"),
    stage("agent-update", "The agent still reports settlement; the seller's solicitor awaits a new time (8 Sep)", "2026-09-08T12:00:00Z"),
    stage("resettled", "The hold clears and a second settlement completes (11 Sep)", "2026-09-11T12:00:00Z"),
    stage("registered", "The registry records the transfer (15 Sep)", "2026-09-15T12:00:00Z")
  ]
}, [
  ["N7S-01", "platform", "2026-09-01T01:00:00Z", "Workspace W-2290 (22 Ibis Court): settlement booked for 4 Sep at 14:00; all parties signed.", { "platform.status": "booked" }],
  ["N7S-02", "bank", "2026-09-01T02:00:00Z", "Loan L-551 for L. and K. Moreau: approved; funds of AUD 812,000 scheduled for settlement on 4 Sep.", { "bank.funds": "scheduled" }],
  ["N7S-03", "registry", "2026-09-01T03:00:00Z", "Title search, 22 Ibis Court: registered owner E. Calder (the seller).", { "registry.owner": "seller" }],
  ["N7S-04", "platform", "2026-09-04T04:06:00Z", "Workspace W-2290: settlement completed at 14:06; funds exchanged; transfer AX-1129 lodged with the registry.", { "platform.status": "settled" }],
  ["N7S-05", "solicitor", "2026-09-04T05:00:00Z", "Seller's solicitor: settlement effected this afternoon; discharge of the seller's mortgage to follow.", { "solicitor.reports": "settled" }],
  ["N7S-06", "agent", "2026-09-04T06:00:00Z", "Selling agent: settled; keys released to the buyers.", { "agent.reports": "settled" }],
  ["N7S-07", "bank", "2026-09-05T00:30:00Z", "Loan L-551: funds were not released. A fraud hold was placed at 13:58 on 4 Sep, before settlement, after a change to the buyers' contact details.", { "bank.funds": "held" }],
  ["N7S-08", "platform", "2026-09-05T01:00:00Z", "Workspace W-2290: the settlement of 4 Sep is reversed because the lender's funds were not received; transfer AX-1129 is withdrawn from the registry. Replaces the settlement record of 4 Sep.", { "platform.status": "reversed" }, ["N7S-04"]],
  ["N7S-09", "agent", "2026-09-08T02:00:00Z", "Selling agent: the buyers are moving in this weekend; settlement is all done.", { "agent.reports": "settled" }],
  ["N7S-10", "solicitor", "2026-09-08T03:00:00Z", "Seller's solicitor: we are waiting for the buyers' lender to give a new settlement time; the keys have been returned to the agent.", { "solicitor.reports": "pending" }],
  ["N7S-11", "bank", "2026-09-11T00:40:00Z", "Loan L-551: fraud hold cleared after identity checks; funds of AUD 812,000 released for settlement on 11 Sep.", { "bank.funds": "released" }],
  ["N7S-12", "platform", "2026-09-11T01:02:00Z", "Workspace W-2290: settlement completed on 11 Sep at 11:02; funds exchanged; transfer AX-1131 lodged with the registry.", { "platform.status": "settled" }],
  ["N7S-13", "solicitor", "2026-09-11T03:00:00Z", "Seller's solicitor: settlement effected today; the seller's mortgage has been discharged.", { "solicitor.reports": "settled" }],
  ["N7S-14", "registry", "2026-09-15T01:00:00Z", "Transfer AX-1131 registered: 22 Ibis Court, registered owners L. and K. Moreau.", { "registry.owner": "buyer" }]
], {
  domain: "property conveyancing", category: "a reversed settlement, a stale source, then a second settlement",
  description: "The platform records settlement, then reverses it because the lender's funds were held; the agent keeps reporting settlement from stale information while the seller's solicitor reports the delay. A second settlement completes (a new record, restating the platform's status, not a reinstatement of the first) and the registry records the buyers.",
  checkpoints: [
    cp("booked", "H-NOT-SETTLED", { unsupported: ["H-SETTLED"] }),
    cp("settled", "H-SETTLED", { notCurrent: ["H-NOT-SETTLED"] }),
    cp("reversed", "H-NOT-SETTLED", { notCurrent: ["H-SETTLED"], invalidated: ["N7S-04"] }),
    cp("agent-update", "H-NOT-SETTLED", { notCurrent: ["H-SETTLED"], invalidated: ["N7S-04"] }),
    cp("resettled", "H-SETTLED", { notCurrent: ["H-NOT-SETTLED"], invalidated: ["N7S-04"] }),
    cp("registered", "H-SETTLED", { notCurrent: ["H-NOT-SETTLED"], unsupported: ["H-NOT-SETTLED"], invalidated: ["N7S-04"] })
  ]
});

// 3. A release certificate withdrawn over a suspect part; the part is later
// cleared, but the release stays withdrawn until a new one is issued.
build("aircraft-release", {
  id: "c7-aircraft-release", caseId: "N7-AIR-01", title: "Is aircraft VH-QRK validly released to service?",
  question: "After its number 2 fuel-pump defect, is aircraft VH-QRK validly released to service?",
  sources: {
    mx: { name: "Maintenance tracking system", reliability: 0.9 },
    crs: { name: "Certificate of release register", reliability: 0.95 },
    supplier: { name: "Parts supplier notices", reliability: 0.8 },
    regulator: { name: "Aviation safety regulator", reliability: 0.95 },
    ops: { name: "Airline operations control", reliability: 0.6 }
  },
  hypotheses: [
    { key: "H-RELEASED", statement: "VH-QRK is validly released to service.", prior: 0.5, rules: [
      supports("crs.status", "issued"), supports("mx.defect", "closed", 0.5), supports("ops.status", "flying", 0.3),
      against("mx.defect", "open", 0.5), against("supplier.part", "suspect", 0.5), refutes("crs.status", "withdrawn")] },
    { key: "H-GROUNDED", statement: "VH-QRK is not validly released to service.", prior: 0.5, rules: [
      supports("crs.status", "withdrawn"), supports("mx.defect", "open", 0.5), supports("supplier.part", "suspect", 0.5),
      supports("ops.status", "withdrawn", 0.5), against("crs.status", "issued", 0.5), against("mx.defect", "closed", 0.5)] }
  ],
  questions: [{ id: "Q-CRS", text: "Is a certificate of release to service in force?", answeredBy: "crs.status" }],
  stages: [
    stage("defect", "Fuel-pump defect raised; the aircraft is taken off the schedule (2 Oct)", "2026-10-02T12:00:00Z"),
    stage("repaired", "Pump replaced; certificate of release CRS-5512 issued (3 Oct)", "2026-10-03T12:00:00Z"),
    stage("part-notice", "The supplier flags the fitted pump's serial range as suspect (5 Oct, morning)", "2026-10-05T02:00:00Z"),
    stage("release-withdrawn", "CRS-5512 is withdrawn; operations still show the aircraft flying (5 Oct)", "2026-10-05T12:00:00Z"),
    stage("notice-retracted", "The supplier corrects its notice: the fitted serial was certified (7 Oct)", "2026-10-07T12:00:00Z"),
    stage("new-release", "A new certificate, CRS-5530, is issued (8 Oct)", "2026-10-08T12:00:00Z"),
    stage("directive", "An airworthiness directive allows 50 flight hours for an inspection (10 Oct)", "2026-10-10T12:00:00Z")
  ]
}, [
  ["N7A-01", "mx", "2026-10-02T01:00:00Z", "Defect D-77 on VH-QRK: number 2 fuel pump low pressure; aircraft unserviceable until rectified.", { "mx.defect": "open" }],
  ["N7A-02", "ops", "2026-10-02T02:00:00Z", "Operations: VH-QRK withdrawn from the schedule; sectors reassigned.", { "ops.status": "withdrawn" }],
  ["N7A-03", "mx", "2026-10-03T03:00:00Z", "Defect D-77 closed: number 2 fuel pump replaced with part 3105-2, serial 88412; leak and pressure checks passed.", { "mx.defect": "closed" }],
  ["N7A-04", "crs", "2026-10-03T04:00:00Z", "Certificate of release to service CRS-5512 issued for VH-QRK by licensed engineer L. Tran, covering defect D-77.", { "crs.status": "issued" }],
  ["N7A-05", "ops", "2026-10-03T05:00:00Z", "Operations: VH-QRK back on the schedule from 06:00 on 4 Oct.", { "ops.status": "flying" }],
  ["N7A-06", "supplier", "2026-10-05T00:30:00Z", "Unapproved-part notice UP-19: fuel pumps part 3105-2, serials 88400 to 88420, were shipped without a valid release certificate. Operators must review any installation.", { "supplier.part": "suspect" }],
  ["N7A-07", "crs", "2026-10-05T03:00:00Z", "CRS-5512 for VH-QRK withdrawn: the fitted pump (serial 88412) is within the range of unapproved-part notice UP-19. Replaces CRS-5512.", { "crs.status": "withdrawn" }, ["N7A-04"]],
  ["N7A-08", "mx", "2026-10-05T04:00:00Z", "Defect D-77 reopened pending the part documentation review.", { "mx.defect": "open" }],
  ["N7A-09", "ops", "2026-10-05T05:00:00Z", "Operations: VH-QRK operating today's sectors as scheduled.", { "ops.status": "flying" }],
  ["N7A-10", "supplier", "2026-10-07T01:00:00Z", "Correction to UP-19: serial 88412 was shipped with a valid release certificate (RC-2201, attached); the affected range is 88400 to 88410 only. Replaces UP-19.", { "supplier.part": "cleared" }, ["N7A-06"]],
  ["N7A-11", "crs", "2026-10-08T02:00:00Z", "Certificate of release to service CRS-5530 issued for VH-QRK by licensed engineer L. Tran after review of release certificate RC-2201.", { "crs.status": "issued" }],
  ["N7A-12", "mx", "2026-10-08T03:00:00Z", "Defect D-77 closed after the part documentation review.", { "mx.defect": "closed" }],
  ["N7A-13", "regulator", "2026-10-10T01:00:00Z", "Airworthiness directive AD 2026-41: inspect the fuel-pump electrical connectors on all aircraft of this type within 50 flight hours.", { "regulator.ad": "inspect_within_50h" }],
  ["N7A-14", "ops", "2026-10-10T03:00:00Z", "Operations: VH-QRK on the schedule; the AD 2026-41 inspection is planned for its overnight check on 12 Oct.", { "ops.status": "flying" }]
], {
  domain: "aircraft maintenance", category: "a withdrawn release; a cleared part does not reinstate it",
  description: "The release certificate is withdrawn when the fitted pump falls in a suspect serial range. When the supplier clears that serial, the aircraft is still not validly released: the withdrawn certificate is not reinstated, and only the new certificate releases it. Operations' schedule is not evidence of a valid release, and a directive allowing 50 flight hours does not ground it.",
  checkpoints: [
    cp("defect", "H-GROUNDED", { unsupported: ["H-RELEASED"] }),
    cp("repaired", "H-RELEASED", { unsupported: ["H-GROUNDED"] }),
    cp("part-notice", null),
    cp("release-withdrawn", "H-GROUNDED", { notCurrent: ["H-RELEASED"], invalidated: ["N7A-04"] }),
    cp("notice-retracted", "H-GROUNDED", { notCurrent: ["H-RELEASED"], invalidated: ["N7A-04", "N7A-06"] }),
    cp("new-release", "H-RELEASED", { unsupported: ["H-GROUNDED"], invalidated: ["N7A-04", "N7A-06"] }),
    cp("directive", "H-RELEASED", { unsupported: ["H-GROUNDED"], invalidated: ["N7A-04", "N7A-06"] })
  ]
});

// 4. A no-show reported twice (one report relays the other); a late check-in
// and door-lock entries; a disputing guest; then both the check-in and the
// key entries are re-attributed, so the original no-show stands again.
build("hotel-chargeback", {
  id: "c7-hotel-chargeback", caseId: "N7-HTL-01", title: "Did guest R. Lindqvist stay on 12-14 October?",
  question: "Did guest R. Lindqvist stay at the Harbourside Hotel on 12-14 Oct under booking BK-6620?",
  sources: {
    pms: { name: "Hotel property management system", reliability: 0.85 },
    ota: { name: "Online travel agency", reliability: 0.7 },
    locks: { name: "Door-lock audit log", reliability: 0.9 },
    card: { name: "Card network dispute", reliability: 0.6 },
    guest: { name: "Guest correspondence", reliability: 0.5 }
  },
  hypotheses: [
    { key: "H-STAYED", statement: "R. Lindqvist stayed at the hotel on 12-14 Oct under booking BK-6620.", prior: 0.5, rules: [
      supports("pms.checkin", "true"), supports("locks.booking_key_used", "true"),
      against("pms.checkin", "false", 0.5), against("ota.status", "no_show", 0.5), against("card.claim", "not_stayed", 0.3),
      against("guest.says", "not_stayed", 0.3)] },
    { key: "H-NO-SHOW", statement: "R. Lindqvist did not stay; booking BK-6620 was a no-show.", prior: 0.5, rules: [
      supports("pms.checkin", "false", 0.5), supports("ota.status", "no_show", 0.5), supports("ota.status", "refunded_no_show", 0.5),
      supports("card.claim", "not_stayed", 0.3), supports("guest.says", "not_stayed", 0.3),
      against("pms.checkin", "true", 0.5), refutes("locks.booking_key_used", "true")] }
  ],
  questions: [{ id: "Q-KEY", text: "Was the booking's key used on the room door?", answeredBy: "locks.booking_key_used" }],
  stages: [
    stage("booked", "Booking confirmed for 12-14 Oct (11 Oct)", "2026-10-11T12:00:00Z"),
    stage("no-show", "The night audit shows no check-in; the agency records a no-show (13 Oct)", "2026-10-13T12:00:00Z"),
    stage("late-checkin", "A late check-in is found, with door-lock entries (15 Oct)", "2026-10-15T12:00:00Z"),
    stage("dispute", "The guest disputes the charge (28 Oct)", "2026-10-28T12:00:00Z"),
    stage("reattributed", "The check-in and the key entries are found to be another guest's (2 Nov)", "2026-11-02T12:00:00Z"),
    stage("refunded", "The agency refunds the booking as a no-show (5 Nov)", "2026-11-05T12:00:00Z")
  ]
}, [
  ["N7H-01", "ota", "2026-10-11T01:00:00Z", "Booking BK-6620 for R. Lindqvist, Harbourside Hotel, 12-14 Oct (2 nights), prepaid AUD 486, free cancellation until 11 Oct 18:00.", { "ota.status": "confirmed" }],
  ["N7H-02", "pms", "2026-10-13T00:10:00Z", "Night audit, 12 Oct: booking BK-6620 not checked in; flagged as a no-show.", { "pms.checkin": "false" }],
  ["N7H-03", "ota", "2026-10-13T02:00:00Z", "Booking BK-6620: the hotel reported the guest as a no-show for 12 Oct.", { "ota.status": "no_show" }],
  ["N7H-04", "pms", "2026-10-15T01:00:00Z", "Correction to the night audit: BK-6620 was checked in at 23:40 on 12 Oct by the night manager (a late arrival) to room 412. Replaces the night-audit entry.", { "pms.checkin": "true" }, ["N7H-02"]],
  ["N7H-05", "locks", "2026-10-15T02:00:00Z", "Room 412: key K-6620, encoded for booking BK-6620, used 12 Oct 23:52, 13 Oct 08:10, 13 Oct 19:31 and 14 Oct 07:55.", { "locks.booking_key_used": "true" }],
  ["N7H-06", "card", "2026-10-28T01:00:00Z", "Dispute CB-3302 on AUD 486 (Harbourside Hotel): the cardholder states the stay did not take place.", { "card.claim": "not_stayed" }],
  ["N7H-07", "guest", "2026-10-28T03:00:00Z", "R. Lindqvist: I never stayed at the hotel; I tried to cancel through the agency on 11 Oct.", { "guest.says": "not_stayed" }],
  ["N7H-08", "pms", "2026-10-30T02:00:00Z", "Front office: dispute CB-3302 noted; the hotel's response is due by 6 Nov.", { "pms.note": "dispute" }],
  ["N7H-09", "locks", "2026-11-02T01:00:00Z", "Audit correction: key K-6620 was re-encoded at 23:45 on 12 Oct for walk-in booking WK-118 in room 412; the four entries of 12-14 Oct belong to WK-118, not BK-6620. Replaces the room 412 key entries.", { "locks.key_reassigned": "true" }, ["N7H-05"]],
  ["N7H-10", "pms", "2026-11-02T02:00:00Z", "Correction: the 23:40 check-in to room 412 on 12 Oct was walk-in WK-118 (guest R. Lindgren), keyed against BK-6620 by mistake. Replaces the night-audit correction of 15 Oct.", { "pms.checkin_reassigned": "true" }, ["N7H-04"]],
  ["N7H-11", "ota", "2026-11-05T01:00:00Z", "Booking BK-6620: refunded to the guest as a no-show; the hotel accepts dispute CB-3302.", { "ota.status": "refunded_no_show" }]
], {
  domain: "hospitality payments", category: "a dependent report, a late check-in, a dispute, then a re-attribution that restores the original",
  description: "The night audit flags a no-show and the agency relays the hotel's report, so the two are one source, not two. A late check-in and door-lock entries then show a stay, which the guest's dispute does not outweigh. Both the check-in and the key entries are then re-attributed to a walk-in guest with a similar name, so the night audit's no-show counts again.",
  checkpoints: [
    cp("booked", null, { unsupported: ["H-STAYED", "H-NO-SHOW"] }),
    cp("no-show", null, { unsupported: ["H-STAYED"] }),
    cp("late-checkin", "H-STAYED", { notCurrent: ["H-NO-SHOW"], invalidated: ["N7H-02"] }),
    cp("dispute", "H-STAYED", { notCurrent: ["H-NO-SHOW"], invalidated: ["N7H-02"] }),
    cp("reattributed", "H-NO-SHOW", { unsupported: ["H-STAYED"], invalidated: ["N7H-04", "N7H-05"] }),
    cp("refunded", "H-NO-SHOW", { unsupported: ["H-STAYED"], invalidated: ["N7H-04", "N7H-05"] })
  ]
});

console.log(`set 7 written to ${path.relative(root, out)}`);
