CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_user_id text NOT NULL UNIQUE,
  operator_company_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  module_scope text[],
  authorization_revision integer NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status <> 'active'
    OR (
      module_scope IS NOT NULL
      AND cardinality(module_scope) > 0
      AND module_scope <@ ARRAY[
        'ADM-01','ADM-02','ADM-03','ADM-04','ADM-05','ADM-06','ADM-07','ADM-08',
        'ADM-09','ADM-10','ADM-11','ADM-12','ADM-13','ADM-14','ADM-15','ADM-16'
      ]::text[]
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_platform_operator_company_status
  ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments(operator_company_id, status);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.platform_operator_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments(assignment_id),
  actor_identity_user_id text NOT NULL,
  target_identity_user_id text NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_operator_audit_target_created
  ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_audit_events(target_identity_user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments
  TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_audit_events
  TO sophia_runtime_app;
