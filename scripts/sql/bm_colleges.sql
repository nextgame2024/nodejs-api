-- Business Manager college directory. Deliberately separate from bm_clients:
-- projects/documents treat every bm_clients row as a customer.
CREATE TABLE IF NOT EXISTS bm_colleges (
  college_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
  college_name text NOT NULL CHECK (length(btrim(college_name)) BETWEEN 1 AND 200),
  owner_name text,
  abn text,
  address text,
  city text,
  category text,
  email text,
  cel text,
  tel text,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz,
  UNIQUE (company_id, college_id)
);
CREATE INDEX IF NOT EXISTS bm_colleges_company_name
  ON bm_colleges(company_id, lower(college_name), college_id);

CREATE TABLE IF NOT EXISTS bm_college_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  role_title text,
  email text,
  cel text,
  tel text,
  createdat timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bm_college_contacts_parent
  ON bm_college_contacts(company_id, college_id, lower(name), id);

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

-- Existing workspaces with Clients enabled can see the new module on rollout.
INSERT INTO bm_navigation_links(company_id, navigation_type, navigation_label, active)
SELECT company_id, 'menu', 'Colleges', true
FROM bm_navigation_links
WHERE navigation_type = 'menu' AND lower(btrim(navigation_label)) = 'clients' AND active = true
ON CONFLICT DO NOTHING;
