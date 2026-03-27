-- Add owner and ABN fields to Business Manager clients.
ALTER TABLE bm_clients
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS abn text;

