-- Small, complete organisation settings snapshot; no provider calls during page reads.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues (
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{"items":[],"accounts":[],"taxRates":[]}'::jsonb CHECK(jsonb_typeof(snapshot)='object'),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  last_synced_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK(error_code IN ('authorization','rate_limited','provider_unavailable')),
  PRIMARY KEY(customer_id,xero_connection_id),
  FOREIGN KEY(xero_connection_id,customer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_xero_sales_catalogues TO sophia_runtime_app;
