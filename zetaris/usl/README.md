# Zetaris Unified Semantic Layer: delivery evidence

A Unified Semantic Layer (USL) over two delivery sources, built on the local Zetaris platform
for the disputed-delivery investigation (`DISPUTE-1042`, parcel `PCL-88412`). Run it with
`npm run zetaris:usl` (needs the platform running and `ZETARIS_USERNAME`/`ZETARIS_PASSWORD` in
`.env`). It writes `eval/results/zetaris-usl.md`, which shows every statement and its real
output.

**It does not touch the live evidence path.** Evidence Desk's live mode reads the Lightning
database `EVIDENCE_DESK`. Everything here lives in its own database, `EVIDENCE_DESK_SOURCES`,
and its own USL namespace, `lightning.metastore.evidence_desk`. The failure case is separate
again: `EVIDENCE_DESK_DQ_SAMPLE` and `lightning.metastore.evidence_desk_dq_sample`.

## Sources

**These are sample data**, not live external systems. Each source holds the scenario's real
warehouse and carrier records, from `fixtures/scenarios/disputed-delivery/evidence.json`,
reshaped into a format each system might plausibly export. No record was invented, and the
content text is verbatim. `test/zetaris-usl.test.ts` checks this.

| Source | Origin | Onboarded as | Fields | Records |
|---|---|---|---|---|
| Warehouse handover export | `sources/wms_handover/*.csv`, the warehouse record `EV-WMS-002` | Lightning file-store table `EVIDENCE_DESK_SOURCES.wms_handover`, `FORMAT csv`, `header "true"` | handover_id, order_no, parcel_no, event_code, scanned_at_utc, dock, manifest_no, weight_kg, scanner_id, remarks (all read as `string`) | 1 |
| Carrier tracking feed | `sources/carrier_tracking/*.json`, the carrier records `EV-CAR-003` and `EV-CAR-005` | Lightning file-store table `EVIDENCE_DESK_SOURCES.carrier_tracking`, `FORMAT json` | event_id, tracking_no, status, event_time, driver_id, gps_distance_m (`bigint`), delivered_address, amends_event_id, recorded_by, description | 2 |
| Data-quality sample (isolated) | `dq-sample/carrier_tracking_dq_sample/*.json`, **labelled SAMPLE DATA**: one carrier event with an empty event id | `EVIDENCE_DESK_DQ_SAMPLE.carrier_tracking_dq_sample`, `FORMAT json` | as the carrier feed | 1 |

**How they were onboarded.**
1. The files are copied into the driver's data folder, as `npm run zetaris:seed` does.
2. They are registered with `CREATE LIGHTNING DATABASE` and
   `CREATE LIGHTNING FILESTORE TABLE … FORMAT csv|json OPTIONS (path "file://…")`.

The JSON tables use one object per file. The existing seed found that Lightning's JSON file
store reads only the first object of a newline-delimited file.

## The semantic layer

- **DDL:** `delivery_usl.ddl.sql`, compiled with
  `COMPILE USL IF NOT EXISTS delivery_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL …`.
- **Mapping:** `delivery_evidence.activate.sql`, bound with
  `ACTIVATE USL TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence AS …`.
- **Query it as** `lightning.metastore.evidence_desk.delivery_usl.delivery_evidence`.

| USL column | Warehouse handover | Carrier tracking | How it is filled |
|---|---|---|---|
| `evidence_id` | `'wms:' \|\| handover_id` | `'carrier:' \|\| event_id` | **derived**; empty string when the native id is empty (the column is declared NOT NULL, and Zetaris requires the mapping to honour it) |
| `source_system` | `'wms'` | `'carrier'` | **derived** (constant per source) |
| `source_record_ref` | `handover_id` | `event_id` | read as-is: the source's own record reference |
| `shipment_id` | `parcel_no` | `tracking_no` | read as-is (the same parcel number in both) |
| `order_id` | `order_no` | — | read as-is; **NULL for carrier rows: not in that source**, never guessed |
| `event_type` | `HANDED_TO_CARRIER` → `warehouse_handover` | `DELIVERED` → `carrier_delivered`, `DELIVERED_INCORRECT_ADDRESS` → `carrier_delivery_amended`, else `carrier_other` | **derived** from the code |
| `source_event_code` | `event_code` | `status` | read as-is |
| `observed_at` | `CAST(scanned_at_utc AS timestamp)` | `CAST(event_time AS timestamp)` | read, typed (UTC; the session time zone is GMT) |
| `content` | `remarks` | `description` | read as-is |
| `supersedes_ref` | — (NULL) | `'carrier:' \|\| amends_event_id` | **derived** from the carrier's own amendment link; NULL when there is none |
| `inferred_fields` | `evidence_id,source_system,event_type` | `evidence_id,source_system,event_type,supersedes_ref` | lists each value on the row that was derived rather than read |

**Missing and derived values are told apart.**
- **Missing:** a NULL that is not listed in `inferred_fields` was absent from the source.
- **Derived:** a column listed in `inferred_fields` was computed by the mapping.
- **Source references are kept verbatim** in `source_record_ref`.

## Data-quality rule

`evidence_id_present`: `evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0`.

- Registered with `REGISTER DQ \`evidence_id_present\` TABLE … AS …`.
- Run with `RUN DQ \`evidence_id_present\` TABLE …`.
- Failing records are listed with `SHOW DQ INVALID RECORD \`evidence_id_present\` TABLE …`.

Bad records are shown, never dropped.
