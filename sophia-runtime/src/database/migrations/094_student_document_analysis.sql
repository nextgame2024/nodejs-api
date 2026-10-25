-- Inert foundation: no jobs are enqueued and no provider calls are activated here.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  ADD CONSTRAINT student_document_analysis_scope UNIQUE(customer_id,case_id,document_id);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_jobs (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  document_kind text NOT NULL CHECK(document_kind IN ('passport','engagement_letter','letter_of_offer')),
  schema_version text NOT NULL CHECK(length(schema_version) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK(error_code IN ('provider_unavailable','rate_limited','invalid_output','source_unavailable','source_changed','unsupported_document')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,job_id),
  UNIQUE(customer_id,case_id,document_id,content_sha256,document_kind,schema_version),
  UNIQUE(customer_id,case_id,document_id,job_id),
  FOREIGN KEY(customer_id,case_id,document_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents(customer_id,case_id,document_id),
  CHECK((status='processing')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX student_document_analysis_due ON __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_jobs(customer_id,status,next_attempt_at,created_at);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_results (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  job_id uuid NOT NULL,
  result_id uuid NOT NULL DEFAULT gen_random_uuid(),
  extraction jsonb NOT NULL CHECK(jsonb_typeof(extraction)='object'),
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 120),
  input_tokens integer NOT NULL CHECK(input_tokens>=0),
  output_tokens integer NOT NULL CHECK(output_tokens>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,result_id),
  UNIQUE(customer_id,job_id),
  UNIQUE(customer_id,case_id,document_id,result_id),
  FOREIGN KEY(customer_id,case_id,document_id,job_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_jobs(customer_id,case_id,document_id,job_id)
);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  result_id uuid NOT NULL,
  review_id uuid NOT NULL DEFAULT gen_random_uuid(),
  review_version integer NOT NULL CHECK(review_version>0),
  decision text NOT NULL CHECK(decision IN ('confirmed','rejected')),
  corrections jsonb CHECK(corrections IS NULL OR jsonb_typeof(corrections)='object'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  actor_identity_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,review_id),
  UNIQUE(customer_id,case_id,document_id,review_version),
  FOREIGN KEY(customer_id,case_id,document_id,result_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_results(customer_id,case_id,document_id,result_id)
);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offers (
  customer_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  result_id uuid NOT NULL,
  offer_id uuid NOT NULL DEFAULT gen_random_uuid(),
  record_version integer NOT NULL DEFAULT 1 CHECK(record_version>0),
  status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','superseded')),
  is_current boolean NOT NULL DEFAULT false,
  provider_name text,
  resolved_college_id uuid,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  stated_total_minor bigint CHECK(stated_total_minor BETWEEN 0 AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,offer_id),
  UNIQUE(customer_id,result_id),
  FOREIGN KEY(customer_id,case_id,document_id,result_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_results(customer_id,case_id,document_id,result_id),
  FOREIGN KEY(customer_id,resolved_college_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_colleges(customer_id,college_id),
  CHECK(NOT is_current OR status='confirmed')
);
CREATE UNIQUE INDEX student_case_current_offer ON __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,case_id) WHERE is_current;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_courses (
  customer_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  course_id uuid NOT NULL DEFAULT gen_random_uuid(),
  sort_order integer NOT NULL CHECK(sort_order>=0),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 500),
  code text,
  starts_on date,
  ends_on date,
  duration text,
  PRIMARY KEY(customer_id,offer_id,course_id),
  UNIQUE(customer_id,offer_id,sort_order),
  FOREIGN KEY(customer_id,offer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,offer_id),
  CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on>=starts_on)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_fees (
  customer_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  fee_id uuid NOT NULL DEFAULT gen_random_uuid(),
  course_id uuid,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 500),
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 1000000000),
  conditional boolean NOT NULL,
  condition text,
  PRIMARY KEY(customer_id,offer_id,fee_id),
  FOREIGN KEY(customer_id,offer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,offer_id),
  FOREIGN KEY(customer_id,offer_id,course_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_courses(customer_id,offer_id,course_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_instalments (
  customer_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  course_id uuid,
  due_term text,
  due_on date,
  total_minor bigint NOT NULL CHECK(total_minor BETWEEN 0 AND 1000000000),
  included_conditional_fee_minor bigint NOT NULL CHECK(included_conditional_fee_minor BETWEEN 0 AND total_minor),
  PRIMARY KEY(customer_id,offer_id,sequence),
  FOREIGN KEY(customer_id,offer_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,offer_id),
  FOREIGN KEY(customer_id,offer_id,course_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_courses(customer_id,offer_id,course_id)
);

-- Explicit grants override any deployment owner default privileges. Evidence is append-only.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['student_document_analysis_jobs','student_document_analysis_results','student_document_reviews',
    'student_case_offers','student_case_offer_courses','student_case_offer_fees','student_case_offer_instalments'] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',tab);
    EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM PUBLIC,sophia_runtime_app',tab);
    EXECUTE format('GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',tab);
  END LOOP;
END $$;
GRANT UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_document_analysis_jobs,__SOPHIA_RUNTIME_SCHEMA__.student_case_offers TO sophia_runtime_app;
