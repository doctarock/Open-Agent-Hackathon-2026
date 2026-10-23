CREATE TABLE delivery_evidence (
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
