-- Project Types + Materials + Labor
-- Run once per database (production/staging/local).

CREATE TABLE IF NOT EXISTS bm_project_types (
  project_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  notes text NULL,
  status text NOT NULL DEFAULT 'active',
  createdat timestamptz NOT NULL DEFAULT NOW(),
  updatedat timestamptz NULL
);

CREATE TABLE IF NOT EXISTS bm_project_types_materials (
  company_id uuid NOT NULL,
  project_type_id uuid NOT NULL,
  supplier_id uuid NULL,
  material_id uuid NOT NULL,
  unit text NULL,
  coverage_ratio numeric NULL,
  coverage_unit text NULL,
  quantity numeric NULL,
  unit_cost_override numeric NULL,
  sell_cost_override numeric NULL,
  notes text NULL,
  createdat timestamptz NOT NULL DEFAULT NOW(),
  updatedat timestamptz NULL,
  PRIMARY KEY (project_type_id, material_id)
);

CREATE TABLE IF NOT EXISTS bm_project_types_labor (
  company_id uuid NOT NULL,
  project_type_id uuid NOT NULL,
  labor_id uuid NOT NULL,
  quantity numeric NULL,
  unit_cost_override numeric NULL,
  sell_cost_override numeric NULL,
  unit_productivity numeric NULL,
  productivity_unit text NULL,
  notes text NULL,
  createdat timestamptz NOT NULL DEFAULT NOW(),
  updatedat timestamptz NULL,
  PRIMARY KEY (project_type_id, labor_id)
);

-- Optional indexes (recommended)
CREATE INDEX IF NOT EXISTS idx_project_types_company
  ON bm_project_types (company_id);
CREATE INDEX IF NOT EXISTS idx_project_types_materials_company
  ON bm_project_types_materials (company_id);
CREATE INDEX IF NOT EXISTS idx_project_types_labor_company
  ON bm_project_types_labor (company_id);

-- Projects -> optional project_type_id (for template loading)
ALTER TABLE bm_projects
  ADD COLUMN IF NOT EXISTS project_type_id uuid;

ALTER TABLE bm_projects
  ADD CONSTRAINT IF NOT EXISTS bm_projects_project_type_fkey
  FOREIGN KEY (project_type_id)
  REFERENCES bm_project_types(project_type_id)
  ON DELETE SET NULL;
