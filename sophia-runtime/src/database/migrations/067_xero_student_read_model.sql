ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connections
  ADD CONSTRAINT xero_connections_id_customer_unique
  UNIQUE (xero_connection_id, customer_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  xero_connection_id uuid NOT NULL,
  organisation_role text NOT NULL CHECK (organisation_role IN ('trust', 'operating', 'unassigned')),
  enabled boolean NOT NULL DEFAULT true,
  incremental_interval interval NOT NULL DEFAULT interval '1 hour',
  reconciliation_interval interval NOT NULL DEFAULT interval '12 hours',
  last_incremental_sync_at timestamptz,
  last_reconciliation_sync_at timestamptz,
  last_successful_sync_at timestamptz,
  last_error_code text,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, xero_connection_id),
  FOREIGN KEY (xero_connection_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX student_operations_one_trust_xero_org
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id)
  WHERE organisation_role = 'trust' AND enabled;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_runs (
  sync_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  xero_connection_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('initial', 'incremental', 'reconciliation')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'schedule', 'webhook', 'connection')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  requested_by_identity text,
  modified_since timestamptz,
  contact_count integer NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  invoice_count integer NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  provider_status integer,
  provider_correlation_id text CHECK (provider_correlation_id IS NULL OR length(provider_correlation_id) <= 200),
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds BETWEEN 1 AND 86400),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (xero_connection_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX student_operations_xero_one_active_sync
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_runs(customer_id, xero_connection_id)
  WHERE status IN ('queued', 'processing');
CREATE INDEX student_operations_xero_sync_due
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_runs(customer_id, status, created_at);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  contact_status text,
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 500),
  email text CHECK (email IS NULL OR length(email) <= 320),
  contact_number text CHECK (contact_number IS NULL OR length(contact_number) <= 100),
  account_number text CHECK (account_number IS NULL OR length(account_number) <= 100),
  provider_updated_at timestamptz,
  last_seen_sync_run_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_runs(sync_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, xero_connection_id, xero_contact_id),
  FOREIGN KEY (xero_connection_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
    ON DELETE RESTRICT
);

CREATE INDEX student_operations_xero_contacts_search
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts(customer_id, xero_connection_id, lower(legal_name), xero_contact_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  xero_connection_id uuid NOT NULL,
  xero_invoice_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  invoice_number text CHECK (invoice_number IS NULL OR length(invoice_number) <= 100),
  invoice_type text NOT NULL,
  invoice_status text NOT NULL,
  invoice_date date,
  due_date date,
  currency_code text CHECK (currency_code IS NULL OR length(currency_code) <= 8),
  total numeric(18, 4) NOT NULL DEFAULT 0,
  amount_paid numeric(18, 4) NOT NULL DEFAULT 0,
  amount_due numeric(18, 4) NOT NULL DEFAULT 0,
  provider_updated_at timestamptz,
  last_seen_sync_run_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_runs(sync_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, xero_connection_id, xero_invoice_id),
  FOREIGN KEY (xero_connection_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id, customer_id)
    ON DELETE RESTRICT
);

CREATE INDEX student_operations_xero_invoices_candidate
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices(
    customer_id, xero_connection_id, xero_contact_id, invoice_status, due_date
  );

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_candidate_reviews (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'accepted', 'ignored')),
  student_id uuid,
  reviewed_by_identity text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, xero_connection_id, xero_contact_id),
  FOREIGN KEY (customer_id, xero_connection_id, xero_contact_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts(customer_id, xero_connection_id, xero_contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (student_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id, customer_id)
    ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'student_operations_xero_sync_configurations',
    'student_operations_xero_sync_runs',
    'student_operations_xero_contacts',
    'student_operations_xero_invoices',
    'student_operations_xero_candidate_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app', table_name);
    EXECUTE format('REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM sophia_runtime_app', table_name);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_sync_runs(
  requested_limit integer DEFAULT 10
) RETURNS TABLE(customer_id uuid, sync_run_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
BEGIN
  INSERT INTO student_operations_xero_sync_runs
    (customer_id, xero_connection_id, mode, trigger_type, modified_since)
  SELECT c.customer_id, c.xero_connection_id,
         CASE
           WHEN c.last_successful_sync_at IS NULL THEN 'initial'
           WHEN c.last_reconciliation_sync_at IS NULL
             OR c.last_reconciliation_sync_at < now() - c.reconciliation_interval
             THEN 'reconciliation'
           ELSE 'incremental'
         END,
         'schedule',
         CASE
           WHEN c.last_successful_sync_at IS NOT NULL
             AND c.last_reconciliation_sync_at IS NOT NULL
             AND c.last_reconciliation_sync_at >= now() - c.reconciliation_interval
             THEN c.last_successful_sync_at - interval '5 minutes'
           ELSE NULL
         END
    FROM student_operations_xero_sync_configurations c
   WHERE c.enabled AND c.next_sync_at <= now()
     AND NOT EXISTS (
       SELECT 1 FROM student_operations_xero_sync_runs r
        WHERE r.customer_id=c.customer_id AND r.xero_connection_id=c.xero_connection_id
          AND r.status IN ('queued','processing')
     )
   ORDER BY c.next_sync_at
   LIMIT greatest(1, least(requested_limit, 50))
  ON CONFLICT DO NOTHING;

  RETURN QUERY
  SELECT r.customer_id, r.sync_run_id
    FROM student_operations_xero_sync_runs r
   WHERE r.status='queued'
      OR (r.status='processing' AND r.lease_expires_at < now())
   ORDER BY r.created_at
   LIMIT greatest(1, least(requested_limit, 50));
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_sync_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_sync_runs(integer)
  TO sophia_runtime_app;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_student_operations_xero_sync_target(
  requested_xero_tenant_id text
) RETURNS TABLE(customer_id uuid, xero_connection_id uuid)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
  SELECT c.customer_id, c.xero_connection_id
    FROM student_operations_xero_sync_configurations c
    JOIN xero_connections x
      ON x.customer_id=c.customer_id AND x.xero_connection_id=c.xero_connection_id
   WHERE c.enabled AND x.status='active' AND x.xero_tenant_id=requested_xero_tenant_id
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_student_operations_xero_sync_target(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_student_operations_xero_sync_target(text)
  TO sophia_runtime_app;
