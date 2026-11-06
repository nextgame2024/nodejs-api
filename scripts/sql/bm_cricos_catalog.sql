-- Add the official CRICOS provider, location and course catalogue to Business Manager.
-- Public CRICOS data is copied into each importing workspace so normal reads remain
-- tenant-scoped and do not depend on the external government service.
BEGIN;

ALTER TABLE bm_colleges
  ADD COLUMN IF NOT EXISTS cricos_provider_code text,
  ADD COLUMN IF NOT EXISTS trading_name text,
  ADD COLUMN IF NOT EXISTS institution_type text,
  ADD COLUMN IF NOT EXISTS institution_capacity integer,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS postal_address text,
  ADD COLUMN IF NOT EXISTS postal_city text,
  ADD COLUMN IF NOT EXISTS postal_state text,
  ADD COLUMN IF NOT EXISTS postal_postcode text,
  ADD COLUMN IF NOT EXISTS cricos_synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS bm_colleges_company_cricos_provider
  ON bm_colleges(company_id, cricos_provider_code)
  WHERE cricos_provider_code IS NOT NULL;

ALTER TABLE bm_college_sites
  ADD COLUMN IF NOT EXISTS cricos_location_key text,
  ADD COLUMN IF NOT EXISTS location_name text,
  ADD COLUMN IF NOT EXISTS location_type text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postcode text;

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

COMMIT;
