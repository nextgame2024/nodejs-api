-- Project surcharges (transportation, other, ...)
-- Run once per database (production/staging/local).

CREATE TABLE IF NOT EXISTS bm_project_surcharges (
  surcharge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  surcharge_type text NOT NULL,
  surcharge_name text NOT NULL,
  surcharge_cost numeric(12,2) NOT NULL,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bm_project_surcharges_project_fk
    FOREIGN KEY (project_id)
    REFERENCES bm_projects(project_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bm_project_surcharges_company_project
  ON bm_project_surcharges (company_id, project_id);

CREATE INDEX IF NOT EXISTS idx_bm_project_surcharges_project
  ON bm_project_surcharges (project_id);
