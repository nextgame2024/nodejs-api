-- Add soft-delete status for projects.
ALTER TYPE bm_project_status ADD VALUE IF NOT EXISTS 'deleted';
