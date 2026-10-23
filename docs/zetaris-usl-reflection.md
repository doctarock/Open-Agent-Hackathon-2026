# Zetaris Unified Semantic Layer: what was built, time saved, and how Zetaris could improve

This covers the hackathon's Zetaris requirements. Everything was run against the local Zetaris
platform, version `2.4.3-v2.4.3.1-hackathon`, in Docker at `http://localhost:3000`, on
2026-10-23. The USL's details are in [`zetaris/usl/README.md`](../zetaris/usl/README.md).
`npm run zetaris:usl` reproduces every step and writes each statement with its real output to
`eval/results/zetaris-usl.md`.

**The short version:** Evidence Desk's live investigation reads its evidence from a Zetaris USL.
- One query to `lightning.metastore.evidence_desk.evidence_usl.case_evidence` returns the case's
  records from four source systems, each onboarded in its own native shape, mapped into the one
  evidence model the investigation reasons over.
- The USL resolves each record's case through a dispute register, derives its structured facts
  from native fields, and carries the carrier's correction as a supersession.
- It is the default live path, in the standalone server and inside Speck.

## What was built

### 1. Identifying the data sources

What the deployment held before this work:
- **Three Lightning databases** (`SHOW LIGHTNING DATABASES`):
  - `EVIDENCE_DESK`: four per-source tables seeded from this repository's fixture, already
    flattened by Evidence Desk's own code into one shared schema;
  - `NY_TAXI` and `TPCDS_DB`: the platform's sample data.
- **No registered external data sources** (`SHOW DATASOURCES`).
- **No USL** (`SHOW NAMESPACES OR TABLES IN lightning.metastore`).

**The business case** is the disputed delivery of order `ORD-1042`, parcel `PCL-88412`, case
`DISPUTE-1042`. Its evidence comes from four logically distinct systems:
- the order system (what was ordered and where it was to go);
- the warehouse (the handover to the carrier);
- the carrier (a "delivered" scan, then a proof-of-delivery review that amends it);
- customer support (the customer's complaint, then a neighbour holding the parcel).

A **dispute register** links the case to the order and parcel numbers those systems use.

### 2. Onboarding them

All are **sample data**. They hold the scenario's real records, reshaped into a native format
for each system, with the content text verbatim and no invented records
(`test/zetaris-usl.test.ts`). They live in their own Lightning database,
`EVIDENCE_DESK_SOURCES`.

| Source | Onboarded as | Records | Verification query |
|---|---|---|---|
| Order system export (JSON) | `EVIDENCE_DESK_SOURCES.oms_orders`, `CREATE LIGHTNING FILESTORE TABLE … FORMAT json OPTIONS (path "file://…")` | 1 | `SELECT count(*) FROM EVIDENCE_DESK_SOURCES.oms_orders` → 1 |
| Warehouse handover export (CSV) | `EVIDENCE_DESK_SOURCES.wms_handover`, `… FORMAT csv OPTIONS (…, header "true")` | 1 | `… wms_handover` → 1 |
| Carrier tracking feed (JSON) | `EVIDENCE_DESK_SOURCES.carrier_tracking`, `… FORMAT json …` | 2 | `… carrier_tracking` → 2 |
| Support contacts (CSV) | `EVIDENCE_DESK_SOURCES.support_contacts`, `… FORMAT csv OPTIONS (…, header "true", escape "\"")` | 2 | `… support_contacts` → 2 |
| Dispute register (CSV) | `EVIDENCE_DESK_SOURCES.dispute_register`, `… FORMAT csv …` | 1 | `… dispute_register` → 1 |

The files are copied into the driver container's data folder (`docker cp`) and registered with
`CREATE LIGHTNING DATABASE` and `CREATE LIGHTNING FILESTORE TABLE`. That's the same file
onboarding the existing `npm run zetaris:seed` uses. The field lists are in
[`zetaris/usl/README.md`](../zetaris/usl/README.md).

### 3. Querying the sources

```sql
SELECT order_no, ship_to, placed_at FROM EVIDENCE_DESK_SOURCES.oms_orders
-- ORD-1042 | 41 Lydiard St South, Ballarat VIC 3350 | 2026-10-10T02:14:00Z

SELECT event_id, tracking_no, status, event_time, amends_event_id
FROM EVIDENCE_DESK_SOURCES.carrier_tracking WHERE tracking_no = 'PCL-88412'
-- tracking/PCL-88412/events/7     | PCL-88412 | DELIVERED                   | 2026-10-13T03:02:00Z | null
-- tracking/PCL-88412/pod-review/1 | PCL-88412 | DELIVERED_INCORRECT_ADDRESS | 2026-10-15T05:20:00Z | tracking/PCL-88412/events/7

SELECT contact_id, category, location_reported FROM EVIDENCE_DESK_SOURCES.support_contacts
-- tickets/T-55190/messages/1 | NON_RECEIPT         | null
-- calls/C-90233              | THIRD_PARTY_HOLDING | 41 Lydiard St North (held by resident)
```

### 4. Creating the Unified Semantic Layer

How to do this on this deployment was established from the deployment itself; no syntax was
assumed:
- **The engine has a USL.** The driver's jars contain `com.zetaris.lightning.datasources.v2.usl`
  and the Lightning catalogue grammar (`CompileUSL`, `ActivateUSLTable`, `RegisterDQ`, `RunDQ`,
  `ShowDQResult`, and others).
- **The statement forms came from the web interface.** Its own code, including its built-in USL
  tutorial, gives them. It sends them through `POST /api/proxy/sql-editor/sqls/run-query`.

```sql
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk
COMPILE USL IF NOT EXISTS evidence_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL
  CREATE TABLE case_evidence (id string NOT NULL, case_id string NOT NULL, source_system string NOT NULL, …,
    CONSTRAINT pk_case_evidence PRIMARY KEY (id));
ACTIVATE USL TABLE lightning.metastore.evidence_desk.evidence_usl.case_evidence AS
  SELECT … FROM EVIDENCE_DESK_SOURCES.oms_orders o JOIN EVIDENCE_DESK_SOURCES.dispute_register d ON o.order_no = d.order_no
  UNION ALL SELECT … wms_handover … ON w.parcel_no = d.parcel_no
  UNION ALL SELECT … carrier_tracking … ON c.tracking_no = d.parcel_no
  UNION ALL SELECT … support_contacts … ON s.linked_order_no = d.order_no
```

**The semantic mapping** (field by field in [`zetaris/usl/README.md`](../zetaris/usl/README.md)):
- **The case** is resolved through the dispute register: by order number for orders and
  support, and by parcel number for the warehouse and carrier.
- **Structured facts are derived from native fields:**
  - a warehouse `HANDED_TO_CARRIER` code becomes `warehouse.handover=true`;
  - a carrier `DELIVERED_INCORRECT_ADDRESS` status becomes `delivery.address_match=false`, plus
    the GPS distance and the actual address;
  - a support category becomes `customer.reports_non_receipt` or `parcel.held_by_third_party`
    and `parcel.location`.

  Absent values are left out, never guessed.
- **Supersession:** the carrier's own `amends_event_id` becomes the record's supersession link.
- **Provenance is preserved:** each row keeps the source's own record reference (`record_ref`),
  its source table (`source_table`), and the list of its derived values (`inferred_fields`).
- **Ids are short and derived:** a source prefix plus 6 hex characters of the SHA-256 of the
  source reference, for example `CAR-59F14C`. Longer, source-shaped ids were tried first; in live
  runs the local 4B model mangled them, and its judgments were discarded (see *How it was
  verified*).

A second, smaller USL, `delivery_usl.delivery_evidence`, maps just the warehouse and carrier
events into shared shipment, order and event-type concepts. Missing values stay NULL there, and
derived values are named.

### 5. Querying the USL, and Evidence Desk reading it

Evidence Desk's live mode runs, through its existing adapter and Zetaris's SELECT route:

```sql
SELECT id, case_id, source_system, source_name, observed_at, content, facts_json, record_ref, system_of_record, author, supersedes
FROM lightning.metastore.evidence_desk.evidence_usl.case_evidence WHERE case_id = 'DISPUTE-1042'
```

| id | source_system | observed_at | facts_json | supersedes |
|---|---|---|---|---|
| OMS-597434 | oms | 2026-10-10T02:14:00Z | `{"order.id":"ORD-1042","order.ship_to":"41 Lydiard St South, Ballarat VIC 3350"}` | |
| WMS-385E8C | wms | 2026-10-11T23:40:00Z | `{"parcel.id":"PCL-88412","warehouse.handover":"true"}` | |
| CAR-59F14C | carrier | 2026-10-13T03:02:00Z | `{"carrier.status":"delivered","carrier.driver":"D-219"}` | |
| SUP-585332 | support | 2026-10-13T22:30:00Z | `{"customer.reports_non_receipt":"true"}` | |
| CAR-E8C127 | carrier | 2026-10-15T05:20:00Z | `{"delivery.address_match":"false","delivery.gps_distance_m":"380","delivery.actual_address":"41 Lydiard St North, Ballarat VIC 3350"}` | CAR-59F14C |
| SUP-6B84C3 | support | 2026-10-15T23:05:00Z | `{"parcel.held_by_third_party":"true","parcel.location":"41 Lydiard St North (held by resident)"}` | |

**Verified** (by `npm run zetaris:usl`, on every run):
- **Record for record.** The 6 USL records equal the 6 read from the per-source tables through
  the same adapter, matched by source reference: content, time, facts, provenance and
  supersession.
- **The investigation is identical.** Run, update, run, with the rule assessor, gives identical
  beliefs from the USL and from the tables: leading H-DELIVERED, then supported H-MISDELIVERED,
  with the carrier's original scan no longer counting.

**Where it is used:**
- **Default live path.** `config/zetaris-usl-queries.json`, used whenever `EVIDENCE_MODE=zetaris`
  in the standalone server and in the Speck plugin. The per-source tables remain available with
  `ZETARIS_QUERY_CONFIG=config/zetaris-queries.json`.
- **In the page:**
  - The header reads **Evidence: Zetaris USL (live)**, and every record is badged **Zetaris USL**.
  - The guided tour says which USL table is queried and what the layer does.
  - The Guide lists "Zetaris Unified Semantic Layer" as demonstrated once records have arrived
    through it.
  - The execution trace shows the one USL SELECT with its row count and query token.

### 6. The data-quality rule

The rule is a non-empty evidence record id:

```sql
REGISTER DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.evidence_usl.case_evidence
  AS id IS NOT NULL AND length(trim(id)) > 0
RUN DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.evidence_usl.case_evidence
SHOW DQ INVALID RECORD `evidence_id_present` TABLE …
```

| Run against | Checked | Passed | Failed |
|---|---|---|---|
| The evidence USL (what the investigation reads) | 6 | 6 | 0 |
| The delivery USL | 3 | 3 | 0 |
| An isolated sample USL: the delivery sources plus one labelled sample row with an empty carrier event id | 4 | 3 | 1 |

`SHOW DQ INVALID RECORD` returns the failing sample row in full. Nothing is discarded, and no
production evidence was changed. The sample lives in its own database (`EVIDENCE_DESK_DQ_SAMPLE`)
and its own USL namespace. Zetaris also registered a primary-key rule automatically, from each
DDL's `PRIMARY KEY`.

## Time saved

**Measured: query time.** Each test was run 10 times, alternating, after one warm-up, against
the same platform.

| Task | Before | After |
|---|---|---|
| Fetch the case's evidence through Evidence Desk's adapter | 4 per-source SELECTs: median 268 ms (249–294) | 1 USL SELECT: median 412 ms (394–447) |
| Warehouse and carrier events in one shape | 2 source queries plus client-side mapping: median 149 ms (141–164) | 1 delivery-USL query: median 196 ms (188–242) |

The USL is **slower at query time** on this data, because it performs the joins and derivations
when queried. No runtime saving is claimed.

**Counted: work no longer done in application code.** Before the USL, Evidence Desk's own code
did the semantic mapping:
- `src/scripts/zetaris-seed.ts` flattened every source into one hand-made column set before it
  reached Zetaris;
- each source table needed its own query in the adapter.

With the USL:
- **One query, any consumer.** The case resolution, fact derivation, supersession and id rules
  live in one activation query (`zetaris/usl/case_evidence.activate.sql`, 4 branches ×
  13 columns), and the adapter issues one SELECT.
- **Sources keep their native shape.** Adding a source means adding a branch to the mapping, not
  changing every consumer.
- **The contract is enforced.** Activation refused a mapping that could yield NULL for a NOT
  NULL column.
- **The quality rule is defined once,** on the layer.

**Estimated, not measured: human time.**

*Assumptions:*
- a per-source mapping into the evidence model takes 30–60 minutes to write and test, for a
  developer who knows the source;
- it would be needed by each of two investigation workflows;
- a source changes about once a quarter.

*Estimate:* for four sources and two workflows, roughly 4–8 hours of initial mapping work
avoided (4 sources × 2 workflows × 30–60 minutes), plus 30–60 minutes per source change.

No before-and-after measurement of human effort was made. This is an estimate under those
assumptions.

## How this could help my work

- **Local-first agents get consistent evidence.** Evidence Desk's reasoning wants one evidence
  shape: id, source, time, content, facts and supersession. The USL now delivers exactly that
  from four systems, and the agent never learns any system's schema. Everything runs locally:
  Zetaris, Nemotron and Speck on one machine.
- **Data access can be reused across workflows.** The disputed-delivery case, a payment reversal
  and a procurement dispute (the cross-domain suite) all need "evidence about entity X, with
  corrections". One semantic model per domain, queried by any workflow, beats per-workflow
  adapters.
- **Provenance and quality checks happen before reasoning.**
  - Every row keeps its source reference and says which values were derived.
  - The data-quality rule runs on the layer, so a record with no id is caught before it reaches
    the reasoning layer.
  - The correction link arrives as data, which is exactly what Evidence Desk's belief revision
    needs.
- **Not yet shown:** a genuinely external system behind the layer. The sources here are
  file-store tables of sample data.

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
     data-quality rule, while keeping the table activated and the primary-key rule. Reproduced:
     `LIST DQ USL` showed 2 rules before the recompile and 1 after.
   - *Suggestion:* "if not exists" should leave an existing USL untouched, or warn that its rules
     will be reset.
3. **Make rule names consistent.**
   - *What happened:* `` REGISTER DQ `evidence_id_present` `` stored the backticks as part of the
     name, so `RUN DQ evidence_id_present` failed ("not found") and only the backticked form
     worked. The automatic primary-key rule is listed as `evidence_id`, but `RUN DQ evidence_id`
     cannot find it.
   - *Suggestion:* strip identifier quoting when storing names, and make every listed rule
     runnable by its listed name.
4. **Give file sources an onboarding path.**
   - *What happened:* registering a file source needed the files inside the driver container
     (`docker cp`) and a `file://` path. I did not find an upload route for a file-store table
     in this deployment's documentation.
   - *Suggestion:* an upload endpoint, or a mounted `customer-data` folder on the host.
5. **Report file-store schema and parsing choices.**
   - *Types and order:* the CSV sources came back with every column as `string`, and the JSON
     sources' columns were reordered alphabetically.
   - *Quoting:* a CSV with standard doubled quotes (`""`) needed `escape "\""`; the default
     escape character is a backslash.
   - *NDJSON:* the existing seed found the JSON file store reads only the first object of a
     newline-delimited file (observed 2026-10-22; this build used one object per file and did not
     re-test it).
   - *Suggestion:* document the CSV and JSON options and the NDJSON behaviour, or report the
     inferred schema when the table is created.
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
- **Rich mapping SQL.** Joins, `map_filter`, `to_json`, `sha2` and `date_format` all work inside
  an activation query, so the whole semantic mapping lives in the layer.
- **Data-quality results are useful.** `RUN DQ` gives total, valid and invalid counts, and
  `SHOW DQ VALID|INVALID RECORD` gives the actual records.
- **A key gives a rule for free.** A primary key in the USL DDL becomes a data-quality rule
  automatically.
- **The USL reads like any table.** It is queryable through the ordinary SELECT route, with a
  query token, so Evidence Desk's existing adapter needed only a config switch to read it.

## How it was verified (2026-10-23)

| Check | Result |
|---|---|
| `npm run zetaris:usl` | Exit 0: 5 sources (1, 1, 2, 2, 1 records); evidence USL 6 records, identical record for record to the per-source tables; investigation (rule assessor) identical from either source; DQ 6/6 on the evidence USL, 3/3 on the delivery USL, 3 of 4 on the isolated sample |
| `npm run zetaris:check` | `lightning.metastore.evidence_desk.evidence_usl.case_evidence: 6 record(s) for DISPUTE-1042` |
| `npm run sponsors:verify` | Exit 0: Zetaris (1 SELECT per run on the USL table, every assessed record carrying that run's query token), Meterless, Nemotron and Speck all observed |
| Live journeys, local Nemotron, 3 each way | 0 judgments discarded through the USL and through the tables alike; one model-errored second run on each side, with its records left pending and retried |
| Live journeys with the earlier, longer USL ids | 3, then 12–14, judgments discarded per journey: the reason for the short ids |
| In-Speck browser journey (headless Chrome, live USL and Nemotron) | 29/29 checks: header "Evidence: Zetaris USL (live)", every record badged "Zetaris USL", tour explains the USL query, Guide marks the USL demonstrated; no console errors |
| `npm test` | 86/86, including the USL path, an unbuilt-USL hint, record ids containing "/", and the USL files |
| `npm run eval`, `npm run eval:cross-domain` | Unchanged; they use fixture evidence |

Using the USL exposed a latent Evidence Desk bug, now fixed: ids were read back from Speck after
the last "/", which broke any id containing one (`test/record-ids.test.ts`).

## Requirement checklist

| Requirement | Evidence |
|---|---|
| 1. Identify data sources | *Identifying the data sources*: the deployment's inventory, and the four systems plus the dispute register for the delivery case |
| 2. Onboard data sources | Five Lightning file-store tables in `EVIDENCE_DESK_SOURCES`, in JSON and CSV, via `CREATE LIGHTNING FILESTORE TABLE`; `npm run zetaris:usl` |
| 3. Query those sources | *Querying the sources*, with real output and counts |
| 4. Create a Unified Semantic Layer | `evidence_usl.case_evidence` (four sources and the register mapped into the evidence model) and `delivery_usl.delivery_evidence`, compiled and activated in `lightning.metastore.evidence_desk`; SQL in `zetaris/usl/` |
| 5. Query the USL | Evidence Desk's live investigation queries `case_evidence` on every run; checked identical to the per-source tables, record by record and belief by belief |
| 6. A basic data-quality rule | `evidence_id_present`: 6/6 pass on the evidence USL; 1 of 4 fails on the isolated sample, with the failing record shown |
| 7. Time saved, applicability, suggestions | *Time saved* (measured latency, counted mapping work, labelled estimate); *How this could help my work*; *How Zetaris could improve* |
