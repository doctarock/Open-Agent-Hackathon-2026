CREATE TABLE case_evidence (
  id string NOT NULL,
  case_id string NOT NULL,
  source_system string NOT NULL,
  source_name string,
  observed_at string,
  content string,
  facts_json string,
  record_ref string,
  system_of_record string,
  author string,
  supersedes string,
  source_table string,
  inferred_fields string,
  CONSTRAINT pk_case_evidence PRIMARY KEY (id)
);
