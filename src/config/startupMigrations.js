import pool from "./db.js";
import { ensureStudentConsultationSchema } from "./studentConsultationSchema.js";

const BM_USER_TYPE_VALUES = ["employee", "supplier", "client"];

export async function ensureStartupMigrations() {
  await ensureBmUserTypeValues();
  await ensureTownPlannerBookingWorkflowSchema();
  await ensureStudentAgencyKnowledgeSchema();
  await ensureStudentConsultationSchema();
}

export async function ensureTownPlannerBookingWorkflowSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_property_report_jobs (
      report_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      property_id uuid NOT NULL REFERENCES bm_properties(property_id) ON DELETE CASCADE,
      cache_key text NOT NULL UNIQUE,
      report_version text NOT NULL,
      property_version text NOT NULL,
      report_inputs jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'retry', 'daily_retry', 'running', 'ready', 'failed')),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      lease_until timestamptz,
      locked_by text,
      pdf_key text,
      pdf_url text,
      last_error text,
      initial_attempts_exhausted_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bm_property_report_jobs_claim
      ON bm_property_report_jobs(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS bm_inspection_confirmation_deliveries (
      delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      booking_id uuid NOT NULL UNIQUE
        REFERENCES bm_property_inspection_bookings(booking_id) ON DELETE CASCADE,
      report_job_id uuid NOT NULL
        REFERENCES bm_property_report_jobs(report_job_id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'waiting_report'
        CHECK (status IN (
          'waiting_report', 'email_queued', 'email_sending', 'email_retry',
          'sent', 'fallback_queued', 'fallback_sent', 'failed'
        )),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      lease_until timestamptz,
      locked_by text,
      sent_at timestamptz,
      fallback_without_report boolean NOT NULL DEFAULT false,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bm_inspection_deliveries_claim
      ON bm_inspection_confirmation_deliveries(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS bm_inspection_email_commands (
      command_id text PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      booking_id uuid NOT NULL REFERENCES bm_property_inspection_bookings(booking_id) ON DELETE CASCADE,
      customer_email text NOT NULL,
      status text NOT NULL DEFAULT 'executing'
        CHECK (status IN ('executing', 'completed', 'failed', 'unknown')),
      response jsonb,
      last_error text,
      attempt_count integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bm_inspection_email_commands_booking
      ON bm_inspection_email_commands(company_id, booking_id, created_at DESC);

    ALTER TABLE bm_property_report_jobs
      ADD COLUMN IF NOT EXISTS claim_token uuid,
      ADD COLUMN IF NOT EXISTS claim_generation integer NOT NULL DEFAULT 0;

    ALTER TABLE bm_inspection_confirmation_deliveries
      ADD COLUMN IF NOT EXISTS claim_token uuid,
      ADD COLUMN IF NOT EXISTS claim_generation integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS workflow_version_id uuid,
      ADD COLUMN IF NOT EXISTS provider_key text,
      ADD COLUMN IF NOT EXISTS provider_message_id text,
      ADD COLUMN IF NOT EXISTS provider_accepted_at timestamptz,
      ADD COLUMN IF NOT EXISTS verified_delivered_at timestamptz;

    ALTER TABLE bm_property_inspection_bookings
      ADD COLUMN IF NOT EXISTS confirmation_email_provider_key text,
      ADD COLUMN IF NOT EXISTS confirmation_email_provider_message_id text,
      ADD COLUMN IF NOT EXISTS confirmation_email_accepted_at timestamptz,
      ADD COLUMN IF NOT EXISTS confirmation_email_previewed_at timestamptz,
      ADD COLUMN IF NOT EXISTS confirmation_email_verified_delivered_at timestamptz;

    ALTER TABLE bm_property_report_jobs
      DROP CONSTRAINT IF EXISTS bm_property_report_jobs_claim_generation_check;
    ALTER TABLE bm_property_report_jobs
      ADD CONSTRAINT bm_property_report_jobs_claim_generation_check
      CHECK (claim_generation >= 0);

    ALTER TABLE bm_inspection_confirmation_deliveries
      DROP CONSTRAINT IF EXISTS bm_inspection_confirmation_deliveries_claim_generation_check;
    ALTER TABLE bm_inspection_confirmation_deliveries
      ADD CONSTRAINT bm_inspection_confirmation_deliveries_claim_generation_check
      CHECK (claim_generation >= 0);

    ALTER TABLE bm_inspection_confirmation_deliveries
      DROP CONSTRAINT IF EXISTS bm_inspection_confirmation_deliveries_status_check;
    ALTER TABLE bm_inspection_confirmation_deliveries
      ADD CONSTRAINT bm_inspection_confirmation_deliveries_status_check
      CHECK (status IN (
        'waiting_report', 'email_queued', 'email_sending', 'email_retry',
        'provider_accepted', 'fallback_provider_accepted',
        'previewed', 'fallback_previewed', 'outcome_unknown',
        'delivered', 'fallback_delivered', 'sent', 'fallback_sent', 'failed'
      ));

    UPDATE bm_inspection_confirmation_deliveries
    SET status = CASE status
      WHEN 'sent' THEN 'provider_accepted'
      WHEN 'fallback_sent' THEN 'fallback_provider_accepted'
      ELSE status
    END
    WHERE status IN ('sent', 'fallback_sent');
  `);
}

async function ensureBmUserTypeValues() {
  for (const value of BM_USER_TYPE_VALUES) {
    try {
      await pool.query(
        `ALTER TYPE bm_user_type ADD VALUE IF NOT EXISTS '${value}'`
      );
    } catch (error) {
      if (error?.code === "42704") {
        console.warn("bm_user_type enum not found; skipping user type sync");
        return;
      }
      throw error;
    }
  }
}

export async function ensureStudentAgencyKnowledgeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_student_agency_knowledge (
      knowledge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      topic text NOT NULL,
      question text NOT NULL,
      answer text NOT NULL,
      previous_rule text,
      current_rule text,
      new_student_impact text,
      current_student_impact text,
      applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
      change_status text NOT NULL DEFAULT 'general'
        CHECK (change_status IN ('general', 'announced', 'in_force', 'superseded')),
      effective_from date,
      effective_to date,
      sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
      publication_status text NOT NULL DEFAULT 'draft'
        CHECK (publication_status IN ('draft', 'approved', 'withdrawn')),
      reviewed_by text,
      verified_at timestamptz,
      review_due_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
      CHECK (publication_status <> 'approved' OR (
        reviewed_by IS NOT NULL AND length(trim(reviewed_by)) > 0
        AND verified_at IS NOT NULL AND review_due_at IS NOT NULL
        AND review_due_at > verified_at AND jsonb_array_length(sources) > 0
      ))
    );
    ALTER TABLE bm_student_agency_knowledge ADD COLUMN IF NOT EXISTS content_key text;
    ALTER TABLE bm_student_agency_knowledge ADD COLUMN IF NOT EXISTS revision_hash text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_student_knowledge_revision
      ON bm_student_agency_knowledge(company_id, content_key, revision_hash);
    CREATE TABLE IF NOT EXISTS bm_student_source_snapshots (
      source_id text NOT NULL,
      content_hash text NOT NULL,
      snapshot jsonb NOT NULL,
      first_fetched_at timestamptz NOT NULL DEFAULT now(),
      last_checked_at timestamptz NOT NULL,
      PRIMARY KEY(source_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_bm_student_knowledge_company
      ON bm_student_agency_knowledge(company_id, publication_status, review_due_at);
  `);
}
