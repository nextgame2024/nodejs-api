-- Business Manager college directory. Deliberately separate from bm_clients:
-- projects/documents treat every bm_clients row as a customer.
CREATE TABLE IF NOT EXISTS bm_colleges (
  college_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
  college_name text NOT NULL CHECK (length(btrim(college_name)) BETWEEN 1 AND 200),
  acronym text CHECK (acronym IS NULL OR length(btrim(acronym)) BETWEEN 1 AND 80),
  owner_name text,
  abn text,
  address text,
  city text,
  category text,
  email text,
  cel text,
  tel text,
  notes text,
  cricos_provider_code text,
  trading_name text,
  institution_type text,
  institution_capacity integer,
  website text,
  postal_address text,
  postal_city text,
  postal_state text,
  postal_postcode text,
  cricos_synced_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz,
  UNIQUE (company_id, college_id)
);
CREATE INDEX IF NOT EXISTS bm_colleges_company_name
  ON bm_colleges(company_id, lower(college_name), college_id);
CREATE UNIQUE INDEX IF NOT EXISTS bm_colleges_company_cricos_provider
  ON bm_colleges(company_id, cricos_provider_code)
  WHERE cricos_provider_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS bm_college_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  role_title text,
  email text,
  cel text,
  tel text,
  fax text,
  source text NOT NULL DEFAULT 'manual',
  source_key text,
  contact_type text,
  source_url text,
  source_checked_at timestamptz,
  source_hash text,
  source_active boolean NOT NULL DEFAULT true,
  updatedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_college_contacts_parent
  ON bm_college_contacts(company_id, college_id, lower(name), id);
CREATE UNIQUE INDEX IF NOT EXISTS bm_college_contacts_source_key
  ON bm_college_contacts(company_id, college_id, source, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bm_college_contacts_source_status
  ON bm_college_contacts(company_id, college_id, source, source_active, id);

CREATE TABLE IF NOT EXISTS bm_cricos_contact_sync (
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  cricos_provider_code text NOT NULL,
  sample_course_code text,
  source_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'no_contacts', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  contact_count integer NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  last_error_code text,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  updatedat timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, cricos_provider_code),
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_cricos_contact_sync_progress
  ON bm_cricos_contact_sync(company_id, status, cricos_provider_code);

CREATE TABLE IF NOT EXISTS bm_college_sites (
  site_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  email text,
  address text,
  phone text,
  mobile text,
  city text,
  category text,
  cricos_location_key text,
  location_name text,
  location_type text,
  state text,
  postcode text,
  is_primary boolean NOT NULL DEFAULT false,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz,
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_college_sites_parent
  ON bm_college_sites(company_id, college_id, createdat, site_id);
CREATE UNIQUE INDEX IF NOT EXISTS bm_college_sites_one_primary
  ON bm_college_sites(company_id, college_id) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS bm_college_sites_company_cricos_location
  ON bm_college_sites(company_id, cricos_location_key)
  WHERE cricos_location_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bm_college_sites_company_site_id
  ON bm_college_sites(company_id, site_id);

CREATE TABLE IF NOT EXISTS bm_college_courses (
  course_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  cricos_course_code text NOT NULL,
  course_name text NOT NULL,
  vet_national_code text,
  dual_qualification boolean NOT NULL DEFAULT false,
  field_1_broad text,
  field_1_narrow text,
  field_1_detailed text,
  field_2_broad text,
  field_2_narrow text,
  field_2_detailed text,
  course_level text,
  foundation_studies boolean NOT NULL DEFAULT false,
  work_component boolean NOT NULL DEFAULT false,
  work_component_hours_week numeric,
  work_component_weeks integer,
  work_component_total_hours numeric,
  course_language text,
  duration_weeks integer,
  tuition_fee_cents bigint,
  non_tuition_fee_cents bigint,
  estimated_total_cost_cents bigint,
  expired boolean NOT NULL DEFAULT false,
  cricos_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, course_id),
  UNIQUE (company_id, cricos_course_code),
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_college_courses_parent
  ON bm_college_courses(company_id, college_id, expired, lower(course_name), course_id);

CREATE TABLE IF NOT EXISTS bm_college_course_locations (
  company_id uuid NOT NULL,
  course_id uuid NOT NULL,
  site_id uuid NOT NULL,
  PRIMARY KEY (company_id, course_id, site_id),
  FOREIGN KEY (company_id, course_id)
    REFERENCES bm_college_courses(company_id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, site_id)
    REFERENCES bm_college_sites(company_id, site_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_college_course_locations_site
  ON bm_college_course_locations(company_id, site_id, course_id);

-- Existing workspaces with Clients enabled can see the new module on rollout.
INSERT INTO bm_navigation_links(company_id, navigation_type, navigation_label, active)
SELECT company_id, 'menu', 'Colleges', true
FROM bm_navigation_links
WHERE navigation_type = 'menu' AND lower(btrim(navigation_label)) = 'clients' AND active = true
ON CONFLICT DO NOTHING;
