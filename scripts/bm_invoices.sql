-- Add new project status for invoice flow
ALTER TYPE bm_project_status ADD VALUE IF NOT EXISTS 'quote_approved';
ALTER TYPE bm_project_status ADD VALUE IF NOT EXISTS 'invoice_process';

-- Track previous status when a project goes on hold
ALTER TABLE bm_projects
  ADD COLUMN IF NOT EXISTS status_before_hold bm_project_status;

-- Invoice status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bm_invoice_status') THEN
    CREATE TYPE bm_invoice_status AS ENUM (
      'invoice_created',
      'invoice_approved',
      'overdue_invoice',
      'invoice_paid'
    );
  END IF;
END $$;

-- Store generated invoice PDFs + status
ALTER TABLE bm_documents
  ADD COLUMN IF NOT EXISTS pdf_key text,
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS invoice_status bm_invoice_status;

-- Backfill invoice status for existing invoices
UPDATE bm_documents
SET invoice_status = 'invoice_created'
WHERE type = 'invoice' AND invoice_status IS NULL;

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
