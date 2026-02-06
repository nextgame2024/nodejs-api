-- Add new project status for invoice flow
ALTER TYPE bm_project_status ADD VALUE IF NOT EXISTS 'quote_approved';

-- Store generated invoice PDFs
ALTER TABLE bm_documents
  ADD COLUMN IF NOT EXISTS pdf_key text,
  ADD COLUMN IF NOT EXISTS pdf_url text;

-- Ensure only one invoice per project (optional but recommended)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'bm_documents_invoice_per_project'
  ) THEN
    CREATE UNIQUE INDEX bm_documents_invoice_per_project
      ON bm_documents (company_id, project_id)
      WHERE type = 'invoice';
  END IF;
END$$;
