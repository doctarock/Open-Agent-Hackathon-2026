# Zetaris Unified Semantic Layer: what was built, time saved, and how Zetaris could improve

This covers the hackathon's Zetaris requirements. Everything was run against the local Zetaris
platform, version `2.4.3-v2.4.3.1-hackathon`, in Docker at `http://localhost:3000`, on
2026-10-23. The details of the USL itself are in [`zetaris/usl/README.md`](../zetaris/usl/README.md).
`npm run zetaris:usl` reproduces every step and writes each statement with its real output to
`eval/results/zetaris-usl.md`.

## What was built

### 1. Identifying the data sources

What the deployment held before this work:
- **Three Lightning databases** (`SHOW LIGHTNING DATABASES`):
  - `EVIDENCE_DESK`: Evidence Desk's live evidence, four file-store tables;
  - `NY_TAXI` and `TPCDS_DB`: the platform's sample data.
- **No registered external data sources** (`SHOW DATASOURCES`).
- **No USL** (`SHOW NAMESPACES OR TABLES IN lightning.metastore`).

`EVIDENCE_DESK`'s four tables are seeded from this repository's fixture file. They all already
share one hand-made schema, so a semantic layer over them would demonstrate nothing.

For the business case, the disputed delivery of parcel `PCL-88412`, the two logically distinct
sources are:
- **the warehouse's handover record**, which shows the parcel left the warehouse;
- **the carrier's tracking events**: a "delivered" scan, then a proof-of-delivery review that
  amends it.

### 2. Onboarding them

Both are **sample data**. They hold the scenario's real warehouse and carrier records,
reshaped into a native format for each system, with the content text verbatim and no invented
records (`test/zetaris-usl.test.ts`). They are kept out of the live `EVIDENCE_DESK` database.

| Source | Onboarded as | Fields | Records | Verification query |
|---|---|---|---|---|
| Warehouse handover export (CSV) | `EVIDENCE_DESK_SOURCES.wms_handover`, `CREATE LIGHTNING FILESTORE TABLE … FORMAT csv OPTIONS (path "file://…", header "true")` | 10, all read as `string` | 1 | `SELECT count(*) FROM EVIDENCE_DESK_SOURCES.wms_handover` → 1 |
| Carrier tracking feed (JSON) | `EVIDENCE_DESK_SOURCES.carrier_tracking`, `… FORMAT json …` | 10, types inferred (`gps_distance_m` bigint) | 2 | `SELECT count(*) FROM EVIDENCE_DESK_SOURCES.carrier_tracking` → 2 |

To onboard them, the files were copied into the driver container's data folder (`docker cp`)
and registered with `CREATE LIGHTNING DATABASE` and `CREATE LIGHTNING FILESTORE TABLE`. That is
the same file onboarding the existing `npm run zetaris:seed` uses.

### 3. Querying the sources

```sql
SELECT handover_id, parcel_no, order_no, event_code, scanned_at_utc
FROM EVIDENCE_DESK_SOURCES.wms_handover WHERE parcel_no = 'PCL-88412'
-- scans/dock3/MAN-5521/PCL-88412 | PCL-88412 | ORD-1042 | HANDED_TO_CARRIER | 2026-10-11T23:40:00Z

SELECT event_id, tracking_no, status, event_time, amends_event_id
FROM EVIDENCE_DESK_SOURCES.carrier_tracking WHERE tracking_no = 'PCL-88412'
-- tracking/PCL-88412/events/7     | PCL-88412 | DELIVERED                   | 2026-10-13T03:02:00Z | null
-- tracking/PCL-88412/pod-review/1 | PCL-88412 | DELIVERED_INCORRECT_ADDRESS | 2026-10-15T05:20:00Z | tracking/PCL-88412/events/7
```

### 4. Creating the Unified Semantic Layer

How to do this on this deployment was established from the deployment itself; no syntax was
assumed:
- **The engine has a USL.** The driver's jars contain `com.zetaris.lightning.datasources.v2.usl`
  and the Lightning catalogue grammar, with the rules `CompileUSL`, `ActivateUSLTable`,
  `RegisterDQ`, `RunDQ`, `ShowDQResult` and others.
- **The exact statements came from the web interface.** Its own code, including its built-in
  USL tutorial, gives the statement forms. It sends them through
  `POST /api/proxy/sql-editor/sqls/run-query`.

The statements, in order:

```sql
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk
COMPILE USL IF NOT EXISTS delivery_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL
  CREATE TABLE delivery_evidence (evidence_id string NOT NULL, source_system string NOT NULL, …,
    CONSTRAINT pk_delivery_evidence PRIMARY KEY (evidence_id));
ACTIVATE USL TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence AS
  SELECT … FROM EVIDENCE_DESK_SOURCES.wms_handover UNION ALL SELECT … FROM EVIDENCE_DESK_SOURCES.carrier_tracking
```

**The shared concepts:**
- evidence record id;
- source system and the source's own record reference;
- shipment id;
- order id;
- event type, plus the source's own event code;
- observation time (UTC);
- content;
- the supersession link (the carrier's `amends_event_id`).

The full field mapping and its transformations are in
[`zetaris/usl/README.md`](../zetaris/usl/README.md). **Missing and derived values are told
apart:**
- the carrier feed has no order number, so `order_id` is NULL there, never guessed;
- every value the mapping computed is named in that row's `inferred_fields`.

### 5. Querying the USL

```sql
SELECT evidence_id, source_system, shipment_id, order_id, event_type, observed_at, supersedes_ref
FROM lightning.metastore.evidence_desk.delivery_usl.delivery_evidence
WHERE shipment_id = 'PCL-88412' ORDER BY observed_at
```

| evidence_id | source_system | shipment_id | order_id | event_type | observed_at | supersedes_ref |
|---|---|---|---|---|---|---|
| wms:scans/dock3/MAN-5521/PCL-88412 | wms | PCL-88412 | ORD-1042 | warehouse_handover | 2026-10-11 23:40:00 | null |
| carrier:tracking/PCL-88412/events/7 | carrier | PCL-88412 | null | carrier_delivered | 2026-10-13 03:02:00 | null |
| carrier:tracking/PCL-88412/pod-review/1 | carrier | PCL-88412 | null | carrier_delivery_amended | 2026-10-15 05:20:00 | carrier:tracking/PCL-88412/events/7 |

**Verified:**
- The USL's rows equal the union of the two source queries.
- All 3 of the scenario's warehouse and carrier records are present (`EV-WMS-002`,
  `EV-CAR-003`, `EV-CAR-005`, matched by record reference).
- The carrier's correction is carried as `supersedes_ref`.

### 6. The data-quality rule

The rule is a non-empty evidence record id:

```sql
REGISTER DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence
  AS evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0
RUN DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence
SHOW DQ INVALID RECORD `evidence_id_present` TABLE …
```

| Run against | Checked | Passed | Failed |
|---|---|---|---|
| The USL (real records) | 3 | 3 | 0 |
| An isolated sample USL: the same sources plus one labelled sample row with an empty carrier event id | 4 | 3 | 1 |

`SHOW DQ INVALID RECORD` returns the failing sample row in full. Nothing is discarded, and no
production evidence was changed. The sample lives in its own database (`EVIDENCE_DESK_DQ_SAMPLE`)
and its own USL namespace.

Zetaris also registered a primary-key rule on its own, from the DDL's `PRIMARY KEY`.

### Integration with Evidence Desk

Evidence Desk's existing Zetaris adapter (`ZetarisEvidenceProvider.select`) reads the USL
through the SELECT route its live mode already uses. Unchanged, it returned the same 3 rows,
with a Zetaris query token. `npm run zetaris:usl` runs this as a separate integration check.

**Evidence Desk's live path does not read the USL yet.** It still reads `EVIDENCE_DESK`, for
two reasons:
- **Facts:** its assessor needs each record's structured facts (`facts_json`), and the USL does
  not model them yet.
- **Coverage:** it also needs the order and support sources, which were not onboarded here.

Switching over would change the live demo's evidence path, so that was left for later rather
than half-done.

## Time saved

**Measured: query time.** The repeatable task is retrieving the shipment's evidence from both
sources in one consistent shape. Each way was run 10 times, alternating, after one warm-up,
against the same platform. Both returned the same 3 records.

| | Median | Range |
|---|---|---|
| Before: two source-specific queries, then the per-source mapping applied in the client | 149 ms | 141–164 ms |
| After: one USL query | 196 ms | 188–242 ms |

At runtime the USL was **slower** by about 47 ms on this data. The saving is not query time,
and none is claimed.

**Counted: work a consumer no longer repeats.** Without the USL, every consumer of this
evidence repeats the following for each source, and keeps it in step when a source changes:
- a source-specific query;
- the field mapping: renaming, typing timestamps, translating event codes, building ids, and
  turning the carrier's amendment link into a supersession.

With the USL:
- **One query in the consumer.** That mapping now lives in one activation query
  (`zetaris/usl/delivery_evidence.activate.sql`, 2 branches × 11 columns).
- **The table's contract is enforced.** Activation refused a mapping that could yield NULL for
  a NOT NULL column.
- **The quality rule is defined once,** on the layer, rather than in each consumer.

In this repository, the same kind of mapping is currently written twice in code:
- `src/scripts/zetaris-seed.ts` flattens each record into the shared column set;
- `ZetarisEvidenceProvider.toRecord` turns rows back into evidence.

A USL-backed path would remove the first entirely.

**Estimated, not measured: human time.**

*Assumptions:*
- a per-source mapping takes 30–60 minutes to write and test for a developer who knows both
  schemas;
- it is reused by two investigation workflows;
- a source changes about once a quarter.

*Estimate:* for two sources and two workflows, roughly 2–4 hours of initial mapping work avoided
(2 sources × 2 workflows × 30–60 minutes), plus 30–60 minutes per source change.

No before-and-after measurement of human effort was made. This is an estimate under those
assumptions.

## How this could help my work

- **Local-first agents get consistent evidence.**
  - Evidence Desk's reasoning layer wants one evidence shape: id, source, time, content and
    supersession. A USL gives agents exactly that from several systems, without each agent
    learning each system's schema.
  - Because the layer runs on the local platform, it fits a local-first setup: local Zetaris,
    local Nemotron, Speck on the same machine.
- **Data access can be reused across workflows.** The disputed-delivery case, a payment
  reversal and a procurement dispute (the cross-domain suite) all need "evidence about entity X,
  with corrections". One semantic model per domain, queried by any workflow, beats per-workflow
  adapters.
- **Provenance and quality checks happen before reasoning.**
  - Every row keeps its source reference and says which fields were derived.
  - The data-quality rule runs on the layer, so a record with no id can be caught before it
    reaches the reasoning layer, rather than surfacing as a confusing citation later.
  - The supersession link arrives as data, which is exactly what Evidence Desk's revision needs.
- **Not yet shown:** a real external system behind the layer, or Evidence Desk's live path
  reading from it.

## How Zetaris could improve

These are the obstacles actually hit during this build, most impactful first.

1. **Document the USL and data-quality statements in the local bundle.**
   - *What happened:* the platform README covers install, sample data and JDBC, but not USL or
     data quality. The syntax had to be recovered from the driver's parser and the web
     interface's JavaScript, the built-in tour included.
   - *Suggestion:* a SQL reference page in the bundle for `COMPILE USL`, `ACTIVATE USL TABLE`
     and `REGISTER/RUN/LIST/SHOW DQ`, with one end-to-end example.
2. **Don't drop rules silently on recompile.**
   - *What happened:* `COMPILE USL IF NOT EXISTS` on an existing USL removed its custom
     data-quality rule, while keeping the table activated and the primary-key rule. This was
     reproduced: `LIST DQ USL` showed 2 rules before the recompile and 1 after.
   - *Suggestion:* "if not exists" should leave an existing USL untouched, or warn that its rules
     will be reset.
3. **Make rule names consistent.**
   - *What happened:* registering `` REGISTER DQ `evidence_id_present` `` stored the backticks as
     part of the name. `RUN DQ evidence_id_present` then failed ("not found"); only
     `` RUN DQ `evidence_id_present` `` worked. Likewise, the automatic primary-key rule is listed
     as `evidence_id` but `RUN DQ evidence_id` cannot find it.
   - *Suggestion:* strip identifier quoting when storing names, and make every listed rule
     runnable by its listed name.
4. **Give file sources an onboarding path.**
   - *What happened:* registering a file source needed the files inside the driver container
     (`docker cp`) and a `file://` path. I did not find an upload route for a file-store table
     in this deployment's documentation.
   - *Suggestion:* an upload endpoint, or a mounted `customer-data` folder on the host.
5. **Report file-store schema choices.**
   - *What happened:* the CSV source came back with every column as `string`. The JSON source's
     columns were reordered alphabetically. The existing seed found the JSON file store reads
     only the first object of a newline-delimited file (observed 2026-10-22; this build used one
     object per file and did not re-test it).
   - *Suggestion:* document the schema options and NDJSON behaviour, or report the inferred
     schema when the table is created.
6. **Shorter, clearer errors.**
   - *What happened:* a statement in the wrong word order returned a parser message followed by
     a full Java stack trace. A database description containing a colon was rejected only at
     execution time.
   - *Suggestion:* return the parser message alone, and validate descriptions in the interface.
7. **Explain which route accepts what.** `query/sql/start` accepts SELECT only; DDL and USL
   statements need `sql-editor/sqls/run-query`. Both work, but nothing says which is for what.

**What worked well, worth keeping:**
- **Activation checks the contract.** It checks the mapping against the USL's declared
  nullability, then says exactly which column is wrong and suggests a fix (`COALESCE`).
- **Data-quality results are useful.** `RUN DQ` gives total, valid and invalid counts, and
  `SHOW DQ VALID|INVALID RECORD` gives the actual records.
- **A key gives a rule for free.** A primary key in the USL DDL becomes a data-quality rule
  automatically.
- **The USL reads like any table.** It is queryable through the ordinary SELECT route, with a
  query token, so existing clients read it unchanged.
- **Statements are fast.** Each ran in well under a second on this laptop.

## How it was verified (2026-10-23)

| Command | Result |
|---|---|
| `npm run zetaris:usl` | Exit 0. Sources 1 and 2 records; USL 3 rows, equal to the source queries; 3/3 scenario records; correction link preserved; DQ 3/3 pass on the USL and 3 of 4 on the isolated sample (1 failure shown); adapter read the same 3 rows with a query token |
| `npm test` | 76/76 (4 new, in `test/zetaris-usl.test.ts`) |
| `npm run eval` | Held-out and regression results unchanged: 8/8, 8/8, 5/8 and 8/8, 8/8, 6/8 |
| `npm run eval:cross-domain` | Unchanged: lock verified; 15/27, 15/27, 17/27 |
| `npm run zetaris:check` | The original live path: 6 records for DISPUTE-1042 from `EVIDENCE_DESK` |
| `npm run sponsors:verify` | Exit 0: Zetaris, Meterless, Nemotron and Speck observed in a live run |
| In-Speck demo (`npm run speck`, scratch database) | Opens on the Evidence tab; bank return ends *supported*, H-UNPAID at 0.66 |

## Requirement checklist

| Requirement | Evidence |
|---|---|
| 1. Identify data sources | *Identifying the data sources* above: the deployment's inventory, and the two sources chosen for the delivery case |
| 2. Onboard data sources | `EVIDENCE_DESK_SOURCES.wms_handover` (CSV) and `.carrier_tracking` (JSON), via `CREATE LIGHTNING FILESTORE TABLE`; `npm run zetaris:usl` steps 1–2 |
| 3. Query those sources | The source queries in *Querying the sources*, with their real output; counts 1 and 2 |
| 4. Create a Unified Semantic Layer | `delivery_usl` compiled into `lightning.metastore.evidence_desk`, and `delivery_evidence` activated over both sources; mapping in `zetaris/usl/` |
| 5. Query the USL | *Querying the USL*: 3 rows, checked equal to the source queries and to the scenario's records |
| 6. A basic data-quality rule | `evidence_id_present`: 3/3 pass on the USL; 1 of 4 fails on the isolated sample, with the failing record shown |
| 7. Time saved, applicability, suggestions | *Time saved* (measured latency, counted mapping work, labelled estimate); *How this could help my work*; *How Zetaris could improve* |
