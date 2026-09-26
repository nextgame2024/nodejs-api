import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  ApproveDataFlowSchema, ApprovePrivacyNoticeSchema, CreateLegalHoldSchema,
  CreatePrivacyNoticeSchema, CreateRetentionPolicySchema, CreateSubjectRequestSchema,
  UpdateLegalReviewSchema, UpsertDataFlowSchema, VerifySubjectRequestSchema,
} from "./privacy.contracts.js";

const LEGAL_CONTROL_KEYS = [
  "privacy_act_applicability", "privacy_notice", "recording_rules", "consumer_representations",
  "marketing_consent", "cross_border_disclosure", "breach_response", "provider_customer_terms",
] as const;

@Injectable()
export class PrivacyService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async overview(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const [notices, policies, flows, reviews, requests, holds] = await Promise.all([
        client.query(`SELECT privacy_notice_version_id, notice_key, version, status, purpose_manifest,
          content_digest, counsel_reference, created_at, approved_at
          FROM ${schema}.privacy_notice_versions WHERE customer_id = $1 ORDER BY notice_key, version DESC`, [tenantId]),
        client.query(`SELECT privacy_retention_policy_id, dataset_key, version, status, retention_days,
          disposal_method, policy_reference, created_at, approved_at
          FROM ${schema}.privacy_retention_policies WHERE customer_id = $1 ORDER BY dataset_key, version DESC`, [tenantId]),
        client.query(`SELECT privacy_data_flow_id, flow_key, owner_key, capability, data_categories,
          processing_jurisdictions, storage_jurisdictions, retention_control, deletion_control,
          status, failover_eligible, assessment_reference, updated_at
          FROM ${schema}.privacy_data_flows WHERE customer_id = $1 ORDER BY flow_key`, [tenantId]),
        client.query(`SELECT control_key, status, review_reference, reviewer_identity, updated_at, approved_at
          FROM ${schema}.privacy_legal_reviews WHERE customer_id = $1 ORDER BY control_key`, [tenantId]),
        client.query(`SELECT privacy_subject_request_id, request_type, verification_status, status,
          created_at, verified_at, completed_at
          FROM ${schema}.privacy_subject_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]),
        client.query(`SELECT privacy_legal_hold_id, status, reason_reference, created_at, released_at
          FROM ${schema}.privacy_legal_holds WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]),
      ]);
      const legalReviews = LEGAL_CONTROL_KEYS.map((controlKey) => reviews.rows.find((row) => row.control_key === controlKey)
        ?? { control_key: controlKey, status: "required" });
      const approvedPolicies = new Set(policies.rows.filter((row) => row.status === "approved").map((row) => row.dataset_key));
      return {
        privacyDefaults: { rawAudioRecording: false, fullTranscriptPersistence: false, marketing: false },
        retentionAutomation: {
          enabled: false,
          status: approvedPolicies.size === 6 ? "policies_recorded_execution_not_enabled" : "policy_incomplete",
          detail: "Automatic retention execution remains disabled until every owned store has an approved processor and hold/backup verification.",
        },
        notices: notices.rows,
        retentionPolicies: policies.rows,
        dataFlows: flows.rows,
        legalReviews,
        subjectRequests: requests.rows,
        legalHolds: holds.rows,
      };
    });
  }

  async createNotice(tenantId: string, actorId: string, input: unknown) {
    const value = CreatePrivacyNoticeSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::int + 1 AS version FROM ${schema}.privacy_notice_versions
         WHERE customer_id = $1 AND notice_key = $2`, [tenantId, value.noticeKey]);
      const result = await client.query(
        `INSERT INTO ${schema}.privacy_notice_versions
          (customer_id, notice_key, version, purpose_manifest, content_digest, created_by_identity)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING privacy_notice_version_id, notice_key, version, status`,
        [tenantId, value.noticeKey, next.rows[0].version, JSON.stringify(value.purposeManifest), value.contentDigest, actorId]);
      return result.rows[0];
    });
  }

  async approveNotice(tenantId: string, noticeId: string, actorId: string, input: unknown) {
    const value = ApprovePrivacyNoticeSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.privacy_notice_versions
         SET status = 'approved', counsel_reference = $3, approved_by_identity = $4, approved_at = now()
         WHERE customer_id = $1 AND privacy_notice_version_id = $2 AND status = 'draft'
         RETURNING privacy_notice_version_id, notice_key, version, status`, [tenantId, noticeId, value.counselReference, actorId]);
      if (!result.rows[0]) throw new ConflictException("Only a draft privacy notice can be approved.");
      return result.rows[0];
    });
  }

  async createRetentionPolicy(tenantId: string, actorId: string, input: unknown) {
    const value = CreateRetentionPolicySchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::int + 1 AS version FROM ${schema}.privacy_retention_policies
         WHERE customer_id = $1 AND dataset_key = $2`, [tenantId, value.datasetKey]);
      const result = await client.query(
        `INSERT INTO ${schema}.privacy_retention_policies
          (customer_id, dataset_key, version, retention_days, disposal_method, policy_reference, created_by_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING privacy_retention_policy_id, dataset_key, version, status`,
        [tenantId, value.datasetKey, next.rows[0].version, value.retentionDays, value.disposalMethod, value.policyReference, actorId]);
      return result.rows[0];
    });
  }

  async approveRetentionPolicy(tenantId: string, policyId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.privacy_retention_policies
       SET status = 'approved', approved_by_identity = $3, approved_at = now()
       WHERE customer_id = $1 AND privacy_retention_policy_id = $2 AND status = 'draft'
       RETURNING privacy_retention_policy_id, dataset_key, version, status`, [tenantId, policyId, actorId]));
    if (!result.rows[0]) throw new ConflictException("Only a draft retention policy can be approved.");
    return result.rows[0];
  }

  async upsertDataFlow(tenantId: string, actorId: string, input: unknown) {
    const value = UpsertDataFlowSchema.parse(input); const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `INSERT INTO ${schema}.privacy_data_flows
        (customer_id, flow_key, owner_key, capability, data_categories, processing_jurisdictions,
         storage_jurisdictions, retention_control, deletion_control, status, created_by_identity)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (customer_id, flow_key) DO UPDATE SET
         owner_key = EXCLUDED.owner_key, capability = EXCLUDED.capability,
         data_categories = EXCLUDED.data_categories, processing_jurisdictions = EXCLUDED.processing_jurisdictions,
         storage_jurisdictions = EXCLUDED.storage_jurisdictions, retention_control = EXCLUDED.retention_control,
         deletion_control = EXCLUDED.deletion_control, status = EXCLUDED.status,
         failover_eligible = false, assessment_reference = NULL, approved_by_identity = NULL,
         approved_at = NULL, updated_at = now()
       WHERE ${schema}.privacy_data_flows.status <> 'approved'
       RETURNING privacy_data_flow_id, flow_key, status, failover_eligible`,
      [tenantId, value.flowKey, value.ownerKey, value.capability, JSON.stringify(value.dataCategories),
        JSON.stringify(value.processingJurisdictions), JSON.stringify(value.storageJurisdictions),
        value.retentionControl, value.deletionControl, value.status, actorId]));
    if (!result.rows[0]) throw new ConflictException("Approved data flows are immutable; create a new flow key for reassessment.");
    return result.rows[0];
  }

  async approveDataFlow(tenantId: string, flowId: string, actorId: string, input: unknown) {
    const value = ApproveDataFlowSchema.parse(input); const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.privacy_data_flows SET status = 'approved', failover_eligible = $3,
         assessment_reference = $4, approved_by_identity = $5, approved_at = now(), updated_at = now()
       WHERE customer_id = $1 AND privacy_data_flow_id = $2 AND status IN ('draft', 'blocked')
         AND retention_control <> 'unverified' AND deletion_control <> 'unverified'
       RETURNING privacy_data_flow_id, flow_key, status, failover_eligible`,
      [tenantId, flowId, value.failoverEligible, value.assessmentReference, actorId]));
    if (!result.rows[0]) throw new ConflictException("The data flow is missing verified retention or deletion controls.");
    return result.rows[0];
  }

  async updateLegalReview(tenantId: string, controlKey: string, actorId: string, input: unknown) {
    if (!LEGAL_CONTROL_KEYS.includes(controlKey as typeof LEGAL_CONTROL_KEYS[number])) throw new NotFoundException("Legal review control not found.");
    const value = UpdateLegalReviewSchema.parse(input); const schema = runtimeConfig().schema;
    if (value.status === "approved" && value.reviewerIdentity === actorId) {
      throw new ConflictException("Legal approval must identify an independent reviewer, not the administrator recording it.");
    }
    const reviewReference = "reviewReference" in value ? value.reviewReference ?? null : null;
    const reviewerIdentity = "reviewerIdentity" in value ? value.reviewerIdentity : null;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `INSERT INTO ${schema}.privacy_legal_reviews
        (customer_id, control_key, status, review_reference, reviewer_identity, updated_by_identity, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'approved' THEN now() ELSE NULL END)
       ON CONFLICT (customer_id, control_key) DO UPDATE SET status = EXCLUDED.status,
         review_reference = EXCLUDED.review_reference, reviewer_identity = EXCLUDED.reviewer_identity,
         updated_by_identity = EXCLUDED.updated_by_identity, updated_at = now(), approved_at = EXCLUDED.approved_at
       RETURNING control_key, status, review_reference, reviewer_identity, updated_at, approved_at`,
      [tenantId, controlKey, value.status, reviewReference, reviewerIdentity, actorId]));
    return result.rows[0];
  }

  async createSubjectRequest(tenantId: string, actorId: string, input: unknown) {
    const value = CreateSubjectRequestSchema.parse(input); const schema = runtimeConfig().schema;
    const subjectDigest = subjectReferenceDigest(tenantId, value.subjectReference);
    return this.database.tenantTransaction(tenantId, async (client) => {
      const sessions = await client.query<{ session_id: string }>(
        `SELECT session_id FROM ${schema}.sessions WHERE customer_id = $1 AND session_id = ANY($2::uuid[])`,
        [tenantId, value.sessionIds]);
      if (sessions.rows.length !== new Set(value.sessionIds).size) throw new NotFoundException("One or more sessions are unknown or outside this tenant.");
      const created = await client.query<{ privacy_subject_request_id: string }>(
        `INSERT INTO ${schema}.privacy_subject_requests
          (customer_id, request_type, subject_reference_digest, selectors, requested_by_identity)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING privacy_subject_request_id`,
        [tenantId, value.requestType, subjectDigest, JSON.stringify({ sessionIds: [...new Set(value.sessionIds)] }), actorId]);
      const requestId = created.rows[0].privacy_subject_request_id;
      const targets = [
        ["runtime_session_content", "runtime_controlled"], ["runtime_review_payloads", "runtime_controlled"],
        ["runtime_operational_metadata", "runtime_controlled"], ["business_manager_documents", "external_owner"],
        ["provider_owned_data", "external_owner"], ["backups", "external_owner"],
      ];
      for (const [targetKey, ownership] of targets) await client.query(
        `INSERT INTO ${schema}.privacy_subject_request_targets
          (customer_id, privacy_subject_request_id, target_key, ownership)
         VALUES ($1, $2, $3, $4)`, [tenantId, requestId, targetKey, ownership]);
      for (const sessionId of new Set(value.sessionIds)) await client.query(
        `INSERT INTO ${schema}.privacy_subject_bindings
          (customer_id, subject_reference_digest, session_id, created_by_request_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (customer_id, subject_reference_digest, session_id) DO NOTHING`,
        [tenantId, subjectDigest, sessionId, requestId]);
      await client.query(
        `INSERT INTO ${schema}.privacy_subject_request_events
          (customer_id, privacy_subject_request_id, event_type, actor_identity)
         VALUES ($1, $2, 'created', $3)`, [tenantId, requestId, actorId]);
      return { privacySubjectRequestId: requestId, requestType: value.requestType, verificationStatus: "pending", status: "pending_verification" };
    });
  }

  async verifySubjectRequest(tenantId: string, requestId: string, actorId: string, input: unknown) {
    const value = VerifySubjectRequestSchema.parse(input); const schema = runtimeConfig().schema;
    const status = value.verificationStatus === "verified" ? "ready" : "rejected";
    const result = await this.database.tenantTransaction(tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE ${schema}.privacy_subject_requests SET verification_status = $3, verification_method = $4,
           verification_evidence_reference = $5, status = $6, verified_by_identity = $7, verified_at = now()
         WHERE customer_id = $1 AND privacy_subject_request_id = $2 AND verification_status = 'pending'
         RETURNING privacy_subject_request_id, request_type, verification_status, status`,
        [tenantId, requestId, value.verificationStatus, value.verificationMethod,
          value.verificationEvidenceReference, status, actorId]);
      if (updated.rows[0]) await client.query(
        `INSERT INTO ${schema}.privacy_subject_request_events
          (customer_id, privacy_subject_request_id, event_type, actor_identity, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [tenantId, requestId, value.verificationStatus === "verified" ? "verified" : "rejected", actorId,
          JSON.stringify({ method: value.verificationMethod })]);
      return updated;
    });
    if (!result.rows[0]) throw new ConflictException("Only a pending subject request can be verified or rejected.");
    return result.rows[0];
  }

  async createLegalHold(tenantId: string, actorId: string, input: unknown) {
    const value = CreateLegalHoldSchema.parse(input); const schema = runtimeConfig().schema;
    const digest = subjectReferenceDigest(tenantId, value.subjectReference);
    const result = await this.database.tenantTransaction(tenantId, async (client) => {
      const executing = await client.query(
        `SELECT 1 FROM ${schema}.privacy_subject_requests
         WHERE customer_id = $1 AND subject_reference_digest = $2 AND status = 'processing'
           AND processing_started_at > now() - interval '15 minutes' LIMIT 1`, [tenantId, digest]);
      if (executing.rows[0]) throw new ConflictException("A privacy request is currently processing for this subject; retry the hold after it finishes.");
      return client.query(
        `INSERT INTO ${schema}.privacy_legal_holds
          (customer_id, subject_reference_digest, reason_reference, created_by_identity)
         VALUES ($1, $2, $3, $4) RETURNING privacy_legal_hold_id, status, reason_reference, created_at`,
        [tenantId, digest, value.reasonReference, actorId]);
    });
    return result.rows[0];
  }

  async releaseLegalHold(tenantId: string, holdId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.privacy_legal_holds SET status = 'released', released_by_identity = $3, released_at = now()
       WHERE customer_id = $1 AND privacy_legal_hold_id = $2 AND status = 'active'
       RETURNING privacy_legal_hold_id, status, released_at`, [tenantId, holdId, actorId]));
    if (!result.rows[0]) throw new ConflictException("Only an active legal hold can be released.");
    return result.rows[0];
  }
}

export function subjectReferenceDigest(tenantId: string, opaqueReference: string): string {
  return createHash("sha256").update(`${tenantId}\u0000${opaqueReference}`).digest("hex");
}
