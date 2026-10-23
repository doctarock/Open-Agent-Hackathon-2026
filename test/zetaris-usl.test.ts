import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../src/config.js";

// The Zetaris USL demonstration's files (zetaris/usl/), checked offline. The
// live run is npm run zetaris:usl; nothing here needs the platform.

const USL_DIR = path.join(ROOT_DIR, "zetaris", "usl");
const read = (...parts: string[]) => fs.readFileSync(path.join(USL_DIR, ...parts), "utf8");
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "fixtures", "scenarios", "disputed-delivery", "evidence.json"), "utf8")) as {
  records: Array<{ id: string; observedAt: string; content: string; source: { system: string }; provenance: { recordRef: string; supersedes: string[] } }>;
};

const declared = [...read("delivery_usl.ddl.sql").matchAll(/^\s{2}(\w+) \w+/gm)].map((match) => match[1]).filter((name) => name !== "CONSTRAINT");
const aliases = (sql: string) => sql.split(/^UNION ALL$/m).map((branch) => [...branch.matchAll(/ AS (\w+),?$/gm)].map((match) => match[1]));

test("every branch of each activation query yields the USL's declared columns, in order", () => {
  assert.equal(declared.length, 11);
  for (const file of ["delivery_evidence.activate.sql", "delivery_evidence.dq-sample.activate.sql"]) {
    for (const branch of aliases(read(file))) assert.deepEqual(branch, declared, file);
  }
  assert.equal(aliases(read("delivery_evidence.dq-sample.activate.sql")).length, 3, "the sample USL adds one branch, for the sample row");
});

test("the onboarded sources hold the scenario's real warehouse and carrier records, reshaped", () => {
  const byRef = new Map(scenario.records.map((record) => [record.provenance.recordRef, record]));
  const [header, row] = read("sources", "wms_handover", "handover-2026-10-11.csv").trim().split("\n");
  const columns = header!.split(",");
  const cells = row!.match(/("[^"]*"|[^,]+)/g)!.map((cell) => cell.replace(/^"|"$/g, ""));
  const wms = Object.fromEntries(columns.map((name, index) => [name, cells[index]]));
  assert.equal(byRef.get(wms.handover_id!)?.id, "EV-WMS-002");
  assert.equal(wms.remarks, byRef.get(wms.handover_id!)!.content);
  assert.equal(wms.scanned_at_utc, byRef.get(wms.handover_id!)!.observedAt.replace(".000", ""));
  const carrier = fs.readdirSync(path.join(USL_DIR, "sources", "carrier_tracking")).map((file) => JSON.parse(read("sources", "carrier_tracking", file)) as Record<string, string | null>);
  assert.deepEqual(carrier.map((event) => byRef.get(event.event_id!)?.id).sort(), ["EV-CAR-003", "EV-CAR-005"]);
  for (const event of carrier) assert.equal(event.description, byRef.get(event.event_id!)!.content);
  // The carrier's own correction link is the scenario's supersession.
  const review = carrier.find((event) => event.amends_event_id)!;
  assert.deepEqual(byRef.get(review.event_id!)!.provenance.supersedes, [byRef.get(review.amends_event_id!)!.id]);
});

test("the data-quality sample is labelled as sample data and kept apart from the sources", () => {
  for (const file of fs.readdirSync(path.join(USL_DIR, "dq-sample", "carrier_tracking_dq_sample"))) {
    const row = JSON.parse(read("dq-sample", "carrier_tracking_dq_sample", file)) as Record<string, string>;
    assert.match(row.description!, /^SAMPLE DATA/);
    assert.equal(row.event_id, "");
  }
  assert.doesNotMatch(read("delivery_evidence.activate.sql"), /DQ_SAMPLE/);
});

test("the USL work never touches the live evidence database", () => {
  // Code only: the script's comments name EVIDENCE_DESK to say it is left alone.
  const script = fs.readFileSync(path.join(ROOT_DIR, "src", "scripts", "zetaris-usl.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const text of [script, read("delivery_evidence.activate.sql"), read("delivery_evidence.dq-sample.activate.sql")]) {
    assert.doesNotMatch(text, /EVIDENCE_DESK\.(order_events|warehouse_scans|carrier_events|support_messages)/);
    assert.doesNotMatch(text, /\bEVIDENCE_DESK\b(?!_)/);
  }
});
