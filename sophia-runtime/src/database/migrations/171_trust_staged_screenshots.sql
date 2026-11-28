ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
  ALTER COLUMN statement_file_name DROP NOT NULL,
  ALTER COLUMN statement_file_sha256 DROP NOT NULL,
  ALTER COLUMN statement_record DROP NOT NULL,
  ADD CHECK (num_nonnulls(statement_file_name,statement_file_sha256,statement_record) IN (0,3));

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots (
  customer_id uuid NOT NULL, connection_id uuid NOT NULL, deposit_id uuid NOT NULL,
  evidence bytea NOT NULL CHECK(octet_length(evidence) BETWEEN 1 AND 5242880),
  evidence_type text NOT NULL CHECK(evidence_type IN ('image/png','image/jpeg')),
  sha256 text GENERATED ALWAYS AS (encode(sha256(evidence),'hex')) STORED,
  uploaded_by text NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,deposit_id),
  FOREIGN KEY(customer_id,connection_id,deposit_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_deposits
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications ADD COLUMN staged_screenshot_id uuid,
  ADD FOREIGN KEY(customer_id,connection_id,staged_screenshot_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots,
  ADD CHECK(staged_screenshot_id IS NULL OR evidence IS NULL);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources (
  customer_id uuid NOT NULL,connection_id uuid NOT NULL,deposit_id uuid NOT NULL,
  statement_file_name text NOT NULL CHECK(length(statement_file_name) BETWEEN 1 AND 255),
  statement_file_sha256 text NOT NULL CHECK(statement_file_sha256 ~ '^[0-9a-f]{64}$'),
  statement_record integer NOT NULL CHECK(statement_record BETWEEN 2 AND 1001),
  attached_by text NOT NULL, attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,connection_id,deposit_id),
  UNIQUE(customer_id,connection_id,statement_file_sha256,statement_record),
  FOREIGN KEY(customer_id,connection_id,deposit_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_screenshots
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources
 USING(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid)
 WITH CHECK(customer_id=nullif(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources FROM sophia_runtime_app;
GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_staged_statement_sources TO sophia_runtime_app;

