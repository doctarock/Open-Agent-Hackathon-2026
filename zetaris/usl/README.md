# Zetaris Unified Semantic Layer: the evidence Evidence Desk reads

Evidence Desk's live investigation reads its evidence from a Zetaris Unified Semantic Layer
(USL). The USL maps four source systems, each in its own native shape, into the one evidence
model the investigation consumes. Evidence Desk then reads it with a single query:

```sql
SELECT id, case_id, source_system, source_name, observed_at, content, facts_json,
       record_ref, system_of_record, author, supersedes
FROM lightning.metastore.evidence_desk.evidence_usl.case_evidence
WHERE case_id = 'DISPUTE-1042'
```

This is the default live path: `config/zetaris-usl-queries.json`, used whenever
`EVIDENCE_MODE=zetaris`. Both the standalone server and the Speck plugin read it.

**Build and check:** `npm run zetaris:usl`. It needs the platform running and
`ZETARIS_USERNAME` and `ZETARIS_PASSWORD` in `.env`. It writes `eval/results/zetaris-usl.md`
(git-ignored), with every statement and its real output. The per-source tables built by
`npm run zetaris:seed` remain available with `ZETARIS_QUERY_CONFIG=config/zetaris-queries.json`.
They are also the reference the USL is checked against.

## Sources

**These are sample data**, not live external systems.
- Each source holds the disputed-delivery scenario's real records, from
  `fixtures/scenarios/disputed-delivery/evidence.json`.
- Each is reshaped into a format that system might plausibly export.
- No record was invented, and the content text is verbatim. `test/zetaris-usl.test.ts` checks
  this.

All are Lightning file-store tables in the database `EVIDENCE_DESK_SOURCES`.

| Source | Format | Native fields | Records |
|---|---|---|---|
| Order system export `oms_orders` | JSON | order_ref, order_no, customer_id, placed_at, items, ship_to, total_aud, channel, summary | 1 |
| Warehouse handover export `wms_handover` | CSV | handover_id, order_no, parcel_no, event_code, scanned_at_utc, dock, manifest_no, weight_kg, scanner_id, remarks | 1 |
| Carrier tracking feed `carrier_tracking` | JSON | event_id, tracking_no, status, event_time, driver_id, gps_distance_m, delivered_address, amends_event_id, recorded_by, description | 2 |
| Support contacts `support_contacts` | CSV (`escape "\""` for its quoted messages) | contact_id, linked_order_no, received_at_utc, channel, from_party, category, location_reported, message | 2 |
| Dispute register `dispute_register` | CSV | case_id, order_no, parcel_no, opened_at_utc, opened_by | 1 |
| Data-quality sample (isolated, **labelled SAMPLE DATA**) `EVIDENCE_DESK_DQ_SAMPLE.carrier_tracking_dq_sample` | JSON | as the carrier feed; one event with an empty event id | 1 |

**How they were onboarded.**
1. The files are copied into the driver's data folder, as `npm run zetaris:seed` does.
2. They are registered with `CREATE LIGHTNING DATABASE` and
   `CREATE LIGHTNING FILESTORE TABLE … FORMAT csv|json OPTIONS (path "file://…")`.

JSON tables use one object per file, because the existing seed found that Lightning's JSON file
store reads only the first object of a newline-delimited file.

## The evidence USL: `evidence_usl.case_evidence`

- **DDL:** `evidence_usl.ddl.sql`, compiled with
  `COMPILE USL IF NOT EXISTS evidence_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL …`.
- **Mapping:** `case_evidence.activate.sql`, bound with
  `ACTIVATE USL TABLE lightning.metastore.evidence_desk.evidence_usl.case_evidence AS …`.

The mapping is four `SELECT`s, one per source, combined with `UNION ALL`. Each joins its source
to the dispute register, which resolves the case.

| Evidence model column | How it is filled |
|---|---|
| `id` | **derived**: a source prefix (`OMS`, `WMS`, `CAR`, `SUP`) plus the first 6 hex characters of the SHA-256 of the source's own record reference, for example `CAR-59F14C`. It is stable as records arrive. It is kept short because the local reasoning model must echo ids exactly: longer source-shaped ids were mangled in live runs, and the judgments were discarded. |
| `case_id` | **derived** by joining the dispute register: order system and support on `order_no`, warehouse and carrier on `parcel_no` |
| `source_system`, `source_name`, `system_of_record` | **derived**, one constant per source |
| `observed_at` | read and normalised to ISO UTC (`placed_at`, `scanned_at_utc`, `event_time`, `received_at_utc`) |
| `content` | read as-is (`summary`, `remarks`, `description`, `message`) |
| `facts_json` | **derived** from native fields, for example `event_code = 'HANDED_TO_CARRIER'` → `warehouse.handover=true`; `status = 'DELIVERED_INCORRECT_ADDRESS'` → `delivery.address_match=false` plus the GPS distance and actual address; support `category` → `customer.reports_non_receipt` or `parcel.held_by_third_party` and `parcel.location`. Absent values are left out, never guessed. |
| `record_ref` | read as-is: the source's own reference, for tracing a record back |
| `author` | read as-is (`channel`, `scanner_id`, `recorded_by`, `from_party`) |
| `supersedes` | **derived** from the carrier's own `amends_event_id`, by the same id rule |
| `source_table`, `inferred_fields` | which source table the row came from, and which of its values were derived |

**Checked by `npm run zetaris:usl`:**
- **Record for record.** The 6 USL records equal the 6 records read from the per-source tables
  through Evidence Desk's adapter, matched by source reference: same content, time, facts,
  provenance and supersession.
- **The investigation itself.** Run, update, run, with the rule assessor, from the USL and from
  the tables. The beliefs are identical at both points: leading H-DELIVERED, then supported
  H-MISDELIVERED, with the carrier's original scan no longer counting.
- **Data quality.** The rule passes 6 of 6 on the evidence USL.

## The delivery USL: `delivery_usl.delivery_evidence`

A second, smaller USL over the warehouse and carrier sources only. It shows the shared delivery
concepts directly: shipment, order, event type, and the correction link as `supersedes_ref`.
Missing values stay NULL, and derived ones are named in `inferred_fields`. Its DDL is
`delivery_usl.ddl.sql`, and its mapping `delivery_evidence.activate.sql`.

## Data-quality rule

`evidence_id_present`: `evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0`, or `id …`
on the evidence USL.

- Registered with `REGISTER DQ \`evidence_id_present\` TABLE … AS …`.
- Run with `RUN DQ \`evidence_id_present\` TABLE …`.
- Failing records are listed with `SHOW DQ INVALID RECORD \`evidence_id_present\` TABLE …`.

| Run against | Checked | Passed | Failed |
|---|---|---|---|
| Evidence USL | 6 | 6 | 0 |
| Delivery USL | 3 | 3 | 0 |
| Isolated sample USL (delivery sources plus one labelled sample row with an empty event id) | 4 | 3 | 1, shown in full |

Bad records are shown, never dropped.
