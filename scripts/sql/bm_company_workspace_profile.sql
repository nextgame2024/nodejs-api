ALTER TABLE bm_company
  ADD COLUMN IF NOT EXISTS workspace_profile text NOT NULL DEFAULT 'project_map';

ALTER TABLE bm_company
  DROP CONSTRAINT IF EXISTS bm_company_workspace_profile_check;

ALTER TABLE bm_company
  ADD CONSTRAINT bm_company_workspace_profile_check CHECK (
    workspace_profile IN ('project_map', 'student_operations')
  );

