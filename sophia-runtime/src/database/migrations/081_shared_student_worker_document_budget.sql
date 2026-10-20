-- A long-running shared worker must not reset the document batch limit when
-- it restarts or is deployed again. This is a source-attempt limit, not a
-- replacement for cross-connection/provider API quota accounting.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
  business_date date NOT NULL,
  attempted_sources integer NOT NULL DEFAULT 0 CHECK(attempted_sources BETWEEN 0 AND 500),
  started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,business_date)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_window(at_time timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog
AS $$ SELECT EXTRACT(HOUR FROM at_time AT TIME ZONE 'Australia/Brisbane')>=3
        AND EXTRACT(HOUR FROM at_time AT TIME ZONE 'Australia/Brisbane')<6 $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_window(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_window(timestamptz) TO sophia_runtime_app;
