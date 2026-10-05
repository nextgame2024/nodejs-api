CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students (
  student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  student_reference text NOT NULL CHECK (length(student_reference) BETWEEN 1 AND 80),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  preferred_name text CHECK (preferred_name IS NULL OR length(preferred_name) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  current_stage text NOT NULL DEFAULT 'new_application' CHECK (current_stage IN (
    'new_application', 'pre_payment_audit', 'student_payment_received',
    'reconciliation', 'cover_letter', 'college_payment', 'collections',
    'commission_recovery', 'completed'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'action_required', 'on_hold', 'completed', 'archived'
  )),
  advisor_identity_user_id text,
  college_name text CHECK (college_name IS NULL OR length(college_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, student_reference),
  UNIQUE (student_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_ofa_students_tenant_status_name
  ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students(customer_id, status, legal_name);
CREATE INDEX IF NOT EXISTS idx_ofa_students_tenant_advisor
  ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students(customer_id, advisor_identity_user_id);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS open_for_australia_students_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students;
CREATE POLICY open_for_australia_students_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students
  TO sophia_runtime_app;
