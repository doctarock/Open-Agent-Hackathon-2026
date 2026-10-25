# Zetaris USL run

Generated 2026-10-25T12:17:59.723Z against http://localhost:3000.

## Create Lightning database for the sources

already present, 82 ms

```sql
CREATE LIGHTNING DATABASE EVIDENCE_DESK_SOURCES DESCRIBE BY "SAMPLE DATA - Evidence Desk delivery sources in native formats" OPTIONS ()
```

## Onboard warehouse handover export (CSV)

already present, 43 ms

```sql
CREATE LIGHTNING FILESTORE TABLE wms_handover FROM EVIDENCE_DESK_SOURCES FORMAT csv OPTIONS (path "file:///home/zetaris/customer-data/shared/evidence_desk_usl/wms_handover", header "true")
```

## Onboard carrier tracking feed (JSON)

already present, 38 ms

```sql
CREATE LIGHTNING FILESTORE TABLE carrier_tracking FROM EVIDENCE_DESK_SOURCES FORMAT json OPTIONS (path "file:///home/zetaris/customer-data/shared/evidence_desk_usl/carrier_tracking")
```

## Describe wms_handover

ok, 55 ms

```sql
DESC TABLE EVIDENCE_DESK_SOURCES.wms_handover
```

| col_name | data_type | comment |
|---|---|---|
| handover_id | string | null |
| order_no | string | null |
| parcel_no | string | null |
| event_code | string | null |
| scanned_at_utc | string | null |
| dock | string | null |
| manifest_no | string | null |
| weight_kg | string | null |
| scanner_id | string | null |
| remarks | string | null |

## Describe carrier_tracking

ok, 52 ms

```sql
DESC TABLE EVIDENCE_DESK_SOURCES.carrier_tracking
```

| col_name | data_type | comment |
|---|---|---|
| amends_event_id | string | null |
| delivered_address | string | null |
| description | string | null |
| driver_id | string | null |
| event_id | string | null |
| event_time | string | null |
| gps_distance_m | bigint | null |
| recorded_by | string | null |
| status | string | null |
| tracking_no | string | null |

## Count wms_handover

ok, 145 ms

```sql
SELECT count(*) AS records FROM EVIDENCE_DESK_SOURCES.wms_handover
```

| records |
|---|
| 1 |

## Count carrier_tracking

ok, 94 ms

```sql
SELECT count(*) AS records FROM EVIDENCE_DESK_SOURCES.carrier_tracking
```

| records |
|---|
| 2 |

## Query wms_handover for the shipment

ok, 122 ms

```sql
SELECT handover_id, parcel_no, order_no, event_code, scanned_at_utc FROM EVIDENCE_DESK_SOURCES.wms_handover WHERE parcel_no = 'PCL-88412' ORDER BY scanned_at_utc
```

| handover_id | parcel_no | order_no | event_code | scanned_at_utc |
|---|---|---|---|---|
| scans/dock3/MAN-5521/PCL-88412 | PCL-88412 | ORD-1042 | HANDED_TO_CARRIER | 2026-10-11T23:40:00Z |

## Query carrier_tracking for the shipment

ok, 144 ms

```sql
SELECT event_id, tracking_no, status, event_time, amends_event_id FROM EVIDENCE_DESK_SOURCES.carrier_tracking WHERE tracking_no = 'PCL-88412' ORDER BY event_time
```

| event_id | tracking_no | status | event_time | amends_event_id |
|---|---|---|---|---|
| tracking/PCL-88412/events/7 | PCL-88412 | DELIVERED | 2026-10-13T03:02:00Z | null |
| tracking/PCL-88412/pod-review/1 | PCL-88412 | DELIVERED_INCORRECT_ADDRESS | 2026-10-15T05:20:00Z | tracking/PCL-88412/events/7 |

## Create USL namespace

ok, 42 ms

```sql
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk
```

| Result |
|---|

## Compile and deploy USL delivery_usl

ok, 83 ms

```sql
COMPILE USL IF NOT EXISTS delivery_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL CREATE TABLE delivery_evidence (
  evidence_id string NOT NULL,
  source_system string NOT NULL,
  source_record_ref string,
  shipment_id string,
  order_id string,
  event_type string,
  source_event_code string,
  observed_at timestamp,
  content string,
  supersedes_ref string,
  inferred_fields string,
  CONSTRAINT pk_delivery_evidence PRIMARY KEY (evidence_id)
);
```

| json |
|---|
| {"namespace":["metastore","evidence_desk"],"name":"delivery_usl","tables":[{"name":"delivery_evidence","columnSpecs":[{"name":"evidence_id","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_system","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_record_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"shipment_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"order_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"event_type","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"source_event_code","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"observed_at","dataType":"\"timestamp\"","dqAnnotations":[],"acAnnotations":[]},{"name":"content","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"supersedes_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"inferred_fields","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]}],"primaryKey":{"columns":["evidence_id"],"name":"pk_delivery_evidence"},"unique":[],"foreignKeys":[],"checks":[],"ifNotExit":false,"namespace":["lightning","metastore","evidence_desk","delivery_usl"],"dqAnnotations":[],"acAnnotations":[]}]} |

## Activate delivery_evidence over both sources

ok, 102 ms

```sql
ACTIVATE USL TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence AS SELECT
  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,
  'wms' AS source_system,
  handover_id AS source_record_ref,
  parcel_no AS shipment_id,
  order_no AS order_id,
  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,
  event_code AS source_event_code,
  CAST(scanned_at_utc AS timestamp) AS observed_at,
  remarks AS content,
  CAST(NULL AS string) AS supersedes_ref,
  'evidence_id,source_system,event_type' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.wms_handover
UNION ALL
SELECT
  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,
  'carrier' AS source_system,
  event_id AS source_record_ref,
  tracking_no AS shipment_id,
  CAST(NULL AS string) AS order_id,
  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,
  status AS source_event_code,
  CAST(event_time AS timestamp) AS observed_at,
  description AS content,
  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,
  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.carrier_tracking
```

| registered |
|---|
| {"name":"delivery_evidence","query":"SELECT\n  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,\n  'wms' AS source_system,\n  handover_id AS source_record_ref,\n  parcel_no AS shipment_id,\n  order_no AS order_id,\n  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,\n  event_code AS source_event_code,\n  CAST(scanned_at_utc AS timestamp) AS observed_at,\n  remarks AS content,\n  CAST(NULL AS string) AS supersedes_ref,\n  'evidence_id,source_system,event_type' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.wms_handover\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.carrier_tracking"} |

## List the USL's tables

ok, 43 ms

```sql
SHOW NAMESPACES OR TABLES IN lightning.metastore.evidence_desk.delivery_usl
```

| name | type | usl_id | count | activated |
|---|---|---|---|---|
| delivery_evidence | table | null | 0 | true |

## Query the USL for the disputed shipment

ok, 308 ms

```sql
SELECT evidence_id, source_system, source_record_ref, shipment_id, order_id, event_type, observed_at, supersedes_ref, inferred_fields FROM lightning.metastore.evidence_desk.delivery_usl.delivery_evidence WHERE shipment_id = 'PCL-88412' ORDER BY observed_at
```

| evidence_id | source_system | source_record_ref | shipment_id | order_id | event_type | observed_at | supersedes_ref | inferred_fields |
|---|---|---|---|---|---|---|---|---|
| wms:scans/dock3/MAN-5521/PCL-88412 | wms | scans/dock3/MAN-5521/PCL-88412 | PCL-88412 | ORD-1042 | warehouse_handover | 2026-10-11 23:40:00.0 | null | evidence_id,source_system,event_type |
| carrier:tracking/PCL-88412/events/7 | carrier | tracking/PCL-88412/events/7 | PCL-88412 | null | carrier_delivered | 2026-10-13 03:02:00.0 | null | evidence_id,source_system,event_type,supersedes_ref |
| carrier:tracking/PCL-88412/pod-review/1 | carrier | tracking/PCL-88412/pod-review/1 | PCL-88412 | null | carrier_delivery_amended | 2026-10-15 05:20:00.0 | carrier:tracking/PCL-88412/events/7 | evidence_id,source_system,event_type,supersedes_ref |

## Register DQ rule on the USL

ok, 234 ms

```sql
REGISTER DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence AS evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0
```

| json |
|---|
| {"namespace":["metastore","evidence_desk"],"name":"delivery_usl","tables":[{"name":"delivery_evidence","columnSpecs":[{"name":"evidence_id","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_system","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_record_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"shipment_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"order_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"event_type","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"source_event_code","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"observed_at","dataType":"\"timestamp\"","dqAnnotations":[],"acAnnotations":[]},{"name":"content","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"supersedes_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"inferred_fields","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]}],"primaryKey":{"columns":["evidence_id"],"name":"pk_delivery_evidence"},"unique":[],"foreignKeys":[],"checks":[],"ifNotExit":false,"namespace":["lightning","metastore","evidence_desk","delivery_usl"],"dqAnnotations":[{"name":"`evidence_id_present`","expression":"evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0","cte":{}}],"acAnnotations":[],"activateQuery":"SELECT\n  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,\n  'wms' AS source_system,\n  handover_id AS source_record_ref,\n  parcel_no AS shipment_id,\n  order_no AS order_id,\n  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,\n  event_code AS source_event_code,\n  CAST(scanned_at_utc AS timestamp) AS observed_at,\n  remarks AS content,\n  CAST(NULL AS string) AS supersedes_ref,\n  'evidence_id,source_system,event_type' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.wms_handover\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.carrier_tracking"}]} |

## List DQ rules on the USL

ok, 43 ms

```sql
LIST DQ USL lightning.metastore.evidence_desk.delivery_usl
```

| name | table | type | expression |
|---|---|---|---|
| evidence_id | delivery_evidence | Primary key constraints |  |
| `evidence_id_present` | delivery_evidence | Custom Data Quality | evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0 |

## Run DQ rule on the USL

ok, 592 ms

```sql
RUN DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence
```

| name | table | type | total_record | valid_record | invalid_record |
|---|---|---|---|---|---|
| `evidence_id_present` | delivery_evidence | Custom Data Quality | 3 | 3 | 0 |

## Show records failing the rule (USL)

ok, 342 ms

```sql
SHOW DQ INVALID RECORD `evidence_id_present` TABLE lightning.metastore.evidence_desk.delivery_usl.delivery_evidence
```

| evidence_id | source_system | source_record_ref | shipment_id | order_id | event_type | source_event_code | observed_at | content | supersedes_ref | inferred_fields |
|---|---|---|---|---|---|---|---|---|---|---|

## Create Lightning database for the DQ sample

already present, 32 ms

```sql
CREATE LIGHTNING DATABASE EVIDENCE_DESK_DQ_SAMPLE DESCRIBE BY "SAMPLE DATA - isolated rows for the data-quality demonstration" OPTIONS ()
```

## Onboard the DQ sample row (JSON)

already present, 32 ms

```sql
CREATE LIGHTNING FILESTORE TABLE carrier_tracking_dq_sample FROM EVIDENCE_DESK_DQ_SAMPLE FORMAT json OPTIONS (path "file:///home/zetaris/customer-data/shared/evidence_desk_usl/carrier_tracking_dq_sample")
```

## Create sample USL namespace

ok, 38 ms

```sql
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk_dq_sample
```

| Result |
|---|

## Compile sample USL

ok, 42 ms

```sql
COMPILE USL IF NOT EXISTS delivery_usl_dq_sample DEPLOY NAMESPACE lightning.metastore.evidence_desk_dq_sample DDL CREATE TABLE delivery_evidence (
  evidence_id string NOT NULL,
  source_system string NOT NULL,
  source_record_ref string,
  shipment_id string,
  order_id string,
  event_type string,
  source_event_code string,
  observed_at timestamp,
  content string,
  supersedes_ref string,
  inferred_fields string,
  CONSTRAINT pk_delivery_evidence PRIMARY KEY (evidence_id)
);
```

| json |
|---|
| {"namespace":["metastore","evidence_desk_dq_sample"],"name":"delivery_usl_dq_sample","tables":[{"name":"delivery_evidence","columnSpecs":[{"name":"evidence_id","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_system","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_record_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"shipment_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"order_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"event_type","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"source_event_code","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"observed_at","dataType":"\"timestamp\"","dqAnnotations":[],"acAnnotations":[]},{"name":"content","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"supersedes_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"inferred_fields","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]}],"primaryKey":{"columns":["evidence_id"],"name":"pk_delivery_evidence"},"unique":[],"foreignKeys":[],"checks":[],"ifNotExit":false,"namespace":["lightning","metastore","evidence_desk_dq_sample","delivery_usl_dq_sample"],"dqAnnotations":[],"acAnnotations":[]}]} |

## Activate sample delivery_evidence (sources plus the sample row)

ok, 144 ms

```sql
ACTIVATE USL TABLE lightning.metastore.evidence_desk_dq_sample.delivery_usl_dq_sample.delivery_evidence AS SELECT
  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,
  'wms' AS source_system,
  handover_id AS source_record_ref,
  parcel_no AS shipment_id,
  order_no AS order_id,
  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,
  event_code AS source_event_code,
  CAST(scanned_at_utc AS timestamp) AS observed_at,
  remarks AS content,
  CAST(NULL AS string) AS supersedes_ref,
  'evidence_id,source_system,event_type' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.wms_handover
UNION ALL
SELECT
  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,
  'carrier' AS source_system,
  event_id AS source_record_ref,
  tracking_no AS shipment_id,
  CAST(NULL AS string) AS order_id,
  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,
  status AS source_event_code,
  CAST(event_time AS timestamp) AS observed_at,
  description AS content,
  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,
  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.carrier_tracking

UNION ALL
SELECT
  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,
  'carrier' AS source_system,
  event_id AS source_record_ref,
  tracking_no AS shipment_id,
  CAST(NULL AS string) AS order_id,
  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,
  status AS source_event_code,
  CAST(event_time AS timestamp) AS observed_at,
  description AS content,
  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,
  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields
FROM EVIDENCE_DESK_DQ_SAMPLE.carrier_tracking_dq_sample
```

| registered |
|---|
| {"name":"delivery_evidence","query":"SELECT\n  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,\n  'wms' AS source_system,\n  handover_id AS source_record_ref,\n  parcel_no AS shipment_id,\n  order_no AS order_id,\n  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,\n  event_code AS source_event_code,\n  CAST(scanned_at_utc AS timestamp) AS observed_at,\n  remarks AS content,\n  CAST(NULL AS string) AS supersedes_ref,\n  'evidence_id,source_system,event_type' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.wms_handover\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.carrier_tracking\n\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_DQ_SAMPLE.carrier_tracking_dq_sample"} |

## Register DQ rule on the sample USL

ok, 410 ms

```sql
REGISTER DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk_dq_sample.delivery_usl_dq_sample.delivery_evidence AS evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0
```

| json |
|---|
| {"namespace":["metastore","evidence_desk_dq_sample"],"name":"delivery_usl_dq_sample","tables":[{"name":"delivery_evidence","columnSpecs":[{"name":"evidence_id","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_system","dataType":"\"string\"","notNull":{"columns":[]},"dqAnnotations":[],"acAnnotations":[]},{"name":"source_record_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"shipment_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"order_id","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"event_type","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"source_event_code","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"observed_at","dataType":"\"timestamp\"","dqAnnotations":[],"acAnnotations":[]},{"name":"content","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"supersedes_ref","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]},{"name":"inferred_fields","dataType":"\"string\"","dqAnnotations":[],"acAnnotations":[]}],"primaryKey":{"columns":["evidence_id"],"name":"pk_delivery_evidence"},"unique":[],"foreignKeys":[],"checks":[],"ifNotExit":false,"namespace":["lightning","metastore","evidence_desk_dq_sample","delivery_usl_dq_sample"],"dqAnnotations":[{"name":"`evidence_id_present`","expression":"evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0","cte":{}}],"acAnnotations":[],"activateQuery":"SELECT\n  COALESCE(CASE WHEN handover_id IS NULL OR trim(handover_id) = '' THEN NULL ELSE concat('wms:', handover_id) END, '') AS evidence_id,\n  'wms' AS source_system,\n  handover_id AS source_record_ref,\n  parcel_no AS shipment_id,\n  order_no AS order_id,\n  CASE event_code WHEN 'HANDED_TO_CARRIER' THEN 'warehouse_handover' ELSE 'warehouse_other' END AS event_type,\n  event_code AS source_event_code,\n  CAST(scanned_at_utc AS timestamp) AS observed_at,\n  remarks AS content,\n  CAST(NULL AS string) AS supersedes_ref,\n  'evidence_id,source_system,event_type' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.wms_handover\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_SOURCES.carrier_tracking\n\nUNION ALL\nSELECT\n  COALESCE(CASE WHEN event_id IS NULL OR trim(event_id) = '' THEN NULL ELSE concat('carrier:', event_id) END, '') AS evidence_id,\n  'carrier' AS source_system,\n  event_id AS source_record_ref,\n  tracking_no AS shipment_id,\n  CAST(NULL AS string) AS order_id,\n  CASE status WHEN 'DELIVERED' THEN 'carrier_delivered' WHEN 'DELIVERED_INCORRECT_ADDRESS' THEN 'carrier_delivery_amended' ELSE 'carrier_other' END AS event_type,\n  status AS source_event_code,\n  CAST(event_time AS timestamp) AS observed_at,\n  description AS content,\n  CASE WHEN amends_event_id IS NULL OR trim(amends_event_id) = '' THEN NULL ELSE concat('carrier:', amends_event_id) END AS supersedes_ref,\n  'evidence_id,source_system,event_type,supersedes_ref' AS inferred_fields\nFROM EVIDENCE_DESK_DQ_SAMPLE.carrier_tracking_dq_sample"}]} |

## Run DQ rule on the sample USL

ok, 715 ms

```sql
RUN DQ `evidence_id_present` TABLE lightning.metastore.evidence_desk_dq_sample.delivery_usl_dq_sample.delivery_evidence
```

| name | table | type | total_record | valid_record | invalid_record |
|---|---|---|---|---|---|
| `evidence_id_present` | delivery_evidence | Custom Data Quality | 4 | 3 | 1 |

## Show records failing the rule (sample USL)

ok, 327 ms

```sql
SHOW DQ INVALID RECORD `evidence_id_present` TABLE lightning.metastore.evidence_desk_dq_sample.delivery_usl_dq_sample.delivery_evidence
```

| evidence_id | source_system | source_record_ref | shipment_id | order_id | event_type | source_event_code | observed_at | content | supersedes_ref | inferred_fields |
|---|---|---|---|---|---|---|---|---|---|---|
|  | carrier |  | PCL-88412 | null | carrier_other | IN_TRANSIT | 2026-10-12 01:00:00.0 | SAMPLE DATA for the data-quality demonstration only: a carrier event exported without its event id. | null | evidence_id,source_system,event_type,supersedes_ref |

