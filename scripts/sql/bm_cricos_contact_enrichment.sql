-- Source-labelled CRICOS contact enrichment and durable per-provider checkpoints.
BEGIN;

ALTER TABLE bm_college_contacts
  ADD COLUMN IF NOT EXISTS fax text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS contact_type text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_hash text,
  ADD COLUMN IF NOT EXISTS source_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updatedat timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS bm_college_contacts_source_key
  ON bm_college_contacts(company_id, college_id, source, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bm_college_contacts_source_status
  ON bm_college_contacts(company_id, college_id, source, source_active, id);

CREATE TABLE IF NOT EXISTS bm_cricos_contact_sync (
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  cricos_provider_code text NOT NULL,
  sample_course_code text,
  source_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'no_contacts', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  contact_count integer NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  last_error_code text,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  updatedat timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, cricos_provider_code),
  FOREIGN KEY (company_id, college_id)
    REFERENCES bm_colleges(company_id, college_id) ON DELETE CASCADE
);
ALTER TABLE bm_cricos_contact_sync ALTER COLUMN sample_course_code DROP NOT NULL;
CREATE INDEX IF NOT EXISTS bm_cricos_contact_sync_progress
  ON bm_cricos_contact_sync(company_id, status, cricos_provider_code);

COMMIT;
