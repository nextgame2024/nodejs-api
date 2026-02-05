-- Add cost_in_quote toggle to bm_projects
ALTER TABLE bm_projects
  ADD COLUMN IF NOT EXISTS cost_in_quote boolean NOT NULL DEFAULT false;

UPDATE bm_projects
SET cost_in_quote = false
WHERE cost_in_quote IS NULL;
