-- Run after bm_colleges_city_category.sql on existing installations.
-- The original college contact fields remain as a read projection of the primary site.
BEGIN;
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

-- Preserve existing College Details values as a first site. A rerun does not duplicate it.
INSERT INTO bm_college_sites (company_id, college_id, email, address, phone, mobile, city, category, is_primary)
SELECT c.company_id, c.college_id, c.email, c.address, c.tel, c.cel, c.city, c.category, true
FROM bm_colleges c
WHERE (nullif(btrim(c.email), '') IS NOT NULL
    OR nullif(btrim(c.address), '') IS NOT NULL
    OR nullif(btrim(c.tel), '') IS NOT NULL
    OR nullif(btrim(c.cel), '') IS NOT NULL
    OR nullif(btrim(c.city), '') IS NOT NULL
    OR nullif(btrim(c.category), '') IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM bm_college_sites s
    WHERE s.company_id = c.company_id AND s.college_id = c.college_id
  );
COMMIT;
