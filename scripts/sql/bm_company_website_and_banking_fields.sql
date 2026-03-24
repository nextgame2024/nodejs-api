-- Add website and banking details used in company profile.
ALTER TABLE bm_company
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS bank text,
  ADD COLUMN IF NOT EXISTS account_name text,
  ADD COLUMN IF NOT EXISTS bsb_number text,
  ADD COLUMN IF NOT EXISTS account_number text;
