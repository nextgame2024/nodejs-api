-- Owner migration, after bm_user_student_fields.sql. No accounts are created here.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS users_company_student_identity ON public.users(company_id, student_id);
CREATE TABLE IF NOT EXISTS public.bm_xero_student_sync_config (
  customer_id uuid PRIMARY KEY REFERENCES sophia_runtime.customers(customer_id),
  company_id uuid NOT NULL REFERENCES public.bm_company(company_id),
  actor_user_id uuid NOT NULL REFERENCES public.users(id),
  automatic boolean NOT NULL DEFAULT false,
  last_source_sync timestamptz
);
CREATE TABLE IF NOT EXISTS public.bm_xero_student_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.bm_xero_student_sync_config(customer_id),
  mode text NOT NULL CHECK (mode IN ('preview','apply')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed')),
  phase text NOT NULL DEFAULT 'scan' CHECK (phase IN ('scan','apply','done')),
  actor_user_id uuid NOT NULL REFERENCES public.users(id),
  source_sync timestamptz,
  created_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bm_xero_student_sync_one_run
  ON public.bm_xero_student_sync_runs(customer_id) WHERE status IN ('queued','processing');
CREATE TABLE IF NOT EXISTS public.bm_xero_student_identities (
  customer_id uuid NOT NULL REFERENCES sophia_runtime.customers(customer_id),
  company_id uuid NOT NULL,
  student_id text NOT NULL,
  PRIMARY KEY(customer_id, student_id),
  FOREIGN KEY(company_id, student_id) REFERENCES public.users(company_id, student_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS public.bm_xero_student_sync_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.bm_xero_student_sync_config(customer_id),
  connection_id uuid NOT NULL,
  name_key text NOT NULL,
  display_name text NOT NULL,
  source_names jsonb NOT NULL,
  emails jsonb NOT NULL,
  contact_ids uuid[] NOT NULL,
  record_count integer NOT NULL,
  status text NOT NULL CHECK(status IN ('ready','pending','linked','excluded')),
  reason text,
  student_id text,
  resolution_name text,
  resolution_email text,
  resolved_by uuid REFERENCES public.users(id),
  scan_run_id uuid REFERENCES public.bm_xero_student_sync_runs(id),
  processed_run_id uuid REFERENCES public.bm_xero_student_sync_runs(id),
  normalization_version integer NOT NULL DEFAULT 1,
  UNIQUE(customer_id, name_key),
  FOREIGN KEY(customer_id,student_id) REFERENCES public.bm_xero_student_identities(customer_id,student_id)
);
CREATE TABLE IF NOT EXISTS public.bm_xero_student_contact_links (
  customer_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  student_id text NOT NULL,
  PRIMARY KEY(customer_id,connection_id,contact_id),
  FOREIGN KEY(customer_id,student_id) REFERENCES public.bm_xero_student_identities(customer_id,student_id)
);
CREATE TABLE IF NOT EXISTS public.bm_xero_student_sync_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  candidate_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sophia_runtime.student_operations_xero_invoices ADD COLUMN IF NOT EXISTS student_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='xero_invoice_student_user_identity') THEN
    ALTER TABLE sophia_runtime.student_operations_xero_invoices
      ADD CONSTRAINT xero_invoice_student_user_identity FOREIGN KEY(customer_id,student_id)
      REFERENCES public.bm_xero_student_identities(customer_id,student_id) ON DELETE RESTRICT;
  END IF;
END $$;
-- Keep raw Xero updates from changing local identity associations. No runtime grants are expanded.
CREATE INDEX IF NOT EXISTS xero_invoice_student_user ON sophia_runtime.student_operations_xero_invoices(customer_id,student_id);
INSERT INTO public.bm_navigation_links(company_id,user_id,navigation_type,navigation_label,active)
SELECT c.company_id, NULL, 'menu', 'Sync users', true FROM public.bm_company c
WHERE c.workspace_profile='student_operations' AND NOT EXISTS (
  SELECT 1 FROM public.bm_navigation_links n WHERE n.company_id=c.company_id AND lower(trim(n.navigation_label))='sync users'
) ON CONFLICT DO NOTHING;
COMMIT;
