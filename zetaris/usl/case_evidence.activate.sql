SELECT
  COALESCE(concat('oms:', NULLIF(trim(o.order_ref), '')), '') AS id,
  COALESCE(d.case_id, '') AS case_id,
  'oms' AS source_system,
  'Shopfront order system' AS source_name,
  date_format(CAST(o.placed_at AS timestamp), "yyyy-MM-dd'T'HH:mm:ss'Z'") AS observed_at,
  o.summary AS content,
  to_json(map_filter(map('order.id', o.order_no, 'order.ship_to', o.ship_to), (k, v) -> v IS NOT NULL)) AS facts_json,
  o.order_ref AS record_ref,
  'Shopfront OMS' AS system_of_record,
  o.channel AS author,
  '' AS supersedes,
  'EVIDENCE_DESK_SOURCES.oms_orders' AS source_table,
  'id,case_id,source_system,source_name,facts_json' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.oms_orders o
JOIN EVIDENCE_DESK_SOURCES.dispute_register d ON o.order_no = d.order_no
UNION ALL
SELECT
  COALESCE(concat('wms:', NULLIF(trim(w.handover_id), '')), '') AS id,
  COALESCE(d.case_id, '') AS case_id,
  'wms' AS source_system,
  'Warehouse management system' AS source_name,
  date_format(CAST(w.scanned_at_utc AS timestamp), "yyyy-MM-dd'T'HH:mm:ss'Z'") AS observed_at,
  w.remarks AS content,
  to_json(map_filter(map('parcel.id', w.parcel_no, 'warehouse.handover', CASE WHEN w.event_code = 'HANDED_TO_CARRIER' THEN 'true' END), (k, v) -> v IS NOT NULL)) AS facts_json,
  w.handover_id AS record_ref,
  'Ballarat DC WMS' AS system_of_record,
  w.scanner_id AS author,
  '' AS supersedes,
  'EVIDENCE_DESK_SOURCES.wms_handover' AS source_table,
  'id,case_id,source_system,source_name,facts_json' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.wms_handover w
JOIN EVIDENCE_DESK_SOURCES.dispute_register d ON w.parcel_no = d.parcel_no
UNION ALL
SELECT
  COALESCE(concat('carrier:', NULLIF(trim(c.event_id), '')), '') AS id,
  COALESCE(d.case_id, '') AS case_id,
  'carrier' AS source_system,
  'Carrier tracking API' AS source_name,
  date_format(CAST(c.event_time AS timestamp), "yyyy-MM-dd'T'HH:mm:ss'Z'") AS observed_at,
  c.description AS content,
  to_json(map_filter(map(
    'carrier.status', CASE WHEN c.status = 'DELIVERED' THEN 'delivered' END,
    'carrier.driver', CASE WHEN c.status = 'DELIVERED' THEN c.driver_id END,
    'delivery.address_match', CASE WHEN c.status = 'DELIVERED_INCORRECT_ADDRESS' THEN 'false' END,
    'delivery.gps_distance_m', CAST(c.gps_distance_m AS string),
    'delivery.actual_address', c.delivered_address), (k, v) -> v IS NOT NULL)) AS facts_json,
  c.event_id AS record_ref,
  'Carrier tracking API' AS system_of_record,
  c.recorded_by AS author,
  COALESCE(concat('carrier:', NULLIF(trim(c.amends_event_id), '')), '') AS supersedes,
  'EVIDENCE_DESK_SOURCES.carrier_tracking' AS source_table,
  'id,case_id,source_system,source_name,facts_json,supersedes' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.carrier_tracking c
JOIN EVIDENCE_DESK_SOURCES.dispute_register d ON c.tracking_no = d.parcel_no
UNION ALL
SELECT
  COALESCE(concat('support:', NULLIF(trim(s.contact_id), '')), '') AS id,
  COALESCE(d.case_id, '') AS case_id,
  'support' AS source_system,
  'Customer support inbox' AS source_name,
  date_format(CAST(s.received_at_utc AS timestamp), "yyyy-MM-dd'T'HH:mm:ss'Z'") AS observed_at,
  s.message AS content,
  to_json(map_filter(map(
    'customer.reports_non_receipt', CASE WHEN s.category = 'NON_RECEIPT' THEN 'true' END,
    'parcel.held_by_third_party', CASE WHEN s.category = 'THIRD_PARTY_HOLDING' THEN 'true' END,
    'parcel.location', CASE WHEN s.category = 'THIRD_PARTY_HOLDING' THEN NULLIF(trim(s.location_reported), '') END), (k, v) -> v IS NOT NULL)) AS facts_json,
  s.contact_id AS record_ref,
  'Support inbox' AS system_of_record,
  s.from_party AS author,
  '' AS supersedes,
  'EVIDENCE_DESK_SOURCES.support_contacts' AS source_table,
  'id,case_id,source_system,source_name,facts_json' AS inferred_fields
FROM EVIDENCE_DESK_SOURCES.support_contacts s
JOIN EVIDENCE_DESK_SOURCES.dispute_register d ON s.linked_order_no = d.order_no
