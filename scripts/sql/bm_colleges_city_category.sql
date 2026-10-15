-- Add College Details fields to existing Business Manager installations.
ALTER TABLE bm_colleges
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS category text;
