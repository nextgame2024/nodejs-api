-- Student users are owned by Business Manager. The profile UUID remains the
-- stable runtime identity used by existing candidate reviews and write APIs.
-- No account, invoice, or existing student row is updated by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS users_company_id_student_identity
  ON public.users(company_id, id, student_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_company_id_for_student_advisors
  ON public.users(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS student_operations_customer_external_company
  ON __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id, external_company_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links (
  customer_id uuid NOT NULL,
  student_id uuid NOT NULL,
  company_id uuid NOT NULL,
  company_external_id text GENERATED ALWAYS AS (company_id::text) STORED,
  user_id uuid NOT NULL,
  student_reference text NOT NULL CHECK (student_reference ~ '^STD-[0-9]+$'),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, student_id),
  UNIQUE (customer_id, user_id),
  UNIQUE (customer_id, student_reference),
  UNIQUE (customer_id, student_id, student_reference),
  FOREIGN KEY (student_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id, customer_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, company_external_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id, external_company_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (company_id, user_id, student_reference)
    REFERENCES public.users(company_id, id, student_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  student_id uuid NOT NULL,
  case_reference text NOT NULL CHECK (length(btrim(case_reference)) BETWEEN 1 AND 80),
  case_kind text NOT NULL CHECK (length(btrim(case_kind)) BETWEEN 1 AND 80),
  title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 200),
  lifecycle_status text NOT NULL DEFAULT 'open'
    CHECK (lifecycle_status IN ('open', 'on_hold', 'completed', 'cancelled')),
  current_stage text NOT NULL DEFAULT 'new_application'
    CHECK (length(btrim(current_stage)) BETWEEN 1 AND 80),
  opened_on date NOT NULL DEFAULT CURRENT_DATE,
  closed_on date,
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closed_on IS NULL OR closed_on >= opened_on),
  CHECK (lifecycle_status NOT IN ('open', 'on_hold') OR closed_on IS NULL),
  UNIQUE (customer_id, case_id),
  UNIQUE (customer_id, student_id, case_id),
  UNIQUE (customer_id, case_reference),
  FOREIGN KEY (student_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(student_id, customer_id)
    ON DELETE RESTRICT
);
CREATE INDEX student_operations_cases_student_opened
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  (customer_id, student_id, opened_on DESC, case_id);
CREATE INDEX student_operations_cases_tenant_status_opened
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases
  (customer_id, lifecycle_status, opened_on DESC, case_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges (
  college_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  college_name text NOT NULL CHECK (length(btrim(college_name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, college_id)
);
CREATE INDEX student_operations_colleges_name
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges
  (customer_id, lower(college_name), college_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  company_id uuid NOT NULL,
  company_external_id text GENERATED ALWAYS AS (company_id::text) STORED,
  advisor_user_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, case_id, advisor_user_id),
  FOREIGN KEY (customer_id, case_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, company_external_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id, external_company_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (company_id, advisor_user_id)
    REFERENCES public.users(company_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX student_operations_case_one_primary_advisor
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors(customer_id, case_id)
  WHERE is_primary;
CREATE INDEX student_operations_case_advisors_by_user
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors
  (customer_id, advisor_user_id, case_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  college_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  course_name text CHECK (course_name IS NULL OR length(btrim(course_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, case_id, college_id),
  FOREIGN KEY (customer_id, case_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, college_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges(customer_id, college_id)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX student_operations_case_one_primary_college
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges(customer_id, case_id)
  WHERE is_primary;
CREATE INDEX student_operations_case_colleges_by_college
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges
  (customer_id, college_id, case_id);

-- A transaction is first linked to a Student by the existing reviewed Xero
-- process. Case attribution is a separate reviewed decision.
CREATE UNIQUE INDEX IF NOT EXISTS student_operations_xero_invoice_identity_for_case
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
  (customer_id, xero_connection_id, xero_invoice_id, student_id);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links (
  case_invoice_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  student_id uuid NOT NULL,
  student_reference text NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_invoice_id uuid NOT NULL,
  linked_by_identity text NOT NULL CHECK (length(linked_by_identity) BETWEEN 1 AND 240),
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, case_invoice_link_id),
  UNIQUE (customer_id, case_id, case_invoice_link_id),
  UNIQUE (customer_id, xero_connection_id, xero_invoice_id),
  FOREIGN KEY (customer_id, student_id, case_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, student_id, case_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, student_id, student_reference)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links
      (customer_id, student_id, student_reference)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, xero_connection_id, xero_invoice_id, student_reference)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
      (customer_id, xero_connection_id, xero_invoice_id, student_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX student_operations_case_invoice_links_case
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links
  (customer_id, case_id, linked_at DESC);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_payment_schedule (
  payment_schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('approved_offer', 'manual', 'xero_invoice')),
  case_invoice_link_id uuid,
  due_on date NOT NULL,
  amount numeric(18, 4) NOT NULL CHECK (amount >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'partially_paid', 'paid', 'cancelled')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, payment_schedule_id),
  FOREIGN KEY (customer_id, case_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, case_id, case_invoice_link_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links
      (customer_id, case_id, case_invoice_link_id)
    ON DELETE RESTRICT,
  CHECK ((source_kind = 'xero_invoice') = (case_invoice_link_id IS NOT NULL))
);
CREATE INDEX student_operations_case_schedule_due
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_payment_schedule
  (customer_id, case_id, due_on, payment_schedule_id)
  WHERE status IN ('pending', 'partially_paid');

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity (
  activity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  actor_identity_user_id text NOT NULL CHECK (length(actor_identity_user_id) BETWEEN 1 AND 240),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, case_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases(customer_id, case_id)
    ON DELETE RESTRICT
);
CREATE INDEX student_operations_case_activity_recent
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  (customer_id, case_id, created_at DESC, activity_id);
CREATE TRIGGER student_operations_case_activity_append_only
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_student_operations_student_audit_event();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'student_operations_student_user_links',
    'student_operations_cases',
    'student_operations_colleges',
    'student_operations_case_advisors',
    'student_operations_case_colleges',
    'student_operations_case_invoice_links',
    'student_operations_case_payment_schedule',
    'student_operations_case_activity'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING '
      || '(customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

-- SECURITY BARRIER prevents caller predicates from being pushed through this
-- deliberately narrow account projection. Runtime gets no public.users grant.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_roster
  WITH (security_barrier = true) AS
SELECT c.customer_id, u.company_id, u.id AS user_id,
       u.student_id AS student_reference, u.name AS legal_name,
       u.email, u.status::text AS account_status,
       u.createdat AS account_created_at, u.updatedat AS account_updated_at,
       l.student_id AS profile_id
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
  JOIN public.users u ON u.company_id::text = c.external_company_id
  LEFT JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    ON l.customer_id = c.customer_id AND l.user_id = u.id
 WHERE c.status = 'active' AND u.type::text = 'student'
   AND u.student_id ~ '^STD-[0-9]+$'
   AND c.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;

-- This narrow function is the ongoing account/profile boundary. It is called
-- only by an authorized case write, never by a list read or Xero refresh.
-- Legacy profile candidates with a matching name or email stay unresolved.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_student_operations_profile(
  requested_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant_id uuid := NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;
  account record;
  existing_profile record;
  profile_id uuid;
  possible_count integer;
BEGIN
  IF tenant_id IS NULL THEN
    RAISE EXCEPTION 'Student tenant context is required';
  END IF;
  SELECT u.id, u.company_id, u.student_id, u.name, u.email
    INTO account
    FROM public.users u
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers c
      ON c.customer_id = tenant_id AND c.external_company_id = u.company_id::text
   WHERE u.id = requested_user_id AND u.type::text = 'student'
     AND u.status::text <> 'archived' AND c.status = 'active'
     AND u.student_id ~ '^STD-[0-9]+$';
  IF NOT FOUND OR NULLIF(btrim(account.name), '') IS NULL
    OR NULLIF(btrim(account.email), '') IS NULL THEN
    RAISE EXCEPTION 'Student account is not eligible for a profile';
  END IF;
  SELECT count(*) INTO possible_count
    FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
   WHERE c.external_company_id = account.company_id::text AND c.status = 'active';
  IF possible_count <> 1 THEN
    RAISE EXCEPTION 'Student company mapping requires review';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('student-profile-backfill:' || tenant_id::text, 0));
  SELECT l.student_id, l.student_reference INTO existing_profile
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
   WHERE l.customer_id = tenant_id AND l.user_id = requested_user_id;
  IF FOUND THEN
    IF existing_profile.student_reference <> account.student_id THEN
      RAISE EXCEPTION 'Student identity link requires review';
    END IF;
    RETURN existing_profile.student_id;
  END IF;

  SELECT count(*) INTO possible_count
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students s
   WHERE s.customer_id = tenant_id
     AND (s.student_reference = account.student_id
       OR lower(regexp_replace(btrim(s.legal_name), '[[:space:]]+', ' ', 'g')) =
          lower(regexp_replace(btrim(account.name), '[[:space:]]+', ' ', 'g'))
       OR lower(btrim(s.email)) = lower(btrim(account.email)));
  IF possible_count > 0 THEN
    RAISE EXCEPTION 'Existing student profile requires review before linking';
  END IF;

  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
    (customer_id, student_reference, legal_name, email)
  VALUES (tenant_id, account.student_id, btrim(account.name), btrim(account.email))
  RETURNING student_id INTO profile_id;
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links
    (customer_id, student_id, company_id, user_id, student_reference)
  VALUES (tenant_id, profile_id, account.company_id, account.id, account.student_id);
  RETURN profile_id;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_student_operations_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_student_operations_profile(uuid)
  TO sophia_runtime_app;

-- Deliberate least privilege: account/profile linking is owner-operated during
-- backfill. Later write APIs can use a reviewed function rather than broad user
-- table grants. Case tables are prepared for the authorized service endpoints.
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_roster
  TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links
  TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_payment_schedule
  TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  TO sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_advisors,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_colleges,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_payment_schedule,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  FROM sophia_runtime_app;
REVOKE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  FROM sophia_runtime_app;
