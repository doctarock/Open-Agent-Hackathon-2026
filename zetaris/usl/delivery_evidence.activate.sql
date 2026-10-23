SELECT
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
