-- Scheduling is local only. It neither backfills queues nor calls Xero.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
  business_date date NOT NULL,
  scheduled_sources integer NOT NULL DEFAULT 0 CHECK(scheduled_sources BETWEEN 0 AND 25),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,business_date)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets TO sophia_runtime_app;
CREATE INDEX student_document_sources_recheck
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources(customer_id,checked_at)
  WHERE status='succeeded';
