-- Additional costs (global or per-project)
-- Run once per database (production/staging/local).

CREATE TABLE IF NOT EXISTS bm_additional_cost (
  additional_cost_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  cost_name text NOT NULL,
  type text NOT NULL DEFAULT 'single',
  project_id uuid NULL,
  cost_value numeric(12,2) NOT NULL,
  active boolean NOT NULL DEFAULT true
);

-- Optional indexes (recommended) Hola
CREATE INDEX IF NOT EXISTS idx_bm_additional_cost_company
  ON bm_additional_cost (company_id);

CREATE INDEX IF NOT EXISTS idx_bm_additional_cost_project
  ON bm_additional_cost (project_id);

CREATE INDEX IF NOT EXISTS idx_bm_additional_cost_type
  ON bm_additional_cost (type);
