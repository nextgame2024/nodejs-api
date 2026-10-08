ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  ADD COLUMN IF NOT EXISTS record_version integer NOT NULL DEFAULT 1
    CHECK (record_version > 0);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  student_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('student.created', 'student.updated')),
  record_version integer NOT NULL CHECK (record_version > 0),
  changed_fields text[] NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (student_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id, customer_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_student_operations_student_audit_tenant_student
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events(
    customer_id, student_id, created_at DESC
  );

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests (
  customer_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  actor_identity_user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  operation text NOT NULL CHECK (operation IN ('student.create', 'student.update')),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  student_id uuid,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, actor_identity_user_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_student_operations_student_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Student audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS protect_student_operations_student_audit_event
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events;
CREATE TRIGGER protect_student_operations_student_audit_event BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_student_operations_student_audit_event();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'student_operations_student_audit_events',
    'student_operations_write_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I',
      table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
  TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  TO sophia_runtime_app;
